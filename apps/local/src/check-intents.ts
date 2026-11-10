/**
 * The `pnpm local --check` steps of the any-chain checkout (NEAR Intents, simulated): a buyer pays a checkout from "USDC
 * on Base" through the public routes the hosted page uses, the fake 1Click server delivers real mock USDC on this chain
 * from the local solver account, and the result is asserted on chain (the merchant's own token balance and the
 * delivery transaction's NEP-141 event, read through RPC), in the payment, in a signed webhook a local receiver got,
 * and in the reconciliation report. A second payment sends too little and its deposit is returned.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyWebhook, WEBHOOK_SIGNATURE_HEADER, type AccountId, type CheckoutView, type IntentsOptions, type IntentsQuote } from "@payminto/protocol";
import { NodeSession } from "./session.ts";
import { rpc } from "./signer-near.ts";
import type { Stack } from "./stack.ts";

export const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
/** A Base address for refunds. Simulated: nothing is ever sent to it. */
export const BUYER_BASE_ADDRESS = "0x5f2b3a1e9c7d4b6a8f0e1d2c3b4a59687766554f";

type Step = (name: string, run: () => Promise<{ ok: boolean; detail: string }>) => Promise<void>;
type Hook = { type: string; paymentId: string | null; signed: boolean; object: Record<string, unknown> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 45_000, everyMs = 400): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await read();
  while (!done(v) && Date.now() < deadline) {
    await sleep(everyMs);
    v = await read();
  }
  return v;
}

