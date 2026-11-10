import { accountKindOf, isAccountId, printable, type AccountId } from "./account.ts";
import type { AgeSource } from "./age.ts";
import { REPORT_LIMITS, reportSchema, type BlocklistReader } from "./blocklist.ts";
import type { CodeStore } from "./code-store.ts";
import { NOT_CHECKED, contractIdOf, known, nextCodeRecord, unknown, type Fact, type PayeeFacts } from "./facts.ts";
import { ReadError } from "./http.ts";
import { resolvePolicy, type PolicyInput } from "./policy.ts";
import type { NearReader } from "./rpc.ts";
import { evaluate, type Verdict } from "./verdict.ts";

/** What this payer has paid this payee before. The node answers this from its own records. */
export interface HistorySource {
  paymentsBetween(payer: AccountId, payee: AccountId): Promise<{ count: number; total: bigint; lastAtMs: number | null }>;
}

export type CheckRequest = {
  /** The account to judge. Any text is accepted: text that is not an account id gets a block verdict. */
  payee: string;
  /** Who would pay. Needed for the prior-payments signals. */
  payer?: AccountId | null;
  /** The Budget's allowed payees. Needed for the lookalike signal. */
  budgetPayees?: readonly AccountId[] | null;
};

/** Judges one payee. It resolves with a verdict for every payee text, and rejects only on a caller mistake. */
export type PayeeCheck = (request: CheckRequest) => Promise<Verdict>;

export type CheckSources = {
  /** The only required source: read-only NEAR access. */
  reader: NearReader;
  /** The settlement token. Without it, token registration is not checked. */
  token?: AccountId;
  /** Without it, account age is not checked. */
  ageSource?: AgeSource;
  /** Without it, prior payments are not checked. */
  history?: HistorySource;
  /** Without it, the shared blocklist is not checked. */
  blocklist?: BlocklistReader;
  /** Without it, code changes are not checked. */
  codeStore?: CodeStore;
  /** False reads the code store without recording this look. Default true. */
  remember?: boolean;
  /** Unix milliseconds. Default `Date.now`. */
  clock?: () => number;
  /** A source that takes longer than this counts as not answering. Default 10000. */
  sourceTimeoutMs?: number;
};

const causeOf = (e: unknown): string => (e instanceof ReadError ? `${e.source}: ${e.code}` : printable(e instanceof Error ? e.message : e, 120));

