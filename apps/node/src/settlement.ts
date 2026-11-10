import { randomBytes } from "node:crypto";
import {
  buildReceiptTree,
  ChainError,
  type Batch,
  computeNetting,
  MAX_CLAIMS,
  settleDeadline,
  sha256Text,
  verifyDigest,
  voucherDigest,
  type AccountId,
  type Claim,
  type Id32,
  type NetEntry,
  type PublicKey,
  type ReceiptFields,
  type Sig64,
} from "@payminto/protocol";
import type { ChainClient } from "./chain.ts";
import type { Database } from "./db/database.ts";
import type { EventBus } from "./events.ts";
import type { FundsTracker } from "./funds.ts";
import { accounts, type Ledger, type Posting } from "./ledger.ts";
import type { Logger } from "./logger.ts";
import { Mutex } from "./mutex.ts";
import { grossGraph, projectNetting } from "./netting.ts";
import type { Metrics } from "./metrics.ts";
import { batchSummaryJson, nowIso, sellerSettlementJson, type BatchRow, type CallRow, type SellerSettlementJson, type SellerSettlementRow, type Store } from "./store.ts";

/** One claim candidate: the latest accepted voucher of a (Budget, payee) pair above what is settled. */
export type Candidate = {
  budgetId: Id32;
  owner: AccountId;
  agent: PublicKey;
  payee: AccountId;
  cumulative: bigint;
  settled: bigint;
  delta: bigint;
  amount: bigint;
  requestHash: Id32;
  agentSig: Sig64;
  calls: number;
};

export type DroppedClaim = { budgetId: Id32; payee: AccountId; reason: string };
/**
 * `sellerSettled`: what payees settled themselves on the hub since the last run, booked by this run outside any batch.
 * Always present next to `batchIds`; present on a skipped run only when it booked something.
 */
export type SettleResult =
  | { batchIds: Id32[]; batches: ReturnType<typeof batchSummaryJson>[]; dropped: DroppedClaim[]; sellerSettled: SellerSettlementJson[] }
  | { skipped: string; dropped?: DroppedClaim[]; sellerSettled?: SellerSettlementJson[] };

/** Something only the operator can resolve. Logged as an error, emitted as `operator.alert`, and counted for paging. */
export type OperatorAlert = { kind: "batch_mismatch" | "seller_settled_uncleared" | "settled_position_behind" | "claim_signature_invalid"; message: string } & Record<string, string | number | null>;

/** How one batch send ended. `stale`: the hub refused it because a settled position moved under it; rebuild and retry. */
type ChunkOutcome = { kind: "confirmed"; batchId: Id32 } | { kind: "stale" } | { kind: "failed" };

/**
 * A `settle_own` that lands while a batch is being built makes the hub refuse the whole batch. The node reads the hub
 * again, books what the seller settled, and rebuilds; a seller could race every rebuild, so the retries are bounded
 * and the rest waits for the next run.
 */
export const MAX_STALE_REBUILDS = 3;

const pairKey = (budgetId: Id32, payee: AccountId) => `${budgetId}:${payee}`;

/** Why a claim is left out of a batch when its voucher signature fails the hub's rule (`verifyDigest`). */
export const BAD_CLAIM_SIGNATURE = "the voucher signature fails the hub's ed25519 rule";

/** Unique per node and attempt. It cannot be derived from the root, because every leaf commits to the batch id. */
export function batchIdOf(hub: AccountId, network: string, operator: AccountId, seq: number, nonce: string): Id32 {
  return sha256Text(`payminto.batch.v1|${hub}|${network}|${operator}|${seq}|${nonce}`);
}

export function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/**
 * Packs candidates into batches of at most MAX_CLAIMS with one Budget per owner per batch, which the hub requires so that
 * each owner's net debit is limited by exactly one escrow. Owners stay together where possible, so their offsets land in one batch.
 */
export function packBatches(cands: readonly Candidate[], maxClaims = MAX_CLAIMS): Candidate[][] {
  const batches: Array<{ claims: Candidate[]; budgetOf: Map<AccountId, Id32> }> = [];
  for (const c of [...cands].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : a.budgetId < b.budgetId ? -1 : a.budgetId > b.budgetId ? 1 : 0))) {
    let batch = batches.find((b) => b.claims.length < maxClaims && (b.budgetOf.get(c.owner) ?? c.budgetId) === c.budgetId);
    if (!batch) {
      batch = { claims: [], budgetOf: new Map() };
      batches.push(batch);
    }
    batch.claims.push(c);
    batch.budgetOf.set(c.owner, c.budgetId);
  }
  return batches.map((b) => b.claims);
}

function toClaim(c: Candidate): Claim {
  return { budgetId: c.budgetId, payee: c.payee, amount: c.amount, cumulative: c.cumulative, requestHash: c.requestHash, signature: c.agentSig };
}

