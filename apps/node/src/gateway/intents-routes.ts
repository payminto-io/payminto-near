import type { Context, Hono } from "hono";
import { z } from "zod";
import { isId } from "@payminto/protocol";
import { auditActor, type Access } from "../auth/actor.ts";
import type { AuthService } from "../auth/service.ts";
import { ApiError } from "../errors.ts";
import { TokenBuckets } from "../ratelimit.ts";
import { body, parse, rawBody, zAccount, zPublicKey } from "./http.ts";
import type { Gateway } from "./index.ts";
import { ORIGIN_TX_HASH, type IntentsService } from "./intents.ts";
import type { PaymentRow } from "./model.ts";

const quoteSchema = z.object({ origin_asset: z.string().min(1).max(200), refund_to: z.string().trim().min(1).max(128).optional() });
const depositSchema = z.object({ tx_hash: z.string().regex(ORIGIN_TX_HASH, "must be a transaction hash on the origin chain") });
const simulateSchema = z.object({ amount: z.string().regex(/^[1-9][0-9]{0,40}$/, "must be a positive integer of the origin token's base units").optional() });
const payoutSchema = z.object({
  account: zAccount,
  proof: z.object({ timestamp: z.number().int().positive(), public_key: zPublicKey, signature: z.string().min(1).max(200) }),
});
/** "Receive as" USDC on an EVM chain: the address and an EIP-191 (`personal_sign`) proof by it. */
const evmPayoutSchema = z.object({
  destination_chain: z.string().min(1).max(20),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address"),
  proof: z.object({ type: z.literal("eip191"), timestamp: z.number().int().positive(), signature: z.string().regex(/^0x[0-9a-fA-F]{128,130}$/, "must be a 0x signature") }),
});
const defaultOriginSchema = z.object({ default_origin: z.string().min(1).max(200).nullable() });

/** Wet quotes create deposit addresses on the platform's 1Click quota: ten per client address per minute. */
export const QUOTES_PER_IP_PER_MINUTE = 10;

/**
 * The any-chain checkout routes (docs/DEVELOPERS.md, "Any-chain checkout"): five public checkout routes, three merchant
 * routes for where the USDC lands (a NEAR account, or an address on an EVM chain) and the token the checkout pre-selects,
 * and the platform status. With INTENTS_CHECKOUT=off every one of them
 * answers 404 INTENTS_CHECKOUT_OFF, except the platform status, which says the mode.
 */
