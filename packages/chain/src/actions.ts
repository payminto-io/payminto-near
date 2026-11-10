import { publicKeyBytes, toHex } from "./bytes.ts";
import { DEFAULT_MAX_PAYEES } from "./constants.ts";
import { canonicalPayees } from "./digest.ts";
import type { Acceptance, AccountId, BudgetTerms, CheckoutTerms, Claim, Id32, PublicKey, Sig64 } from "./types.ts";

/** Pure wallet transaction builders, in the shape NEAR wallets accept. Signing and sending belong to the wallet. */
export type FunctionCallAction = {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
};

export type WalletTx = { receiverId: AccountId; actions: FunctionCallAction[] };

const TGAS = 1_000_000_000_000n;
const ONE_YOCTO = "1";
const call = (methodName: string, args: Record<string, unknown>, tgas: bigint, deposit: string): FunctionCallAction => ({
  type: "FunctionCall",
  params: { methodName, args, gas: (tgas * TGAS).toString(), deposit },
});

/**
 * JSON shape of BudgetTerms in `open_budget`. Amounts and times are decimal strings, ids are Id32 hex. The hub never
 * reads an empty list as "any payee": a Budget with no list says so with `allow_any_payee` and declares in
 * `max_payees` how many distinct payees it can ever pay (`t.maxPayees`, default `DEFAULT_MAX_PAYEES`).
 */
export function budgetTermsArgs(t: BudgetTerms): Record<string, unknown> {
  const payees = canonicalPayees(t.payees);
  const any = payees.length === 0;
  return {
    agent_pk: toHex(publicKeyBytes(t.agentPk)),
    settler: t.settler,
    cap: t.cap.toString(),
    valid_until: t.validUntil.toString(),
    payees,
    policy_hash: t.policyHash,
    salt: t.salt,
    allow_any_payee: any,
    max_payees: any ? (t.maxPayees ?? DEFAULT_MAX_PAYEES) : 0,
  };
}

/**
 * The caller becomes the owner, so `t.owner` must be the signing account. `storageDeposit` is yoctoNEAR: the hub keeps
 * `openBudgetStorageCost(t)` of it, for the record, a later revoke and the settlement storage of every payee the Budget
 * can pay, and refunds the rest.
 */
export const openBudgetTx = (hub: AccountId, t: BudgetTerms, storageDeposit: string): WalletTx => ({
  receiverId: hub,
  actions: [call("open_budget", { terms: budgetTermsArgs(t) }, 50n, storageDeposit)],
});

/** Raises escrow only, never cap. */
export const depositBudgetTx = (token: AccountId, hub: AccountId, budgetId: Id32, amount: bigint): WalletTx => ({
  receiverId: token,
  actions: [call("ft_transfer_call", { receiver_id: hub, amount: amount.toString(), msg: JSON.stringify({ budget: { budget_id: budgetId } }) }, 100n, ONE_YOCTO)],
});

/**
 * Moves the owner's own hub credit into one of the owner's open Budgets: escrow only, never cap. The owner's wallet signs
 * it, and the hub requires exactly one yoctoNEAR so that only a full-access key or a wallet confirmation can call it.
 */
export const fundFromCreditTx = (hub: AccountId, budgetId: Id32, amount: bigint): WalletTx => ({
  receiverId: hub,
  actions: [call("fund_from_credit", { budget_id: budgetId, amount: amount.toString() }, 30n, ONE_YOCTO)],
});

export const checkoutPayTx = (token: AccountId, hub: AccountId, t: CheckoutTerms, signature: Sig64): WalletTx => ({
  receiverId: token,
  actions: [
    call(
      "ft_transfer_call",
      {
        receiver_id: hub,
        amount: t.amount.toString(),
        msg: JSON.stringify({ payment: { payment_id: t.paymentId, merchant: t.merchant, amount: t.amount.toString(), expiry_ms: t.expiryMs.toString(), signature } }),
      },
      100n,
      ONE_YOCTO,
    ),
  ],
});

export const revokeBudgetTx = (hub: AccountId, budgetId: Id32): WalletTx => ({
  receiverId: hub,
  actions: [call("revoke_budget", { budget_id: budgetId }, 30n, "0")],
});

export const reclaimTx = (hub: AccountId, budgetId: Id32): WalletTx => ({
  receiverId: hub,
  actions: [call("reclaim", { budget_id: budgetId }, 100n, "0")],
});

/**
 * After the settlement deadline, the owner removes the Budget's `settled` entries for `payees` (at most
 * `MAX_PRUNE_PAYEES`) and gets back the storage they freed plus the unused storage reserve, in NEAR.
 */
export const pruneTx = (hub: AccountId, budgetId: Id32, payees: readonly AccountId[]): WalletTx => ({
  receiverId: hub,
  actions: [call("prune", { budget_id: budgetId, payees: [...payees] }, 100n, "0")],
});

