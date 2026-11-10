import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Text, type ChainPayment, type TxState, type TxTransfers } from "@payminto/protocol";
import { expectedCheckIds, plainCheckTitle, proofVerdict, runProofChecks, type DeliveryReader, type PaymentReader, type ProofCheck, type ServedOrder } from "@/lib/payment-proof";
import { anyProofSchema, type IntentsProof, type OrderCommitment, type PaymentProof } from "@/lib/schemas";

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

describe("runProofChecks for a payment paid from another chain (NEAR Intents)", () => {
  const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const DELIVERY = "4oUu8NQ5wVyZCjU2LhJ3PZm6yZ5v1nTzgk8h2KkS4m7Q";
  const intents: IntentsProof = {
    method: "oneclick",
    amount: "1500000",
    payer: "base:0x5f2b...554f",
    quote_id: "iq_aaaaaaaaaaaaaaaaaaaaaaaa",
    mode: "live",
    label: "Live - NEAR mainnet",
    settlement_network: "near:mainnet",
    token: USDC,
    recipient: "northwind-usdc.near",
    origin: { asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", chain: "base", chain_name: "Base", symbol: "USDC", decimals: 6 },
    deposited: { amount: "1503010", formatted: "1.503010", symbol: "USDC" },
    origin_txs: [{ hash: `0x${"1".repeat(64)}`, explorer_url: null }],
    delivery_tx: { hash: DELIVERY, explorer_url: `https://nearblocks.io/txns/${DELIVERY}` },
    delivery_senders: ["relay.near", "northwind-usdc.near"],
    oneclick: { status: "SUCCESS", correlation_id: "c-1", deposit_address: `0x${"2".repeat(40)}`, read_at: "2026-11-14T10:00:00.000Z" },
    verification: "rpc_checked",
    delivered_on_chain: "1500000",
    verified: true,
  };
  const any: PaymentProof = { ...proof, method: "oneclick", payer: intents.payer, payout: intents.recipient, token: USDC, tx_hash: DELIVERY, hub_payment_id: null, credit_amount: "1500000", amount_paid: "1500000", intents };
  const delivery = (answer: TxTransfers, asked: string[][] = []): DeliveryReader => ({
    rpcUrl: "https://rpc.mainnet.near.org",
    txTransfers: async (hash, senders) => (asked.push([hash, ...senders]), answer),
  });
  const paid: TxTransfers = { status: "final", sender: "relay.near", transfers: [{ token: USDC, from: "intents.near", to: "northwind-usdc.near", amount: 1_500_000n }] };

  it("reads the delivery on NEAR mainnet in this browser: final, and the USDC reached the business's account", async () => {
    const asked: string[][] = [];
    const r = await runProofChecks(any, served, reader(), delivery(paid, asked));
    expect(states(r)).toEqual({ delivery: "pass", delivered: "pass", order: "pass" });
    expect(asked).toEqual([[DELIVERY, "relay.near", "northwind-usdc.near"]]);
    expect(r.read).toEqual({ rpcUrl: "https://rpc.mainnet.near.org", hub: "hub.payminto.testnet", blockHeight: null });
    expect(proofVerdict(r.checks).state).toBe("verified");
    expect(expectedCheckIds(any)).toEqual(["delivery", "delivered", "order"]);
    expect(plainCheckTitle("delivered", { merchant: "Northwind", network: "NEAR mainnet" })).toBe("The USDC reached Northwind's NEAR account");
  });

  it("fails a delivery that pays less, pays someone else, or is another token, and one NEAR does not know", async () => {
    const short: TxTransfers = { ...paid, transfers: [{ ...paid.transfers[0]!, amount: 1_499_999n }] };
    expect(states(await runProofChecks(any, served, reader(), delivery(short))).delivered).toBe("fail");
    const other: TxTransfers = { ...paid, transfers: [{ ...paid.transfers[0]!, to: "attacker.near" }] };
    expect(states(await runProofChecks(any, served, reader(), delivery(other))).delivered).toBe("fail");
    const token: TxTransfers = { ...paid, transfers: [{ ...paid.transfers[0]!, token: "fake-usdc.near" }] };
    expect(states(await runProofChecks(any, served, reader(), delivery(token))).delivered).toBe("fail");
    expect(states(await runProofChecks(any, served, reader(), delivery({ status: "unknown" })))).toMatchObject({ delivery: "fail", delivered: "fail" });
  });

  it("skips the chain checks without a reader for the settlement network, and never uses the hub's record", async () => {
    const r = await runProofChecks(any, served, reader(), null);
    expect(states(r)).toEqual({ delivery: "skip", delivered: "skip", order: "pass" });
    expect(proofVerdict(r.checks).state).toBe("unverified");
  });

  it("reads the node's proof with a NEAR Intents credit", () => {
    const p = anyProofSchema.parse({
      payment_id: "pay_1",
      livemode: false,
      status: "paid",
      network: "near:sandbox",
      hub: "hub.test.near",
      token: { address: "usdc.test.near", symbol: "USDC", decimals: 6 },
      payout: "northwind.test.near",
      amount_due: "1500000",
      amount_paid: "1500000",
      order_hash: "ab".repeat(32),
      paid_at: "2026-11-14T10:00:00.000Z",
      checked_at: "2026-11-14T10:05:00.000Z",
      credits: [intents],
    });
    expect(p).toMatchObject({ method: "oneclick", payout: "northwind-usdc.near", token: USDC, tx_hash: DELIVERY, hub_payment_id: null, payer: "base:0x5f2b...554f", intents: { quote_id: intents.quote_id } });
  });
});
