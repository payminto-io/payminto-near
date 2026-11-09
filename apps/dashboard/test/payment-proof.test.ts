import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toBytes, type Address, type Hex } from "viem";
import { canonicalOrder, metadataHash, orderHash } from "@payminto/protocol";
import { ATTESTATION_FIELDS, expectedCheckIds, plainCheckTitle, proofEventsAbi, proofVerdict, runProofChecks, type ChainLog, type ChainReader } from "@/lib/payment-proof";
import type { OrderCommitment, PaymentProof } from "@/lib/schemas";

const TOKEN = getAddress("0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6");
const PAYER = getAddress("0x00000000000000000000000000000000000000a1");
const ROUTER = getAddress("0x00000000000000000000000000000000000000b2");
const PAYOUT = getAddress("0x00000000000000000000000000000000000000c3");
const TX = keccak256(toBytes("tx")) as Hex;
const NONCE = keccak256(toBytes("nonce")) as Hex;
const UID = keccak256(toBytes("uid")) as Hex;

const order: OrderCommitment = { payment_id: "pay_aaaaaaaaaaaaaaaaaaaaaaaa", amount: "25000000", token: TOKEN, payout: PAYOUT, reference: null, description: "Pro plan", line_items: [{ name: "Pro plan", quantity: 1, unit_amount: "25000000" }], metadata_hash: metadataHash({}) };
const served = { raw: canonicalOrder({ ...order, token: TOKEN, payout: PAYOUT, metadata_hash: metadataHash({}) }), order };
const HASH = orderHash({ ...order, token: TOKEN, payout: PAYOUT, metadata_hash: metadataHash({}) });

const proof: PaymentProof = {
  payment_id: order.payment_id,
  status: "paid",
  chain_id: 133,
  token: TOKEN,
  payout: PAYOUT,
  deposit_address: getAddress("0x00000000000000000000000000000000000000d4"),
  amount_due: "25000000",
  amount_paid: "25000000",
  credit_amount: "25000000",
  method: "wallet",
  payer: PAYER,
  tx_hash: TX,
  block_number: 100,
  finality_tag: "safe",
  order_hash: HASH,
  authorization_nonce: NONCE,
  eas_enabled: true,
  attestation: { uid: UID, schema: null, attester: null, eas: null },
  paid_at: null,
};

const transfer = (from: Address, to: Address, value: bigint): ChainLog => ({
  address: TOKEN,
  topics: encodeEventTopics({ abi: proofEventsAbi, eventName: "Transfer", args: { from, to } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

function reader(over: Partial<{ logs: ChainLog[]; safe: bigint; amount: bigint; revoked: bigint }> = {}): ChainReader {
  return {
    receipt: async () => ({
      status: "success",
      blockNumber: 100n,
      logs: over.logs ?? [
        { address: TOKEN, topics: encodeEventTopics({ abi: proofEventsAbi, eventName: "AuthorizationUsed", args: { authorizer: PAYER, nonce: NONCE } }) as Hex[], data: "0x" },
        transfer(PAYER, ROUTER, 25_000_000n),
        transfer(ROUTER, PAYOUT, 24_875_000n),
      ],
    }),
    blockAt: async () => over.safe ?? 120n,
    attestation: async (_eas, uid) => ({
      uid,
      attester: PAYER,
      revocationTime: over.revoked ?? 0n,
      data: encodeAbiParameters(ATTESTATION_FIELDS, [keccak256(toBytes("ref")), HASH, PAYER, PAYOUT, TOKEN, over.amount ?? 25_000_000n, TX]),
    }),
  };
}

describe("runProofChecks", () => {
  it("passes every check when the chain agrees with the node", async () => {
    const r = await runProofChecks(proof, served, reader());
    expect(r.checks.map((c) => [c.id, c.state])).toEqual([
      ["tx", "pass"],
      ["transfer", "pass"],
      ["auth", "pass"],
      ["final", "pass"],
      ["order", "pass"],
      ["eas", "pass"],
    ]);
    expect(r.events).toHaveLength(3);
  });
  it("fails when the payout got less than it is owed, or the block is not final yet", async () => {
    const r = await runProofChecks(proof, served, reader({ logs: [transfer(PAYER, PAYOUT, 1n)], safe: 99n }));
    const state = Object.fromEntries(r.checks.map((c) => [c.id, c.state]));
    expect(state.transfer).toBe("fail");
    expect(state.auth).toBe("fail");
    expect(state.final).toBe("fail");
  });
  it("catches a tampered order or attestation", async () => {
    const r = await runProofChecks(proof, { ...served, raw: served.raw.replace("Pro plan", "Something else") }, reader({ amount: 1n }));
    const state = Object.fromEntries(r.checks.map((c) => [c.id, c.state]));
    expect(state.order).toBe("fail");
    expect(state.eas).toBe("fail");
  });
  it("says so instead of failing when EAS is off", async () => {
    const r = await runProofChecks({ ...proof, eas_enabled: false, attestation: null }, served, reader());
    expect(r.checks.find((c) => c.id === "eas")?.state).toBe("skip");
  });
});

describe("proof page wording", () => {
  it("lists the wallet signature check only for signed payments", () => {
    expect(expectedCheckIds("wallet")).toEqual(["tx", "transfer", "auth", "final", "order", "eas"]);
    expect(expectedCheckIds("deposit")).toEqual(["tx", "transfer", "final", "order", "eas"]);
  });
  it("says each check in plain words", () => {
    const ctx = { merchant: "Acme Store", network: "HashKey Chain" };
    expect(plainCheckTitle("tx", ctx)).toBe("The payment is on HashKey Chain");
    expect(plainCheckTitle("transfer", ctx)).toBe("The money reached Acme Store");
    for (const id of expectedCheckIds("wallet")) expect(plainCheckTitle(id, ctx)).not.toMatch(/EAS|nonce|Transfer\(|\u2014/);
  });
  it("verifies only when every check that ran passed", () => {
    const c = (state: "pass" | "fail" | "skip") => ({ id: "x", label: "x", detail: "", state });
    expect(proofVerdict([c("pass"), c("pass"), c("skip")])).toEqual({ state: "verified", passed: 2, run: 2, skipped: 1, failed: 0 });
    expect(proofVerdict([c("pass"), c("fail")]).state).toBe("failed");
    expect(proofVerdict([c("skip")]).state).toBe("failed");
  });
});
