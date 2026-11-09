/**
 * Payment proof checks for /receipt/{id} (GATEWAY.md section 13.3). The node's proof is a set of claims; each check
 * re-reads the chain through a ChainReader and passes only when the chain agrees, so the reader need not trust the node.
 * The checks are pure over the reader, which makes them testable with fixture logs.
 */
import { createPublicClient, decodeAbiParameters, decodeEventLog, http, isAddressEqual, keccak256, parseAbi, toBytes, TransactionReceiptNotFoundError, type Address, type Hex } from "viem";
import type { OrderCommitment, PaymentProof } from "./schemas";

/** The order as the node served it: the exact bytes that were hashed, and the parsed object for display. */
export type ServedOrder = { raw: string; order: OrderCommitment };

export const proofEventsAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);

export const easAbi = parseAbi([
  "function getAttestation(bytes32 uid) view returns ((bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))",
]);

/** The attestation schema from section 13.3. */
export const ATTESTATION_FIELDS = [
  { name: "paymentRef", type: "bytes32" },
  { name: "orderHash", type: "bytes32" },
  { name: "payer", type: "address" },
  { name: "payout", type: "address" },
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "txHash", type: "bytes32" },
] as const;

/** OP Stack EAS predeploy, used when the proof does not name the contract. */
export const EAS_PREDEPLOY: Address = "0x4200000000000000000000000000000000000021";

export type ChainLog = { address: Address; topics: readonly Hex[]; data: Hex };
export type ChainReader = {
  receipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint; logs: readonly ChainLog[] } | null>;
  /** Block number at a tag (latest, safe or finalized). */
  blockAt(tag: string): Promise<bigint>;
  attestation(eas: Address, uid: Hex): Promise<{ uid: Hex; attester: Address; revocationTime: bigint; data: Hex } | null>;
};

export type CheckState = "pass" | "fail" | "skip";
export type ProofCheck = { id: string; label: string; state: CheckState; detail: string };

export class RpcUnreachableError extends Error {
  constructor(readonly rpcUrl: string) {
    super(`Could not read the chain at ${rpcUrl.replace(/^https?:\/\//, "")}.`);
    this.name = "RpcUnreachableError";
  }
}

export function rpcReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return { status: r.status, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
      } catch (e) {
        // "Not found" is an answer; anything else means this browser could not ask, which is not evidence either way.
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw new RpcUnreachableError(rpcUrl);
      }
    },
    async blockAt(tag) {
      const b = await client.getBlock({ blockTag: tag as "latest" | "safe" | "finalized" });
      return b.number;
    },
    async attestation(eas, uid) {
      try {
        const a = await client.readContract({ address: eas, abi: easAbi, functionName: "getAttestation", args: [uid] });
        return { uid: a.uid, attester: a.attester, revocationTime: a.revocationTime, data: a.data };
      } catch {
        return null;
      }
    },
  };
}

type Decoded = { name: "Transfer"; from: Address; to: Address; value: bigint } | { name: "AuthorizationUsed"; authorizer: Address; nonce: Hex };