/** Runs one source, turning a failure or a hang into an unknown fact. */
async function ask<T>(read: () => Promise<T>, timeoutMs: number): Promise<Fact<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Fact<T>>((resolve) => {
    timer = setTimeout(() => resolve(unknown(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  const answer = (async (): Promise<Fact<T>> => {
    try {
      return known(await read());
    } catch (e) {
      return unknown(causeOf(e));
    }
  })();
  try {
    return await Promise.race([answer, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The facts of a check that could not run at all: the payee as asked, and the chain marked unreadable with the cause.
 * `evaluate` turns them into a verdict with `check_failed`, plus whatever needs no reading, such as a lookalike name.
 */
export function unreadableFacts(request: CheckRequest, cause: string, nowMs: number): PayeeFacts {
  const kind = accountKindOf(request.payee);
  const payer = request.payer ?? null;
  const allowed = request.budgetPayees ?? null;
  return {
    payee: typeof request.payee === "string" ? request.payee : printable(request.payee),
    kind,
    payer: isAccountId(payer) ? payer : null,
    nowMs,
    account: kind === null ? NOT_CHECKED : unknown(cause),
    keys: NOT_CHECKED,
    age: NOT_CHECKED,
    code: NOT_CHECKED,
    token: NOT_CHECKED,
    history: NOT_CHECKED,
    reports: NOT_CHECKED,
    budgetPayees: allowed && allowed.every(isAccountId) ? [...allowed] : null,
  };
}

/**
 * Reads everything a verdict needs. The chain is read first; keys, age, code and token registration are read only for
 * an account that exists. No failure of a source escapes: it becomes an unknown fact with its cause.
 * Rejects with `TypeError` when `payer` or `budgetPayees` are not account ids, since those come from the caller.
 */
export async function collectFacts(sources: CheckSources, request: CheckRequest): Promise<PayeeFacts> {
  const payer = request.payer ?? null;
  if (payer !== null && !isAccountId(payer)) throw new TypeError("payer must be a NEAR account id");
  const budgetPayees = request.budgetPayees ? [...request.budgetPayees] : null;
  if (budgetPayees?.some((p) => !isAccountId(p))) throw new TypeError("budgetPayees must be NEAR account ids");

  const payee = request.payee;
  const nowMs = (sources.clock ?? Date.now)();
  const limit = sources.sourceTimeoutMs ?? 10_000;
  const facts: PayeeFacts = { ...unreadableFacts({ payee, payer, budgetPayees }, "not read yet", nowMs), account: NOT_CHECKED };
  if (facts.kind === null) return facts;

  const { reader, token, ageSource, history, blocklist, codeStore } = sources;
  const [account, reports, paid] = await Promise.all([
    ask(() => reader.viewAccount(payee), limit),
    blocklist
      ? ask(async () => {
          // Reports are other parties' data, and the store may be someone else's code: validate again on the way in.
          const all = await blocklist.reportsFor(payee);
          if (!Array.isArray(all) || all.length > REPORT_LIMITS.perAccount) throw new Error("the blocklist answered out of bounds");
          return all.map((r) => reportSchema.parse(r)).filter((r) => r.account === payee);
        }, limit).then((f) => (f.state === "unknown" ? unknown("the blocklist could not be read") : f))
      : NOT_CHECKED,
    history && payer !== null
      ? ask(async () => {
          const h = await history.paymentsBetween(payer, payee);
          if (!Number.isSafeInteger(h.count) || h.count < 0 || typeof h.total !== "bigint" || h.total < 0n) throw new Error("the history source answered out of bounds");
          return { count: h.count, totalPaid: h.total.toString(), lastAtMs: typeof h.lastAtMs === "number" && Number.isFinite(h.lastAtMs) ? h.lastAtMs : null };
        }, limit)
      : NOT_CHECKED,
  ]);
  facts.account = account;
  facts.reports = reports;
  facts.history = paid;
  if (account.state !== "known" || account.value === null) return facts;

  const view = account.value;
  const contractId = contractIdOf(view);
  [facts.keys, facts.age, facts.code, facts.token] = await Promise.all([
    ask(async () => {
      const { keys, more } = await reader.accessKeys(payee);
      const fullAccess = keys.filter((k) => k.permission === "full_access").length;
      return { fullAccess, functionCall: keys.length - fullAccess, more };
    }, limit),
    ageSource
      ? ask(async () => {
          const a = await ageSource.createdAt(payee);
          if (a.status === "known" && !(Number.isSafeInteger(a.createdAtMs) && a.createdAtMs >= 0)) throw new Error("the age source answered out of bounds");
          return { ...a, source: printable(ageSource.name, 40) };
        }, limit)
      : NOT_CHECKED,
    codeStore
      ? ask(async () => (sources.remember === false ? nextCodeRecord(await codeStore.get(payee), contractId, nowMs) : codeStore.observe(payee, contractId, nowMs)), limit)
      : NOT_CHECKED,
    token ? ask(async () => ({ token, registered: (await reader.storageBalanceOf(token, payee)) !== null }), limit) : NOT_CHECKED,
  ]);
  return facts;
}

/**
 * Builds the check: read the facts, apply the policy, return the verdict.
 * The policy is validated once, here, so a malformed policy fails at start-up and not at the first payment.
 */
export function createPayeeCheck(sources: CheckSources & { policy?: PolicyInput }): PayeeCheck {
  const policy = resolvePolicy(sources.policy);
  if (sources.token !== undefined && !isAccountId(sources.token)) throw new TypeError("token must be a NEAR account id");
  return async (request) => evaluate(await collectFacts(sources, request), policy);
}
