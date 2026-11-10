import { DENIAL_RULES, HUB_UNREADABLE_MESSAGE, REPEAT_WINDOW_SEC, type AccountId, type DenialRule, type Id32, type Policy, type Refusal, type RetryHint } from "@payminto/protocol";

/**
 * A question about one of a Budget's rolling windows, asked only to build the retry hint of a refusal: in how many
 * seconds will `leave` counted calls have left the window, or `free` atomic units of spend? The engine decides what
 * must leave; the caller knows when the calls were accepted.
 */
export type WindowQuery =
  | { window: "calls"; seconds: number; leave: number }
  | { window: "sameRequest"; seconds: number; leave: number }
  | { window: "spend"; seconds: number; free: bigint };

/** Everything the policy engine needs, loaded inside the acceptance transaction. Pure data, apart from `waitFor`. */
export type VoucherContext = {
  /** Unix seconds, for the rolling windows. */
  now: number;
  /** Unix milliseconds at decision time, for expiry: the hub stores validUntil in milliseconds. */
  nowMs: bigint;
  provider: { payee: AccountId; priceAtomic: bigint };
  voucher: { budgetId: Id32; payee: AccountId; amount: bigint; cumulative: bigint };
  /**
   * What the caps are checked against when one request is paid with several vouchers (a payment split between a
   * merchant and a platform fee): this voucher's amount plus the amounts of the request's vouchers still to come.
   * The first voucher therefore carries the whole request, and a client cannot get under a cap by splitting.
   * Absent for a request paid with one voucher.
   */
  requestAmount?: bigint;
  /**
   * Position of this voucher within its request, 0 for the first or only one. The per-minute and same-request limits
   * count requests, so they are checked on part 0 only.
   */
  requestPart?: number;
  /**
   * Result of the ed25519 check against the Budget's agent key, computed before the transaction (the key is immutable).
   * Checked before every rule that reads the voucher: an unsigned voucher says nothing about the agent.
   */
  signatureValid: boolean;
  budget: null | {
    status: "pending" | "open" | "revoked";
    cap: bigint;
    /** Unix milliseconds. */
    validUntilMs: bigint;
    payees: readonly AccountId[];
    policy: Policy;
  };
  /** Latest accepted cumulative for (Budget, payee), or 0. */
  position: bigint;
  /** Accepted requests of this Budget in the last 60 s. */
  callsLastMinute: number;
  /** Accepted requests of this Budget repeating this request hash in the repeat window. */
  sameRequestCalls: number;
  /** Accepted spend of this Budget in the last hour. */
  spentLastHour: bigint;
  /** Accepted spend of this Budget in the last 24 h. */
  spentLast24h: bigint;
  /** Settled plus accepted-unsettled spend of this Budget. */
  spentTotal: bigint;
  /** Accepted-unsettled spending of this Budget: what its escrow must still cover at settlement. */
  budgetOutstanding: bigint;
  /** Accepted-unsettled amounts payable to this Budget's owner. Only used to choose the retry hint, never to widen the limit. */
  ownerIncoming: bigint;
  /** Last known escrow of this Budget and its owner's withdrawable credit. Null if never observed, which refuses the call. */
  funds: null | { escrow: bigint; credit: bigint };
  /** Milliseconds since `funds` was read from the hub. Ignored when `funds` is null. */
  fundsAgeMs: number;
  /** FUNDS_MAX_AGE_MS: a snapshot older than this is never decided on, because the refresh that should have replaced it failed. */
  fundsMaxAgeMs: number;
  /**
   * Answers a WindowQuery in seconds from `now`, or null when it cannot. Called only for a limit the call breaks. When
   * absent or null the hint falls back to the whole window, which is always long enough.
   */
  waitFor?: (q: WindowQuery) => number | null;
};

/** Seconds an agent is told to wait when the node could not read the hub: long enough for a retry to find it readable. */
export const HUB_RETRY_SEC = 5;

const MINUTE_SEC = 60;
const HOUR_SEC = 3_600;
const DAY_SEC = 86_400;

export type Details = Record<string, string | number | boolean | null>;

export type Decision = { ok: true } | { ok: false; rule: DenialRule; message: string; details: Details; refusal: Refusal };

function remainingOf(c: VoucherContext): string | null {
  if (!c.budget) return null;
  return (c.budget.cap > c.spentTotal ? c.budget.cap - c.spentTotal : 0n).toString();
}