function decode(log: ChainLog): Decoded | null {
  try {
    const d = decodeEventLog({ abi: proofEventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
    if (d.eventName === "Transfer") return { name: "Transfer", ...d.args };
    return { name: "AuthorizationUsed", ...d.args };
  } catch {
    return null;
  }
}

/** Decoded token logs of the payment transaction, for display. */
export function tokenEvents(logs: readonly ChainLog[], token: Address): Decoded[] {
  return logs.filter((l) => isAddressEqual(l.address, token)).map(decode).filter((d): d is Decoded => d !== null);
}

export async function runProofChecks(proof: PaymentProof, served: ServedOrder | null, reader: ChainReader): Promise<{ checks: ProofCheck[]; events: Decoded[]; blockNumber: bigint | null; finalBlock: bigint | null }> {
  const checks: ProofCheck[] = [];
  const token = proof.token as Address;
  let events: Decoded[] = [];
  let blockNumber: bigint | null = null;
  let finalBlock: bigint | null = null;

  const hash = proof.tx_hash as Hex | null;
  let unreachable: string | null = null;
  const receipt = hash
    ? await reader.receipt(hash).catch((e: unknown) => {
        if (e instanceof RpcUnreachableError) return ((unreachable = e.message), null);
        throw e;
      })
    : null;
  if (unreachable) checks.push({ id: "tx", label: "Transaction found", state: "fail", detail: `${unreachable} This browser could not check the transaction, so the receipt is unverified, not disproved.` });
  else if (!hash) checks.push({ id: "tx", label: "Transaction found", state: "skip", detail: "This payment has no on-chain transaction yet (a voucher waits for its clearing batch)." });
  else if (!receipt) checks.push({ id: "tx", label: "Transaction found", state: "fail", detail: "The RPC has no receipt for this transaction hash." });
  else checks.push({ id: "tx", label: "Transaction succeeded", state: receipt.status === "success" ? "pass" : "fail", detail: receipt.status === "success" ? `Included in block ${receipt.blockNumber}.` : "The transaction reverted." });

  if (receipt) {
    blockNumber = receipt.blockNumber;
    events = tokenEvents(receipt.logs, token);
    const targets = [proof.payout, proof.deposit_address].filter((a): a is string => Boolean(a)).map((a) => a.toLowerCase());
    const credited = events.reduce((acc, e) => (e.name === "Transfer" && targets.includes(e.to.toLowerCase()) ? acc + e.value : acc), 0n);
    // A deposit lands whole on the forwarder; through the router the payer pays the full credit and the payout
    // receives it minus the quoted fee, so the check is: money reached the merchant, and the payer (or the forwarder
    // deposit) moved the whole credit.
    const credit = BigInt(proof.credit_amount ?? proof.amount_due);
    const fromPayer = proof.payer ? events.reduce((acc, e) => (e.name === "Transfer" && isAddressEqual(e.from, proof.payer as Address) ? acc + e.value : acc), 0n) : 0n;
    const reached = credited > 0n;
    const whole = fromPayer >= credit || credited >= credit;
    checks.push({
      id: "transfer",
      label: "Paid to the merchant",
      state: reached && whole ? "pass" : "fail",
      detail: reached && whole ? "The token moved the full amount from the payer, and it reached the payout or this payment's deposit address." : "No token Transfer in this transaction pays this merchant the credited amount.",
    });

    if (proof.method === "wallet" || proof.method === "x402") {
      const nonce = proof.authorization_nonce?.toLowerCase();
      const used = events.some((e) => e.name === "AuthorizationUsed" && (!proof.payer || isAddressEqual(e.authorizer, proof.payer as Address)) && (!nonce || e.nonce.toLowerCase() === nonce));
      checks.push({ id: "auth", label: "Signed by the payer", state: used ? "pass" : "fail", detail: used ? "The token emitted AuthorizationUsed for the payer and this payment's nonce." : "No matching AuthorizationUsed event." });
    }

    try {
      finalBlock = await reader.blockAt(proof.finality_tag);
      const final = receipt.blockNumber <= finalBlock;
      checks.push({ id: "final", label: `Final at the ${proof.finality_tag} head`, state: final ? "pass" : "fail", detail: final ? `The ${proof.finality_tag} head is block ${finalBlock}.` : `Not yet: the ${proof.finality_tag} head is block ${finalBlock}.` });
    } catch {
      checks.push({ id: "final", label: "Finality", state: "fail", detail: `The RPC did not answer for the ${proof.finality_tag} block.` });
    }
  }

  if (!served) checks.push({ id: "order", label: "Order matches its hash", state: "fail", detail: "The order could not be loaded." });
  else {
    // keccak256 of the exact bytes served by /order, so nothing is re-serialized before hashing.
    const recomputed = keccak256(toBytes(served.raw));
    const ok = recomputed.toLowerCase() === proof.order_hash.toLowerCase() && served.order.payment_id === proof.payment_id;
    checks.push({ id: "order", label: "Order matches its hash", state: ok ? "pass" : "fail", detail: ok ? "Hashed in this browser from the canonical order the node served." : `Hashed to ${recomputed.slice(0, 12)}..., the node claims ${proof.order_hash.slice(0, 12)}...` });
  }

  if (!proof.eas_enabled || !proof.attestation) {
    checks.push({ id: "eas", label: "Attested on EAS", state: "skip", detail: "This node does not attest payments (EAS is switched off)." });
  } else {
    const a = await reader.attestation((proof.attestation.eas ?? EAS_PREDEPLOY) as Address, proof.attestation.uid as Hex);
    if (!a || /^0x0+$/.test(a.uid)) checks.push({ id: "eas", label: "Attested on EAS", state: "fail", detail: "EAS has no attestation with this UID." });
    else {
      let ok = a.revocationTime === 0n;
      try {
        const [, oh, , payout, tok, amount, tx] = decodeAbiParameters(ATTESTATION_FIELDS, a.data);
        ok = ok && oh.toLowerCase() === proof.order_hash.toLowerCase() && isAddressEqual(payout, proof.payout as Address) && isAddressEqual(tok, token) && amount === BigInt(proof.amount_paid) && (!hash || tx.toLowerCase() === hash.toLowerCase());
      } catch {
        ok = false;
      }
      checks.push({ id: "eas", label: "Attested on EAS", state: ok ? "pass" : "fail", detail: ok ? "The attestation commits to this order, payout, token, amount and transaction, and is not revoked." : "The attestation fields do not match this payment, or it was revoked." });
    }
  }
  return { checks, events, blockNumber, finalBlock };
}

// ---------------------------------------------------------------------------
// Plain words for the proof page
// ---------------------------------------------------------------------------

/** The checks runProofChecks will produce for a payment, in order, so the page can list them before they finish. */
export function expectedCheckIds(method: string | null | undefined): string[] {
  return ["tx", "transfer", ...(method === "wallet" || method === "x402" ? ["auth"] : []), "final", "order", "eas"];
}

/** One sentence a non-technical reader understands, per check; the technical detail stays in its own line. */
export function plainCheckTitle(id: string, ctx: { merchant: string; network: string }): string {
  switch (id) {
    case "tx":
      return `The payment is on ${ctx.network}`;
    case "transfer":
      return `The money reached ${ctx.merchant}`;
    case "auth":
      return "The payer approved it with their wallet";
    case "final":
      return "It is final and cannot be reversed";
    case "order":
      return "The order matches what was bought";
    case "eas":
      return "A permanent public record exists";
    default:
      return id;
  }
}

export type ProofVerdict = { state: "verified" | "failed"; passed: number; run: number; skipped: number; failed: number };

/** Counts only checks the chain answered; a skipped check (not applicable) never counts as passed. */
export function proofVerdict(checks: readonly ProofCheck[]): ProofVerdict {
  const run = checks.filter((c) => c.state !== "skip");
  const failed = run.filter((c) => c.state === "fail").length;
  return { state: failed === 0 && run.length > 0 ? "verified" : "failed", passed: run.length - failed, run: run.length, skipped: checks.length - run.length, failed };
}
