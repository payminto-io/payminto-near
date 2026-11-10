/**
 * The paid services of the local stack: six small HTTP endpoints behind the real SDK paywall, registered at the node
 * through its HTTP API. Their answers are deterministic and say so; what is real is the 402, the voucher, the node's
 * decision and the receipt.
 */
import { Hono } from "hono";
import { deterministicQuote } from "@payminto/demo";
import { isAccountId, sha256Text, type AccountId } from "@payminto/protocol";
import { FileVoucherStore, paywall, type Paywall } from "@payminto/sdk";
import type { LocalAccounts } from "./accounts.ts";
import type { NodeSession } from "./session.ts";

export type ServiceKey = "quotes" | "briefs" | "scan" | "vendor" | "report" | "alpha";

export type ServiceSpec = {
  key: ServiceKey;
  name: string;
  description: string;
  /** Path under the services server, with a query that makes a sensible default request. */
  path: string;
  priceAtomic: bigint;
  category: string;
  /** What a call to it shows in the walkthrough. */
  note: string;
};

export const SERVICES: readonly ServiceSpec[] = [
  { key: "quotes", name: "Bob's Quotes", description: "NEAR, BTC and ETH spot quotes (deterministic local data)", path: "/svc/quotes/v1/quote?symbol=NEAR", priceAtomic: 2_000n, category: "data", note: "Paid to Bob. Alice's agent may buy it." },
  { key: "briefs", name: "Alice's Briefs", description: "A short research brief (deterministic local data)", path: "/svc/briefs/v1/brief?topic=NEAR", priceAtomic: 20_000n, category: "research", note: "Paid to Alice. Bob's agent may buy it, so Alice and Bob owe each other and settlement nets them." },
  { key: "scan", name: "Risk Scan", description: "A wallet risk score (deterministic local heuristic)", path: "/svc/scan/v1/scan?address=shopper.test.near", priceAtomic: 5_000n, category: "risk", note: "Paid to the seller. Both agents may buy it." },
  { key: "vendor", name: "New Vendor", description: "A translation service from a payee the owner has not approved yet (deterministic local data)", path: "/svc/vendor/v1/translate?text=hello", priceAtomic: 3_000n, category: "language", note: "Paid to a new account that never registered with the token. The node's payee check warns, so the call waits until the Budget's owner approves the payee." },
  { key: "report", name: "Deep Report", description: "A long report that costs more than either seeded Budget allows per call", path: "/svc/report/v1/report", priceAtomic: 250_000n, category: "research", note: "Paid to the seller. Costs 0.25 USDC, above the 0.05 USDC limit per call, so the node refuses it." },
  { key: "alpha", name: "Unlisted Alpha", description: "A service whose payee is on no Budget's payee list", path: "/svc/alpha/v1/alpha", priceAtomic: 2_000n, category: "other", note: "Paid to the platform operator's account, which is on no Budget's payee list, so the node refuses it." },
];

export type RegisteredService = ServiceSpec & { id: string; payee: AccountId; url: string };

/** Who each service pays. The unlisted one pays a real account that no Budget lists, so only the Budget rule stops it. */
export function payeeOf(key: ServiceKey, accounts: LocalAccounts): AccountId {
  switch (key) {
    case "quotes":
      return accounts.by.bob.accountId;
    case "briefs":
      return accounts.by.alice.accountId;
    case "vendor":
      return accounts.vendor;
    case "alpha":
      return accounts.by.platform.accountId;
    default:
      return accounts.by.seller.accountId;
  }
}

type Registered = { id: string; apiKey: string };

/**
 * Registers every service at the node as the platform owner (POST /v1/providers, the route the dashboard's Paid
 * services page uses), and returns the Hono app that serves them behind the paywall.
 */
export async function registerServices(o: { session: NodeSession; nodeUrl: string; baseUrl: string; accounts: LocalAccounts; voucherPath: string }): Promise<{ app: Hono; services: RegisteredService[]; close(): void }> {
  const vouchers = new FileVoucherStore(o.voucherPath);
  const app = new Hono();
  const services: RegisteredService[] = [];
  const pay = {} as Record<ServiceKey, Paywall>;
  for (const s of SERVICES) {
    const payee = payeeOf(s.key, o.accounts);
    const url = `${o.baseUrl}${s.path}`;
    const r = await o.session.post<Registered>("/v1/providers", { name: s.name, description: s.description, payee, priceAtomic: s.priceAtomic.toString(), resource: url.split("?")[0], category: s.category });
    pay[s.key] = paywall({ nodeUrl: o.nodeUrl, providerId: r.id, apiKey: r.apiKey, price: s.priceAtomic, description: s.description, ...(s.key === "scan" ? { vouchers } : {}) });
    services.push({ ...s, id: r.id, payee, url });
  }
  const local = "deterministic local data, not a market feed";
  app.get("/svc/quotes/v1/quote", pay.quotes.hono(), (c) => {
    const symbol = (c.req.query("symbol") ?? "NEAR").toUpperCase();
    if (symbol !== "NEAR" && symbol !== "BTC" && symbol !== "ETH") return c.json({ error: { code: "UNKNOWN_SYMBOL", message: "symbol must be NEAR, BTC or ETH" } }, 400);
    return c.json({ symbol, priceUsd: deterministicQuote(symbol, Date.now()), source: local, receipt: c.get("payminto").receipt.callId });
  });
  app.get("/svc/briefs/v1/brief", pay.briefs.hono(), (c) => {
    const topic = (c.req.query("topic") ?? "NEAR").slice(0, 80);
    return c.json({ topic, brief: `${topic}: NEAR at ${deterministicQuote("NEAR", Date.now())} USD. This brief is ${local}.`, receipt: c.get("payminto").receipt.callId });
  });
  app.get("/svc/scan/v1/scan", pay.scan.hono(), (c) => {
    const address = c.req.query("address") ?? "";
    if (!isAccountId(address)) return c.json({ error: { code: "BAD_ADDRESS", message: "address must be a NEAR account id" } }, 400);
    return c.json({ address, score: Number.parseInt(sha256Text(address).slice(0, 2), 16) % 101, model: "sha256 of the account id: a local stand-in for a risk model", receipt: c.get("payminto").receipt.callId });
  });
  app.get("/svc/vendor/v1/translate", pay.vendor.hono(), (c) => c.json({ text: (c.req.query("text") ?? "hello").slice(0, 80), translation: "hallo", note: `A fixed answer. It is ${local}.`, receipt: c.get("payminto").receipt.callId }));
  app.get("/svc/report/v1/report", pay.report.hono(), (c) => c.json({ report: `A long report. It is ${local}.`, receipt: c.get("payminto").receipt.callId }));
  app.get("/svc/alpha/v1/alpha", pay.alpha.hono(), (c) => c.json({ alpha: "nothing: no Budget should ever have paid for this", receipt: c.get("payminto").receipt.callId }));
  return { app, services, close: () => vouchers.close() };
}