function receiptOf(c: CallRow): ReceiptFields {
  return {
    callId: c.call_id,
    budgetId: c.budget_id,
    payee: c.payee,
    amount: BigInt(c.amount),
    cumulative: BigInt(c.cumulative),
    requestHash: c.request_hash,
    timestampMs: BigInt(c.timestamp) * 1000n,
    voucherSig: c.agent_signature,
  };
}

export const receiptFieldsOf = receiptOf;

/**
 * A batch whose send failed without a verdict stays adoptable this long. NEAR drops a transaction whose reference block
 * is about a day old, so after two days the hub can no longer receive it and the batch is failed for good.
 */
export const UNKNOWN_BATCH_TTL_MS = 2 * 86_400_000;

/**
 * Builds batches from accepted calls and settles them through the `Chain` seam.
 *
 * Every send has one of three outcomes. The hub refusing it (ChainError) fails the batch and returns its calls to the
 * queue. The hub having it (also BATCH_EXISTS on a resend) books it. No verdict (a timeout, a dropped connection, a
 * restart while it was in flight) marks it `unknown` and returns its calls to the queue; before every later run the node
 * asks the hub again and adopts the batch if it landed after all, so a late landing never double-books or strands calls.
 * A batch is booked from the hub's record only when that record names this node as settler and stores this batch's
 * root; anything else under the node's batch id is a hard error that pages the operator.
 *
 * The node is not the only one who settles. A payee can settle its own latest voucher on the hub (`settle_own`, spec
 * decision 4), so before every run the node reads the hub's settled position of each pair it is about to claim and
 * books what the payee settled itself: those calls are settled outside any batch and have no Merkle proof. If a
 * `settle_own` lands after that read, the hub refuses the batch (STALE_VOUCHER, or NET_MISMATCH when it settled only
 * part of a claim); the node then reads again, books it, and rebuilds the batch without what is already settled.
 */
export class SettlementService {
  readonly #db: Database;
  readonly #store: Store;
  readonly #chain: ChainClient;
  readonly #ledger: Ledger;
  readonly #events: EventBus;
  readonly #funds: FundsTracker;
  readonly #log: Logger;
  readonly #writes: Mutex;
  readonly #metrics: Metrics | null;
  readonly #alerted = new Set<string>();
  /** Single flight: at most one settlement run, and a settled-position sync never overlaps one. */
  #running: Promise<SettleResult> | null = null;
  #syncing: Promise<SellerSettlementJson[]> | null = null;
  /** Run inside the transaction that books a confirmed batch (the gateway marks voucher payments paid there, payouts queue the creditors). */
  readonly confirmHooks: Array<(b: { seq: number; batchId: Id32; txHash: string | null }) => void> = [];
  /** Run inside the transaction that books what a payee settled itself, with the calls it settled. */
  readonly sellerSettledHooks: Array<(s: { seq: number; id: string; budgetId: Id32; payee: AccountId; callIds: Id32[] }) => void> = [];

  constructor(deps: { db: Database; store: Store; chain: ChainClient; ledger: Ledger; events: EventBus; funds: FundsTracker; log: Logger; writes?: Mutex; metrics?: Metrics }) {
    this.#db = deps.db;
    this.#store = deps.store;
    this.#chain = deps.chain;
    this.#ledger = deps.ledger;
    this.#events = deps.events;
    this.#funds = deps.funds;
    this.#log = deps.log.child({ component: "settlement" });
    this.#writes = deps.writes ?? new Mutex();
    this.#metrics = deps.metrics ?? null;
  }

  get running(): boolean {
    return this.#running !== null;
  }

  /**
   * Pages the operator: an error log line, an `operator.alert` event, and a counter to alert on. `once` names a
   * condition that every later run would find again; it is raised once per process, not on every sync.
   */
  #alert(a: OperatorAlert, once?: string): void {
    if (once !== undefined) {
      if (this.#alerted.has(once)) return;
      this.#alerted.add(once);
    }
    this.#log.error(`operator alert: ${a.message}`, a);
    this.#metrics?.inc("payminto_operator_alerts_total", "Conditions only the operator can resolve, by kind. Alert on any increase.", { kind: a.kind });
    this.#events.emit("operator.alert", { alert: a });
  }

  async idle(): Promise<void> {
    await this.#syncing?.catch(() => undefined);
    await this.#running?.catch(() => undefined);
  }

