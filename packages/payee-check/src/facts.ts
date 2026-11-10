import type { AccountId, AccountKind } from "./account.ts";
import type { Report } from "./blocklist.ts";

/**
 * One thing the check tried to learn.
 * - `known`: the source answered.
 * - `unknown`: a source was configured and did not answer. The reason is kept, and the verdict never treats it as good news.
 * - `not_checked`: no source was configured for it, so no signal about it can fire.
 */
export type Fact<T> = { state: "known"; value: T } | { state: "unknown"; reason: string } | { state: "not_checked" };

export const known = <T>(value: T): Fact<T> => ({ state: "known", value });
export const unknown = (reason: string): Fact<never> => ({ state: "unknown", reason });
export const NOT_CHECKED: Fact<never> = { state: "not_checked" };

/** `code_hash` of an account with no contract: 32 zero bytes in base58. */
export const NO_CONTRACT_HASH = "11111111111111111111111111111111";

/** An account as `view_account` reports it at a final block. */
export type AccountView = {
  /** Liquid balance in yoctoNEAR. */
  amount: string;
  /** Staked balance in yoctoNEAR. */
  locked: string;
  /** Base58 hash of the deployed code, or `NO_CONTRACT_HASH`. */
  codeHash: string;
  storageUsage: number;
  /** Set when the account runs a global contract pinned by code hash. */
  globalContractHash: string | null;
  /** Set when the account runs whatever global contract this other account publishes. */
  globalContractAccountId: AccountId | null;
  blockHeight: number;
  blockHash: string;
};

/**
 * The identity of the code an account runs, or null when it runs none.
 * A local contract is its code hash. A global contract pinned by hash is `global:<hash>`. A global contract followed by
 * account id is `global-by-account:<id>`: its code can change without this value changing, and the check says so.
 */
export function contractIdOf(a: Pick<AccountView, "codeHash" | "globalContractHash" | "globalContractAccountId">): string | null {
  if (a.codeHash !== NO_CONTRACT_HASH) return a.codeHash;
  if (a.globalContractHash) return `global:${a.globalContractHash}`;
  if (a.globalContractAccountId) return `global-by-account:${a.globalContractAccountId}`;
  return null;
}

/** Key counts. When `more` is true the account has further keys that were not read, so the counts are lower bounds. */
export type AccessKeyCounts = { fullAccess: number; functionCall: number; more: boolean };

/** What an age source says about when an account was created. It never estimates. */
export type AgeAnswer =
  /** The source holds the transaction that created the account. */
  | { status: "known"; createdAtMs: number; txHash: string | null }
  /** The source knows the account but holds no creation transaction, which is how accounts from genesis look. */
  | { status: "no_record" }
  /** The source has never seen the account. On chain it exists, so it is probably newer than the index. */
  | { status: "not_indexed" };

/** The code an account ran each time this check looked, kept in a `CodeStore`. */
export type CodeRecord = {
  /** `contractIdOf` at the latest look, or null for no contract. */
  contractId: string | null;
  firstSeenAtMs: number;
  /** When a look first found different code than the look before it. Null while no change has been seen. */
  changedAtMs: number | null;
  /** The code before that change. Only meaningful when `changedAtMs` is set. */
  previousContractId: string | null;
};

/** The record after looking at an account now. Pure, so the same looks always give the same record. */
export function nextCodeRecord(prev: CodeRecord | null, contractId: string | null, nowMs: number): CodeRecord {
  if (!prev) return { contractId, firstSeenAtMs: nowMs, changedAtMs: null, previousContractId: null };
  if (prev.contractId === contractId) return prev;
  return { contractId, firstSeenAtMs: prev.firstSeenAtMs, changedAtMs: nowMs, previousContractId: prev.contractId };
}

export type PaymentHistory = {
  /** Payments this payer has made to this payee before. */
  count: number;
  /** Their sum in atomic token units, as a decimal string so facts stay JSON. */
  totalPaid: string;
  lastAtMs: number | null;
};

/** Everything a verdict is computed from. Plain JSON: the same facts and policy always give the same verdict. */
export type PayeeFacts = {
  /** The payee exactly as asked. It may be invalid text; signals never interpret it. */
  payee: string;
  /** Null when the text is not a NEAR account id. */
  kind: AccountKind | null;
  payer: AccountId | null;
  /** Unix milliseconds at which the facts were read. Every age and window is measured from it. */
  nowMs: number;
  /** Null value means the account does not exist. */
  account: Fact<AccountView | null>;
  keys: Fact<AccessKeyCounts>;
  age: Fact<AgeAnswer & { source: string }>;
  code: Fact<CodeRecord>;
  token: Fact<{ token: AccountId; registered: boolean }>;
  history: Fact<PaymentHistory>;
  reports: Fact<Report[]>;
  /** The Budget's allowed payees, or null when the caller gave none. */
  budgetPayees: AccountId[] | null;
};
