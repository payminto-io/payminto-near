/**
 * Proves one Payminto receipt against the hub on chain, with no node and no keys.
 *
 * Everything that decides the result is read from the hub: the batch root and settler, the Budget's agent key, payees
 * and settler. The receipt file only supplies the call's fields and its Merkle path. The node's acceptance signature is
 * shown for information and never decides anything, because it is the node's word, not the chain's.
 */
import { z } from "zod";
import {
  clearingReceiptSchema,
  isAccountId,
  isId32,
  nodeDigest,
  receiptLeaf,
  verifyDigest,
  verifyMerkleProof,
  voucherDigest,
  type AccountId,
  type Chain,
  type ClearingReceipt,
  type Id32,
  type Network,
  type ReceiptFields,
} from "@payminto/protocol";

export const RECEIPT_FILE_KIND = "payminto.receipt-proof.v1";

const id32 = z.string().refine(isId32, "must be 64 lowercase hex characters");
const account = z.string().refine(isAccountId, "must be a NEAR account id");

export const receiptFileSchema = z.object({
  kind: z.literal(RECEIPT_FILE_KIND),
  network: z.enum(["near:sandbox", "near:testnet"]),
  hub: account,
  /** The node account the receipt says settled it. Checked against the batch's settler on chain. */
  operator: account,
  /** Where the hub was when the file was written. A hint only: the verifier uses the RPC it is given. */
  rpcUrl: z.string().nullable(),
  batchId: id32,
  proof: z.array(id32).max(32),
  receipt: clearingReceiptSchema,
});
export type ReceiptFile = z.infer<typeof receiptFileSchema>;

export function receiptFile(o: { network: Network; hub: AccountId; operator: AccountId; rpcUrl: string | null; batchId: Id32; proof: readonly Id32[]; receipt: ClearingReceipt }): ReceiptFile {
  return { kind: RECEIPT_FILE_KIND, network: o.network as ReceiptFile["network"], hub: o.hub, operator: o.operator, rpcUrl: o.rpcUrl, batchId: o.batchId, proof: [...o.proof], receipt: { ...o.receipt } };
}

/** One line of output. `ok` is null for information that does not decide the result. */
export type VerifyLine = { ok: boolean | null; what: string; detail: string };
export type VerifyResult = { ok: boolean; lines: VerifyLine[] };

const fieldsOf = (r: ClearingReceipt): ReceiptFields => ({
  callId: r.callId,
  budgetId: r.budgetId,
  payee: r.payee,
  amount: BigInt(r.amount),
  cumulative: BigInt(r.cumulative),
  requestHash: r.requestHash,
  // The leaf commits to milliseconds; the node attests whole seconds.
  timestampMs: BigInt(r.timestamp) * 1000n,
  voucherSig: r.voucherSig,
});

const done = (lines: VerifyLine[]): VerifyResult => ({ ok: lines.every((l) => l.ok !== false), lines });

/** What the hub stores for the batch `settler` settled under `batchId`. Fails when the hub has no such batch. */
export async function verifyBatch(chain: Pick<Chain, "batch">, batchId: Id32, settler: AccountId): Promise<VerifyResult> {
  const b = await chain.batch(batchId, settler);
  if (!b) return done([{ ok: false, what: `batch ${batchId} is stored on the hub`, detail: "the hub has no such batch" }]);
  return done([{ ok: true, what: `batch ${batchId} is stored on the hub`, detail: `root ${b.root}, settled by ${b.settler}, gross ${b.gross}, net ${b.net}, at ${new Date(Number(b.at)).toISOString()}` }]);
}

/**
 * Checks, in order: the file names this hub and network; the batch and the Budget exist on chain; the batch was settled
 * by the Budget's settler, who is the operator the file names; the voucher signature verifies against the Budget's
 * agent key on chain; the payee is allowed; the Merkle path folds from the receipt's leaf to the stored root; and the
 * hub's own `verify_receipt` view agrees.
 */
export async function verifyReceipt(chain: Pick<Chain, "hub" | "network" | "batch" | "budget" | "verifyReceipt">, file: ReceiptFile): Promise<VerifyResult> {
  const lines: VerifyLine[] = [];
  const r = file.receipt;
  const f = fieldsOf(r);
  lines.push({
    ok: file.hub === chain.hub && file.network === chain.network,
    what: "the receipt names this hub and network",
    detail: `file: ${file.hub} on ${file.network}; chain: ${chain.hub} on ${chain.network}`,
  });
  // Batch ids belong to their settler: the batch is read under the operator the file names, which must be the Budget's.
  const [batch, budget] = await Promise.all([chain.batch(file.batchId, file.operator), chain.budget(r.budgetId)]);
  lines.push(batch ? { ok: true, what: `batch ${file.batchId} is stored on the hub`, detail: `root ${batch.root}, settled by ${batch.settler}, gross ${batch.gross}, net ${batch.net}` } : { ok: false, what: `batch ${file.batchId} is stored on the hub`, detail: "the hub has no such batch" });
  lines.push(budget ? { ok: true, what: `Budget ${r.budgetId} is on the hub`, detail: `owner ${budget.owner}, settler ${budget.settler}, agent key ${budget.agentPk}` } : { ok: false, what: `Budget ${r.budgetId} is on the hub`, detail: "the hub has no such Budget" });
  if (batch && budget) {
    lines.push({
      ok: batch.settler === budget.settler && batch.settler === file.operator,
      what: "the batch was settled by the Budget's own settler",
      detail: `batch settler ${batch.settler}, Budget settler ${budget.settler}, file operator ${file.operator}`,
    });
  }
  if (budget) {
    const digest = voucherDigest(chain.hub, chain.network, { budgetId: r.budgetId, payee: r.payee, amount: f.amount, cumulative: f.cumulative, requestHash: r.requestHash });
    lines.push({
      ok: verifyDigest(budget.agentPk, digest, r.voucherSig),
      what: "the voucher signature verifies against the Budget's agent key on chain",
      detail: `voucher for ${r.amount} to ${r.payee} (cumulative ${r.cumulative}) for request ${r.requestHash.slice(0, 16)}...`,
    });
    lines.push({
      ok: budget.payees.length === 0 || budget.payees.includes(r.payee),
      what: "the payee is allowed by the Budget",
      detail: budget.payees.length === 0 ? "the Budget allows any payee" : `payees ${budget.payees.join(", ")}`,
    });
  }
  if (batch) {
    const leaf = receiptLeaf(chain.hub, chain.network, file.batchId, f);
    lines.push({
      ok: verifyMerkleProof(batch.root, leaf, file.proof),
      what: "the Merkle path folds from this receipt's leaf to the stored root (computed here)",
      detail: `leaf ${leaf}, ${file.proof.length} steps, stored root ${batch.root}`,
    });
  }
  lines.push({ ok: await chain.verifyReceipt(file.batchId, file.operator, f, file.proof), what: "the hub's own verify_receipt view agrees", detail: `${chain.hub}.verify_receipt(settler, batch, fields, proof)` });
  const attested = nodeDigest({ ...f, timestamp: BigInt(r.timestamp) });
  lines.push({
    ok: null,
    what: "the node's acceptance signature (information only: the node's word, not the chain's)",
    detail: attested === r.digest && verifyDigest(r.node, attested, r.nodeSignature) ? `valid for node key ${r.node}` : `does not verify for node key ${r.node}`,
  });
  return done(lines);
}

export const PROOF_LIMITS =
  "This proves the call is in a batch root its settler committed to on chain, and that the Budget's agent key signed it. It does not prove delivery, or that the root covers every voucher.";
