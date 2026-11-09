import type { ReceiptProof } from "./schemas";

export type CheckState = "pass" | "fail" | "pending" | "unknown";
export type ProofCheck = { key: "receipt" | "path" | "onchain" | "settled"; label: string; state: CheckState; detail: string };

/**
 * The individual checks behind a receipt verdict, in the order a reader would make them.
 * `pathMatches` is the result of replaying the Merkle path in the browser (null when there is no root yet).
 */
export function proofChecks(p: Pick<ReceiptProof, "batchId" | "receiptsRoot" | "proof" | "txHash" | "onchainVerified">, pathMatches: boolean | null): ProofCheck[] {
  const inBatch = Boolean(p.batchId);
  return [
    {
      key: "receipt",
      label: "Receipt signed by the clearing node",
      state: "pass",
      detail: "The node accepted the voucher and returned this signed receipt to the provider.",
    },
    {
      key: "path",
      label: "Merkle path recomputed in this browser",
      state: !inBatch || pathMatches === null ? "pending" : pathMatches ? "pass" : "fail",
      detail: !inBatch
        ? "Available once a batch includes this call."
        : pathMatches
          ? `${p.proof.length} sibling hashes lead from this receipt to the batch receiptsRoot.`
          : "The recomputed root does not equal the batch receiptsRoot.",
    },
    {
      key: "onchain",
      label: "ClearingHub.verifyReceipt returned true",
      state: !inBatch ? "pending" : p.onchainVerified == null ? "unknown" : p.onchainVerified ? "pass" : "fail",
      detail: !inBatch
        ? "Checked against the hub once the batch settles."
        : p.onchainVerified == null
          ? "The node did not evaluate the call on chain."
          : p.onchainVerified
            ? "The hub contract itself confirms this call is in the settled batch."
            : "The hub contract rejected this proof.",
    },
    {
      key: "settled",
      label: "Batch settled on chain",
      state: p.txHash ? "pass" : "pending",
      detail: p.txHash ? "Funds moved wallet to wallet in one settleBatch transaction." : "Not settled yet.",
    },
  ];
}

/** Verified only when every check passes. */
export function isVerified(checks: readonly ProofCheck[]): boolean {
  return checks.every((c) => c.state === "pass");
}