export function mountIntents(app: Hono<any>, g: Gateway, d: { access: Access; auth: AuthService; clientIp: (c: Context) => string }): void {
  const a = d.access;
  const quotesPerIp = new TokenBuckets({ rps: QUOTES_PER_IP_PER_MINUTE / 60, burst: QUOTES_PER_IP_PER_MINUTE });

  const svc = (): IntentsService => {
    if (!g.intents) throw new ApiError(404, "INTENTS_CHECKOUT_OFF", "this node does not offer the any-chain checkout (INTENTS_CHECKOUT=off)");
    return g.intents;
  };
  const payment = (c: Context): PaymentRow => {
    const id = c.req.param("id");
    const p = isId("payment", id) ? g.payments.row(id) : undefined;
    if (!p) throw new ApiError(404, "NOT_FOUND", "payment not found");
    return p;
  };
  const quoteId = (c: Context): string => {
    const id = c.req.param("qid");
    if (!isId("intentsQuote", id)) throw new ApiError(404, "NOT_FOUND", "no such quote for this payment");
    return id;
  };

  // ---------------------------------------------------------------- public checkout (no auth)

  app.get("/v1/checkout/:id/intents/options", async (c) => c.json(await svc().options(payment(c))));

  app.post("/v1/checkout/:id/intents/quotes", async (c) => {
    const s = svc();
    const p = payment(c);
    const taken = quotesPerIp.take(d.clientIp(c));
    if (!taken.ok) {
      c.header("Retry-After", String(taken.retryAfterSec));
      throw new ApiError(429, "RATE_LIMITED", `at most ${QUOTES_PER_IP_PER_MINUTE} deposit addresses a minute from one address`);
    }
    const run = async () => {
      const b = await body(c, quoteSchema);
      const out = await s.createQuote(p, b);
      return { status: out.reused ? 200 : 201, body: out.quote as unknown };
    };
    const key = c.req.header("idempotency-key");
    if (!key) {
      const out = await run();
      return c.json(out.body as object, out.status as 201);
    }
    const out = await g.idempotency.run(`checkout ${p.id} POST /v1/checkout/:id/intents/quotes`, key, await rawBody(c), run);
    if (out.replayed) c.header("Idempotent-Replayed", "true");
    return c.json(out.body as object, out.status as 201);
  });

  app.get("/v1/checkout/:id/intents/quotes/:qid", (c) => {
    const s = svc();
    return c.json(s.json(s.quoteOf(payment(c), quoteId(c))));
  });

  app.post("/v1/checkout/:id/intents/quotes/:qid/deposit", async (c) => {
    const s = svc();
    const r = s.quoteOf(payment(c), quoteId(c));
    const { tx_hash } = await body(c, depositSchema);
    return c.json(s.json(await s.submitDeposit(r, tx_hash)));
  });

  // Simulated mode only: a deposit on the fake 1Click server. In live mode this route does not exist.
  app.post("/v1/checkout/:id/intents/quotes/:qid/simulate", async (c) => {
    if (g.intents?.mode !== "simulated") throw new ApiError(404, "NOT_FOUND", "not found");
    const s = svc();
    const r = s.quoteOf(payment(c), quoteId(c));
    const b = await body(c, simulateSchema);
    return c.json(s.json(await s.simulateDeposit(r, BigInt(b.amount ?? r.amount_in))));
  });

  // ---------------------------------------------------------------- the merchant's NEAR account

  app.get("/v1/merchant/intents-payout", async (c) => {
    const s = svc();
    const { merchant } = a.business(c, "payments.read");
    return c.json(await s.payoutView(merchant));
  });

  // Like a payout change: the business's payout.change permission, a verified email and a fresh password check. The body
  // is either a NEAR account with a NEP-413 signature by a full-access key of it, or an EVM chain and address with an
  // EIP-191 signature by the address.
  app.put("/v1/merchant/intents-payout", async (c) => {
    const s = svc();
    const { merchant, actor } = a.business(c, "payout.change");
    a.verified(actor);
    a.stepUp(actor);
    const raw = await c.req.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      throw new ApiError(400, "INVALID_JSON", "request body is not valid JSON");
    }
    const before = s.destinationOf(merchant);
    const from = { chain: before.dest.blockchain, address: before.recipient };
    if (parsed && typeof parsed === "object" && "destination_chain" in parsed) {
      const b = parse(parsed, evmPayoutSchema, "request body failed validation");
      const out = await s.setEvmPayout(merchant, b.destination_chain, b.address, b.proof);
      d.auth.audit.write(auditActor(actor), "intents_payout.changed", { merchantId: merchant.id, target: merchant.id, meta: { from: from.address, from_chain: from.chain, to: out.destination.address, destination_chain: out.destination.chain, mode: s.mode } });
      return c.json(out);
    }
    const b = parse(parsed, payoutSchema, "request body failed validation");
    const out = await s.setPayout(merchant, b.account, b.proof);
    d.auth.audit.write(auditActor(actor), "intents_payout.changed", { merchantId: merchant.id, target: merchant.id, meta: { from: from.address, from_chain: from.chain, to: b.account, destination_chain: "near", usdc_registered: out.checks.usdc_registered, mode: s.mode } });
    return c.json(out);
  });

  // The token the hosted checkout pre-selects: a business setting, not a payout change.
  app.patch("/v1/merchant/intents-payout", async (c) => {
    const s = svc();
    const { merchant, actor } = a.business(c, "business.update");
    const b = await body(c, defaultOriginSchema);
    const before = s.defaultOrigin(merchant);
    const out = await s.setDefaultOrigin(merchant, b.default_origin);
    if (before !== out.default_origin) d.auth.audit.write(auditActor(actor), "intents_default_origin.changed", { merchantId: merchant.id, target: merchant.id, meta: { from: before, to: out.default_origin, mode: s.mode } });
    return c.json(out);
  });

  // ---------------------------------------------------------------- platform

  app.get("/v1/platform/intents", (c) => {
    a.platform(c, "platform.read");
    if (!g.intents) return c.json({ object: "intents_status", mode: "off", label: null });
    return c.json(g.intents.platformStatus());
  });
}
