import { receiptLeaf, type AccountId, type Id32, type Network, type ReceiptCheck, type ReceiptFields } from "@payminto/protocol";
import type { ReceiptProof } from "./schemas";

export type CheckState = "pass" | "fail" | "pending" | "unknown";
export type ProofCheckKey = "receipt" | "leaf" | "root" | "path" | "hub";
export type ProofCheck = { key: ProofCheckKey; label: string; state: CheckState; detail: string };

/** Where the browser's own read of NEAR stands. `none` means this page has no RPC to read from. */
export type ChainRead =
  | { state: "none" }
  | { state: "reading" }
  | { state: "error"; message: string }
  | { state: "done"; check: ReceiptCheck; source: string };

/** The receipt as the hub's leaf commits to it. The node attests seconds; the leaf holds milliseconds. */
export function receiptFieldsOf(r: ReceiptProof["receipt"]): ReceiptFields {
  return {
    callId: r.callId,
    budgetId: r.budgetId,
    payee: r.payee,
    amount: BigInt(r.amount),
    cumulative: BigInt(r.cumulative),
    requestHash: r.requestHash,
    timestampMs: BigInt(r.timestamp) * 1000n,
    voucherSig: r.voucherSig,
  };
}

/**
 * The Merkle leaf of a receipt, rebuilt in this browser from its fields and the batch context, so the proof never rests
 * on a leaf the server merely asserted. Null until the Call is in a batch.
 */
export function rebuildLeaf(p: Pick<ReceiptProof, "receipt" | "batchId">, ctx: { hub: AccountId; network: Network }): Id32 | null {
  if (!p.batchId) return null;
  return receiptLeaf(ctx.hub, ctx.network, p.batchId, receiptFieldsOf(p.receipt));
}

const short = (h: string) => `${h.slice(0, 10)}...${h.slice(-6)}`;

/**
 * The checks behind a Call's verdict, in the order a reader makes them. Every check that touches NEAR comes from this
 * browser's own read; the server's claims about the chain are never counted.
 */
export function proofChecks(p: Pick<ReceiptProof, "batchId" | "leaf" | "proof">, rebuiltLeaf: Id32 | null, read: ChainRead): ProofCheck[] {
  const receipt: ProofCheck = { key: "receipt", label: "Receipt signed by the Payminto server", state: "pass", detail: "The server accepted the voucher and signed this receipt for the Payee." };
  if (!p.batchId) {
    const later = "Runs once a settlement batch includes this Call.";
    return [
      receipt,
      { key: "leaf", label: "Leaf rebuilt in this browser", state: "pending", detail: later },
      { key: "root", label: "Batch root read from NEAR", state: "pending", detail: later },
      { key: "path", label: "Merkle path leads to that root", state: "pending", detail: later },
      { key: "hub", label: "The hub's verify_receipt agrees", state: "pending", detail: later },
    ];
  }
  const leafOk = rebuiltLeaf !== null && (!p.leaf || p.leaf === rebuiltLeaf);
  const leaf: ProofCheck = {
    key: "leaf",
    label: "Leaf rebuilt in this browser",
    state: rebuiltLeaf === null ? "pending" : leafOk ? "pass" : "fail",
    detail: rebuiltLeaf === null ? "Waiting for the hub and network." : leafOk ? "The receipt fields hash to the leaf of this Call." : "The receipt fields do not hash to the leaf the server sent.",
  };
  const waiting = (key: ProofCheckKey, label: string, state: CheckState, detail: string): ProofCheck => ({ key, label, state, detail });
  if (read.state !== "done") {
    const [state, detail]: [CheckState, string] =
      read.state === "reading" ? ["pending", "Reading NEAR..."] : read.state === "error" ? ["unknown", read.message] : ["unknown", "This page has no NEAR RPC configured, so the chain was not read."];
    return [
      receipt,
      leaf,
      waiting("root", "Batch root read from NEAR", state, detail),
      waiting("path", "Merkle path leads to that root", state === "pending" ? "pending" : "unknown", state === "pending" ? "Waits for the root." : "Needs the root from NEAR."),
      waiting("hub", "The hub's verify_receipt agrees", state === "pending" ? "pending" : "unknown", state === "pending" ? "Waits for the root." : "Needs NEAR."),
    ];
  }
  const c = read.check;
  return [
    receipt,
    leaf,
    {
      key: "root",
      label: "Batch root read from NEAR",
      state: c.storedRoot ? "pass" : "fail",
      detail: c.storedRoot ? `Read from ${read.source} at final block ${c.blockHeight.toLocaleString("en-US")}.` : `The hub has no settled batch ${short(c.batchId)}.`,
    },
    {
      key: "path",
      label: "Merkle path leads to that root",
      state: c.rootMatches ? "pass" : "fail",
      detail: c.rootMatches
        ? `${p.proof.length} sibling ${p.proof.length === 1 ? "hash leads" : "hashes lead"} from this Call to the stored root.`
        : `The path ends at ${short(c.recomputedRoot)}, not the stored root.`,
    },
    {
      key: "hub",
      label: "The hub's verify_receipt agrees",
      state: c.hubVerified === true ? "pass" : c.hubVerified === false ? "fail" : "unknown",
      detail: c.hubVerified === true ? "The hub contract rebuilt the leaf itself and confirmed this Call is in the batch." : c.hubVerified === false ? "The hub contract rejected this proof." : "Not asked: the hub has no such batch.",
    },
  ];
}

/** Verified only when every check passes. */
export function isVerified(checks: readonly ProofCheck[]): boolean {
  return checks.every((c) => c.state === "pass");
}
