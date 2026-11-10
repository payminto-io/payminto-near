import { describe, expect, it } from "vitest";
import {
  CHECKOUT_METHODS,
  INTENTS_EVENT_TYPES,
  INTENTS_LABELS,
  isId,
  keypairFromSeed,
  nep413Digest,
  newIntentsQuoteId,
  PAYMENT_METHODS,
  payoutProofRequest,
  REPORT_CSV_COLUMNS,
  sha256Text,
  signDigest,
  intentsPayoutMessage,
  intentsPayoutProofRequest,
  verifyIntentsPayoutSignature,
  verifyPayoutProofSignature,
  WEBHOOK_EVENT_TYPES,
} from "../src/index.ts";

describe("any-chain checkout names", () => {
  it("keeps the core methods and events as they were and adds the rail beside them", () => {
    expect(PAYMENT_METHODS).toEqual(["wallet", "voucher"]);
    expect(CHECKOUT_METHODS).toEqual(["wallet", "voucher", "oneclick"]);
    expect(INTENTS_EVENT_TYPES).toEqual(["payment.deposit_returned", "payment.deposit_failed"]);
    for (const e of INTENTS_EVENT_TYPES) expect(WEBHOOK_EVENT_TYPES).not.toContain(e);
    expect(INTENTS_LABELS).toEqual({ live: "Live - NEAR mainnet", simulated: "Simulated - no real money" });
    expect(isId("intentsQuote", newIntentsQuoteId())).toBe(true);
    expect(newIntentsQuoteId()).toMatch(/^iq_[a-z2-7]{24}$/);
  });

  it("appends the settlement and origin columns at the end of the reconciliation CSV", () => {
    expect(REPORT_CSV_COLUMNS.slice(-4)).toEqual(["settlement_network", "origin_asset", "origin_amount", "deposit_address"]);
    expect(REPORT_CSV_COLUMNS.indexOf("screening_rules")).toBe(REPORT_CSV_COLUMNS.length - 5);
  });
});

describe("any-chain payout proofs (NEP-413)", () => {
  const key = keypairFromSeed(new Uint8Array(32).fill(7));
  const scope = { settlementNetwork: "near:mainnet", hub: "hub.payminto.testnet" };
  const sign = (merchantId: string, account: string, timestamp: number) =>
    Buffer.from(signDigest(key.secretKey, nep413Digest(intentsPayoutProofRequest(merchantId, account, timestamp, scope))), "hex").toString("base64");

  it("binds the message to the merchant, the account, the time, the settlement network and the node's hub", () => {
    const message = "Payminto intents payout mer_x shop.near 1800000000 network near:mainnet hub hub.payminto.testnet";
    expect(intentsPayoutMessage("mer_x", "shop.near", 1_800_000_000, scope)).toBe(message);
    const req = intentsPayoutProofRequest("mer_x", "shop.near", 1_800_000_000, scope);
    expect(req).toMatchObject({ message, recipient: scope.hub });
    expect(Buffer.from(req.nonce).toString("hex")).toBe(sha256Text(message));
  });

  it("verifies a wallet's proof and refuses another merchant, account, time, network or a payout-change proof", () => {
    const proof = { timestamp: 1_800_000_000, public_key: key.publicKey, signature: sign("mer_x", "shop.near", 1_800_000_000) };
    expect(verifyIntentsPayoutSignature("shop.near", proof, "mer_x", scope)).toBe(true);
    expect(verifyIntentsPayoutSignature("shop.near", proof, "mer_y", scope)).toBe(false);
    expect(verifyIntentsPayoutSignature("evil.near", proof, "mer_x", scope)).toBe(false);
    expect(verifyIntentsPayoutSignature("shop.near", { ...proof, timestamp: 1_800_000_001 }, "mer_x", scope)).toBe(false);
    expect(verifyIntentsPayoutSignature("shop.near", proof, "mer_x", { ...scope, settlementNetwork: "near:sandbox" })).toBe(false);
    // A payout-change proof is not an any-chain payout proof, and the other way round.
    const payoutScope = { network: "near:mainnet" as const, hub: scope.hub };
    const payoutSig = Buffer.from(signDigest(key.secretKey, nep413Digest(payoutProofRequest("mer_x", "shop.near", 1_800_000_000, payoutScope))), "hex").toString("base64");
    expect(verifyIntentsPayoutSignature("shop.near", { ...proof, signature: payoutSig }, "mer_x", scope)).toBe(false);
    expect(verifyPayoutProofSignature({ payout: "shop.near", ...proof }, "mer_x", payoutScope)).toBe(false);
  });
});
