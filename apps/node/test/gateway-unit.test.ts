/**
 * Gateway units on a temp SQLite file with a fake clock: the payment state machine (under, over, late payments, expiry,
 * processing), the NEAR checkout watcher against FakeChain, the webhook outbox, its retry schedule and signature, and
 * the SSRF guard.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { sha256Text, verifyWebhook, WEBHOOK_RETRY_SCHEDULE_SECONDS, type PaymentStatus } from "@payminto/protocol";
import { ChainClient } from "../src/chain.ts";
import { Database } from "../src/db/database.ts";
import { silentLogger } from "../src/logger.ts";
import { WalletRail } from "../src/gateway/checkout.ts";
import { LinkService } from "../src/gateway/links.ts";
import { MerchantService, type MerchantRow } from "../src/gateway/merchants.ts";
import type { ModelContext } from "../src/gateway/model.ts";
import { nextStatus, PaymentService } from "../src/gateway/payments.ts";
import { checkWebhookUrl, isPrivateAddress } from "../src/gateway/ssrf.ts";
import { PaymentWatcher } from "../src/gateway/watcher.ts";
import { WebhookService, type WebhookSender } from "../src/gateway/webhooks.ts";
import { startFakeChain, tempDir, testKey } from "./helpers.ts";

const tmp = tempDir("payminto-gateway-unit-");
afterAll(() => tmp.cleanup());

const PAYOUT = "shop.testnet";
const PAYER = "payer.testnet";
const TOKEN = "usdc.fake.testnet";
const ctx: ModelContext = { network: "near:sandbox", livemode: false, hub: "hub.payminto.testnet", token: TOKEN, checkoutBaseUrl: "http://localhost:3000" };

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
  const merchants = new MerchantService({ db, ctx, checkoutKey: testKey(90).publicKey });
  const { defaultMerchant } = merchants.seed({ platformName: "Test", feeRecipient: null, seedPayout: PAYOUT });
  const webhooks = new WebhookService({ db, ctx, log: silentLogger, allowPrivate: true, clock: () => clock.now, send });
  const payments = new PaymentService({ db, ctx, merchants, webhooks, clock: () => clock.now, ttlSec: 1800 });
  return { db, clock, sent, merchants, merchant: defaultMerchant as MerchantRow, webhooks, payments };
}

let seq = 0;

/** A confirmed wallet credit (a hub record), or with `pending` a voucher credit waiting for its batch. */
function credit(h: ReturnType<typeof harness>, paymentId: string, amount: bigint, status: "pending" | "confirmed" = "confirmed") {
  const id = sha256Text(`credit-${++seq}`);
  return status === "confirmed"
    ? h.payments.addCredit({ paymentId, method: "wallet", payer: PAYER, amount, txHash: null, checkoutId: id, recordedAtMs: 1n, status, mayBeLate: true })
    : h.payments.addCredit({ paymentId, method: "voucher", payer: PAYER, amount, txHash: null, callId: id, status, mayBeLate: false });
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

  it("partially paid, then underpaid at expiry, then paid by a late payment", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 1_000_000n, metadata: { order: "42" } });
    expect(p).toMatchObject({ status: "open", amount_due: "1000000", net_amount: "1000000", fee_total: "0", payout: PAYOUT });
    expect(p.checkout_id).toMatch(/^[0-9a-f]{64}$/);
    credit(h, p.id, 400_000n);
    expect(h.payments.row(p.id)).toMatchObject({ status: "partially_paid", amount_paid: "400000", payer: PAYER, method: "wallet", late: 0 });
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

  it("overpays in one payment and a replay of the same hub record is a no-op", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 500n });
    const c = credit(h, p.id, 900n);
    expect(c.inserted).toBe(true);
    const replay = h.payments.addCredit({ paymentId: p.id, amount: 900n, txHash: null, checkoutId: c.credit.checkout_id, status: "confirmed", mayBeLate: true, method: "wallet", payer: PAYER });
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

  it("holds expiry while an accepted voucher waits for its batch, and is paid once the batch confirms", async () => {
    const h = harness();
    const p = await h.payments.create(h.merchant, { amount: 100n, expires_in: 300 });
    const c = credit(h, p.id, 100n, "pending");
    expect(h.payments.row(p.id)!.status).toBe("processing");
    h.clock.now += 400;
    h.payments.expireDue();
    expect(h.payments.row(p.id)!.status).toBe("processing");
    h.payments.confirmCredit(c.credit.id, { txHash: "fake-tx-9", batchId: "ab".repeat(32) });
    expect(h.payments.row(p.id)).toMatchObject({ status: "paid", amount_paid: "100", late: 0 });
    expect(h.payments.credits(p.id)[0]).toMatchObject({ status: "confirmed", tx_hash: "fake-tx-9", batch_id: "ab".repeat(32) });
  });

  it("refuses line items that do not add up, and commits to the order with sha256", async () => {
    const h = harness();
    await expect(h.payments.create(h.merchant, { amount: 100n, line_items: [{ name: "a", quantity: 2, unit_amount: "40" }] })).rejects.toThrow(/add up/);
    const p = await h.payments.create(h.merchant, { amount: 100n, reference: "inv-1", line_items: [{ name: "a", quantity: 2, unit_amount: "50" }] });
    expect(p.order_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a wallet quote that would carry a fee, because the hub credits the merchant in full", async () => {
    const h = harness();
    h.db.run("UPDATE platform SET fee_recipient = 'fees.testnet'");
    h.merchants.setMethods(h.merchant.id, [{ method: "wallet", fee_bps: 100 }], false);
    expect(() => h.payments.quote(h.merchant, 10_000n, "wallet")).toThrow(/cannot carry a platform or method fee/);
    expect(h.payments.feasibleMethods(h.merchant, 10_000n)).toEqual(["voucher"]);
  });
});