/**
 * Evaluates the rules in order and the first failing rule wins. Kept pure so every rule is unit tested without a
 * database or chain. Every denial carries the structured refusal an agent can act on without reading the message.
 *
 * Retry hints are held to one standard: a hint never invites a retry that cannot work, and never says `never` when
 * waiting works. A rolling limit therefore answers with the seconds until this call fits every rolling limit it breaks
 * now, and with `never` when the call cannot fit at all (it is larger than the cap, the Budget cap is used up, or the
 * Budget expires first).
 */
export function evaluateVoucher(c: VoucherContext): Decision {
  const { voucher: v, budget: m } = c;
  // One request, one call: every cap sees the whole amount of the request this voucher belongs to.
  const amount = c.requestAmount ?? v.amount;
  const split = c.requestAmount !== undefined && c.requestAmount !== v.amount;
  const amounts = (): Details => ({ amount: v.amount.toString(), ...(split ? { requestAmount: amount.toString() } : {}) });

  const deny = (rule: DenialRule, retry: RetryHint, details: Details = {}, message: string = DENIAL_RULES[rule]): Decision => ({
    ok: false,
    rule,
    message,
    details,
    refusal: { rule, message, attemptedAmount: amount.toString(), remainingBudget: remainingOf(c), retry },
  });

  // The two answers that are nobody's refusal: the node returns them as plain errors and records nothing (vouchers.ts).
  if (!m) return deny("UNKNOWN_BUDGET", { kind: "never" });
  if (!c.signatureValid) return deny("BAD_SIGNATURE", { kind: "never" });
  if (m.status === "revoked") return deny("BUDGET_REVOKED", { kind: "never" });
  // Fail closed from the first millisecond after validUntil, although the hub keeps settlement open for its grace period.
  const expired = c.nowMs > m.validUntilMs;
  if (m.status !== "open" || expired) {
    return deny("BUDGET_NOT_ACTIVE", { kind: "never" }, { status: m.status, validUntilMs: m.validUntilMs.toString(), now: c.now });
  }
  if (m.payees.length > 0 && !m.payees.includes(v.payee)) {
    return deny("PAYEE_NOT_ALLOWED", { kind: "never" }, { payee: v.payee });
  }
  if (v.amount !== c.provider.priceAtomic) {
    return deny("PRICE_MISMATCH", { kind: "never" }, { amount: v.amount.toString(), price: c.provider.priceAtomic.toString() });
  }
  const perCallCap = BigInt(m.policy.perCallCap);
  if (amount > perCallCap) return deny("PER_CALL_CAP", { kind: "never" }, { ...amounts(), perCallCap: perCallCap.toString() });
  if (v.cumulative !== c.position + v.amount) {
    const expectedCumulative = (c.position + v.amount).toString();
    return deny("STALE_CUMULATIVE", { kind: "resign", expectedCumulative }, { expectedCumulative, cumulative: v.cumulative.toString() });
  }

  const firstPart = (c.requestPart ?? 0) === 0;
  const maxCalls = m.policy.maxCallsPerMinute;
  const maxRepeats = m.policy.maxRepeatsPerRequest ?? 0;
  const hourlyCap = BigInt(m.policy.hourlyCap ?? "0");
  const dailyCap = BigInt(m.policy.dailyCap);
  const over = {
    rate: firstPart && maxCalls > 0 && c.callsLastMinute >= maxCalls,
    repeat: firstPart && maxRepeats > 0 && c.sameRequestCalls >= maxRepeats,
    hourly: hourlyCap > 0n && c.spentLastHour + amount > hourlyCap,
    daily: c.spentLast24h + amount > dailyCap,
    total: c.spentTotal + amount > m.cap,
  };

  /**
   * The hint of a rolling-limit refusal: the wait after which this call fits every rolling limit it breaks now. Waiting
   * for the minute to pass is no use if the daily cap then refuses the same call, and nothing helps a call that is
   * larger than a rolling cap, that the Budget cap no longer has room for, or whose Budget expires before the wait ends.
   */
  const windowHint = (): RetryHint => {
    if (over.total || (over.hourly && amount > hourlyCap) || (over.daily && amount > dailyCap)) return { kind: "never" };
    const ask = (q: WindowQuery) => c.waitFor?.(q) ?? q.seconds;
    let seconds = 0;
    if (over.rate) seconds = Math.max(seconds, ask({ window: "calls", seconds: MINUTE_SEC, leave: c.callsLastMinute - maxCalls + 1 }));
    if (over.repeat) seconds = Math.max(seconds, ask({ window: "sameRequest", seconds: REPEAT_WINDOW_SEC, leave: c.sameRequestCalls - maxRepeats + 1 }));
    if (over.hourly) seconds = Math.max(seconds, ask({ window: "spend", seconds: HOUR_SEC, free: c.spentLastHour + amount - hourlyCap }));
    if (over.daily) seconds = Math.max(seconds, ask({ window: "spend", seconds: DAY_SEC, free: c.spentLast24h + amount - dailyCap }));
    return expiresWithin(c, seconds) ? { kind: "never" } : { kind: "after", seconds };
  };

  if (over.rate) return deny("RATE_LIMIT", windowHint(), { maxCallsPerMinute: maxCalls, callsLastMinute: c.callsLastMinute });
  if (over.repeat) return deny("REPEAT_REQUEST", windowHint(), { maxRepeatsPerRequest: maxRepeats, sameRequestCalls: c.sameRequestCalls });
  if (over.hourly) return deny("HOURLY_CAP", windowHint(), { hourlyCap: hourlyCap.toString(), spentLastHour: c.spentLastHour.toString(), ...amounts() });
  if (over.daily) return deny("DAILY_CAP", windowHint(), { dailyCap: dailyCap.toString(), spentLast24h: c.spentLast24h.toString(), ...amounts() });
  if (over.total) return deny("TOTAL_CAP", { kind: "never" }, { cap: m.cap.toString(), spentTotal: c.spentTotal.toString(), ...amounts() });

  // Never decide on what the hub said long ago. The caller refreshes a snapshot older than the maximum age before it
  // gets here, so an old or missing one means that read failed: the escrow may be spent or the Budget revoked on chain
  // since, and the node cannot know. Refuse, and say that waiting (not funding) is what helps.
  if (!c.funds || c.fundsAgeMs > c.fundsMaxAgeMs) {
    return deny(
      "NET_EXPOSURE",
      expiresWithin(c, HUB_RETRY_SEC) ? { kind: "never" } : { kind: "after", seconds: HUB_RETRY_SEC, reason: "hub_unreadable" },
      {
        hubUnreadable: true,
        fundsKnown: c.funds !== null,
        fundsAgeMs: c.funds ? c.fundsAgeMs : null,
        fundsMaxAgeMs: c.fundsMaxAgeMs,
        outstanding: c.budgetOutstanding.toString(),
        ...amounts(),
      },
      HUB_UNREADABLE_MESSAGE,
    );
  }

  // Fail closed on unsettled exposure, counting escrow only. The hub debits only escrow at settlement (one Budget per
  // owner per batch), so this Budget's unsettled spending plus this call must fit its escrow. Neither hub credit nor
  // unsettled incoming calls widen the limit: credit cannot pay a net debit, and an offset may never settle.
  const { escrow, credit } = c.funds;
  const projected = c.budgetOutstanding + amount;
  if (projected > escrow) {
    return deny("NET_EXPOSURE", exposureHint(c, amount, projected, escrow, credit), {
      projected: projected.toString(),
      escrow: escrow.toString(),
      outstanding: c.budgetOutstanding.toString(),
      ...amounts(),
      credit: credit.toString(),
      incoming: c.ownerIncoming.toString(),
      fundsKnown: true,
    });
  }
  return { ok: true };
}

