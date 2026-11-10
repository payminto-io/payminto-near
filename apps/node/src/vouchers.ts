import { randomBytes } from "node:crypto";
import {
  DENIAL_RULES,
  nodeDigest,
  verifyDigest,
  voucherCallId,
  voucherDigest,
  type AccountId,
  type ClearingReceipt,
  type DenialRule,
  type Id32,
  type Policy,
  type PublicKey,
  type Refusal,
  type RefusalRecord,
  REPEAT_WINDOW_SEC,
  type Sig64,
} from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import { DEFAULT_FUNDS_MAX_AGE_MS, DEFAULT_NEW_PAYEE_LIMITS, type NewPayeeLimits } from "./config.ts";
import type { Database } from "./db/database.ts";
import { ApiError } from "./errors.ts";
import type { EventBus } from "./events.ts";
import type { FundsTracker } from "./funds.ts";
import { accounts, type Ledger } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import type { PayeeService } from "./payees/service.ts";
import { evaluateVoucher, type Decision, type WindowQuery } from "./policy-engine.ts";
import { callJson, denialJson, nowIso, type BudgetRow, type CallRow, type DenialRow, type ProviderRow, type Store } from "./store.ts";

export type VoucherInput = {
  budgetId: Id32;
  payee: AccountId;
  amount: bigint;
  cumulative: bigint;
  signature: Sig64;
  requestHash: Id32;
};

export type PositionJson = { budgetId: Id32; payee: AccountId; cumulative: string; settled: string };

/**
 * The node's record of a refusal with its signature (see `refusalDigest` in @payminto/protocol). `callId` is the id the
 * call would have had; `timestamp` is when the node first refused it, `lastSeen` and `repeats` count folded replays.
 */
export type SignedRefusal = RefusalRecord & { callId: Id32; lastSeen: number; repeats: number; digest: Id32; nodeSignature: Sig64; node: PublicKey };

/** What `error.details.record` carries with a 402: enough, with the voucher and the refusal next to it, to check the signature. */
export type RefusalRecordRef = Pick<SignedRefusal, "id" | "timestamp" | "digest" | "nodeSignature" | "node">;

/** A refusal just recorded: the row, its structured refusal, the Budget owner (null for an unknown Budget) and the provider refused. */
export type DenialNotice = { denial: DenialRow; refusal: Refusal | null; owner: AccountId | null; provider: ProviderRow };

export type AcceptResult =
  | { ok: true; receipt: ClearingReceipt; position: PositionJson }
  | { ok: false; rule: DenialRule; message: string; details: Record<string, unknown>; refusal: Refusal; position: PositionJson };

/**
 * A voucher that is not signed by its Budget's agent key, or names a Budget this node does not know (so there is no
 * key to check it against). Anyone holding a provider key can post such a voucher for any public Budget id, so it is
 * never a refusal: it is answered with this plain error, counted against the sender's unsigned-voucher limit, and
 * never recorded as a denial, an event or a webhook in the owner's name.
 */
export class UnsignedVoucherError extends ApiError {
  declare readonly code: "UNKNOWN_BUDGET" | "BAD_SIGNATURE";
  constructor(code: "UNKNOWN_BUDGET" | "BAD_SIGNATURE") {
    super(402, code, DENIAL_RULES[code]);
    this.name = "UnsignedVoucherError";
  }
}

/**
 * Deterministic call id: unique per (budget, payee, cumulative) because cumulative strictly increases.
 * This is `voucherCallId` of @payminto/chain, the one definition the SDK and the hub contract share.
 */
export const callIdOf = voucherCallId;

/** Funds snapshots older than this are re-read from chain before a NET_EXPOSURE denial is final. */
const FUNDS_STALE_MS = 2_000;