describe("draft payments", () => {
  it("are invisible until promoted, announce themselves on promotion, and are collected after expiry", async () => {
    const h = harness();
    const d = await h.payments.create(h.merchant, { amount: 100n, method: "voucher", expires_in: 300 }, { draftKey: "k" });
    expect(h.payments.row(d.id)).toMatchObject({ draft: 1, status: "open" });
    expect(h.payments.list(h.merchant.id, { limit: 10 }).items).toEqual([]);
    expect(h.payments.list(h.merchant.id, { limit: 10 }).counts.open).toBe(0);
    expect(() => h.payments.get(h.merchant.id, d.id)).toThrow(/not found/);
    expect(eventsOf(h, d.id)).toEqual([]);
    // Money reaching a draft promotes it: payment.created comes first, then its state.
    const paid = await h.payments.create(h.merchant, { amount: 100n, method: "voucher", expires_in: 300 }, { draftKey: "k2" });
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

describe("NEAR checkout rail and watcher", () => {
  it("signs terms the hub accepts, and books the hub's record as a confirmed wallet credit exactly once", async () => {
    const h = harness();
    const fake = startFakeChain([PAYER]);
    const node = testKey(90);
    fake.setCheckoutKey(node.publicKey);
    const chain = new ChainClient(fake, node);
    const recorded: string[] = [];
    const watcher = new PaymentWatcher({ db: h.db, chain, payments: h.payments, log: silentLogger, onRecorded: (_p, merchant, payer) => recorded.push(`${merchant}<${payer}`) });
    const p = await h.payments.create(h.merchant, { amount: 2_500_000n, expires_in: 600 });
    const offer = new WalletRail(chain).offer(p)!;
    expect(offer.terms).toEqual({ payment_id: p.checkout_id, merchant: PAYOUT, amount: "2500000", expiry_ms: String(p.expires_unix * 1000) });
    expect(offer.checkout_key).toBe(node.publicKey);
    const call = offer.transaction.actions[0]!.params;
    expect(offer.transaction.receiverId).toBe(fake.token);
    expect(call.methodName).toBe("ft_transfer_call");
    const args = call.args as { receiver_id: string; amount: string; msg: string };
    expect(args.receiver_id).toBe(fake.hub);

    expect(await watcher.tick()).toBe(0);
    // The hub refuses tampered terms (returns the tokens) and records the signed ones.
    const tampered = JSON.parse(args.msg);
    tampered.payment.amount = "1";
    expect(fake.ftTransferCall(PAYER, 1n, JSON.stringify(tampered)).refunded).toBe(1n);
    expect(fake.ftTransferCall(PAYER, 2_500_000n, args.msg).refunded).toBe(0n);
    // The same terms cannot pay twice.
    expect(fake.ftTransferCall(PAYER, 2_500_000n, args.msg).refunded).toBe(2_500_000n);
    fake.solvency();

    expect(await watcher.tick()).toBe(1);
    expect(h.payments.row(p.id)).toMatchObject({ status: "paid", amount_paid: "2500000", payer: PAYER, method: "wallet" });
    expect(h.payments.credits(p.id)).toMatchObject([{ method: "wallet", status: "confirmed", checkout_id: p.checkout_id, recorded_at_ms: Number(fake.nowMs) }]);
    expect(recorded).toEqual([`${PAYOUT}<${PAYER}`]);
    expect(await fake.creditOf(PAYOUT)).toBe(2_500_000n);
    // Polled again (the payment stays watched for a while after it closes): nothing new is booked.
    expect(await watcher.tick()).toBe(0);
    expect(h.payments.credits(p.id)).toHaveLength(1);
    // Once paid, no wallet terms are offered any more.
    expect(new WalletRail(chain).offer(h.payments.row(p.id)!)).toBeNull();
  });

  it("books a wallet payment the hub recorded after the node's clock expired the payment, as late", async () => {
    const h = harness();
    const fake = startFakeChain([PAYER]);
    const node = testKey(90);
    fake.setCheckoutKey(node.publicKey);
    const chain = new ChainClient(fake, node);
    const watcher = new PaymentWatcher({ db: h.db, chain, payments: h.payments, log: silentLogger });
    // The node's clock is behind the hub's block time here, which a real deployment can see by a few seconds.
    h.clock.now = Math.floor(Number(fake.nowMs) / 1000);
    const p = await h.payments.create(h.merchant, { amount: 70_000n, expires_in: 300 });
    const msg = (new WalletRail(chain).offer(p)!.transaction.actions[0]!.params.args as { msg: string }).msg;
    h.clock.now += 301;
    h.payments.expireDue();
    expect(h.payments.row(p.id)!.status).toBe("expired");
    expect(fake.ftTransferCall(PAYER, 70_000n, msg).refunded).toBe(0n);
    expect(await watcher.tick()).toBe(1);
    expect(h.payments.row(p.id)).toMatchObject({ status: "paid", late: 1 });
  });
});

describe("minimum checkout amount", () => {
  it("refuses an open-amount link or a payer amount below the minimum, and signs no wallet terms below it", async () => {
    const h = harness();
    const links = new LinkService(h.db, ctx);
    expect(links.minimum).toBe(10_000n);
    expect(() => links.create(h.merchant.id, { title: "Tips", min_amount: 9_999n, max_amount: 50_000n })).toThrow(/AMOUNT_TOO_SMALL|at least 10000/);
    const open = links.create(h.merchant.id, { title: "Tips", min_amount: 10_000n, max_amount: 50_000n });
    expect(links.amountFor(open, 20_000n)).toBe(20_000n);
    // An operator can choose a higher floor; a link created under a lower one is held to the new floor when paid.
    const strict = new LinkService(h.db, { ...ctx, minCheckoutAmount: 15_000n });
    expect(() => strict.amountFor(open, 12_000n)).toThrow(/at least 15000/);

    const fake = startFakeChain([PAYER]);
    const node = testKey(90);
    fake.setCheckoutKey(node.publicKey);
    const chain = new ChainClient(fake, node);
    const below = await h.payments.create(h.merchant, { amount: 9_999n, expires_in: 300 });
    expect(new WalletRail(chain).offer(below)).toBeNull();
    expect(new WalletRail(chain, 1n).offer(below)).not.toBeNull();
    const at = await h.payments.create(h.merchant, { amount: 10_000n, expires_in: 300 });
    expect(new WalletRail(chain).offer(at)!.terms.amount).toBe("10000");
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

