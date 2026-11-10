#!/usr/bin/env node
/**
 * `pnpm live:capture <payment id>`: after the live run (docs/LIVE_RUN.md), saves what proves it as a dated fixture for
 * the README, while `pnpm local --intents live` is still running: the payment's any-chain quote as the node holds it
 * (with the signed 1Click quote), 1Click's status read now, and the NEAR mainnet delivery transaction read now.
 *
 * Only reads: the node's own API with the business's API key from this run's logins file, 1Click's public status route,
 * and a NEAR mainnet RPC. The file names no email, name or metadata; it lists every account and address it contains
 * so the product owner can approve them before committing it. Nothing is committed here.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DATA_DIR, REPO_ROOT } from "./config.ts";
import { DEFAULT_MAINNET_RPC, ONECLICK_LIVE_URL } from "./intents-live.ts";

export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptureError";
  }
}

type Tx = { hash: string; explorer_url: string | null };
type Quote = {
  id: string;
  mode: string;
  status: string;
  provider_status: string | null;
  deposit_address: string;
  refund_to: string;
  recipient: string;
  settlement_network: string;
  delivery_tx: Tx | null;
  quote_response?: unknown;
  [k: string]: unknown;
};
type Detail = { id: string; status: string; amount: string; amount_paid: string; method: string | null; paid_at: string | null; intents: { quotes: Quote[] } | null };

/** The business's API key, from the logins file pnpm local wrote for this run. */
export function apiKeyFromLogins(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("API key of"));
  const key = at >= 0 ? lines[at + 1]?.trim() : undefined;
  if (!key) throw new CaptureError("No API key in the logins file: is pnpm local --intents live running from this checkout?");
  return key;
}

const QUOTE_FIELDS = [
  "id",
  "mode",
  "label",
  "status",
  "provider_status",
  "origin",
  "deposit_address",
  "send_exactly",
  "min_amount_in",
  "amount_out",
  "fees",
  "slippage_bps",
  "refund_to",
  "recipient",
  "settlement_network",
  "deadline",
  "deposited",
  "delivered",
  "refunded",
  "refund_reason",
  "origin_txs",
  "destination_txs",
  "near_txs",
  "delivery_tx",
  "verification",
  "correlation_id",
  "signature_valid",
  "created_at",
  "updated_at",
] as const;

export async function captureLive(o: { paymentId: string; nodeUrl: string; apiKey: string; outDir: string; fetch?: typeof fetch; now?: Date; rpcUrl?: string }): Promise<{ path: string; accounts: string[] }> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? new Date();
  const json = async (what: string, url: string, init?: RequestInit) => {
    const r = await f(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new CaptureError(`${what} answered HTTP ${r.status}`);
    return (await r.json()) as unknown;
  };
  if (!/^pay_[a-z0-9]{24}$/.test(o.paymentId)) throw new CaptureError(`${o.paymentId} is not a payment id (pay_ and 24 characters)`);
  const p = (await json("the node", `${o.nodeUrl}/v1/payments/${o.paymentId}`, { headers: { authorization: `Bearer ${o.apiKey}` } })) as Detail;
  const quotes = p.intents?.quotes ?? [];
  if (!quotes.length) throw new CaptureError(`${o.paymentId} was not paid from another chain: it has no NEAR Intents quote`);
  const q = quotes.find((x) => x.status === "confirmed") ?? quotes.find((x) => x.delivery_tx) ?? quotes[quotes.length - 1]!;
  if (q.mode !== "live") throw new CaptureError(`${o.paymentId} was paid in simulated mode; this command captures the live run only`);
  if (!q.delivery_tx) throw new CaptureError(`${o.paymentId} has no delivery on NEAR yet (its quote is ${q.status}); wait for it, then run this again`);

  // Read now, from the sources themselves: 1Click's status, and the delivery on NEAR mainnet.
  const status = await json("1Click", `${ONECLICK_LIVE_URL}/v0/status?depositAddress=${encodeURIComponent(q.deposit_address)}`);
  const rpc = (await json("NEAR mainnet RPC", o.rpcUrl ?? DEFAULT_MAINNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "payminto-capture", method: "tx", params: { tx_hash: q.delivery_tx.hash, sender_account_id: q.recipient, wait_until: "NONE" } }),
  })) as { result?: { transaction?: { signer_id?: string } }; error?: unknown };
  if (!rpc.result) throw new CaptureError(`NEAR mainnet did not return ${q.delivery_tx.hash}: ${JSON.stringify(rpc.error).slice(0, 200)}`);

  const accounts = [...new Set([q.recipient, q.refund_to, q.deposit_address, rpc.result.transaction?.signer_id].filter((x): x is string => typeof x === "string" && x.length > 0))];
  const fixture = {
    note: "A real payment of the Payminto any-chain checkout on NEAR mainnet: paid from another chain through NEAR Intents (1Click), delivered as USDC to the business's own NEAR account. Captured with pnpm live:capture; see docs/LIVE_RUN.md.",
    captured_at: now.toISOString(),
    payment: { id: p.id, status: p.status, amount: p.amount, amount_paid: p.amount_paid, method: p.method, paid_at: p.paid_at, settlement_network: q.settlement_network },
    quote: Object.fromEntries(QUOTE_FIELDS.filter((k) => k in q).map((k) => [k, q[k]])),
    signed_quote: q.quote_response ?? null,
    oneclick_status: status,
    near_delivery_tx: rpc.result,
    accounts_and_addresses: accounts,
  };
  mkdirSync(o.outDir, { recursive: true });
  const path = join(o.outDir, `${now.toISOString().slice(0, 10)}-${p.id}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`);
  return { path, accounts };
}

async function main(argv: string[]): Promise<number> {
  const args = argv.filter((a) => a !== "--");
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const nodeUrl = (flag("--node") ?? "http://127.0.0.1:4210").replace(/\/+$/, "");
  const outDir = flag("--out") ?? join(REPO_ROOT, "docs", "live-run");
  const rpcUrl = flag("--rpc");
  const paymentId = args[0];
  if (!paymentId || args.length !== 1) {
    process.stderr.write("usage: pnpm live:capture <payment id> [--node <url>] [--out <dir>] [--rpc <NEAR mainnet RPC>]\n");
    return 2;
  }
  try {
    let logins: string;
    try {
      logins = readFileSync(join(DATA_DIR, "logins.txt"), "utf8");
    } catch {
      throw new CaptureError("No logins file in apps/local/data: run this while pnpm local --intents live is still running (stopping it deletes the run).");
    }
    const apiKey = apiKeyFromLogins(logins);
    const out = await captureLive({ paymentId, nodeUrl, apiKey, outDir, ...(rpcUrl ? { rpcUrl } : {}) });
    const say = (l: string) => process.stdout.write(`${l}\n`);
    say(`Saved ${out.path}`);
    say("It contains these accounts and addresses, and no email, name or order metadata:");
    for (const a of out.accounts) say(`  ${a}`);
    say("Open the file and read it. Commit it only if every one of them is a dev account or address you approve.");
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\nNothing was saved.\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