/**
 * Step one of replacing the hub's admin, signed by the admin: names the next admin, or withdraws the proposal with
 * null. `deposit` pays for the name in the hub's root record (at least one yoctoNEAR; the excess is refunded).
 */
export const proposeAdminTx = (hub: AccountId, next: AccountId | null, deposit = "10000000000000000000000"): WalletTx => ({
  receiverId: hub,
  actions: [call("propose_admin", { new_admin: next }, 30n, deposit)],
});

/** Step two, signed by the proposed account with a full-access key: it becomes the admin. Exactly one yoctoNEAR. */
export const acceptAdminTx = (hub: AccountId): WalletTx => ({
  receiverId: hub,
  actions: [call("accept_admin", {}, 30n, ONE_YOCTO)],
});

/**
 * The settler named by the admin's `set_checkout_key` takes the checkout role, for exactly the proposed key. Signed by
 * the settler account itself with a full-access key: the hub requires exactly one yoctoNEAR. Until it does, no checkout
 * payment draws on its storage balance.
 */
export const acceptCheckoutTx = (hub: AccountId, key: PublicKey): WalletTx => ({
  receiverId: hub,
  actions: [call("accept_checkout", { key: toHex(publicKeyBytes(key)) }, 30n, ONE_YOCTO)],
});

/** The admin sets the smallest checkout payment the hub accepts, in token base units. At least one yoctoNEAR. */
export const setMinPaymentTx = (hub: AccountId, amount: bigint): WalletTx => ({
  receiverId: hub,
  actions: [call("set_min_payment", { amount: amount.toString() }, 30n, ONE_YOCTO)],
});

export const payoutTx = (hub: AccountId, accounts: readonly AccountId[]): WalletTx => ({
  receiverId: hub,
  actions: [call("payout", { accounts: [...accounts] }, 300n, "0")],
});

export function claimArgs(c: Claim): Record<string, unknown> {
  return {
    budget_id: c.budgetId,
    payee: c.payee,
    amount: c.amount.toString(),
    cumulative: c.cumulative.toString(),
    request_hash: c.requestHash,
    signature: c.signature,
  };
}

/** JSON shape of the node's acceptance in `settle_own`: the receipt key as hex, Unix seconds as a decimal string. */
export function acceptanceArgs(a: Acceptance): Record<string, unknown> {
  if (a.timestampS < 0n || a.timestampS > 2n ** 64n - 1n) throw new Error("timestampS is outside u64");
  return { node_key: toHex(publicKeyBytes(a.nodeKey)), timestamp_s: a.timestampS.toString(), signature: a.signature };
}

/**
 * The payee settles its own latest voucher, with the node's acceptance of that call. A voucher with no acceptance
 * cannot be settled this way. `storageDeposit` is yoctoNEAR for new storage once the Budget's prepaid reserve is used
 * up; the hub takes only what the call really writes and refunds the rest, and zero is right while the Budget's owner
 * has prepaid for the payee, which it always has for a listed payee.
 */
export const settleOwnTx = (hub: AccountId, claim: Claim, acceptance: Acceptance, storageDeposit = "0"): WalletTx => ({
  receiverId: hub,
  actions: [call("settle_own", { claim: claimArgs(claim), acceptance: acceptanceArgs(acceptance) }, 100n, storageDeposit)],
});

/**
 * The settler registers a key it signs acceptances with, which `settle_own` checks. Signed by the settler account
 * itself with a full-access key: the hub requires exactly one yoctoNEAR. Keys can only be added, at most
 * `MAX_RECEIPT_KEYS`, and the entry is paid from the settler's storage balance, so fund that first.
 */
export const registerReceiptKeyTx = (hub: AccountId, key: PublicKey): WalletTx => ({
  receiverId: hub,
  actions: [call("register_receipt_key", { key: toHex(publicKeyBytes(key)) }, 30n, ONE_YOCTO)],
});

/**
 * Adds `yocto` yoctoNEAR to `account`'s storage balance at the hub. Anyone may fund any account but the hub and
 * the token. `settle_batch` (for its batch record), `register_receipt_key` and checkout payments draw on it.
 */
export const fundStorageTx = (hub: AccountId, account: AccountId, yocto: bigint): WalletTx => ({
  receiverId: hub,
  actions: [call("fund_storage", { account }, 30n, yocto.toString())],
});

/** The signing account takes back `yocto` of its unused storage balance. The hub requires exactly one yoctoNEAR. */
export const withdrawStorageTx = (hub: AccountId, yocto: bigint): WalletTx => ({
  receiverId: hub,
  actions: [call("withdraw_storage", { amount: yocto.toString() }, 30n, ONE_YOCTO)],
});

/** NEP-145 registration at the token, so an account can receive payouts. The hub never pays this. */
export const storageDepositTx = (token: AccountId, account: AccountId, deposit: string): WalletTx => ({
  receiverId: token,
  actions: [call("storage_deposit", { account_id: account, registration_only: true }, 30n, deposit)],
});
