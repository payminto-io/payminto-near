/**
 * Gateway units on a temp SQLite file with a fake clock: the payment state machine (under, over, late payments, expiry,
 * processing), the reorg drop of an unconfirmed deposit credit, the webhook outbox, its retry schedule and signature,
 * and the SSRF guard. No chain: the chain-facing parts are fakes behind their seams.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { getAddress, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { verifyWebhook, WEBHOOK_RETRY_SCHEDULE_SECONDS, type PaymentStatus } from "@payminto/protocol";
import { Database } from "../src/db/database.ts";
import { silentLogger } from "../src/logger.ts";
import { MerchantService, type MerchantRow } from "../src/gateway/merchants.ts";
import type { ModelContext } from "../src/gateway/model.ts";
import { nextStatus, PaymentService } from "../src/gateway/payments.ts";
import { GatewayRails } from "../src/gateway/rails.ts";
import { checkWebhookUrl, isPrivateAddress } from "../src/gateway/ssrf.ts";
import { DepositWatcher, type TransferLog, type TransferSource } from "../src/gateway/watcher.ts";
import { WebhookService, type WebhookSender } from "../src/gateway/webhooks.ts";
import { ANVIL_KEYS, tempDir } from "./helpers.ts";

const tmp = tempDir("payminto-gateway-unit-");
afterAll(() => tmp.cleanup());

const PAYOUT = privateKeyToAccount(ANVIL_KEYS[6]).address;
const PAYER = privateKeyToAccount(ANVIL_KEYS[2]).address;
const TOKEN = getAddress("0x00000000000000000000000000000000000000aa");
const FACTORY = getAddress("0x00000000000000000000000000000000000000bb");
const IMPL = getAddress("0x00000000000000000000000000000000000000cc");
const ROUTER = getAddress("0x00000000000000000000000000000000000000dd");
const ctx: ModelContext = { chainId: 31337, livemode: false, token: TOKEN, checkoutBaseUrl: "http://localhost:3000" };

type Sent = { url: string; body: string; headers: Record<string, string> };

let n = 0;
function harness(o: { send?: WebhookSender } = {}) {
  const db = new Database(join(tmp.dir, `unit-${++n}.test.db`));
  db.migrate();
  const clock = { now: 1_800_000_000 };
  const sent: Sent[] = [];
  const send: WebhookSender =
    o.send ??
    (async (url, body, headers) => {
      sent.push({ url: url.toString(), body, headers });
      return { status: 200, body: "ok" };
    });
  const merchants = new MerchantService({ db, ctx, factory: FACTORY, router: ROUTER });
  const { defaultMerchant } = merchants.seed({ platformName: "Test", feeRecipient: null, seedPayout: PAYOUT });
  const webhooks = new WebhookService({ db, ctx, log: silentLogger, allowPrivate: true, clock: () => clock.now, send });
  const rails = new GatewayRails({ chainId: 31337, token: TOKEN, factory: FACTORY, implementation: IMPL, router: ROUTER });
  const payments = new PaymentService({ db, ctx, rails, merchants, webhooks, head: async () => 100n, clock: () => clock.now, ttlSec: 1800, attest: false });
  return { db, clock, sent, merchants, merchant: defaultMerchant as MerchantRow, webhooks, payments };
}

let txn = 0;
const tx = (): Hex => keccak256(toBytes(`tx-${++txn}`));

function credit(h: ReturnType<typeof harness>, paymentId: string, amount: bigint, status: "pending" | "confirmed" = "confirmed", blockNumber = 50) {
  return h.payments.addCredit({
    paymentId,
    method: "deposit",
    payer: PAYER,
    amount,
    txHash: tx(),
    logIndex: 0,
    blockNumber,
    blockHash: keccak256(toBytes(`block-${blockNumber}`)),
    status,
    mayBeLate: true,
  });
}

const eventsOf = (h: ReturnType<typeof harness>, paymentId: string) =>
  h.db.all<{ type: string }>("SELECT type FROM gateway_events WHERE payment_id = ? ORDER BY seq", paymentId).map((e) => e.type);

describe("payment state machine", () => {
  it("picks the state from the confirmed total, pending credits and expiry", () => {
    const cases: Array<[PaymentStatus, bigint, number, boolean, PaymentStatus]> = [
      ["open", 0n, 0, false, "open"],
      ["open", 0n, 1, false, "processing"],
      ["open", 40n, 0, false, "partially_paid"],
      ["partially_paid", 40n, 1, false, "processing"],
      ["open", 100n, 0, false, "paid"],
      ["open", 150n, 0, false, "overpaid"],
      ["partially_paid", 40n, 0, true, "underpaid"],
      ["open", 0n, 0, true, "expired"],
      ["processing", 0n, 1, true, "processing"],
      ["expired", 40n, 0, true, "underpaid"],
      ["expired", 100n, 0, true, "paid"],
      ["canceled", 0n, 0, false, "canceled"],
      ["canceled", 120n, 0, false, "overpaid"],
      ["underpaid", 60n, 0, true, "underpaid"],
      ["underpaid", 100n, 0, true, "paid"],
      ["paid", 160n, 0, true, "overpaid"],
    ];
    for (const [status, confirmed, pending, expired, want] of cases) {
      expect(nextStatus({ status, due: 100n, confirmed, pending, expired }), `${status} ${confirmed} ${pending} ${expired}`).toBe(want);
    }
  });

  it("partially paid, then underpaid at expiry, then paid by a late deposit", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 1_000_000n, metadata: { order: "42" } });
    expect(p).toMatchObject({ status: "open", amount_due: "1000000", net_amount: "1000000", fee_total: "0" });
    credit(h, p.id, 400_000n);
    expect(h.payments.row(p.id)).toMatchObject({ status: "partially_paid", amount_paid: "400000", payer: PAYER, method: "deposit", late: 0 });
    h.clock.now += 1801;
    expect(h.payments.expireDue()).toBe(1);
    expect(h.payments.row(p.id)).toMatchObject({ status: "underpaid", amount_paid: "400000" });
    credit(h, p.id, 600_000n);
    const after = h.payments.row(p.id)!;
    expect(after).toMatchObject({ status: "paid", amount_paid: "1000000", late: 1 });
    expect(after.paid_at).not.toBeNull();
    expect(eventsOf(h, p.id)).toEqual(["payment.created", "payment.partially_paid", "payment.underpaid", "payment.paid"]);
    // A paid payment that gets more money is overpaid.
    credit(h, p.id, 1n);
    expect(h.payments.row(p.id)!.status).toBe("overpaid");
  });

  it("overpays in one deposit and replays are no-ops", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 500n });
    const c = credit(h, p.id, 900n);
    expect(c.inserted).toBe(true);
    const replay = h.payments.addCredit({ ...c.credit, paymentId: p.id, amount: 900n, txHash: c.credit.tx_hash, logIndex: c.credit.log_index, blockNumber: 50, blockHash: c.credit.block_hash, status: "confirmed", mayBeLate: true, method: "deposit", payer: PAYER });
    expect(replay.inserted).toBe(false);
    expect(h.payments.row(p.id)).toMatchObject({ status: "overpaid", amount_paid: "900" });
    expect(h.payments.credits(p.id)).toHaveLength(1);
  });

  it("expired with nothing, then a late deposit; canceled, then a late deposit", async () => {
    const h = harness();
    const a = await h.payments.create(h.merchant, { amount: 100n, expires_in: 300 });
    h.clock.now += 301;
    h.payments.expireDue();
    expect(h.payments.row(a.id)!.status).toBe("expired");
    credit(h, a.id, 100n);
    expect(h.payments.row(a.id)).toMatchObject({ status: "paid", late: 1 });

    const b = await h.payments.create(h.merchant, { amount: 100n });
    h.payments.cancel(h.merchant.id, b.id);
    expect(() => h.payments.cancel(h.merchant.id, b.id)).toThrow(/only open payments/);
    credit(h, b.id, 30n);
    expect(h.payments.row(b.id)).toMatchObject({ status: "underpaid", late: 1, amount_paid: "30" });
    expect(eventsOf(h, b.id)).toEqual(["payment.created", "payment.canceled", "payment.underpaid"]);
  });

  it("holds expiry while money is pending, and expires once the pending credit is dropped", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 100n, expires_in: 300 });
    const c = credit(h, p.id, 100n, "pending");
    expect(h.payments.row(p.id)!.status).toBe("processing");
    h.clock.now += 400;
    h.payments.expireDue();
    expect(h.payments.row(p.id)!.status).toBe("processing");
    h.payments.dropCredit(c.credit.id);
    expect(h.payments.row(p.id)).toMatchObject({ status: "expired", amount_paid: "0", payer: null });
  });

  it("refuses line items that do not add up, and commits to the order", async () => {
    const h = harness();
    await expect(h.payments.create(h.merchant, { amount: 100n, line_items: [{ name: "a", quantity: 2, unit_amount: "40" }] })).rejects.toThrow(/add up/);
    const p = await h.payments.create(h.merchant, { amount: 100n, reference: "inv-1", line_items: [{ name: "a", quantity: 2, unit_amount: "50" }] });
    expect(p.order_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("draft payments", () => {
  it("are invisible until promoted, announce themselves on promotion, and are collected after expiry", async () => {
    const h = harness();
    const d = await h.payments.create(h.merchant, { amount: 100n, method: "x402", expires_in: 300 }, { draftKey: "k" });
    expect(h.payments.row(d.id)).toMatchObject({ draft: 1, status: "open" });
    expect(h.payments.list(h.merchant.id, { limit: 10 }).items).toEqual([]);
    expect(h.payments.list(h.merchant.id, { limit: 10 }).counts.open).toBe(0);
    expect(() => h.payments.get(h.merchant.id, d.id)).toThrow(/not found/);
    expect(eventsOf(h, d.id)).toEqual([]);
    // Money reaching a draft promotes it: payment.created comes first, then its state.
    const paid = await h.payments.create(h.merchant, { amount: 100n, method: "x402", expires_in: 300 }, { draftKey: "k2" });
    credit(h, paid.id, 100n);
    expect(h.payments.row(paid.id)).toMatchObject({ draft: 0, status: "paid" });
    expect(eventsOf(h, paid.id)).toEqual(["payment.created", "payment.paid"]);
    expect(h.payments.list(h.merchant.id, { limit: 10 }).items.map((p) => p.id)).toEqual([paid.id]);
    h.clock.now += 301;
    h.payments.expireDue();
    expect(h.payments.row(d.id)).toBeUndefined();
    expect(h.payments.row(paid.id)!.status).toBe("paid");
  });
});

describe("deposit watcher reorg handling", () => {
  it("drops an unconfirmed credit whose block left the chain, and credits it again where it lands", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 100n });
    const log = (block: bigint, hashTag: string): TransferLog => ({
      txHash: keccak256(toBytes("deposit-tx")),
      logIndex: 3,
      blockNumber: block,
      blockHash: keccak256(toBytes(hashTag)),
      from: PAYER,
      to: p.deposit_address,
      value: 100n,
    });
    const script: Array<{ latest: bigint; final: bigint; logs: TransferLog[] }> = [
      { latest: 10n, final: 5n, logs: [log(8n, "8a")] }, // seen in the unconfirmed tail
      { latest: 9n, final: 5n, logs: [] }, // reorg: block 8 replaced, transfer gone
      { latest: 12n, final: 12n, logs: [log(11n, "11b")] }, // re-included and now final
    ];
    let step = 0;
    const source: TransferSource = {
      heads: async () => script[step]!,
      transfersTo: async (to, from, toBlock) => script[step]!.logs.filter((l) => to.includes(l.to) && l.blockNumber >= from && l.blockNumber <= toBlock),
    };
    const w = new DepositWatcher({ db: h.db, payments: h.payments, source, startBlock: 1n, log: silentLogger });
    await w.tick();
    expect(h.payments.row(p.id)!.status).toBe("processing");
    expect(h.payments.credits(p.id)).toMatchObject([{ status: "pending", block_number: 8 }]);
    expect(w.cursor()).toBe(5n);
    step = 1;
    await w.tick();
    expect(h.payments.credits(p.id)).toEqual([]);
    expect(h.payments.row(p.id)).toMatchObject({ status: "open", amount_paid: "0" });
    step = 2;
    await w.tick();
    expect(h.payments.credits(p.id)).toMatchObject([{ status: "confirmed", block_number: 11, log_index: 3 }]);
    expect(h.payments.row(p.id)).toMatchObject({ status: "paid", flush_status: "pending" });
    expect(w.cursor()).toBe(12n);
  });
});

describe("webhooks", () => {
  let h: ReturnType<typeof harness>;
  let attempts: number[];
  beforeEach(() => {
    attempts = [];
    h = harness({
      send: async () => {
        attempts.push(h.clock.now);
        return { status: 500, body: "x".repeat(5000) };
      },
    });
  });

  it("retries on the schedule with one row per attempt, then fails", async () => {
    const e = await h.webhooks.create(h.merchant.id, { url: "http://127.0.0.1:9/hook", events: ["payment.created"] });
    expect(e.secret).toMatch(/^whsec_/);
    const t0 = h.clock.now;
    await h.payments.create(h.merchant, { amount: 1n });
    const expected = WEBHOOK_RETRY_SCHEDULE_SECONDS.reduce<number[]>((acc, d, i) => [...acc, (i === 0 ? t0 : acc[i - 1]!) + d], []);
    for (const at of expected) {
      h.clock.now = at - 1;
      await h.webhooks.tick();
      h.clock.now = at;
      await h.webhooks.tick();
    }
    h.clock.now += 10 * 86_400;
    await h.webhooks.tick();
    expect(attempts).toEqual(expected);
    const rows = h.db.all<{ attempt: number; status: string; response_status: number; response_body: string; next_attempt_at: string | null }>(
      "SELECT attempt, status, response_status, response_body, next_attempt_at FROM webhook_deliveries ORDER BY seq",
    );
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.every((r) => r.status === "failed" && r.response_status === 500 && r.response_body.length === 2048)).toBe(true);
    expect(rows.slice(0, 6).every((r) => r.next_attempt_at !== null)).toBe(true);
    expect(rows[6]!.next_attempt_at).toBeNull();
  });

  it("signs the exact body with Payminto-Signature, verifiable with verifyWebhook", async () => {
    const g = harness();
    const e = await g.webhooks.create(g.merchant.id, { url: "http://127.0.0.1:9/hook", events: ["*"] });
    const p = await g.payments.create(g.merchant, { amount: 7n, customer_email: "a@b.example" });
    await g.webhooks.tick();
    expect(g.sent).toHaveLength(1);
    const [s] = g.sent;
    expect(await verifyWebhook(s!.body, s!.headers["Payminto-Signature"], e.secret!, { now: g.clock.now })).toBe(true);
    expect(await verifyWebhook(s!.body + " ", s!.headers["Payminto-Signature"], e.secret!, { now: g.clock.now })).toBe(false);
    const body = JSON.parse(s!.body);
    expect(body).toMatchObject({ type: "payment.created", livemode: false, data: { object: { id: p.id, amount_due: "7", fee_total: "0" } } });
    expect(s!.headers["Payminto-Event-Type"]).toBe("payment.created");
    expect(s!.headers["Payminto-Event-Id"]).toBe(body.id);
    expect(g.db.get<{ status: string }>("SELECT status FROM webhook_deliveries")!.status).toBe("succeeded");
  });

  it("disables an endpoint after 3 days of nothing but failures, and PATCH active re-enables it", async () => {
    const e = await h.webhooks.create(h.merchant.id, { url: "http://127.0.0.1:9/hook", events: ["*"] });
    const t0 = h.clock.now;
    await h.payments.create(h.merchant, { amount: 1n });
    for (const step of [0, 60, 300, 1800, 7200, 21_600, 86_400, 3 * 86_400]) {
      h.clock.now = t0 + step;
      await h.payments.create(h.merchant, { amount: 1n });
      await h.webhooks.tick();
    }
    const row = h.webhooks.endpoint(h.merchant.id, e.id!);
    const json = h.webhooks.json(row);
    expect(json).toMatchObject({ active: false, success_rate_7d: 0 });
    expect(json.disabled_reason).toMatch(/disabled after 3 days/);
    expect(json.last_delivery_at).not.toBeNull();
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'pending'")!.n).toBe(0);
    // Disabled endpoints get nothing new, and the disabling itself is not an event.
    const before = attempts.length;
    await h.payments.create(h.merchant, { amount: 1n });
    await h.webhooks.tick();
    expect(attempts.length).toBe(before);
    expect(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM gateway_events WHERE type NOT LIKE 'payment.%'")!.n).toBe(0);
    const back = await h.webhooks.update(h.merchant.id, e.id!, { active: true });
    expect(back).toMatchObject({ active: true, disabled_reason: null });
  });

  it("validates subscriptions and endpoint URLs", async () => {
    await expect(h.webhooks.create(h.merchant.id, { url: "http://127.0.0.1/x", events: ["payment.nope"] })).rejects.toThrow(/unknown event types/);
    await expect(h.webhooks.create(h.merchant.id, { url: "ftp://example.com/x", events: ["*"] })).rejects.toThrow(/http or https/);
  });
});

describe("SSRF guard", () => {
  it("classifies private, loopback, link-local and mapped addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
    // IPv4-compatible (::/96) and NAT64 (64:ff9b::/96, local-use 64:ff9b:1::/48) are refused whatever IPv4 they embed.
    for (const ip of ["::127.0.0.1", "::7f00:1", "::8.8.8.8", "64:ff9b::8.8.8.8", "64:ff9b::808:808", "64:ff9b:1::1", "64:ff9b:1:ffff::a00:1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("on live chains needs https to public addresses only", async () => {
    const strict = { allowPrivate: false };
    const publicDns = async () => ["93.184.216.34"];
    const privateDns = async () => ["93.184.216.34", "10.0.0.7"];
    await expect(checkWebhookUrl("http://hooks.example.com/x", strict, publicDns)).rejects.toThrow(/https/);
    for (const u of ["https://127.0.0.1/x", "https://[::1]/x", "https://169.254.169.254/latest", "https://10.0.0.1/x", "https://localhost/x", "https://[::ffff:127.0.0.1]/x"]) {
      await expect(checkWebhookUrl(u, strict, publicDns), u).rejects.toThrow();
    }
    await expect(checkWebhookUrl("https://rebind.example.com/x", strict, privateDns)).rejects.toThrow(/private/);
    await expect(checkWebhookUrl("https://user:pw@hooks.example.com/x", strict, publicDns)).rejects.toThrow(/credentials/);
    expect((await checkWebhookUrl("https://hooks.example.com/x", strict, publicDns)).hostname).toBe("hooks.example.com");
    expect((await checkWebhookUrl("https://1.1.1.1/x", strict, publicDns)).hostname).toBe("1.1.1.1");
    // Locally (31337) http://localhost is allowed.
    expect((await checkWebhookUrl("http://localhost:4000/x", { allowPrivate: true })).port).toBe("4000");
  });
});

