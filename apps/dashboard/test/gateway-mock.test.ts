import { describe, expect, it } from "vitest";
import { keccak256, toBytes } from "viem";
import { computeFees } from "@payminto/protocol";
import { MockCheckoutApi, MockGatewayApi, DEMO_PAYMENTS } from "@/lib/mock/gateway";
import { checkoutViewSchema, paymentDetailSchema } from "@/lib/schemas";
import { runProofChecks } from "@/lib/payment-proof";

describe("mock gateway node", () => {
  const checkout = new MockCheckoutApi();
  const gateway = new MockGatewayApi();

  // The mock node sleeps per call like a real one, and this walks every demo payment: give it the same room as below.
  it("serves checkout views that parse with the wire schema", { timeout: 15_000 }, async () => {
    for (const id of Object.values(DEMO_PAYMENTS)) {
      const v = await checkout.checkout(id);
      expect(checkoutViewSchema.safeParse(v).success).toBe(true);
    }
  });
  it("keeps fees, order hashes and statuses consistent", { timeout: 15_000 }, async () => {
    const page = await gateway.payments({ limit: 100 });
    for (const p of page.items.slice(0, 6)) {
      const d = await gateway.payment(p.id);
      expect(paymentDetailSchema.safeParse(d).success).toBe(true);
      expect(BigInt(d.amount_due) - BigInt(d.fee_total)).toBe(BigInt(d.net_amount));
      const order = await checkout.order(d.id);
      expect(keccak256(toBytes(order.raw))).toBe(d.order_hash);
    }
    expect(page.items.length).toBeGreaterThan(40);
    expect(computeFees({ amount: 25_000_000n, plan: { platform_fee_bps: 50, platform_fee_fixed: 0n }, method: null }).platform_fee).toBe(125_000n);
  });
  it("re-quotes an open payment when the payer picks manual transfer", async () => {
    const v = await checkout.chooseMethod(DEMO_PAYMENTS.open, "deposit");
    expect(v.surcharge).toBe("100000");
    expect(BigInt(v.amount_due)).toBe(BigInt(v.amount) + 100_000n);
  });
  it("produces proofs the browser checks pass against the mock chain", async () => {
    const proof = await checkout.proof(DEMO_PAYMENTS.paid);
    const order = await checkout.order(DEMO_PAYMENTS.paid);
    const r = await runProofChecks(proof, order, checkout.chainReader());
    expect(r.checks.filter((c) => c.state !== "pass").map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
  }, 10_000);
});
