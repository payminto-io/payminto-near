import { describe, expect, it } from "vitest";
import { anyProofSchema, denyListEntrySchema, platformFeesSchema } from "@/lib/schemas";

const A = "0x00000000000000000000000000000000000000a1";
const T = "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6";
const H = `0x${"ab".repeat(32)}`;

describe("node response shapes (GATEWAY.md section 15)", () => {
  it("maps the node's proof (credits with decoded logs) to what the receipt page checks", () => {
    const p = anyProofSchema.parse({
      payment_id: "pay_x",
      livemode: false,
      status: "paid",
      chain_id: 31337,
      confirm_tag: "latest",
      token: { address: T, symbol: "USDC", decimals: 6 },
      payout: A,
      amount_due: "25000000",
      amount_paid: "25000000",
      order_hash: H,
      paid_at: "2026-11-01T10:00:00.000Z",
      credits: [{ method: "wallet", amount: "25000000", payer: A, tx_hash: H, block_number: 12, transfers: [], authorization_used: [{ log_index: 1, authorizer: A, nonce: H }] }],
      attestation: { enabled: false, status: "disabled", reason: "off" },
    });
    expect(p).toMatchObject({ token: T, finality_tag: "latest", credit_amount: "25000000", authorization_nonce: H, eas_enabled: false, attestation: null, tx_hash: H });
  });
  it("folds per merchant and method fee rows", () => {
    const f = platformFeesSchema.parse({
      fee_recipient: A,
      totals: { platform_fee: "150", method_fee: "0", fee_total: "150" },
      items: [
        { merchant_id: "mer_a", merchant_name: "Acme", method: "wallet", payments: 2, volume: "1000", platform_fee: "100", method_fee: "0", fee_total: "100" },
        { merchant_id: "mer_a", merchant_name: "Acme", method: "deposit", payments: 1, volume: "500", platform_fee: "50", method_fee: "0", fee_total: "50" },
      ],
    });
    expect(f.total).toBe("150");
    expect(f.by_merchant).toEqual([{ merchant_id: "mer_a", name: "Acme", volume: "1500", fees: "150", payments: 3 }]);
    expect(f.by_method.map((m) => m.method)).toEqual(["wallet", "deposit"]);
  });
  it("reads the deny list's reason as the note", () => {
    expect(denyListEntrySchema.parse({ address: A, reason: "chargebacks", created_at: "2026-11-01T10:00:00.000Z" }).note).toBe("chargebacks");
  });
});