export class VoucherService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #ledger: Ledger;
  readonly #events: EventBus;
  readonly #funds: FundsTracker;
  readonly #log: Logger;
  /** The payee check, decided after the signature check and before the Budget's own rules. Null: no check. */
  readonly #payees: PayeeService | null;
  readonly #clockMs: () => number;
  readonly #denialDedupSec: number;
  /**
   * FUNDS_MAX_AGE_MS. A snapshot older than this is re-read from the hub before a call is decided; the read also sees
   * an on-chain revoke. If that read fails the call is refused (policy-engine.ts), so neither stale escrow nor a missed
   * revoke outlives this age.
   */
  readonly #fundsMaxAgeMs: number;
  /** NEW_PAYEE_MIN_AMOUNT and NEW_PAYEES_PER_HOUR: what a Budget may make this node's settler pay for in new pairs. */
  readonly #newPayees: NewPayeeLimits;
  /**
   * Runs inside the transaction that records a new refusal (decision 8: the refusal webhook goes out through the outbox
   * with it). A replay folded into an existing row within the dedup window does not run it again.
   */
  onDenial: ((n: DenialNotice) => void) | null = null;

  constructor(deps: {
    db: Database;
    store: Store;
    chain: ChainClient;
    ledger: Ledger;
    events: EventBus;
    funds: FundsTracker;
    log: Logger;
    payees?: PayeeService | null;
    /** Unix milliseconds. */
    clockMs?: () => number;
    /** Identical denials within this many seconds fold into one row (0 disables). */
    denialDedupSec?: number;
    /** Oldest funds snapshot a call may be decided on, in milliseconds. Default: DEFAULT_FUNDS_MAX_AGE_MS. */
    fundsMaxAgeMs?: number;
    /** Limits on payees new to a Budget. Default: DEFAULT_NEW_PAYEE_LIMITS. */
    newPayees?: NewPayeeLimits;
  }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#ledger = deps.ledger;
    this.#events = deps.events;
    this.#funds = deps.funds;
    this.#log = deps.log;
    this.#payees = deps.payees ?? null;
    this.#clockMs = deps.clockMs ?? (() => Date.now());
    this.#denialDedupSec = deps.denialDedupSec ?? 60;
    this.#fundsMaxAgeMs = deps.fundsMaxAgeMs ?? DEFAULT_FUNDS_MAX_AGE_MS;
    this.#newPayees = deps.newPayees ?? DEFAULT_NEW_PAYEE_LIMITS;
  }

  /** Unix seconds: the node-attested timestamp of a call, and the unit of every rolling window. */
  #clock(): number {
    return Math.floor(this.#clockMs() / 1000);
  }

  positionJson(budgetId: Id32, payee: AccountId): PositionJson {
    const p = this.#store.position(budgetId, payee);
    return { budgetId, payee, cumulative: p.cumulative.toString(), settled: p.settled.toString() };
  }

  /** True when `v` is signed by its Budget's agent key. False for an unknown Budget. */
  isSignedByAgent(v: VoucherInput): boolean {
    const m = this.#store.budget(v.budgetId);
    return m ? this.#signatureValid(m.agent, v) : false;
  }

  /**
   * The Budget whose agent key signed `v`. Runs before anything is read, evaluated or recorded for a voucher: until the
   * signature checks out, nothing in the voucher can be attributed to the agent or its owner.
   */
  signedBudget(v: VoucherInput): BudgetRow {
    const m = this.#store.budget(v.budgetId);
    if (!m) throw new UnsignedVoucherError("UNKNOWN_BUDGET");
    if (!this.#signatureValid(m.agent, v)) throw new UnsignedVoucherError("BAD_SIGNATURE");
    return m;
  }

  #signatureValid(agent: PublicKey, v: VoucherInput): boolean {
    const { hub, network } = this.#chain;
    return verifyDigest(agent, voucherDigest(hub, network, v), v.signature);
  }

  #attest(v: VoucherInput, now: number): { digest: Id32; nodeSignature: Sig64 } {
    const digest = nodeDigest({ callId: callIdOf(v), budgetId: v.budgetId, payee: v.payee, amount: v.amount, cumulative: v.cumulative, requestHash: v.requestHash, timestamp: BigInt(now), voucherSig: v.signature });
    return { digest, nodeSignature: this.#chain.signAcceptance(digest) };
  }

  /**
   * `onAccepted` runs inside the acceptance transaction after the call is recorded (the gateway books its payment
   * credit there, so a call and its credit commit together); throwing from it rolls the call back.
   */
  async accept(provider: ProviderRow, v: VoucherInput, opts: { onAccepted?: (callId: Id32) => void } = {}): Promise<AcceptResult> {
    const budgetId = v.budgetId.toLowerCase();
    const input = { ...v, budgetId };
    const now = this.#clock();
    const m0 = this.signedBudget(input);
    const blocked = await this.#payeeGate(provider, input, now, m0, input.amount);
    if (blocked) return blocked;
    // A failed read is not an error here: the decision below refuses when it leaves the snapshot older than its maximum age.
    await this.#funds.ensure(m0, this.#fundsMaxAgeMs).catch((err) => this.#log.warn("funds read failed", { budgetId, err }));
    const { digest, nodeSignature } = this.#attest(input, now);

    let result = this.#decide(provider, input, now, digest, nodeSignature, { isRetry: false, onAccepted: opts.onAccepted });
    if ("retryable" in result) {
      await this.#funds.refresh(m0).catch((err) => this.#log.warn("funds refresh failed", { budgetId, err }));
      result = this.#decide(provider, input, now, digest, nodeSignature, { isRetry: true, onAccepted: opts.onAccepted });
    }
    if ("retryable" in result) throw new Error("funds decision deferred twice");
    return result;
  }

  /**
   * Accepts the vouchers of one request all or nothing (a gateway payment split between the merchant and the platform
   * fee): every voucher is evaluated in one BEGIN IMMEDIATE transaction, in order, each seeing the ones before it. If
   * any is denied the transaction rolls back, the first denial is recorded on its own, and nothing is accepted.
   * `onAccepted` runs in that transaction with every call id; throwing from it rolls everything back.
   *
   * The request is one call for the Budget's limits: every cap (per call, per hour, per day, the Budget cap and the
   * exposure limit) is checked against the total a Budget pays in this request, on its first voucher, and the request
   * counts once toward the per-minute and same-request limits. A client cannot get under a cap by splitting.
   */
  async acceptAll(
    items: ReadonlyArray<{ provider: ProviderRow; voucher: VoucherInput }>,
    opts: { onAccepted?: (callIds: Id32[]) => void } = {},
  ): Promise<{ ok: true; results: Array<Extract<AcceptResult, { ok: true }>> } | { ok: false; index: number; denial: Extract<AcceptResult, { ok: false }> }> {
    const now = this.#clock();
    const prepared: Array<{ provider: ProviderRow; input: VoucherInput; digest: Id32; nodeSignature: Sig64; agent: PublicKey; requestAmount: bigint; requestPart: number }> = [];
    const budgets = new Map<Id32, BudgetRow>();
    // Every signature first: one unsigned voucher makes the whole request nobody's, before any of it is evaluated.
    for (const { provider, voucher: v } of items) {
      const input = { ...v, budgetId: v.budgetId.toLowerCase() };
      const m = this.signedBudget(input);
      budgets.set(m.id, m);
      prepared.push({ provider, input, ...this.#attest(input, now), agent: m.agent, requestAmount: 0n, requestPart: 0 });
    }
    // Per Budget: each voucher carries its own amount plus those still to come, so the first one carries the total.
    for (const [i, p] of prepared.entries()) {
      const sameBudget = (q: (typeof prepared)[number]) => q.input.budgetId === p.input.budgetId;
      p.requestPart = prepared.slice(0, i).filter(sameBudget).length;
      p.requestAmount = prepared.slice(i).filter(sameBudget).reduce((s, q) => s + q.input.amount, 0n);
    }
    // The payee check, for every payee of the request, before any of it is evaluated: the first refusal is the answer.
    for (const [index, p] of prepared.entries()) {
      const total = prepared.filter((q) => q.input.budgetId === p.input.budgetId).reduce((s, q) => s + q.input.amount, 0n);
      const blocked = await this.#payeeGate(p.provider, p.input, now, budgets.get(p.input.budgetId)!, total);
      if (blocked) return { ok: false, index, denial: blocked };
    }
    // Fresh funds once up front: the batch decides on them without a second pass.
    for (const b of budgets.values()) await this.#funds.refresh(b).catch((err) => this.#log.warn("funds refresh failed", { budgetId: b.id, err }));
    const rollback = Symbol("rollback");
    let denied: { index: number; rule: DenialRule; message: string; details: Record<string, unknown>; refusal: Refusal } | null = null;
    const results: Array<Extract<AcceptResult, { ok: true }>> = [];
    try {
      this.#db.tx(() => {
        prepared.forEach((p, index) => {
          const r = this.#decide(p.provider, p.input, now, p.digest, p.nodeSignature, { isRetry: true, deferDenials: true, requestAmount: p.requestAmount, requestPart: p.requestPart });
          if (!r.ok) {
            denied = { index, rule: r.rule, message: r.message, details: r.details, refusal: r.refusal };
            throw rollback;
          }
          results.push(r);
        });
        opts.onAccepted?.(results.map((r) => r.receipt.callId));
      });
    } catch (err) {
      if (err !== rollback) throw err;
    }
    const d = denied as { index: number; rule: DenialRule; message: string; details: Record<string, unknown>; refusal: Refusal } | null;
    if (!d) return { ok: true, results };
    const p = prepared[d.index]!;
    const record = this.#recordOf(this.#db.tx(() => this.#writeDenial(p.provider, p.input, now, d.rule, d.message, p.agent, d.details)));
    return {
      ok: false,
      index: d.index,
      denial: { ok: false, rule: d.rule, message: d.message, details: { ...d.details, record }, refusal: d.refusal, position: this.positionJson(p.input.budgetId, p.input.payee) },
    };
  }

  /**
   * The payee check for one voucher the Budget's agent signed (payees/service.ts). It may read the chain, so it runs
   * before the acceptance transaction. A refusal is recorded like any other: a row, its event, the `budget.refused`
   * webhook and a signed record. `total` is the price of the whole request, which is what the refusal reports.
   */
  async #payeeGate(provider: ProviderRow, v: VoucherInput, now: number, m: BudgetRow, total: bigint): Promise<Extract<AcceptResult, { ok: false }> | null> {
    if (!this.#payees) return null;
    const r = await this.#payees.guard(m, v.payee, total);
    if (!r) return null;
    return this.#db.tx(() => {
      const spent = BigInt(this.#db.get<{ s: string }>("SELECT bigsum(cumulative) AS s FROM positions WHERE budget_id = ?", m.id)!.s);
      const cap = BigInt(m.cap);
      const refusal: Refusal = { rule: r.rule, message: r.message, attemptedAmount: total.toString(), remainingBudget: (cap > spent ? cap - spent : 0n).toString(), retry: r.retry };
      const position = this.positionJson(v.budgetId, v.payee);
      const details: Record<string, unknown> = { ...r.details, refusal, position };
      const record = this.#recordOf(this.#writeDenial(provider, v, now, r.rule, r.message, m.agent, details));
      return { ok: false, rule: r.rule, message: r.message, details: { ...details, record }, refusal, position };
    });
  }

  /** The atomic part: load state, evaluate every rule in order, and record the call or the denial in one BEGIN IMMEDIATE. */
  #decide(
    provider: ProviderRow,
    v: VoucherInput,
    now: number,
    digest: Id32,
    nodeSignature: Sig64,
    o: {
      /** False on the first pass, where a NET_EXPOSURE verdict on a snapshot a few seconds old is deferred for a fresh read. */
      isRetry: boolean;
      onAccepted?: (callId: Id32) => void;
      /** A request of several vouchers records its denial after rolling back. */
      deferDenials?: boolean;
      /** This voucher's amount plus the amounts of its request's vouchers still to come (see `acceptAll`). */
      requestAmount?: bigint;
      /** Position within its request; 0 for the first or only voucher. */
      requestPart?: number;
    },
  ): AcceptResult | { ok: false; rule: DenialRule; message: string; details: Record<string, unknown>; refusal: Refusal; position: PositionJson; retryable: true } {
    const { isRetry, onAccepted, deferDenials = false, requestPart = 0 } = o;
    const db = this.#db;
    // A first NET_EXPOSURE verdict on a stale snapshot is not recorded; the caller refreshes and decides again.
    let deferred: Extract<Decision, { ok: false }> | null = null;
    let deferredDetails: Record<string, unknown> | null = null;
    const out = db.tx((): AcceptResult | null => {
      const m = this.#store.budget(v.budgetId);
      const position = m ? this.#store.position(m.id, v.payee) : { cumulative: 0n, settled: 0n };
      // Payees this Budget paid for the first time after `since`: the first call of each payee, in the order they came.
      const firstCallsSince = (since: number, limit: number, offset: number) =>
        db.all<{ first: number }>(
          "SELECT first FROM (SELECT MIN(timestamp) AS first FROM calls WHERE budget_id = ? GROUP BY payee) WHERE first > ? ORDER BY first LIMIT ? OFFSET ?",
          m!.id,
          since,
          limit,
          offset,
        );
      const isNewPayee = m !== null && position.cumulative === 0n && position.settled === 0n;
      const spentSince = (sec: number) => BigInt(db.get<{ s: string }>("SELECT bigsum(amount) AS s FROM calls WHERE budget_id = ? AND timestamp > ?", m!.id, now - sec)!.s);
      const funds = m ? this.#store.budgetFunds(m.id) : null;
      // When enough of a rolling window has passed for a refused call to fit. Read only to build a refusal's hint. A
      // call leaves a window of `seconds` at its timestamp plus `seconds`: the windows count `timestamp > now - seconds`.
      const waitFor = (q: WindowQuery): number | null => {
        if (!m) return null;
        const since = now - q.seconds;
        if (q.window === "spend") {
          let freed = 0n;
          for (const r of db.all<{ timestamp: number; amount: string }>("SELECT timestamp, amount FROM calls WHERE budget_id = ? AND timestamp > ? ORDER BY timestamp, seq", m.id, since)) {
            freed += BigInt(r.amount);
            if (freed >= q.free) return r.timestamp + q.seconds - now;
          }
          return null;
        }
        const nth =
          q.window === "calls"
            ? db.get<{ timestamp: number }>("SELECT timestamp FROM calls WHERE budget_id = ? AND request_part = 0 AND timestamp > ? ORDER BY timestamp, seq LIMIT 1 OFFSET ?", m.id, since, q.leave - 1)
            : db.get<{ timestamp: number }>(
                "SELECT timestamp FROM calls WHERE budget_id = ? AND request_hash = ? AND request_part = 0 AND timestamp > ? ORDER BY timestamp, seq LIMIT 1 OFFSET ?",
                m.id,
                v.requestHash,
                since,
                q.leave - 1,
              );
        if (q.window === "newPayees") {
          const first = firstCallsSince(since, 1, q.leave - 1)[0];
          return first ? first.first + q.seconds - now : null;
        }
        return nth ? nth.timestamp + q.seconds - now : null;
      };
      const decision = evaluateVoucher({
        now,
        // Read at decision time, after any chain reads awaited before it: expiry is checked to the millisecond.
        nowMs: BigInt(this.#clockMs()),
        provider: { payee: provider.payee, priceAtomic: BigInt(provider.price_atomic) },
        voucher: v,
        ...(o.requestAmount !== undefined ? { requestAmount: o.requestAmount } : {}),
        requestPart,
        waitFor,
        // Checked by `signedBudget` before this transaction; the agent key of a Budget never changes.
        signatureValid: true,
        budget: m
          ? {
              status: m.status,
              cap: BigInt(m.cap),
              validUntilMs: BigInt(m.valid_until_ms),
              payees: JSON.parse(m.payees) as AccountId[],
              policy: JSON.parse(m.policy) as Policy,
            }
          : null,
        position: position.cumulative,
        // Requests, not vouchers: the later vouchers of a split request (request_part > 0) are not counted again.
        callsLastMinute: m ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ? AND request_part = 0 AND timestamp > ?", m.id, now - 60)!.n : 0,
        sameRequestCalls: m
          ? db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM calls WHERE budget_id = ? AND request_hash = ? AND request_part = 0 AND timestamp > ?",
              m.id,
              v.requestHash,
              now - REPEAT_WINDOW_SEC,
            )!.n
          : 0,
        spentLastHour: m ? spentSince(3_600) : 0n,
        spentLast24h: m ? spentSince(86_400) : 0n,
        spentTotal: m ? BigInt(db.get<{ s: string }>("SELECT bigsum(cumulative) AS s FROM positions WHERE budget_id = ?", m.id)!.s) : 0n,
        budgetOutstanding: m ? this.#store.budgetOutstanding(m.id) : 0n,
        ownerIncoming: m ? this.#store.incomingOutstanding(m.owner) : 0n,
        funds,
        fundsAgeMs: funds ? this.#clockMs() - funds.refreshedAt : 0,
        fundsMaxAgeMs: this.#fundsMaxAgeMs,
        newPayee: {
          isNew: isNewPayee,
          lastHour:
            isNewPayee && this.#newPayees.maxPerHour > 0
              ? db.get<{ n: number }>("SELECT COUNT(*) AS n FROM (SELECT MIN(timestamp) AS first FROM calls WHERE budget_id = ? GROUP BY payee) WHERE first > ?", m!.id, now - 3_600)!.n
              : 0,
          minFirstAmount: this.#newPayees.minFirstAmount,
          maxPerHour: this.#newPayees.maxPerHour,
        },
      });

      const positionAfter = (cumulative: bigint): PositionJson => ({
        budgetId: v.budgetId,
        payee: v.payee,
        cumulative: cumulative.toString(),
        settled: position.settled.toString(),
      });

      if (!decision.ok) {
        // Unreachable after `signedBudget`, and kept that way: these two are never written in the owner's name.
        if (decision.rule === "UNKNOWN_BUDGET" || decision.rule === "BAD_SIGNATURE") throw new UnsignedVoucherError(decision.rule);
        if (decision.rule === "NET_EXPOSURE" && !isRetry && (!funds || this.#clockMs() - funds.refreshedAt > FUNDS_STALE_MS)) {
          deferred = decision;
          return null;
        }
        const details: Record<string, unknown> = { ...decision.details, refusal: decision.refusal, position: positionAfter(position.cumulative) };
        // A batch (several vouchers that must all be accepted or none) records its denial after rolling back.
        if (deferDenials) {
          deferred = decision;
          deferredDetails = details;
          return null;
        }
        const record = this.#recordOf(this.#writeDenial(provider, v, now, decision.rule, decision.message, m!.agent, details));
        return { ok: false, rule: decision.rule, message: decision.message, details: { ...details, record }, refusal: decision.refusal, position: positionAfter(position.cumulative) };
      }

      const budget = m!;
      const callId = callIdOf(v);
      const acceptedAt = nowIso();
      const { lastInsertRowid: seq } = db.run(
        `INSERT INTO calls (call_id, budget_id, agent, payee, provider_id, amount, cumulative, request_hash, agent_signature,
                            timestamp, leaf, node_signature, status, accepted_at, request_part)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
        callId,
        budget.id,
        budget.agent,
        v.payee,
        provider.id,
        v.amount.toString(),
        v.cumulative.toString(),
        v.requestHash,
        v.signature,
        now,
        digest,
        nodeSignature,
        acceptedAt,
        requestPart,
      );
      db.run(
        `INSERT INTO positions (budget_id, payee, cumulative, settled) VALUES (?, ?, ?, '0')
         ON CONFLICT (budget_id, payee) DO UPDATE SET cumulative = excluded.cumulative`,
        budget.id,
        v.payee,
        v.cumulative.toString(),
      );
      this.#ledger.post("call.accepted", callId, `call ${provider.name}`, [
        { account: accounts.providerReceivable(v.payee), debit: v.amount },
        { account: accounts.ownerPayable(budget.owner), credit: v.amount },
      ]);
      const row = db.get<CallRow>("SELECT * FROM calls WHERE seq = ?", seq)!;
      onAccepted?.(callId);
      this.#events.emit("call.accepted", { call: callJson(row) });
      const receipt: ClearingReceipt = {
        callId,
        budgetId: budget.id,
        payee: v.payee,
        amount: v.amount.toString(),
        cumulative: v.cumulative.toString(),
        requestHash: v.requestHash,
        timestamp: now,
        voucherSig: v.signature,
        digest,
        nodeSignature,
        node: this.#chain.nodeKey,
      };
      return { ok: true, receipt, position: positionAfter(v.cumulative) };
    });
    if (out) return out;
    const d = deferred as Extract<Decision, { ok: false }> | null;
    if (!d) throw new Error("unreachable");
    const details = (deferredDetails as Record<string, unknown> | null) ?? { ...d.details, refusal: d.refusal };
    return { ok: false, rule: d.rule, message: d.message, details, refusal: d.refusal, position: this.positionJson(v.budgetId, v.payee), retryable: true };
  }

  /**
   * Records a denial row (folding identical repeats within the dedup window) and its SSE event, and returns the row
   * that now stands for this refusal. Only ever called for a voucher the Budget's agent key signed (`signedBudget`).
   */
  #writeDenial(provider: ProviderRow, v: VoucherInput, now: number, rule: DenialRule, message: string, agent: PublicKey, details: Record<string, unknown>): DenialRow {
    const db = this.#db;
    // A replayed voucher (same request, same cumulative, same verdict) bumps the existing row instead of adding one,
    // so a flood of retries cannot grow the denials and events tables without bound. The row keeps its id and first
    // timestamp and takes the latest refusal, whose retry hint may have moved on.
    if (this.#denialDedupSec > 0) {
      const dup = db.get<{ seq: number }>(
        `SELECT seq FROM denials
         WHERE budget_id = ? AND request_hash = ? AND cumulative = ? AND payee = ? AND provider_id = ? AND rule = ?
           AND agent_signature IS NOT NULL AND COALESCE(last_seen, timestamp) > ?
         ORDER BY seq DESC LIMIT 1`,
        v.budgetId,
        v.requestHash,
        v.cumulative.toString(),
        v.payee,
        provider.id,
        rule,
        now - this.#denialDedupSec,
      );
      if (dup) {
        db.run("UPDATE denials SET repeats = repeats + 1, last_seen = ?, message = ?, details = ? WHERE seq = ?", now, message, JSON.stringify(details), dup.seq);
        return db.get<DenialRow>("SELECT * FROM denials WHERE seq = ?", dup.seq)!;
      }
    }
    const row: DenialRow = {
      seq: 0,
      id: `dny_${randomBytes(8).toString("hex")}`,
      rule,
      message,
      budget_id: v.budgetId,
      agent,
      payee: v.payee,
      provider_id: provider.id,
      amount: v.amount.toString(),
      cumulative: v.cumulative.toString(),
      request_hash: v.requestHash,
      details: JSON.stringify(details),
      timestamp: now,
      at: nowIso(),
      repeats: 1,
      last_seen: null,
      agent_signature: v.signature,
    };
    const { lastInsertRowid } = db.run(
      `INSERT INTO denials (id, rule, message, budget_id, agent, payee, provider_id, amount, cumulative, request_hash, details, timestamp, at, agent_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.rule,
      row.message,
      row.budget_id,
      row.agent,
      row.payee,
      row.provider_id,
      row.amount,
      row.cumulative,
      row.request_hash,
      row.details,
      row.timestamp,
      row.at,
      row.agent_signature,
    );
    const saved = { ...row, seq: lastInsertRowid };
    this.#events.emit("call.denied", { denial: denialJson(saved) });
    this.onDenial?.({ denial: saved, refusal: (details.refusal as Refusal | undefined) ?? null, owner: this.#store.budget(v.budgetId)?.owner ?? null, provider });
    return saved;
  }

  /**
   * The node's signed record of a refusal it recorded: what an agent reads from its own node to confirm a refusal a
   * seller relayed (`GET /v1/budgets/:id/refusals`). Null for a row with no agent signature or no structured refusal
   * (recorded before the node checked signatures first): the node does not vouch for those.
   */
  signedRefusal(row: DenialRow): SignedRefusal | null {
    const refusal = (JSON.parse(row.details) as { refusal?: Refusal }).refusal;
    if (!row.agent_signature || !refusal) return null;
    const record: RefusalRecord = { id: row.id, budgetId: row.budget_id, payee: row.payee, amount: row.amount, cumulative: row.cumulative, requestHash: row.request_hash, timestamp: row.timestamp, refusal };
    const { digest, nodeSignature } = this.#chain.signRefusal(this.#chain.hub, this.#chain.network, record);
    return {
      ...record,
      callId: callIdOf({ budgetId: row.budget_id, payee: row.payee, cumulative: BigInt(row.cumulative), requestHash: row.request_hash }),
      lastSeen: row.last_seen ?? row.timestamp,
      repeats: row.repeats,
      digest,
      nodeSignature,
      node: this.#chain.nodeKey,
    };
  }

  /** The part of a signed refusal that travels with the 402 (`error.details.record`): the caller already has the rest. */
  #recordOf(row: DenialRow): RefusalRecordRef | null {
    const s = this.signedRefusal(row);
    return s ? { id: s.id, timestamp: s.timestamp, digest: s.digest, nodeSignature: s.nodeSignature, node: s.node } : null;
  }
}
