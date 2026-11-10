import type { StoredVoucher } from "../src/voucher-store.ts";

/**
 * A well-formed stored voucher for a payee. The signatures are placeholders: the store keeps what the paywall hands
 * it and checks shapes only, so these tests are about the file, not about signatures.
 */
export function storedVoucher(payee: string, cumulative: bigint): StoredVoucher {
  return {
    budgetId: "ab".repeat(32),
    payee,
    amount: "1000",
    cumulative: cumulative.toString(),
    requestHash: "cd".repeat(32),
    publicKey: "ed25519:8fWHD35Rjd78yeowShh9GwhRudRtLLsGCRjZtgPjAtw9",
    signature: "11".repeat(64),
    hub: "hub.payminto.testnet",
    network: "near:sandbox",
    callId: "ef".repeat(32),
    acceptedAt: "2026-11-10T00:00:00.000Z",
    acceptance: { nodeKey: "ed25519:8fWHD35Rjd78yeowShh9GwhRudRtLLsGCRjZtgPjAtw9", timestampS: "1762732800", signature: "22".repeat(64) },
  };
}
