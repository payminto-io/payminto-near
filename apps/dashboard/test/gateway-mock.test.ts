import { describe, expect, it } from "vitest";
import { computeFees, isAccountId, sha256Text } from "@payminto/protocol";
import { MockCheckoutApi, MockGatewayApi, DEMO_PAYMENTS, applyMockCheckoutTx } from "@/lib/mock/gateway";
import { checkoutViewSchema, paymentDetailSchema, refundSchema } from "@/lib/schemas";
import { ApiError } from "@/lib/http";
import { manualRefundFromError } from "@/lib/intents";
import { proofVerdict, runProofChecks } from "@/lib/payment-proof";
import { checkoutTxOf } from "@/components/checkout/checkout";

describe("mock gateway node", () => {
  const checkout = new MockCheckoutApi();
  const gateway = new MockGatewayApi();

  // The mock node sleeps per call like a real one, and this walks every demo payment: give it the same room as below.
  it("serves NEAR-shaped checkout views that parse with the wire schema", { timeout: 15_000 }, async () => {
    for (const id of Object.values(DEMO_PAYMENTS)) {
      const v = await checkout.checkout(id);
      expect(checkoutViewSchema.safeParse(v).success).toBe(true);
      expect(v.network).toBe("near:testnet");
      expect(isAccountId(v.token.address)).toBe(true);
      expect(JSON.stringify(v)).not.toMatch(/0x[0-9a-f]{8}|chain_id|deposit_address/);
      if (v.payout) expect(isAccountId(v.payout)).toBe(true);
    }
  });
  it("keeps fees, order fingerprints and statuses consistent", { timeout: 15_000 }, async () => {
    const page = await gateway.payments({ limit: 100 });
    for (const p of page.items.slice(0, 6)) {
      const d = await gateway.payment(p.id);
      expect(paymentDetailSchema.safeParse(d).success).toBe(true);
      expect(BigInt(d.amount_due) - BigInt(d.fee_total)).toBe(BigInt(d.net_amount));
      const order = await checkout.order(d.id);
      expect(sha256Text(order.raw)).toBe(d.order_hash);
      if (d.payer) expect(isAccountId(d.payer)).toBe(true);
    }
    expect(page.items.length).toBeGreaterThan(40);
    expect(computeFees({ amount: 25_000_000n, plan: { platform_fee_bps: 50, platform_fee_fixed: 0n }, method: null }).platform_fee).toBe(125_000n);
  });
  it("hands the wallet node-signed terms once the payment is quoted, and pays it with one ft_transfer_call", { timeout: 15_000 }, async () => {
    const v = await checkout.chooseMethod(DEMO_PAYMENTS.soon, "wallet");
    const tx = checkoutTxOf(v);
    if (!tx || tx === "mismatch") throw new Error("expected a checkout transaction");
    expect(tx.receiverId).toBe(v.token.address);
    expect(tx.actions[0]!.params.methodName).toBe("ft_transfer_call");
    expect(tx.actions[0]!.params.args.receiver_id).toBe(v.hub);
    expect(JSON.parse(String(tx.actions[0]!.params.args.msg))).toMatchObject({ payment: { merchant: v.wallet!.terms.merchant, amount: v.amount_remaining } });
    expect(applyMockCheckoutTx(tx, "mira.testnet")).toEqual({ ok: true, used: BigInt(v.amount_remaining) });
    expect((await checkout.checkout(v.id)).status).toBe("processing");
  });
  it("returns the tokens when the terms do not match", async () => {
    const v = await checkout.chooseMethod(DEMO_PAYMENTS.open, "wallet");
    const forged = { ...v.wallet!, transaction: { ...v.wallet!.transaction, actions: [{ ...v.wallet!.transaction.actions[0]!, params: { ...v.wallet!.transaction.actions[0]!.params, args: { ...v.wallet!.transaction.actions[0]!.params.args, amount: "1" } } }] } };
    // The page refuses a server transaction that differs from the signed terms...
    expect(checkoutTxOf({ ...v, wallet: forged })).toBe("mismatch");
    // ...and the hub returns the tokens when the amount does not match.
    expect(applyMockCheckoutTx(forged.transaction, "mira.testnet")).toMatchObject({ ok: false, refunded: true });
  });
  it("verifies a paid payment against the demo hub, and skips every chain check without a reader", { timeout: 15_000 }, async () => {
    const proof = await checkout.proof(DEMO_PAYMENTS.paid);
    const order = await checkout.order(DEMO_PAYMENTS.paid);
    const source = checkout.reader();
    expect(source).toMatchObject({ demo: true });
    const verified = await runProofChecks(proof, order, source.reader);
    expect(verified.checks.map((c) => [c.id, c.state])).toEqual([["tx", "pass"], ["record", "pass"], ["transfer", "pass"], ["order", "pass"]]);
    expect(proofVerdict(verified.checks).state).toBe("verified");
    const unread = await runProofChecks(proof, order, null);
    expect(unread.checks.filter((c) => c.id !== "order").every((c) => c.state === "skip")).toBe(true);
    expect(proofVerdict(unread.checks).state).toBe("unverified");
  });
});

