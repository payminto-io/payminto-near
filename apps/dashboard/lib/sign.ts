/**
 * Owner-side Budget construction for the create wizard. The terms, their hashes and the transactions come from the
 * shared protocol and chain helpers; signing and sending go through lib/wallet.ts.
 */
import {
  budgetIdOf,
  budgetTermsToJson,
  depositBudgetTx,
  isAccountId,
  isPublicKey,
  openBudgetTx,
  policyHash,
  toHex,
  type AccountId,
  type BudgetTerms,
  type BudgetTermsJson,
  type Id32,
  type Network,
  type Policy,
  type PublicKey,
  type WalletTx,
} from "@payminto/protocol";
import { publicKeyProblem } from "@payminto/chain";

export type BudgetDraft = {
  agentPk: PublicKey;
  settler: AccountId;
  cap: bigint;
  validForSeconds: number;
  payees: AccountId[];
  policy: Policy;
};

/**
 * NEAR attached to `open_budget` for the Budget record and the storage it reserves for `settle_own` claims. The hub
 * keeps what the storage costs (about 0.053 NEAR at 16 reserved entries) and refunds the rest in the same receipt.
 */
export const OPEN_BUDGET_STORAGE_YOCTO = (10n ** 23n).toString();

export function buildBudgetTerms(draft: BudgetDraft, owner: AccountId, nowMs = Date.now()): BudgetTerms {
  return {
    owner,
    agentPk: draft.agentPk,
    settler: draft.settler,
    cap: draft.cap,
    validUntil: BigInt(nowMs + draft.validForSeconds * 1000),
    payees: draft.payees,
    policyHash: policyHash(draft.policy),
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
}

export type OpenBudget = { id: Id32; terms: BudgetTerms; json: BudgetTermsJson; txs: WalletTx[] };

/**
 * The owner opens a Budget in two transactions so they pay their own storage: `open_budget` from their account, then
 * the first deposit as `ft_transfer_call` to the hub with the Budget id. With no first deposit, only the first is sent.
 */
export function openBudgetPlan(args: { hub: AccountId; token: AccountId; network: Network; terms: BudgetTerms; deposit: bigint }): OpenBudget {
  const id = budgetIdOf(args.hub, args.network, args.terms);
  const txs = [openBudgetTx(args.hub, args.terms, OPEN_BUDGET_STORAGE_YOCTO)];
  if (args.deposit > 0n) txs.push(depositBudgetTx(args.token, args.hub, id, args.deposit));
  return { id, terms: args.terms, json: budgetTermsToJson(args.terms), txs };
}

/**
 * Why an agent key cannot open a Budget, in plain words, or null when it can. Beyond the NEAR text form, the key must be
 * the one canonical encoding of a curve point that is not of small order: anyone can sign for a small-order key without
 * its secret (audit F3), and the hub v1 would still accept one, so the form refuses it before anything is signed.
 */
export function agentKeyProblem(value: string): string | null {
  const v = value.trim();
  if (!isPublicKey(v)) return "Enter the agent public key (ed25519: followed by base58).";
  switch (publicKeyProblem(v)) {
    case null:
      return null;
    case "small_order":
      return "This key is unsafe: anyone could sign Calls with it. Make a new key with payminto-agent keygen.";
    case "non_canonical":
      return "This key is not in its standard form, so the hub would not treat it as one key. Make a new key with payminto-agent keygen.";
    default:
      return "This is not a valid ed25519 public key. Copy it again from payminto-agent keygen.";
  }
}

/** A key the form accepts: see `agentKeyProblem`. */
export const isAgentKey = (v: string): v is PublicKey => agentKeyProblem(v) === null;

export function parseAccountList(text: string): { valid: AccountId[]; invalid: string[] } {
  const parts = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const valid: AccountId[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (isAccountId(p)) valid.push(p);
    else invalid.push(p);
  }
  return { valid, invalid };
}