  candidates(): Candidate[] {
    const rows = this.#db.all<{ budget_id: Id32; payee: AccountId; cumulative: string; settled: string; agent: PublicKey; owner: AccountId }>(
      `SELECT p.budget_id, p.payee, p.cumulative, p.settled, m.agent, m.owner
       FROM positions p JOIN budgets m ON m.id = p.budget_id
       WHERE p.cumulative != p.settled
       ORDER BY m.owner, p.budget_id, p.payee`,
    );
    const out: Candidate[] = [];
    for (const r of rows) {
      const last = this.#db.get<{ agent_signature: Sig64; amount: string; request_hash: Id32 }>(
        "SELECT agent_signature, amount, request_hash FROM calls WHERE budget_id = ? AND payee = ? AND cumulative = ? AND status = 'accepted'",
        r.budget_id,
        r.payee,
        r.cumulative,
      );
      if (!last) continue; // already in a batch that is being settled
      const inFlight = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ? AND payee = ? AND status = 'settling'", r.budget_id, r.payee)!.n;
      if (inFlight > 0) continue;
      const calls = this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM calls WHERE budget_id = ? AND payee = ? AND status = 'accepted'", r.budget_id, r.payee)!.n;
      const cumulative = BigInt(r.cumulative);
      const settled = BigInt(r.settled);
      out.push({
        budgetId: r.budget_id,
        owner: r.owner,
        agent: r.agent,
        payee: r.payee,
        cumulative,
        settled,
        delta: cumulative - settled,
        amount: BigInt(last.amount),
        requestHash: last.request_hash,
        agentSig: last.agent_signature,
        calls,
      });
    }
    return out;
  }

  /** What settling now would do (GET /v1/netting/preview). Local data only, no chain reads. */
  preview() {
    const cands = this.candidates();
    const chunks = packBatches(cands).map((cs) => projectNetting(cs));
    const calls = cands.reduce((n, c) => n + c.calls, 0);
    const transfers = chunks.flatMap((p) => p.transfers);
    const grossTotal = cands.reduce((s, c) => s + c.delta, 0n);
    const netTotal = transfers.reduce((s, t) => s + t.amount, 0n);
    return {
      calls,
      claims: cands.length,
      batches: chunks.length,
      grossTotal: grossTotal.toString(),
      netTotal: netTotal.toString(),
      gross: grossGraph(cands.map((c) => ({ owner: c.owner, payee: c.payee, amount: c.delta, calls: c.calls }))).map((e) => ({ ...e, amount: e.amount.toString() })),
      net: transfers.map((t) => ({ from: t.from, to: t.to, amount: t.amount.toString() })),
      transfers: transfers.length,
      /** Calls per net transfer; 0 when there is nothing to settle. */
      compression: transfers.length > 0 ? calls / transfers.length : 0,
      savedTransfers: Math.max(0, calls - transfers.length),
    };
  }

  /** Single-flight settlement of every accepted call. A settled-position sync that is under way finishes first. */
  settle(trigger: "manual" | "interval"): Promise<SettleResult> {
    if (this.#running) return Promise.resolve({ skipped: "a settlement is already running" });
    const sync = this.#syncing?.catch(() => undefined) ?? Promise.resolve();
    const run = sync
      .then(() => this.#settle(trigger))
      .finally(() => {
        this.#running = null;
      });
    this.#running = run;
    return run;
  }

  /**
   * Books what payees settled themselves on the hub since the last look, without settling anything. Run between
   * settlements so a Budget's unsettled spending does not stay inflated (and NET_EXPOSURE does not block it) until
   * the next batch. Does nothing while a settlement runs: that run does the same read first.
   */
  syncSettled(): Promise<SellerSettlementJson[]> {
    if (this.#running) return Promise.resolve([]);
    if (this.#syncing) return this.#syncing;
    const run = (async () => {
      await this.#resolvePending();
      return (await this.#syncWithHub()).booked;
    })().finally(() => {
      this.#syncing = null;
    });
    this.#syncing = run;
    return run;
  }

  async #settle(trigger: "manual" | "interval"): Promise<SettleResult> {
    const chain = this.#chain.chain;
    // Single flight: any batch still marked submitted is left over from a crash, and unknown ones may have landed since.
    await this.#resolvePending();
    const sellerSettled: SellerSettlementJson[] = [];
    const dropped = new Map<string, DroppedClaim>();
    const batchIds: Id32[] = [];
    // Pairs whose batch the hub refused in this run for a reason a rebuild does not fix: left for the next run.
    const refused = new Set<string>();
    let sawCandidates = false;

    for (let round = 0; round <= MAX_STALE_REBUILDS; round++) {
      // The hub's settled positions first: what a payee settled itself is booked, never claimed again.
      const sync = await this.#syncWithHub();
      sellerSettled.push(...sync.booked);
      // A rebuild is for a settled position that moved. If none did, the hub refused the batch for another reason.
      if (round > 0 && sync.booked.length === 0) break;

      let cands = this.candidates().filter((c) => !refused.has(pairKey(c.budgetId, c.payee)));
      if (cands.length === 0) break;
      sawCandidates = true;
      const drop = (c: Candidate, reason: string) => {
        dropped.set(`${pairKey(c.budgetId, c.payee)}:${reason}`, { budgetId: c.budgetId, payee: c.payee, reason });
        cands = cands.filter((x) => x !== c);
      };

      const now = BigInt(Date.now());
      const ids = [...new Set(cands.map((c) => c.budgetId))];
      const onchain = new Map(await Promise.all(ids.map(async (id) => [id, await chain.budget(id)] as const)));
      for (const c of [...cands]) {
        const m = onchain.get(c.budgetId);
        const unresolved = sync.unresolved.get(pairKey(c.budgetId, c.payee));
        if (!m) drop(c, "budget is not open on chain");
        else if (now > settleDeadline(m)) drop(c, "budget is past its settlement deadline");
        else if (unresolved) drop(c, unresolved);
        else if (!this.#signedForHub(c, m.agentPk)) drop(c, BAD_CLAIM_SIGNATURE);
      }

      let stale = false;
      for (const group of packBatches(cands)) {
        const claims = this.#fundedClaims(group, onchain, drop);
        if (claims.length === 0) continue;
        const out = await this.#settleChunk(claims, trigger);
        if (out.kind === "confirmed") batchIds.push(out.batchId);
        else if (out.kind === "stale") stale = true;
        else for (const c of claims) refused.add(pairKey(c.budgetId, c.payee));
      }
      if (!stale) break;
      if (round === MAX_STALE_REBUILDS) this.#log.warn("settled positions kept moving under the batch; the rest waits for the next run", { rebuilds: round });
    }

    const drops = [...dropped.values()];
    for (const d of drops) this.#funds.warn({ budgetId: d.budgetId, payee: d.payee, reason: d.reason });
    if (batchIds.length === 0) {
      const skipped = drops.length ? "no claim passed the on-chain pre-checks" : sawCandidates ? "no batch was confirmed" : "nothing to settle";
      return { skipped, ...(drops.length ? { dropped: drops } : {}), ...(sellerSettled.length ? { sellerSettled } : {}) };
    }
    return { batchIds, batches: batchIds.map((id) => batchSummaryJson(this.#store.batch(id)!, this.#chain.network)), dropped: drops, sellerSettled };
  }

  /**
   * Reads the hub's settled position of every pair with unsettled calls and books what moved without a batch of this
   * node: a payee's `settle_own`. `unresolved` names the pairs whose position differs and could not be booked now,
   * with the reason, so the caller leaves them out of this run's batches.
   */
  async #syncWithHub(): Promise<{ booked: SellerSettlementJson[]; unresolved: Map<string, string> }> {
    const chain = this.#chain.chain;
    const booked: SellerSettlementJson[] = [];
    const unresolved = new Map<string, string>();
    const pairs = this.#db.all<{ budget_id: Id32; payee: AccountId; settled: string }>(
      `SELECT p.budget_id, p.payee, p.settled FROM positions p
       WHERE p.cumulative != p.settled
         AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.budget_id = p.budget_id AND c.payee = p.payee AND c.status = 'settling')
       ORDER BY p.budget_id, p.payee`,
    );
    const touched = new Set<Id32>();
    const reads = await Promise.allSettled(pairs.map((p) => chain.settledOf(p.budget_id, p.payee)));
    for (const [i, p] of pairs.entries()) {
      const key = pairKey(p.budget_id, p.payee);
      const local = BigInt(p.settled);
      const read = reads[i]!;
      if (read.status === "rejected") {
        this.#log.warn("cannot read a settled position from the hub; the pair waits for the next run", { budgetId: p.budget_id, payee: p.payee, err: read.reason });
        unresolved.set(key, "the hub's settled position could not be read");
        continue;
      }
      const hub = read.value;
      if (hub === local) continue;
      if (hub < local) {
        // The hub can only move forward. A lower position means this database and this hub do not belong together.
        unresolved.set(key, `on-chain settled ${hub} is behind node position ${local}`);
        this.#alert(
          { kind: "settled_position_behind", message: "the hub's settled position is behind this node's", budgetId: p.budget_id, payee: p.payee, hubSettled: hub.toString(), nodeSettled: local.toString() },
          `behind:${key}:${hub}:${local}`,
        );
        continue;
      }
      // A batch of this node whose send got no verdict may have landed since #resolvePending looked. Read after the
      // position: if the hub still has none of them, the position did not move through this node.
      const own = await this.#unknownBatchLanded(p.budget_id, p.payee);
      if (own !== false) {
        unresolved.set(key, own === null ? "a batch of this node for this pair could not be read from the hub" : "a batch of this node for this pair landed; it is booked on the next run");
        continue;
      }
      const row = this.#bookSellerSettlement(p.budget_id, p.payee, hub);
      if (row) {
        booked.push(sellerSettlementJson(row));
        touched.add(p.budget_id);
      }
    }
    // The hub debited these Budgets' escrow: read it again so the exposure limit and the pre-checks see it.
    for (const id of touched) {
      await this.#funds.refresh(this.#store.budget(id)!).catch((err) => this.#log.warn("funds refresh failed", { budgetId: id, err }));
    }
    return { booked, unresolved };
  }

  /**
   * Whether an `unknown` batch of this node that claims the pair is on the hub now: true, false, or null when the hub
   * could not be asked. Such a batch moves the settled position too, and must not be mistaken for a `settle_own`.
   */
  async #unknownBatchLanded(budgetId: Id32, payee: AccountId): Promise<boolean | null> {
    const batches = this.#db.all<{ batch_id: Id32 }>(
      "SELECT b.batch_id FROM batches b JOIN batch_claims c ON c.batch_seq = b.seq WHERE b.status = 'unknown' AND c.budget_id = ? AND c.payee = ?",
      budgetId,
      payee,
    );
    for (const b of batches) {
      try {
        if ((await this.#chain.chain.batch(b.batch_id)) !== null) return true;
      } catch {
        return null;
      }
    }
    return false;
  }

  /**
   * Books a settled position the hub moved to `hubSettled` without a batch of this node. Everything stays truthful:
   * - calls up to that position are settled, by the seller, with no batch and no Merkle proof;
   * - the ledger clears the payable and receivable of those calls and moves the same amount from the owner's escrow to
   *   the payee's hub credit, which is what `settle_own` does on the hub (no offset, no net);
   * - the position's settled amount follows the hub, so the next batch claims only what is still owed.
   * When the hub is past everything this node accepted, the payee settled a voucher the node never cleared. The node's
   * position follows the hub anyway (the hub counts it against the cap, and the agent's next voucher must extend it),
   * the uncleared part is booked as the cash movement it is, and the operator is paged.
   */
  #bookSellerSettlement(budgetId: Id32, payee: AccountId, hubSettled: bigint): SellerSettlementRow | null {
    const db = this.#db;
    let uncleared = 0n;
    const row = db.tx((): SellerSettlementRow | null => {
      const budget = this.#store.budget(budgetId)!;
      const position = this.#store.position(budgetId, payee);
      if (hubSettled <= position.settled) return null;
      const calls = db
        .all<CallRow>("SELECT * FROM calls WHERE budget_id = ? AND payee = ? AND status = 'accepted' ORDER BY seq", budgetId, payee)
        .filter((c) => BigInt(c.cumulative) > position.settled && BigInt(c.cumulative) <= hubSettled);
      const delta = hubSettled - position.settled;
      uncleared = hubSettled > position.cumulative ? hubSettled - position.cumulative : 0n;
      const cleared = delta - uncleared;
      const id = `sst_${randomBytes(8).toString("hex")}`;
      const { lastInsertRowid: seq } = db.run(
        "INSERT INTO seller_settlements (id, budget_id, payee, previous, cumulative, delta, uncleared, calls, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        budgetId,
        payee,
        position.settled.toString(),
        hubSettled.toString(),
        delta.toString(),
        uncleared.toString(),
        calls.length,
        nowIso(),
      );
      for (const c of calls) db.run("UPDATE calls SET status = 'settled', seller_settlement_seq = ? WHERE seq = ?", seq, c.seq);
      db.run(
        "UPDATE positions SET settled = ?, cumulative = ? WHERE budget_id = ? AND payee = ?",
        hubSettled.toString(),
        (hubSettled > position.cumulative ? hubSettled : position.cumulative).toString(),
        budgetId,
        payee,
      );
      const postings: Posting[] = [
        { account: accounts.ownerEscrow(budget.owner), credit: delta },
        { account: accounts.providerCredit(payee), debit: delta },
      ];
      if (cleared > 0n) {
        postings.push({ account: accounts.ownerPayable(budget.owner), debit: cleared }, { account: accounts.providerReceivable(payee), credit: cleared });
      }
      this.#ledger.post("seller.settled", id, `settled by ${payee} with settle_own`, postings);
      for (const hook of this.sellerSettledHooks) hook({ seq, id, budgetId, payee, callIds: calls.map((c) => c.call_id) });
      const saved = this.#store.sellerSettlement(seq)!;
      this.#events.emit("seller.settled", { sellerSettlement: sellerSettlementJson(saved) });
      return saved;
    });
    if (!row) return null;
    this.#log.info("booked a seller settlement", { id: row.id, budgetId, payee, amount: row.delta, calls: row.calls });
    if (uncleared > 0n) {
      this.#alert({
        kind: "seller_settled_uncleared",
        message: "a payee settled a voucher on the hub that this node never accepted",
        sellerSettlement: row.id,
        budgetId,
        payee,
        uncleared: uncleared.toString(),
        hubSettled: hubSettled.toString(),
      });
    }
    return row;
  }

  /**
   * The hub's own signature rule, applied to a claim before it goes into a batch: the hub refuses a whole batch for one
   * voucher that fails `env::ed25519_verify`. Checked against the agent key the hub holds. Intake applies the same rule,
   * so a claim fails here only if it was accepted before the node used it, or its stored signature changed since; the
   * operator is told once per claim, and the claim stays accepted.
   */
  #signedForHub(c: Candidate, agentPk: PublicKey): boolean {
    const { hub, network } = this.#chain;
    if (verifyDigest(agentPk, voucherDigest(hub, network, toClaim(c)), c.agentSig)) return true;
    this.#alert(
      {
        kind: "claim_signature_invalid",
        message: "a claim's voucher signature fails the hub's ed25519 rule; it is left out of every batch",
        budgetId: c.budgetId,
        payee: c.payee,
        cumulative: c.cumulative.toString(),
        agentPk,
      },
      `claimsig:${c.budgetId}:${c.payee}:${c.cumulative}`,
    );
    return false;
  }

  /** Drops every claim of an owner whose escrow cannot cover its net debit, until the rest of the batch is fundable. */
  #fundedClaims(group: Candidate[], onchain: Map<Id32, { escrow: bigint } | null>, drop: (c: Candidate, reason: string) => void): Candidate[] {
    let claims = group;
    for (;;) {
      const { entries } = computeNetting(claims);
      const short = entries.filter((e) => {
        if (e.debit === 0n) return false;
        const owned = claims.find((c) => c.owner === e.account);
        return (onchain.get(owned!.budgetId)?.escrow ?? 0n) < e.debit;
      });
      if (short.length === 0) return claims;
      for (const c of claims.filter((x) => short.some((s) => s.account === x.owner))) drop(c, "owner escrow cannot cover its net debit");
      claims = claims.filter((x) => !short.some((s) => s.account === x.owner));
      if (claims.length === 0) return claims;
    }
  }

  async #settleChunk(claims: Candidate[], trigger: string): Promise<ChunkOutcome> {
    const db = this.#db;
    const { hub, network, operator } = this.#chain;
    const { entries, gross, net } = computeNetting(claims);
    const projection = projectNetting(claims);

    const { seq, batchId, root } = db.tx(() => {
      const { lastInsertRowid: seq } = db.run("INSERT INTO batches (status, token, trigger, created_at) VALUES ('building', ?, ?, ?)", this.#chain.token, trigger, nowIso());
      const batchId = batchIdOf(hub, network, operator, seq, randomBytes(16).toString("hex"));
      const calls: CallRow[] = [];
      const perClaim: number[] = [];
      for (const c of claims) {
        const rows = db
          .all<CallRow>("SELECT * FROM calls WHERE budget_id = ? AND payee = ? AND status = 'accepted' ORDER BY seq", c.budgetId, c.payee)
          .filter((r) => BigInt(r.cumulative) <= c.cumulative && BigInt(r.cumulative) > c.settled);
        perClaim.push(rows.length);
        calls.push(...rows);
      }
      const tree = buildReceiptTree(hub, network, batchId, calls.map(receiptOf));
      this.#store.updateBatch(seq, {
        batch_id: batchId,
        receipts_root: tree.root,
        claims: claims.length,
        calls: calls.length,
        projected_gross: gross.toString(),
        projected_net: net.toString(),
        transfers: projection.transfers.length,
      });
      for (const c of calls) {
        db.run("UPDATE calls SET status = 'settling', batch_seq = ?, proof = ? WHERE seq = ?", seq, JSON.stringify(tree.proofOf(c.call_id)), c.seq);
      }
      claims.forEach((c, i) => {
        db.run(
          `INSERT INTO batch_claims (batch_seq, idx, budget_id, agent, payee, cumulative, previous, delta, amount, request_hash, calls, agent_signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          seq,
          i,
          c.budgetId,
          c.agent,
          c.payee,
          c.cumulative.toString(),
          c.settled.toString(),
          c.delta.toString(),
          c.amount.toString(),
          c.requestHash,
          perClaim[i]!,
          c.agentSig,
        );
      });
      for (const e of entries) db.run("INSERT INTO batch_net (batch_seq, account, debit, credit) VALUES (?, ?, ?, ?)", seq, e.account, e.debit.toString(), e.credit.toString());
      projection.transfers.forEach((t, i) => db.run("INSERT INTO net_transfers (batch_seq, idx, from_addr, to_addr, amount) VALUES (?, ?, ?, ?, ?)", seq, i, t.from, t.to, t.amount.toString()));
      this.#events.emit("batch.started", { batch: batchSummaryJson(this.#store.batch(String(seq))!, network) });
      return { seq, batchId, root: tree.root };
    });

    db.tx(() => {
      this.#store.updateBatch(seq, { status: "submitted", submitted_at: nowIso() });
      this.#events.emit("batch.submitted", { batch: batchSummaryJson(this.#store.batch(String(seq))!, network) });
    });
    try {
      const txHash = await this.#writes.run(() => this.#chain.chain.settle({ batchId, root, claims: claims.map(toClaim), expectedNet: entries }));
      this.#confirm(seq, txHash, entries);
      return { kind: "confirmed", batchId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof ChainError) {
        // BATCH_EXISTS means an earlier send of this id landed: book it from the hub rather than failing the calls.
        if (err.code === "BATCH_EXISTS") return (await this.#reconcile(seq)) ? { kind: "confirmed", batchId } : { kind: "failed" };
        // A settled position moved between the node's read and the hub's check, which is what a payee's `settle_own`
        // does: at or past a claim it makes the claim stale, below it the claim is worth less than the net says. The
        // hub refused the whole batch and nothing landed; the caller reads the positions again and rebuilds.
        if (err.code === "STALE_VOUCHER" || err.code === "NET_MISMATCH") {
          this.#log.warn("batch refused because a settled position moved; rebuilding it", { seq, code: err.code });
          this.#fail(seq, `${message}; the settled positions are read again and the batch is rebuilt`);
          return { kind: "stale" };
        }
        this.#log.error("batch refused by the hub", { seq, err });
        this.#fail(seq, message);
        return { kind: "failed" };
      }
      // No verdict. The hub may have it already, or may still get it.
      const landed = await this.#chain.chain.batch(batchId).catch(() => undefined);
      if (landed) {
        if (!this.#ownsRecord(seq, landed)) return { kind: "failed" };
        this.#confirm(seq, null, entries);
        return { kind: "confirmed", batchId };
      }
      this.#log.warn("batch outcome unknown; its calls go back to the queue and the batch is adopted if it lands", { seq, err });
      this.#markUnknown(seq, message);
      return { kind: "failed" };
    }
  }

  /**
   * True when the hub's record under this batch id is this node's batch: settled by this node's account, with the root
   * this node built. Anything else is never booked. The hub will not take this id again, so the batch is failed for
   * good (its calls return to the queue for a new batch id if they were still held) and the operator is paged:
   * somebody else settled under an id only this node should know.
   */
  #ownsRecord(seq: number, onchain: Batch): boolean {
    const row = this.#store.batch(String(seq))!;
    const why =
      onchain.settler !== this.#chain.operator
        ? `the hub's batch under this id was settled by ${onchain.settler}, not by this node (${this.#chain.operator})`
        : onchain.root !== row.receipts_root
          ? "the hub stores another receipts root under this batch id"
          : null;
    if (why === null) return true;
    this.#fail(seq, why);
    this.#alert({ kind: "batch_mismatch", message: why, batchId: row.batch_id, seq, hubSettler: onchain.settler, hubRoot: onchain.root, nodeRoot: row.receipts_root });
    return false;
  }

  #confirm(seq: number, txHash: string | null, entries: readonly NetEntry[]): void {
    const db = this.#db;
    const { network } = this.#chain;
    db.tx(() => {
      const batch = this.#store.batch(String(seq))!;
      if (batch.status === "confirmed") return;
      const claims = this.#store.batchClaims(seq);
      const gross = claims.reduce((s, c) => s + BigInt(c.delta), 0n);
      const net = entries.reduce((s, e) => s + e.credit, 0n);
      this.#store.updateBatch(seq, { status: "confirmed", tx_hash: txHash, gross: gross.toString(), net: net.toString(), confirmed_at: nowIso(), reconciled: 1 });
      db.run("UPDATE calls SET status = 'settled' WHERE batch_seq = ?", seq);
      for (const c of claims) db.run("UPDATE positions SET settled = ? WHERE budget_id = ? AND payee = ?", c.cumulative, c.budget_id, c.payee);

      const owners = new Map(claims.map((c) => [c.budget_id, this.#store.budget(c.budget_id)!.owner]));
      const postings: Posting[] = claims.flatMap((c) => [
        { account: accounts.ownerPayable(owners.get(c.budget_id)!), debit: BigInt(c.delta) },
        { account: accounts.providerReceivable(c.payee), credit: BigInt(c.delta) },
      ]);
      for (const e of entries) {
        if (e.debit > 0n) postings.push({ account: accounts.ownerEscrow(e.account), credit: e.debit });
        else postings.push({ account: accounts.providerCredit(e.account), debit: e.credit });
      }
      this.#ledger.post("batch.settled", batch.batch_id, `batch ${seq}`, postings);
      for (const hook of this.confirmHooks) hook({ seq, batchId: batch.batch_id, txHash });
      this.#events.emit("batch.confirmed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, network) });
    });
    for (const id of new Set(this.#store.batchClaims(seq).map((c) => c.budget_id))) {
      this.#funds.refresh(this.#store.budget(id)!).catch((err) => this.#log.warn("funds refresh failed", { budgetId: id, err }));
    }
    this.#log.info("batch confirmed", { seq, txHash });
  }

  #fail(seq: number, error: string): void {
    this.#release(seq, "failed", error);
  }

  /** The send failed without a verdict: the calls go back to the queue, and #resolvePending adopts the batch if it lands. */
  #markUnknown(seq: number, error: string): void {
    this.#release(seq, "unknown", error);
  }

  #release(seq: number, status: "failed" | "unknown", error: string): void {
    this.#db.tx(() => {
      this.#store.updateBatch(seq, { status, error });
      this.#db.run("UPDATE calls SET status = 'accepted', batch_seq = NULL, proof = NULL WHERE batch_seq = ?", seq);
      this.#events.emit("batch.failed", { batch: batchSummaryJson(this.#store.batch(String(seq))!, this.#chain.network) });
    });
  }

  #netOf(seq: number): NetEntry[] {
    return this.#store.batchNet(seq).map((n) => ({ account: n.account, debit: BigInt(n.debit), credit: BigInt(n.credit) }));
  }

  /**
   * Books a batch the hub says exists, but only when the hub's record is this node's batch (settler and root). False
   * when the hub has no record or holds someone else's under this id; both fail the batch and neither is a success.
   */
  async #reconcile(seq: number): Promise<boolean> {
    const row = this.#store.batch(String(seq))!;
    const onchain = await this.#chain.chain.batch(row.batch_id);
    if (!onchain) {
      this.#fail(seq, "the hub has no record of this batch");
      return false;
    }
    if (!this.#ownsRecord(seq, onchain)) return false;
    this.#confirm(seq, row.tx_hash, this.#netOf(seq));
    return true;
  }

  /**
   * Settles the fate of every batch without a verdict. Runs before each settlement and at startup, never while a send is
   * in flight. A batch the node never sent fails. A batch that may have reached the hub is asked about: booked if the
   * hub has it (its calls are taken back from the queue), kept unknown while it still could land, failed once it cannot.
   */
  async #resolvePending(): Promise<void> {
    for (const b of this.#db.all<BatchRow>("SELECT * FROM batches WHERE status IN ('building', 'submitted', 'unknown') ORDER BY seq")) {
      if (b.status === "building") {
        this.#fail(b.seq, "the node stopped before sending this batch");
        continue;
      }
      const onchain = await this.#chain.chain.batch(b.batch_id).catch((err: unknown) => {
        this.#log.warn("cannot read a pending batch from the hub; asking again on the next run", { seq: b.seq, err });
        return undefined;
      });
      if (onchain === undefined) continue;
      if (onchain !== null) {
        // Booked only if the hub's record is this node's batch; a foreign record fails it and pages the operator.
        if (!this.#ownsRecord(b.seq, onchain)) continue;
        if (b.status === "submitted") this.#confirm(b.seq, b.tx_hash, this.#netOf(b.seq));
        else this.#adopt(b);
        continue;
      }
      if (b.status === "submitted") this.#markUnknown(b.seq, "the node stopped while this batch was in flight");
      else if (Date.now() - Date.parse(b.submitted_at ?? b.created_at) > UNKNOWN_BATCH_TTL_MS) {
        this.#store.updateBatch(b.seq, { status: "failed", error: `${b.error ?? "no verdict"}; the hub never recorded it` });
      }
    }
  }

  /**
   * Books an `unknown` batch the hub turned out to have. Its calls went back to the queue when it was marked, so they are
   * claimed again here, checked against the root the hub stores. Nothing else can have settled them: the hub refuses
   * any later claim on the same positions (stale cumulative or net mismatch), and the pre-checks drop it first.
   */
  #adopt(b: BatchRow): void {
    const db = this.#db;
    const { hub, network } = this.#chain;
    const adopted = db.tx(() => {
      const claims = this.#store.batchClaims(b.seq);
      const calls: CallRow[] = [];
      for (const c of claims) {
        const settled = this.#store.position(c.budget_id, c.payee).settled;
        if (settled !== BigInt(c.previous)) {
          this.#log.error("cannot adopt a landed batch: a position moved since it was built", { seq: b.seq, budgetId: c.budget_id, payee: c.payee, settled: settled.toString(), previous: c.previous });
          return false;
        }
        calls.push(
          ...db
            .all<CallRow>("SELECT * FROM calls WHERE budget_id = ? AND payee = ? AND status = 'accepted' ORDER BY seq", c.budget_id, c.payee)
            .filter((r) => BigInt(r.cumulative) > BigInt(c.previous) && BigInt(r.cumulative) <= BigInt(c.cumulative)),
        );
      }
      const tree = buildReceiptTree(hub, network, b.batch_id, calls.map(receiptOf));
      if (tree.root !== b.receipts_root || calls.length !== b.calls) {
        this.#log.error("cannot adopt a landed batch: its calls no longer rebuild its root", { seq: b.seq });
        return false;
      }
      for (const c of calls) db.run("UPDATE calls SET status = 'settling', batch_seq = ?, proof = ? WHERE seq = ?", b.seq, JSON.stringify(tree.proofOf(c.call_id)), c.seq);
      this.#store.updateBatch(b.seq, { status: "submitted" });
      return true;
    });
    if (!adopted) return;
    this.#log.warn("adopted a batch that landed after its send reported no verdict", { seq: b.seq });
    this.#confirm(b.seq, b.tx_hash, this.#netOf(b.seq));
  }

  /** At startup: resolves batches a crash left building or in flight. Never throws; anything unreadable waits for the next run. */
  async recover(): Promise<void> {
    await this.#resolvePending().catch((err) => this.#log.warn("batch recovery failed; retrying before the next settlement", { err }));
  }
}
