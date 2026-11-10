import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Text, type ChainPayment, type TxState } from "@payminto/protocol";
import { expectedCheckIds, plainCheckTitle, proofVerdict, runProofChecks, type PaymentReader, type ProofCheck, type ServedOrder } from "@/lib/payment-proof";
import type { OrderCommitment, PaymentProof } from "@/lib/schemas";

const check = (state: ProofCheck["state"]): ProofCheck => ({ id: "x", label: "x", state, detail: "" });

describe("proofVerdict", () => {
  it("is verified only when every check ran and passed", () => {
    expect(proofVerdict([check("pass"), check("pass")]).state).toBe("verified");
  });
  it("is unverified while chain checks are skipped, so a partial result never reads as verified", () => {
    expect(proofVerdict([check("pass"), check("skip")])).toMatchObject({ state: "unverified", passed: 1, skipped: 1 });
  });
  it("fails on any failed check, or when nothing ran", () => {
    expect(proofVerdict([check("pass"), check("fail")]).state).toBe("failed");
    expect(proofVerdict([check("skip")]).state).toBe("failed");
  });
});

describe("plain words", () => {
  it("lists the checks and names them for a reader", () => {
    expect(expectedCheckIds()).toEqual(["tx", "record", "transfer", "order"]);
    expect(plainCheckTitle("tx", { merchant: "Acme Store", network: "NEAR testnet" })).toBe("The payment is final on NEAR testnet");
  });
});

const HUB_ID = "ab".repeat(32);
const TX = "9vC3q2GdkKZ7v1pGQX5qRpX7n2bT8fW1sLmYhZc4eDuA";
const order: OrderCommitment = { payment_id: "pay_1", amount: "25000000", token: "usdc.testnet", payout: "acme-store.testnet", reference: null, description: "Pro plan", line_items: [{ name: "Pro plan", quantity: 1, unit_amount: "25000000" }], metadata_hash: "0".repeat(64) };
const served: ServedOrder = { raw: canonicalJson(order), order };
const proof: PaymentProof = {
  payment_id: "pay_1",
  status: "paid",
  network: "near:testnet",
  hub: "hub.payminto.testnet",
  token: "usdc.testnet",
  payout: "acme-store.testnet",
  amount_due: "25000000",
  amount_paid: "25000000",
  credit_amount: "25000000",
  method: "wallet",
  payer: "mira.testnet",
  tx_hash: TX,
  hub_payment_id: HUB_ID,
  order_hash: sha256Text(served.raw),
  paid_at: "2026-11-01T10:00:00.000Z",
};
const record: ChainPayment = { id: HUB_ID, merchant: "acme-store.testnet", amount: 25_000_000n, payer: "mira.testnet", at: 1n };
const reader = (over: { record?: ChainPayment | null; tx?: TxState } = {}): PaymentReader => ({
  rpcUrl: "https://rpc.testnet.near.org",
  hub: "hub.payminto.testnet",
  payments: async (ids) => ({ value: ids.map(() => (over.record === undefined ? record : over.record)), blockHeight: 219_402_871, blockHash: "block" }),
  // NEAR finds a transaction by its hash and its signer: the payer.
  txState: async (hash, sender) => (hash === TX && sender === "mira.testnet" ? (over.tx ?? { status: "final" }) : { status: "unknown" }),
});
const states = (r: { checks: ProofCheck[] }) => Object.fromEntries(r.checks.map((c) => [c.id, c.state]));

describe("runProofChecks on NEAR", () => {
  it("verifies a payment the hub recorded to the merchant, in a final transaction, with a matching order", async () => {
    const r = await runProofChecks(proof, served, reader());
    expect(states(r)).toEqual({ tx: "pass", record: "pass", transfer: "pass", order: "pass" });
    expect(r.read).toEqual({ rpcUrl: "https://rpc.testnet.near.org", hub: "hub.payminto.testnet", blockHeight: 219_402_871 });
    expect(states(await runProofChecks({ ...proof, payer: null }, served, reader())).tx).toBe("skip");
    expect(proofVerdict(r.checks).state).toBe("verified");
  });
  it("fails when the hub credited someone else or a different amount", async () => {
    expect(states(await runProofChecks(proof, served, reader({ record: { ...record, merchant: "attacker.testnet" } }))).transfer).toBe("fail");
    expect(states(await runProofChecks(proof, served, reader({ record: { ...record, amount: 1n } }))).transfer).toBe("fail");
  });
  it("fails when the hub has no record, or the transaction is not final", async () => {
    const r = await runProofChecks(proof, served, reader({ record: null, tx: { status: "failed", error: "NOT_PAYEE" } }));
    expect(states(r)).toMatchObject({ tx: "fail", record: "fail", transfer: "fail" });
    expect(proofVerdict(r.checks).state).toBe("failed");
  });
  it("fails an order that does not hash to the fingerprint or is not canonical", async () => {
    expect(states(await runProofChecks({ ...proof, order_hash: "cd".repeat(32) }, served, reader())).order).toBe("fail");
    expect(states(await runProofChecks(proof, { ...served, raw: JSON.stringify(order, null, 1) }, reader())).order).toBe("fail");
  });
  it("skips every chain check without a reader, so the receipt never reads as verified on the server's word", async () => {
    const r = await runProofChecks(proof, served, null);
    expect(states(r)).toEqual({ tx: "skip", record: "skip", transfer: "skip", order: "pass" });
    expect(proofVerdict(r.checks).state).toBe("unverified");
  });
});
