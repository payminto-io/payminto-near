/**
 * Reconciliation report (docs/GATEWAY.md section 16) end to end: anvil with the gateway contracts, the node in-process
 * on a temp SQLite file with workers off. A mix of wallet, deposit (with a method fee), partial deposit, voucher, open
 * and screened payments, a succeeded partial refund and a pending one, and one payment outside the range. Checks every
 * row and the totals, that the totals equal the token moves on chain and the clearing ledger's movements for the range,
 * the CSV (RFC 4180 quoting, formula injection, totals row), range validation, and who may read it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, maxUint256, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  checkoutTypedData,
  depositFactoryAbi,
  depositFactoryBytecode,
  payoutChangeMessage,
  paymentRouterAbi,
  paymentRouterBytecode,
  type CheckoutView,
  type ReconciliationReport,
  type ReconciliationRow,
} from "@payminto/protocol";
import { AgentClient, OwnerClient } from "@payminto/sdk";
import { startNode, type ClearingNode } from "../src/server.ts";
import { silentLogger } from "../src/logger.ts";
import type { GatewayConfig } from "../src/config.ts";
import type { Gateway } from "../src/gateway/index.ts";
import { chargedFees, csvCell, decimalOf, parseReportRange } from "../src/gateway/reports.ts";
import { ANVIL_KEYS, deployClearing, mint, startAnvil, tempDir, testConfig, type Anvil } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const USDC = 1_000_000n;
const DASH = "http://localhost:3000";
const PUBLIC_URL = "http://node.example";
const OWNER = privateKeyToAccount(ANVIL_KEYS[1]);
const PAYER = privateKeyToAccount(ANVIL_KEYS[2]);
const PAYER_2 = privateKeyToAccount(ANVIL_KEYS[3]);
const AGENT = privateKeyToAccount(ANVIL_KEYS[4]);
const PAYOUT_B = privateKeyToAccount(ANVIL_KEYS[5]);
const PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]);
const FEES = privateKeyToAccount(ANVIL_KEYS[7]).address;
const PW = "a-long-enough-passphrase-9";

let anvil: Anvil;
let node: ClearingNode;
let g: Gateway;
let hub: Address;
let token: Address;
let secret = "";
let merchantId = "";
const tmp = tempDir("payminto-reports-");

type Res<T = any> = { status: number; json: T; text: string; headers: Headers };
async function api<T = any>(method: string, path: string, body?: unknown, auth: string | null = ADMIN, headers: Record<string, string> = {}): Promise<Res<T>> {
  const res = await fetch(`${node.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null) as T, text, headers: res.headers };
}

const balanceOf = (who: Address) => anvil.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
async function sendToken(key: Hex, to: Address, amount: bigint): Promise<Hex> {
  const hash = await anvil.wallet(key).writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  await anvil.pub.waitForTransactionReceipt({ hash });
  return hash;
}
async function payWithWallet(paymentId: string, account = PAYER) {
  const view = (await api<CheckoutView>("GET", `/v1/checkout/${paymentId}`, undefined, null)).json;
  const signature = await account.signTypedData(checkoutTypedData(view.authorization!, account.address));
  return api("POST", `/v1/checkout/${paymentId}/authorize`, { payer: account.address, signature }, null);
}

/** RFC 4180 parser for the test: quoted cells with "" escapes and embedded commas and newlines, CRLF records. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(cell), (cell = "");
    else if (ch === "\r" && text[i + 1] === "\n") row.push(cell), rows.push(row), (row = []), (cell = ""), i++;
    else cell += ch;
  }
  return rows;
}

// The range: from two days ago to tomorrow; the "old" payment is moved 40 days back.
const DAY = 86_400_000;
const FROM = new Date(Date.now() - 2 * DAY).toISOString();
const TO = new Date(Date.now() + DAY).toISOString();
const range = `from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;

const ids: Record<"wallet" | "deposit" | "partial" | "voucher" | "open" | "screened" | "old", string> = {} as never;
let refundTx: Hex;
let succeededRefund = "";
let pendingRefund = "";
let payout0 = 0n;
let fees0 = 0n;

beforeAll(async () => {
  anvil = await startAnvil();
  ({ hub, token } = await deployClearing(anvil));
  const factory = await anvil.deploy(depositFactoryAbi as Abi, depositFactoryBytecode);
  const router = await anvil.deploy(paymentRouterAbi as Abi, paymentRouterBytecode);
  const gateway: GatewayConfig = {
    seedPayout: PAYOUT.address,
    platformName: "Acme Store",
    feeRecipient: FEES,
    paymentRouter: router,
    checkoutBaseUrl: DASH,
    depositFactory: factory,
    depositFactoryBlock: 0n,
    forwarderImplementation: null,
    checkoutTtlSec: 1800,
    webhookAllowPrivate: true,
    watchIntervalMs: 2000,
    screenMinPayerNonce: 0,
  };
  node = await startNode(testConfig({ rpcUrl: anvil.rpcUrl, hub, token, dbPath: tmp.dbPath, adminToken: ADMIN, publicUrl: PUBLIC_URL, gateway }), { logger: silentLogger, port: 0, workers: false });
  g = node.services.gateway!;
  for (const p of [PAYER, PAYER_2, AGENT]) await mint(anvil, token, p.address, 100n * USDC);
  const key = await api("POST", "/v1/api-keys", { name: "reports" });
  secret = key.json.secret;
  merchantId = key.json.merchant_id ?? (await api("GET", "/v1/merchant")).json.id;
  // A 1 % deposit fee the business bears, so method fees show up next to the 0.5 % platform fee.
  expect((await api("PUT", `/v1/merchants/${merchantId}/methods`, { methods: [{ method: "deposit", fee_bps: 100, bearer: "merchant" }] })).status).toBe(200);
  // A column another workstream adds (HSP): the report reads it when present and leaves the cell empty otherwise.
  const cols = g.db.all<{ name: string }>("PRAGMA table_info(payments)").map((c) => c.name);
  if (!cols.includes("hsp_flow_id")) g.db.run("ALTER TABLE payments ADD COLUMN hsp_flow_id TEXT");
  if (!cols.includes("hsp_status")) g.db.run("ALTER TABLE payments ADD COLUMN hsp_status TEXT");
  [payout0, fees0] = await Promise.all([balanceOf(PAYOUT.address), balanceOf(FEES)]);

  // Wallet, paid 2.00, then a 0.30 refund the payout sends as a plain transfer.
  ids.wallet = (await api("POST", "/v1/payments", { amount: "2000000", reference: "ord-1001", description: "Mug" }, secret)).json.id;
  expect((await payWithWallet(ids.wallet)).json.status).toBe("paid");
  await g.flusher.tick(); // the payout wallet has the net before it refunds
  const r1 = await api("POST", "/v1/refunds", { paymentId: ids.wallet, amount: "300000", reason: "damaged" }, secret);
  refundTx = await sendToken(ANVIL_KEYS[6], PAYER.address, 300_000n);
  expect((await api("POST", `/v1/refunds/${r1.json.id}/submit`, { txHash: refundTx }, secret)).json.status).toBe("succeeded");
  succeededRefund = r1.json.id;

  // Deposit, paid 3.00 with the method fee; a 0.10 refund stays pending.
  const dep = (await api("POST", "/v1/payments", { amount: "3000000", method: "deposit" }, secret)).json;
  ids.deposit = dep.id;
  await sendToken(ANVIL_KEYS[2], dep.deposit_address, 3_000_000n);
  // Partial deposit: 0.40 of 1.00, so fees are charged pro rata.
  const part = (await api("POST", "/v1/payments", { amount: "1000000", method: "deposit" }, secret)).json;
  ids.partial = part.id;
  await sendToken(ANVIL_KEYS[3], part.deposit_address, 400_000n);
  await g.watcher.tick();
  await g.flusher.tick();
  pendingRefund = (await api("POST", "/v1/refunds", { paymentId: ids.deposit, amount: "100000" }, secret)).json.id;

  // Two agent payments with vouchers (merchant net and platform fee); one is moved out of the range below.
  const owner = new OwnerClient({ nodeUrl: node.url, chainId: 31337, hub, account: OWNER, publicClient: anvil.pub, adminToken: ADMIN });
  const policy = { perCallCap: "2000000", dailyCap: "10000000", maxCallsPerMinute: 100, purpose: "buys reports" };
  const payees = [PAYOUT.address, FEES];
  const m = await owner.createMandate({ agent: AGENT.address, token, totalCap: 10n * USDC, validForSeconds: 86_400, payees, policy });
  await owner.submit({ ...m, policy, payees, label: "Report buyer" });
  const agent = new AgentClient({ nodeUrl: node.url, chainId: 31337, hub, account: AGENT, mandateId: m.mandateId });
  await agent.ensureAllowance(anvil.wallet(ANVIL_KEYS[4]), maxUint256, { token });
  for (const [k, amount] of [["voucher", "1000000"], ["old", "250000"]] as const) {
    ids[k] = (await api("POST", "/v1/payments", { amount, method: "voucher", description: `Agent ${k}` }, secret)).json.id;
    expect((await agent.fetch(`${node.url}/v1/pay/${ids[k]}`)).status).toBe(200);
  }
  expect((await api("POST", "/v1/settlements", {})).json.batchIds).toHaveLength(1);
  const old = new Date(Date.now() - 40 * DAY).toISOString();
  g.db.run("UPDATE payments SET created_at = ? WHERE id = ?", old, ids.old);
  for (const c of g.payments.credits(ids.old)) {
    g.db.run("UPDATE journals SET at = ? WHERE kind = 'call.accepted' AND ref = ?", old, c.call_id!);
    g.db.run("UPDATE ledger_entries SET at = ? WHERE journal_id IN (SELECT id FROM journals WHERE kind = 'call.accepted' AND ref = ?)", old, c.call_id!);
  }

  // Open, with text a spreadsheet would run as a formula and text that needs RFC 4180 quoting.
  ids.open = (await api("POST", "/v1/payments", { amount: "500000", reference: '=HYPERLINK("http://evil.example","x")', description: 'Mug, "large"\nblue' }, secret)).json.id;
  // Screened: the payer is on the business's blocked list.
  ids.screened = (await api("POST", "/v1/payments", { amount: "100000", reference: "@risky" }, secret)).json.id;
  await api("POST", "/v1/screening/deny-list", { address: PAYER_2.address, reason: "chargeback" }, secret);
  expect((await payWithWallet(ids.screened, PAYER_2)).json.error.code).toBe("SCREENING_REFUSED");
  g.db.run("UPDATE payments SET hsp_flow_id = 'flow_123', hsp_status = 'payment-finalized' WHERE id = ?", ids.open);
}, 180_000);

afterAll(async () => {
  await node?.stop();
  anvil?.stop();
  tmp.cleanup();
});

const report = async (q = range, auth: string | null = secret, headers: Record<string, string> = {}) => api<ReconciliationReport & { error: { code: string } }>("GET", `/v1/reports/reconciliation?${q}`, undefined, auth, headers);
const rowOf = (r: ReconciliationReport, id: string) => r.rows.find((x) => x.payment_id === id)!;

describe("reconciliation report", () => {
  it("has one row per payment created in the range, with fee lines, net, refunds and proofs", async () => {
    const res = await report();
    expect(res.status).toBe(200);
    const r = res.json;
    expect(r).toMatchObject({ object: "reconciliation_report", merchant_id: merchantId, business_name: "Acme Store", from: FROM, to: TO, chain_id: 31337, livemode: false, token: { address: token, decimals: 6 } });
    expect(r.rows.map((x) => x.payment_id)).toEqual([ids.wallet, ids.deposit, ids.partial, ids.voucher, ids.open, ids.screened]);

    const wallet = rowOf(r, ids.wallet);
    expect(wallet).toMatchObject({
      reference: "ord-1001",
      description: "Mug",
      status: "paid",
      method: "wallet",
      payer: PAYER.address,
      amount: "2.000000",
      amount_paid: "2.000000",
      platform_fee: "0.010000",
      method_fee: "0.000000",
      fee_total: "0.010000",
      net_amount: "1.990000",
      refunded: "0.300000",
      refunds_pending: "0.000000",
      net_after_refunds: "1.690000",
      proof_url: `${DASH}/receipt/${ids.wallet}`,
      hsp_flow_id: null,
      screening_rules: [],
    });
    expect(wallet.base_units).toMatchObject({ amount_paid: "2000000", net_amount: "1990000", refunded: "300000", net_after_refunds: "1690000" });
    expect(wallet.paid_at).not.toBeNull();
    expect(wallet.refunds).toEqual([expect.objectContaining({ id: succeededRefund, amount: "0.300000", status: "succeeded", tx_hash: refundTx.toLowerCase(), approval: "not_required" })]);
    expect(wallet.transactions).toEqual([expect.objectContaining({ method: "wallet", status: "confirmed", amount: "2.000000", tx_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/), explorer_url: null, receipt_proof_url: null })]);

    expect(rowOf(r, ids.deposit)).toMatchObject({ method: "deposit", status: "paid", platform_fee: "0.015000", method_fee: "0.030000", fee_total: "0.045000", net_amount: "2.955000", refunded: "0.000000", refunds_pending: "0.100000", net_after_refunds: "2.955000" });
    expect(rowOf(r, ids.deposit).refunds.map((f) => [f.id, f.status])).toEqual([[pendingRefund, "pending"]]);
    // 0.40 of 1.00: 0.006 of the 0.015 fee, split 1:2 between platform and method like the forwarder splits it.
    expect(rowOf(r, ids.partial)).toMatchObject({ status: "partially_paid", amount: "1.000000", amount_paid: "0.400000", fee_total: "0.006000", platform_fee: "0.002000", method_fee: "0.004000", net_amount: "0.394000", proof_url: null });

    const voucher = rowOf(r, ids.voucher);
    expect(voucher).toMatchObject({ method: "voucher", status: "paid", payer: AGENT.address, amount_paid: "1.000000", platform_fee: "0.005000", net_amount: "0.995000" });
    const batch = g.db.get<{ batch_id: Hex; tx_hash: Hex }>("SELECT batch_id, tx_hash FROM batches WHERE status = 'confirmed'")!;
    expect(voucher.batch_ids).toEqual([batch.batch_id]);
    expect(voucher.transactions.map((t) => [t.amount, t.tx_hash, t.batch_id])).toEqual([["0.995000", batch.tx_hash, batch.batch_id], ["0.005000", batch.tx_hash, batch.batch_id]]);
    for (const t of voucher.transactions) {
      expect(t.receipt_proof_url).toBe(`${PUBLIC_URL}/v1/receipts/${t.call_id}/proof`);
      // The same path on this node proves the charge.
      const proof = await api("GET", new URL(t.receipt_proof_url!).pathname, undefined, null);
      expect(proof.json).toMatchObject({ batchId: batch.batch_id, status: "settled" });
    }

    expect(rowOf(r, ids.open)).toMatchObject({ status: "open", amount_paid: "0.000000", fee_total: "0.000000", net_amount: "0.000000", hsp_flow_id: "flow_123", hsp_status: "payment-finalized", transactions: [], batch_ids: [] });
    expect(rowOf(r, ids.screened)).toMatchObject({ status: "open", screening_rules: ["PAYER_DENIED"] });
  });

  it("totals add up, equal the token moves on chain, and match the clearing ledger for the range", async () => {
    const r = (await report()).json;
    expect(r.totals).toMatchObject({ payments: 6, gross: "6.400000", platform_fee: "0.032000", method_fee: "0.034000", fees: "0.066000", net: "6.334000", refunds: "0.300000", refunds_pending: "0.100000", net_after_refunds: "6.034000" });
    const t = r.totals.base_units;
    const sum = (k: keyof ReconciliationRow["base_units"]) => r.rows.reduce((a, x) => a + BigInt(x.base_units[k]), 0n).toString();
    expect([t.gross, t.fees, t.net, t.refunds]).toEqual([sum("amount_paid"), sum("fee_total"), sum("net_amount"), sum("refunded")]);
    expect(BigInt(t.gross) - BigInt(t.fees)).toBe(BigInt(t.net));
    expect(BigInt(t.platform_fee) + BigInt(t.method_fee)).toBe(BigInt(t.fees));
    expect(BigInt(t.net) - BigInt(t.refunds)).toBe(BigInt(t.net_after_refunds));
    expect(r.counts).toEqual({ paid: 3, partially_paid: 1, open: 2 });
    expect(Object.keys(r.by_method).sort()).toEqual(["deposit", "voucher", "wallet"]);
    expect(r.by_method.deposit).toMatchObject({ payments: 2, gross: "3.400000", fees: "0.051000", net: "3.349000" });

    // On chain: the fee wallet got exactly the report's fees (plus the out-of-range payment's), and the payout the net
    // minus the refund it sent.
    await g.flusher.tick();
    const old = g.payments.row(ids.old)!;
    const oldFees = chargedFees(old);
    expect((await balanceOf(FEES)) - fees0).toBe(BigInt(t.fees) + oldFees.fee);
    expect((await balanceOf(PAYOUT.address)) - payout0).toBe(BigInt(t.net) + oldFees.net - BigInt(t.refunds));

    // The clearing ledger: the agent charges of the range are exactly its call.accepted movements in the range.
    expect(r.ledger).toMatchObject({ calls: 2, charges: "1.000000", ledger_accepted: "1.000000", matches: true });
    const tb = (await api("GET", "/v1/ledger/trial-balance")).json;
    expect(tb.balanced).toBe(true);
    const inRange = async (account: string) => {
      const entries = (await api<Array<{ kind: string; debit: string; createdAt: string }>>("GET", `/v1/ledger?account=${encodeURIComponent(account)}&limit=1000`)).json;
      return entries.filter((e) => e.kind === "call.accepted" && e.createdAt >= FROM && e.createdAt < TO).reduce((a, e) => a + BigInt(e.debit), 0n);
    };
    const payoutAcct = `provider:${PAYOUT.address}:receivable`;
    const feesAcct = `provider:${FEES}:receivable`;
    const vouchers = r.rows.filter((x) => x.method === "voucher");
    expect(await inRange(payoutAcct)).toBe(vouchers.reduce((a, x) => a + BigInt(x.base_units.net_amount), 0n));
    expect(await inRange(feesAcct)).toBe(vouchers.reduce((a, x) => a + BigInt(x.base_units.fee_total), 0n));
    // The trial balance over all time is the range plus the payment moved out of it, so the range alone is not it.
    const debitOf = (acct: string) => BigInt(tb.accounts.find((a: { account: string }) => a.account === acct).debit);
    expect(debitOf(payoutAcct) + debitOf(feesAcct)).toBe(BigInt(r.ledger.base_units.ledger_accepted) + BigInt(old.amount_paid));
    // Settled batches cleared every receivable the range accepted.
    expect(BigInt(tb.accounts.find((a: { account: string }) => a.account === payoutAcct).balance)).toBe(0n);
  });

  it("serves RFC 4180 CSV with neutralized formulas and a totals row", async () => {
    const res = await report(`${range}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="payminto-reconciliation-[a-z0-9-]+-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.text.endsWith("\r\n")).toBe(true);
    const rows = parseCsv(res.text);
    const head = rows[0]!;
    expect(head.slice(0, 12)).toEqual(["payment_id", "reference", "link_id", "description", "created_at", "paid_at", "status", "method", "payer", "currency", "amount", "surcharge"]);
    expect(rows.every((r) => r.length === head.length)).toBe(true);
    const col = (r: string[], name: string) => r[head.indexOf(name)];
    const byId = (id: string) => rows.find((r) => r[0] === id)!;
    expect(rows).toHaveLength(1 + 6 + 1);
    expect(col(byId(ids.wallet), "net_after_refunds")).toBe("1.690000");
    expect(col(byId(ids.wallet), "refund_ids")).toBe(succeededRefund);
    expect(col(byId(ids.deposit), "refund_ids")).toBe(pendingRefund);
    expect(col(byId(ids.open), "reference")).toBe(`'=HYPERLINK("http://evil.example","x")`);
    expect(col(byId(ids.open), "description")).toBe('Mug, "large"\nblue');
    expect(col(byId(ids.open), "hsp_status")).toBe("payment-finalized");
    expect(col(byId(ids.screened), "reference")).toBe("'@risky");
    expect(col(byId(ids.screened), "screening_rules")).toBe("PAYER_DENIED");
    expect(col(byId(ids.voucher), "receipt_proof_urls")!.split(" ")).toHaveLength(2);
    const total = rows[rows.length - 1]!;
    expect(total[0]).toBe("TOTAL");
    expect([col(total, "amount_paid"), col(total, "fee_total"), col(total, "net_amount"), col(total, "refunded"), col(total, "net_after_refunds")]).toEqual(["6.400000", "0.066000", "6.334000", "0.300000", "6.034000"]);
    expect(col(total, "amount")).toBe("");
  });

  it("validates the date range and format", async () => {
    for (const q of ["", `from=${encodeURIComponent(FROM)}`, "from=yesterday&to=today", "from=2026-10-01T10:00:00&to=2026-10-02", "from=2026-10-10&to=2026-10-01", "from=2025-01-01&to=2026-06-01", `${range}&format=xml`]) {
      const res = await report(q);
      expect(res.status, q).toBe(400);
      expect(res.json.error.code).toBe("VALIDATION_ERROR");
    }
    // A plain `to` date covers that whole day; a range with no payments has zero totals.
    const day = await report("from=2020-03-01&to=2020-03-31");
    expect(day.json).toMatchObject({ from: "2020-03-01T00:00:00.000Z", to: "2020-04-01T00:00:00.000Z", rows: [], totals: { payments: 0, gross: "0.000000", net: "0.000000" }, ledger: { calls: 0, matches: true } });
    expect(parseReportRange("2026-10-01", "2026-10-31")).toEqual({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" });
    expect(parseReportRange("2026-10-01T10:00:00+02:00", "2026-10-01T12:00:00Z")).toEqual({ from: "2026-10-01T08:00:00.000Z", to: "2026-10-01T12:00:00.000Z" });
  });

  it("is readable by the business's API key and Viewers, and by nobody outside the business", async () => {
    expect((await report(range, null)).status).toBe(401);
    expect((await report(range, "sk_test_nope")).status).toBe(401);
    // Another business, with its own key: it sees only its own (empty) report and cannot name the first business.
    const ts = Math.floor(Date.now() / 1000);
    const other = await api("POST", "/v1/merchants", {
      name: "Other Shop",
      payout: { payout: PAYOUT_B.address, timestamp: ts, signature: await PAYOUT_B.signMessage({ message: payoutChangeMessage("new", PAYOUT_B.address, ts, { chainId: 31337, hub }) }) },
    });
    expect(other.status).toBe(201);
    const otherKey = (await api("POST", "/v1/api-keys", { name: "other" }, ADMIN, { "Merchant-Id": other.json.id })).json.secret as string;
    expect((await report(range, otherKey)).json).toMatchObject({ merchant_id: other.json.id, rows: [] });
    expect((await report(range, otherKey, { "Merchant-Id": merchantId })).json.error.code).toBe("UNKNOWN_MERCHANT");
    expect((await report(`${range}&merchant_id=${merchantId}`, otherKey)).status).toBe(404);

    // A Viewer of the first business signs in and reads it; the business is named by header or by query.
    await node.services.auth.addMember(merchantId, { email: "viewer@acme.test", name: "Vera", password: PW }, "viewer", { type: "system", id: null });
    const login = await fetch(`${node.url}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: DASH }, body: JSON.stringify({ email: "viewer@acme.test", password: PW }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("pm_session="))!.split(";")[0]!;
    const asViewer = await report(range, null, { cookie });
    expect(asViewer.status).toBe(200);
    expect(asViewer.json.rows).toHaveLength(6);
    expect((await report(`${range}&format=csv&merchant_id=${merchantId}`, null, { cookie })).status).toBe(200);
    expect((await report(range, null, { cookie, "Merchant-Id": other.json.id })).json.error.code).toBe("UNKNOWN_MERCHANT");
  });
});

describe("report helpers", () => {
  it("formats amounts, splits charged fees, and quotes CSV cells", () => {
    expect(decimalOf(12_500_000n, 6)).toBe("12.500000");
    expect(decimalOf(5n, 6)).toBe("0.000005");
    expect(decimalOf(-5_000n, 6)).toBe("-0.005000");
    expect(decimalOf(7n, 0)).toBe("7");
    // Overpaid: capped at the quoted fee.
    expect(chargedFees({ amount_due: "1000000", amount_paid: "3000000", fee_total: "15000", platform_fee: "5000" })).toEqual({ fee: 15_000n, platform: 5_000n, method: 10_000n, net: 2_985_000n });
    expect(chargedFees({ amount_due: "1000000", amount_paid: "0", fee_total: "15000", platform_fee: "5000" }).fee).toBe(0n);
    expect(csvCell("-0.005000")).toBe('"-0.005000"');
    expect(csvCell("-cmd")).toBe(`"'-cmd"`);
    expect(csvCell("+1")).toBe(`"'+1"`);
    expect(csvCell("\tx")).toBe(`"'\tx"`);
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell(null)).toBe('""');
  });
});
