import { acceptanceDigest, acceptancePreimage, assertId32, publicKeyProblem, sha256Text, voucherCallId, type AccountId, type BudgetTerms, type Claim, type Id32, type PublicKey, type Sig64 } from "@payminto/chain";

/** JSON-safe Budget terms: bigints as decimal strings. `validUntil` is Unix milliseconds. */
export type BudgetTermsJson = Omit<BudgetTerms, "cap" | "validUntil"> & { cap: string; validUntil: string };

export function budgetTermsToJson(t: BudgetTerms): BudgetTermsJson {
  return { ...t, cap: t.cap.toString(), validUntil: t.validUntil.toString() };
}

export function budgetTermsFromJson(j: BudgetTermsJson): BudgetTerms {
  return { ...j, cap: BigInt(j.cap), validUntil: BigInt(j.validUntil) };
}

/** One accepted call, as the node attests it before any batch exists. `nodeDigest` is what the node signs. */
export type NodeAttestation = {
  callId: Id32;
  budgetId: Id32;
  payee: AccountId;
  amount: bigint;
  cumulative: bigint;
  requestHash: Id32;
  timestamp: bigint;
  voucherSig: Sig64;
};

/**
 * The digest the node signs when it accepts a call. Not a Merkle leaf: the leaf needs the batch id.
 *
 * It is `acceptanceDigest` of @payminto/chain, which is also what the hub rebuilds in `settle_own`: the text layout is
 * defined there and nowhere else. The chain package derives the call id from the voucher's own fields, and every
 * attestation a node signs carries exactly that id.
 *
 * A receipt that reaches a client is untrusted, and its call id is one of the fields the digest must cover. So an
 * attestation that names another id still gets a digest, over the chain package's own text with the named id in the
 * call id's place. No node signs that digest, so a receipt whose call id was changed never verifies.
 */
export function nodeDigest(a: NodeAttestation): Id32 {
  const claim: Claim = { budgetId: a.budgetId, payee: a.payee, amount: a.amount, cumulative: a.cumulative, requestHash: a.requestHash, signature: a.voucherSig };
  if (a.callId === voucherCallId(claim)) return acceptanceDigest(claim, a.timestamp);
  assertId32(a.callId, "callId");
  // Nine fields, none of which can contain the separator (see `acceptancePreimage`); the call id is the second.
  const fields = acceptancePreimage(claim, a.timestamp).split("|");
  fields[1] = a.callId;
  return sha256Text(fields.join("|"));
}

/** The refusal code for a Budget whose agent key is not a strong ed25519 key. The node returns it with HTTP 400. */
export const WEAK_AGENT_KEY = "WEAK_AGENT_KEY";

/**
 * Why a Budget with this agent key must not be created or registered, or null when the key is fine. A small-order key
 * (the all-zero key among them) lets anyone sign vouchers for the Budget with no secret, and the hub v1 accepts such a
 * key in `open_budget` (internal audit F3); a non-canonical encoding is refused with it, as hub v2 will.
 */
export function agentKeyRefusal(agentPk: PublicKey): { code: typeof WEAK_AGENT_KEY; message: string } | null {
  const problem = publicKeyProblem(agentPk);
  if (problem === null) return null;
  const why =
    problem === "small_order" || problem === "non_canonical"
      ? "is a small-order or non-canonical ed25519 key, so anyone could sign vouchers for it without its secret"
      : problem === "not_a_point"
        ? "is not a point on the ed25519 curve, so no voucher signed for it could ever settle"
        : "is not an ed25519 public key of 32 bytes";
  return { code: WEAK_AGENT_KEY, message: `budget.agentPk ${why} (${problem}); generate a new agent key` };
}

/** The text an agent or owner signs to revoke through the node. Replays are harmless: revoke is idempotent. */
export const revokeMessage = (budgetId: Id32): string => `Payminto Clearing: revoke budget ${budgetId}`;

export type { PublicKey };
