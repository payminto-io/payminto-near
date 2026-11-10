/**
 * Seller agent (plan 5.2): the "NEAR market brief" skill, sold per call behind paywall() from @payminto/sdk.
 *
 * It is registered on the node as a provider like any other, so it shows up in the node's directory and buyer agents
 * find and pay it. On each paid request it buys its own inputs (spot quotes and a wallet risk scan) from other paid
 * services with its OWN budget, through AgentClient, then asks its model (Claude by default) to write the brief. It returns the brief with
 * the receipts of what it bought: one agent pays another, which pays others, and the node nets it all.
 *
 * It never takes payment without serving: requests are refused with 503 before the paywall when no model is
 * configured, and a model failure after payment still returns a brief built from the purchased data, labelled as such.
 */
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { formatAmount, isAccountId, type AccountId } from "@payminto/protocol";
import { NodeHttp, paywall, type AgentClient, type VoucherStore } from "@payminto/sdk";
import type { ModelClient } from "@payminto/models";
import { researchBrief, type BriefInputs } from "./brief.ts";

export const SKILL_NAME = "NEAR Market Brief";
export const SKILL_CATEGORY = "research";
export const SYMBOLS = ["NEAR", "BTC", "ETH"] as const;

export { templateBrief, type BriefInputs, type Purchase } from "./brief.ts";

export type MarketBriefOptions = {
  nodeUrl: string;
  provider: { id: string; apiKey: string };
  /** Must equal the price registered at the node. */
  price: bigint;
  /** The seller's own buyer, bound to its own budget. */
  buyer: AgentClient;
  /** Where to buy inputs; a function is resolved per request (for example from the node directory). */
  inputs: BriefInputs | (() => Promise<BriefInputs>);
  /** Null when no model is configured: paid requests are refused with 503 before any payment. */
  model: ModelClient | null;
  modelUnavailable?: string;
  /** Token label for amounts in responses. */
  token?: { symbol: string; decimals: number };
  /** Where the paywall keeps the latest voucher per Budget for settle_own (default: memory). */
  vouchers?: VoucherStore;
};

const briefRequest = z.object({
  symbols: z.array(z.enum(SYMBOLS)).min(1).max(3).optional(),
  address: z
    .string()
    .refine((v) => isAccountId(v), "must be a NEAR account id")
    .optional(),
  focus: z.string().max(300).optional(),
});

export function marketBriefApp(o: MarketBriefOptions) {
  const pay = paywall({
    nodeUrl: o.nodeUrl,
    providerId: o.provider.id,
    apiKey: o.provider.apiKey,
    price: o.price,
    description: `${SKILL_NAME}: spot quotes and a wallet risk read, written by Claude`,
    ...(o.vouchers ? { vouchers: o.vouchers } : {}),
  });
  const token = o.token ?? { symbol: "USDC", decimals: 6 };
  const fmt = (a: bigint) => `${formatAmount(a, token.decimals)} ${token.symbol}`;
  const app = new Hono<{ Variables: { brief: z.infer<typeof briefRequest> } }>();

  // Refuse before the paywall, so nothing is charged for a request this seller cannot serve.
  const ready: MiddlewareHandler = async (c, next) => {
    if (!o.model) {
      return c.json(
        { error: { code: "MODEL_UNAVAILABLE", message: o.modelUnavailable ?? "this seller has no model configured (no model API key is set); nothing was charged" } },
        503,
      );
    }
    await next();
  };
  const validate: MiddlewareHandler<{ Variables: { brief: z.infer<typeof briefRequest> } }> = async (c, next) => {
    // Read a clone: the paywall hashes the original body to match the voucher's requestHash.
    const raw = await c.req.raw.clone().text();
    let json: unknown = {};
    if (raw.trim()) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = null;
      }
    }
    const b = briefRequest.safeParse(json);
    if (!b.success) {
      return c.json({ error: { code: "BAD_REQUEST", message: `body must be { symbols?: ["NEAR"|"BTC"|"ETH"], address?: "name.testnet", focus?: string }; nothing was charged` } }, 400);
    }
    c.set("brief", b.data);
    await next();
  };

  app.get("/", (c) =>
    c.json({
      service: SKILL_NAME,
      price: fmt(o.price),
      model: o.model?.model ?? null,
      ready: o.model !== null,
      routes: ["POST /v1/brief { symbols?, address?, focus? }"],
    }),
  );

  app.post("/v1/brief", ready, validate, pay.hono(), async (c) => {
    const req = c.get("brief");
    const symbols = req.symbols ?? ["NEAR", "ETH"];
    const address = req.address ?? null;
    const inputs = typeof o.inputs === "function" ? await o.inputs().catch(() => null) : o.inputs;
    const { brief, writtenBy, quotes, risk, missing, purchases } = await researchBrief({
      buyer: o.buyer,
      inputs,
      model: o.model,
      symbols,
      address,
      focus: req.focus ?? null,
      instruction: `Write the brief${req.focus ? ` with this focus from the customer: ${JSON.stringify(req.focus)}` : ""}.`,
      fmt,
    });
    const spent = purchases.reduce((s, p) => s + BigInt(p.amountAtomic), 0n);
    return c.json({
      skill: SKILL_NAME,
      brief,
      writtenBy,
      inputs: { quotes, risk },
      missing,
      purchases,
      spentOnInputs: fmt(spent),
      seller: o.buyer.publicKey,
      receipt: c.get("payminto").receipt.callId,
    });
  });
  return app;
}

/** Finds a quote and a risk supplier in the node directory (categories market-data and risk), skipping the seller itself. */
export async function discoverInputs(nodeUrl: string, self?: string): Promise<BriefInputs> {
  const dir = await new NodeHttp(nodeUrl).get(
    "/v1/directory",
    z.object({ services: z.array(z.object({ type: z.string(), id: z.string(), category: z.string().optional(), pay_url: z.string() }).loose()) }).loose(),
  );
  const endpoints = dir.services.filter((s) => s.type === "endpoint" && s.id !== self);
  const quote = endpoints.find((s) => s.category === "market-data" && /\/quote\/?$/.test(new URL(s.pay_url).pathname));
  const risk = endpoints.find((s) => s.category === "risk");
  if (!quote || !risk) throw new Error("the node directory has no market-data quote service and risk service to buy inputs from");
  return { quoteUrl: quote.pay_url, riskUrl: risk.pay_url };
}

/** Registers the skill as a provider (operator access), exactly as the demo providers are. */
export async function registerSeller(
  admin: NodeHttp,
  o: { payee: AccountId; price: bigint; resource: string; name?: string; description?: string },
): Promise<{ id: string; apiKey: string }> {
  return admin.post("/v1/providers", z.object({ id: z.string(), apiKey: z.string() }).loose(), {
    name: o.name ?? SKILL_NAME,
    description:
      o.description ??
      `A Claude-written brief on NEAR, BTC and ETH spot prices and a wallet risk read. The seller buys its own inputs from other paid services. ${formatAmount(o.price)} USDC per brief.`,
    payee: o.payee,
    priceAtomic: o.price.toString(),
    resource: o.resource,
    category: SKILL_CATEGORY,
  });
}
