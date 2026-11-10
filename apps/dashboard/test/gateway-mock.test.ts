import { describe, expect, it } from "vitest";
import { computeFees, isAccountId, sha256Text } from "@payminto/protocol";
import { MockCheckoutApi, MockGatewayApi, DEMO_PAYMENTS, applyMockCheckoutTx } from "@/lib/mock/gateway";
import { checkoutViewSchema, paymentDetailSchema } from "@/lib/schemas";
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