/** True when the Budget is past validUntil `seconds` from now: a retry then meets BUDGET_NOT_ACTIVE. */
function expiresWithin(c: VoucherContext, seconds: number): boolean {
  return c.budget !== null && c.nowMs + BigInt(Math.ceil(seconds)) * 1000n > c.budget.validUntilMs;
}

/**
 * What would let a NET_EXPOSURE call through. Settling helps only when it leaves room: the batch debits escrow by the
 * owner's net debit (outgoing minus what the owner is owed in the same window) and clears the outstanding amount.
 * Otherwise escrow must grow, from a deposit or from the owner's hub credit through `fund_from_credit`.
 */
function exposureHint(c: VoucherContext, amount: bigint, projected: bigint, escrow: bigint, credit: bigint): RetryHint {
  const shortBy = projected - escrow;
  if (c.budgetOutstanding > 0n) {
    const netDebit = c.budgetOutstanding > c.ownerIncoming ? c.budgetOutstanding - c.ownerIncoming : 0n;
    if (amount <= escrow - netDebit) return { kind: "after_settlement" };
  }
  if (credit === 0n) return { kind: "fund", shortBy: shortBy.toString() };
  return {
    kind: "fund",
    shortBy: shortBy.toString(),
    fromCredit: { action: "fund_from_credit", budgetId: c.voucher.budgetId, amount: (credit < shortBy ? credit : shortBy).toString(), credit: credit.toString() },
  };
}