/** A local webhook endpoint: records every delivery and whether its signature verifies with the endpoint's secret. */
async function receiver(): Promise<{ url: string; hooks: Hook[]; setSecret(s: string): void; close(): Promise<void> }> {
  const hooks: Hook[] = [];
  let secret = "";
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      void verifyWebhook(raw, req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string | undefined, secret).then((signed) => {
        const body = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
        hooks.push({ type: body.type, paymentId: (body.data.object.id as string) ?? null, signed, object: body.data.object });
        res.writeHead(200).end("ok");
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/payminto`,
    hooks,
    setSecret: (s) => void (secret = s),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The NEP-141 ft_transfer events of a transaction's successful receipts, read from the chain with RPC. */
async function transfersOf(rpcUrl: string, hash: string, sender: AccountId): Promise<Array<{ token: string; to: string; amount: bigint }>> {
  const r = await rpc<{ receipts_outcome: Array<{ outcome: { executor_id: string; logs: string[]; status: Record<string, unknown> } }> }>(rpcUrl, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
  const out: Array<{ token: string; to: string; amount: bigint }> = [];
  for (const o of r.receipts_outcome) {
    if (!("SuccessValue" in o.outcome.status) && !("SuccessReceiptId" in o.outcome.status)) continue;
    for (const log of o.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: Array<{ new_owner_id: string; amount: string }> };
      if (ev.standard === "nep141" && ev.event === "ft_transfer") for (const d of ev.data) out.push({ token: o.outcome.executor_id, to: d.new_owner_id, amount: BigInt(d.amount) });
    }
  }
  return out;
}

export async function intentsChecks(s: Stack, step: Step, o: { api: string; origin: string; admin: { email: string; password: string } }): Promise<void> {
  const chain = s.hub.chain;
  const token = s.hub.names.token;
  // --check always runs the simulated checkout (config.ts refuses --intents live with it).
  const anyChain = s.setup.anyChain;
  if (!anyChain) throw new Error("the any-chain checks need the simulated checkout, and this stack runs it live");
  const anyAccount = anyChain.account;
  const anon = new NodeSession({ baseUrl: o.api, origin: o.origin });
  const admin = new NodeSession({ baseUrl: o.api, origin: o.origin });
  await admin.login(o.admin.email, o.admin.password);
  const scope = { "Merchant-Id": s.setup.merchant.id };
  const hooks = await receiver();
  let endpointId: string | null = null;
  try {
    const endpoint = await admin.post<{ id: string }>("/v1/webhooks", { url: hooks.url, description: "pnpm local --check", events: ["payment.processing", "payment.paid", "payment.deposit_returned", "payment.deposit_failed"] }, scope);
    endpointId = endpoint.id;
    hooks.setSecret((await admin.get<{ secret: string }>(`/v1/webhooks/${endpoint.id}/secret`, scope)).secret);

    await step("pay from another chain (USDC on Base, NEAR Intents simulated): the merchant's own account receives the USDC on chain, the payment is paid, a signed payment.paid arrives and the reconciliation row names the origin", async () => {
      const view = await anon.post<CheckoutView & { intents: { available: boolean; label: string } | null }>(`/v1/links/public/${s.setup.link.slug}/payments`, {});
      const options = await anon.get<IntentsOptions>(`/v1/checkout/${view.id}/intents/options`);
      const base = options.options.find((x) => x.origin.asset === BASE_USDC);
      const quote = await anon.post<IntentsQuote>(`/v1/checkout/${view.id}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: BUYER_BASE_ADDRESS });
      const before = await chain.balanceOf(anyAccount);
      await anon.post(`/v1/checkout/${view.id}/intents/quotes/${quote.id}/simulate`, { amount: quote.send_exactly.amount });
      const done = await until(() => anon.get<IntentsQuote>(`/v1/checkout/${view.id}/intents/quotes/${quote.id}`), (q) => ["confirmed", "refunded", "failed"].includes(q.status));
      const after = await chain.balanceOf(anyAccount);
      const paid = await until(() => anon.get<CheckoutView>(`/v1/checkout/${view.id}`), (v) => v.status === "paid", 10_000);
      const onChain = done.delivery_tx ? await transfersOf(s.urls.rpc, done.delivery_tx.hash, s.accounts.solver) : [];
      const event = onChain.find((t) => t.token === token && t.to === anyAccount);
      const hook = await until(async () => hooks.hooks.find((h) => h.type === "payment.paid" && h.paymentId === view.id), (h) => !!h, 20_000);
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const report = await admin.get<{ rows: Array<Record<string, unknown>> }>(`/v1/reports/reconciliation?from=${day(Date.now() - 86_400_000)}&to=${day(Date.now() + 86_400_000)}`, scope);
      const row = report.rows.find((r) => r.payment_id === view.id);
      const amount = BigInt(view.amount_due);
      const ok =
        view.methods.includes("oneclick" as never) &&
        view.intents?.label === "Simulated - no real money" &&
        !!base?.available &&
        done.status === "confirmed" &&
        done.verification === "rpc_checked" &&
        after - before === amount &&
        !!event &&
        event.amount === amount &&
        paid.status === "paid" &&
        !!hook?.signed &&
        row?.method === "oneclick" &&
        row.settlement_network === "near:mainnet (simulated)" &&
        row.origin_asset === BASE_USDC &&
        row.deposit_address === quote.deposit_address;
      return {
        ok,
        detail: `payment ${view.id} offered ${view.methods.join(", ")}; USDC on Base quoted at ${base?.amount_in?.formatted ?? "?"} USDC; "send exactly ${quote.send_exactly.formatted} USDC on Base to ${quote.deposit_address}"; the quote ended ${done.status} (${done.verification}); ${anyAccount} went from ${before} to ${after} (${after - before} of ${amount}); tx ${done.delivery_tx?.hash ?? "none"} by ${s.accounts.solver} emits ft_transfer of ${event?.amount ?? 0} from ${token}; payment ${paid.status}; payment.paid ${hook ? (hook.signed ? "arrived signed" : "arrived UNSIGNED") : "did not arrive"}; report row ${row ? `${row.method}, ${row.settlement_network}, ${row.origin_amount}` : "missing"}`,
      };
    });

    await step("send too little from another chain: 1Click returns the deposit, the payment is open again, a signed payment.deposit_returned arrives and no USDC moves on chain", async () => {
      const view = await anon.post<CheckoutView>(`/v1/links/public/${anyChain.link.slug}/payments`, {});
      const quote = await anon.post<IntentsQuote>(`/v1/checkout/${view.id}/intents/quotes`, { origin_asset: BASE_USDC, refund_to: BUYER_BASE_ADDRESS });
      const before = await chain.balanceOf(anyAccount);
      const short = BigInt(quote.min_amount_in.amount) / 2n;
      await anon.post(`/v1/checkout/${view.id}/intents/quotes/${quote.id}/simulate`, { amount: short.toString() });
      const done = await until(() => anon.get<IntentsQuote>(`/v1/checkout/${view.id}/intents/quotes/${quote.id}`), (q) => ["confirmed", "refunded", "failed"].includes(q.status));
      const after = await chain.balanceOf(anyAccount);
      const hook = await until(async () => hooks.hooks.find((h) => h.type === "payment.deposit_returned" && h.paymentId === view.id), (h) => !!h, 20_000);
      const payment = await anon.get<CheckoutView & { intents: { available: boolean } | null }>(`/v1/checkout/${view.id}`);
      const ok = done.status === "refunded" && done.refund_reason === "PARTIAL_DEPOSIT" && after === before && payment.status === "open" && !!payment.intents?.available && !!hook?.signed;
      return {
        ok,
        detail: `sent ${short} of the ${quote.min_amount_in.amount} needed: the quote ended ${done.status} (${done.refund_reason}), ${done.refunded?.formatted ?? "?"} USDC returned to ${done.refund_to}; ${anyAccount} unchanged at ${after}; payment ${payment.status}, still payable from another chain: ${payment.intents?.available}; payment.deposit_returned ${hook ? (hook.signed ? "arrived signed" : "arrived UNSIGNED") : "did not arrive"}`,
      };
    });
  } finally {
    // The receiver goes away with this pass, so its endpoint does too.
    if (endpointId) await admin.request("DELETE", `/v1/webhooks/${endpointId}`, undefined, scope).catch(() => undefined);
    await hooks.close();
  }
}