describe("mock gateway node: refunds of an any-chain payment (Q1)", () => {
  const gateway = new MockGatewayApi();
  it("answers 409 REFUND_MANUAL_REQUIRED with the buyer's details, then records a refund sent by hand", { timeout: 15_000 }, async () => {
    const page = await gateway.payments({ limit: 100 });
    const item = page.items.find((p) => p.method === "oneclick" && p.status === "paid");
    if (!item) throw new Error("expected the seeded any-chain payment");
    const err = await gateway.createRefund({ paymentId: item.id, amount: "1000000", reason: "Duplicate" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("REFUND_MANUAL_REQUIRED");
    expect(manualRefundFromError(err)).toMatchObject({ chain: "base", chain_name: "Base", symbol: "USDC", refund_to: "0x5f2b1c0e8a3d4b6f7a9c1e2d3b4a5f6e7d8c554f" });
    const hash = `0x${"cd".repeat(32)}`;
    const bad = await gateway.createRefund({ paymentId: item.id, amount: "1000000", manual: { chain: "base", tx_hash: "0x1" } }).catch((e: unknown) => e);
    expect((bad as ApiError).message).toMatch(/not a Base transaction hash/);
    const r = await gateway.createRefund({ paymentId: item.id, amount: "1000000", reason: "Duplicate", manual: { chain: "base", tx_hash: hash } });
    expect(refundSchema.parse(r)).toMatchObject({ status: "succeeded", tx_hash: null, manual: { chain: "base", chain_name: "Base", tx_hash: hash, explorer_url: `https://basescan.org/tx/${hash}` } });
    // The mock answers like the node: a manual refund's method and verification are both "manual".
    expect(r).toMatchObject({ method: "manual", verification: "manual" });
    const d = paymentDetailSchema.parse(await gateway.payment(item.id));
    expect(d.refund_status).toBe("partial");
    // A manual refund exactly as the node sends it (from a local stack run on 2026-11-13) parses.
    const fromNode = {
      merchant_id: "mer_fqusc75rrakjgmfmdcn4qrec", note: null, approval: "not_required", requested_by: "usr_4vwdb2mrdq36fm42rvdxldqj", approved_by: null, approved_at: null,
      id: "re_jnzj2wzfghkzky5f6j32nbo2", livemode: false, payment_id: "pay_fpd5rqc2avf3p2qikzfsq7xc", amount: "3000000", reason: "Requested by customer",
      to: "base:0x5f2b3a1e9c7d4b6a8f0e1d2c3b4a59687766554f", status: "succeeded", method: "manual", tx_hash: null, verification: "manual",
      manual: { chain: "base", chain_name: "Base", tx_hash: hash, explorer_url: `https://basescan.org/tx/${hash}`, recorded_by: "usr_4vwdb2mrdq36fm42rvdxldqj" },
      failure_reason: null, created_at: "2026-11-13T11:50:28.971Z", updated_at: "2026-11-13T11:50:28.971Z",
    };
    expect(refundSchema.parse(fromNode)).toMatchObject({ verification: "manual", manual: { recorded_by: "usr_4vwdb2mrdq36fm42rvdxldqj" } });
  });
});
