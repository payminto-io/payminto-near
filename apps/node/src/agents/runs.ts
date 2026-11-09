import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { EventBus } from "../events.ts";
import type { WebhookService } from "../gateway/webhooks.ts";
import { nowIso } from "../store.ts";
import { iso, newId, runEventJson, runJson, TERMINAL, type AgentRow, type RunEventRow, type RunEventType, type RunRow, type RunStatus, type RunTrigger } from "./rows.ts";

/** Webhook event types of runs (docs/AGENTS.md section 5), subscribable like the payment events. */
export const AGENT_RUN_WEBHOOK_EVENTS = ["agent_run.succeeded", "agent_run.failed", "agent_run.cancelled", "agent_run.timed_out"] as const;

export const MAX_RUN_INPUT = 20_000;

type LifecycleEvent = "agent_run.queued" | "agent_run.started" | "agent_run.succeeded" | "agent_run.failed" | "agent_run.cancelled" | "agent_run.timed_out";
export const DEFAULT_MAX_ATTEMPTS = 3;

export type CreateRunInput = {
  agent: AgentRow;
  trigger: RunTrigger;
  input: string;
  idempotencyKey?: string | null;
  createdBy?: string | null;
  resultTokenHash?: string | null;
  skillCallId?: string | null;
  payer?: string | null;
};

export type ListRunsFilter = { agentId?: string; status?: RunStatus; limit: number; cursor?: number };

/**
 * Runs and their steps (docs/AGENTS.md section 5). Every write is a guarded transition: worker writes name the lease
 * owner and the running status, so a worker that lost its lease can never overwrite the run. Each transition writes
 * a step, publishes `agent_run.updated` on the node event stream, and a terminal one an `agent_run.*` webhook through
 * the gateway's outbox, all in the same transaction.
 */
export class RunService {
  readonly #db: Database;
  readonly #events: EventBus;
  readonly #webhooks: WebhookService | null;
  readonly #clock: () => number;
  readonly #waiters = new Map<string, Set<() => void>>();
  #onCreated: (() => void) | null = null;
  #onCancel: ((runId: string) => void) | null = null;

  constructor(o: { db: Database; events: EventBus; webhooks: WebhookService | null; clock?: () => number }) {
    this.#db = o.db;
    this.#events = o.events;
    this.#webhooks = o.webhooks;
    this.#clock = o.clock ?? (() => Date.now());
  }

  /** In-process wake-ups for the worker: a new run, and a cancel of a run it may hold. */
  onCreated(fn: (() => void) | null) {
    this.#onCreated = fn;
  }

  onCancel(fn: ((runId: string) => void) | null) {
    this.#onCancel = fn;
  }

  now(): number {
    return this.#clock();
  }

  // ------------------------------------------------------------------ reads

  row(id: string): RunRow | undefined {
    return this.#db.get<RunRow>("SELECT * FROM agent_runs WHERE id = ?", id);
  }

  get(merchantId: string, id: string): RunRow {
    const r = this.row(id);
    if (!r || r.merchant_id !== merchantId) throw new ApiError(404, "NOT_FOUND", "agent run not found");
    return r;
  }

  list(merchantId: string, f: ListRunsFilter) {
    const where = ["merchant_id = ?"];
    const params: Array<string | number> = [merchantId];
    if (f.agentId) (where.push("agent_id = ?"), params.push(f.agentId));
    if (f.status) (where.push("status = ?"), params.push(f.status));
    if (f.cursor !== undefined) (where.push("rowid < ?"), params.push(f.cursor));
    const rows = this.#db.all<RunRow & { rid: number }>(`SELECT rowid AS rid, * FROM agent_runs WHERE ${where.join(" AND ")} ORDER BY rowid DESC LIMIT ?`, ...params, f.limit + 1);
    const page = rows.slice(0, f.limit);
    return { items: page.map((r) => runJson(r)), next_cursor: rows.length > f.limit ? String(page[page.length - 1]!.rid) : null };
  }

  events(runId: string, after: number, limit = 500) {
    const rows = this.#db.all<RunEventRow>("SELECT * FROM agent_run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?", runId, after, limit);
    return rows.map(runEventJson);
  }

  byIdempotencyKey(merchantId: string, key: string): RunRow | undefined {
    return this.#db.get<RunRow>("SELECT * FROM agent_runs WHERE merchant_id = ? AND idempotency_key = ?", merchantId, key);
  }

  cancelRequested(id: string): boolean {
    return this.#db.get<{ c: number }>("SELECT cancel_requested AS c FROM agent_runs WHERE id = ?", id)?.c === 1;
  }

  /** Resolves with the run once its status differs from `from`, or after `ms`. Wakes in-process, polls as a fallback. */
  async waitForChange(id: string, from: RunStatus, ms: number): Promise<RunRow> {
    const deadline = this.#clock() + ms;
    for (;;) {
      const r = this.row(id)!;
      if (r.status !== from || TERMINAL.has(r.status)) return r;
      const left = deadline - this.#clock();
      if (left <= 0) return r;
      await new Promise<void>((resolve) => {
        const set = this.#waiters.get(id) ?? new Set();
        this.#waiters.set(id, set);
        const done = () => {
          clearTimeout(t);
          set.delete(done);
          if (set.size === 0) this.#waiters.delete(id);
          resolve();
        };
        const t = setTimeout(done, Math.min(left, 1_000));
        set.add(done);
      });
    }
  }

  // ------------------------------------------------------------------ create and cancel

  /** A queued run; the same Idempotency-Key with the same agent and input returns the first run. */
  create(b: CreateRunInput): { row: RunRow; replayed: boolean } {
    if (b.idempotencyKey !== undefined && b.idempotencyKey !== null && !/^[\x21-\x7e]{1,255}$/.test(b.idempotencyKey)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Idempotency-Key must be 1-255 visible ASCII characters");
    }
    const out = this.#db.tx(() => {
      if (b.idempotencyKey) {
        const prior = this.#db.get<RunRow>("SELECT * FROM agent_runs WHERE merchant_id = ? AND idempotency_key = ?", b.agent.merchant_id, b.idempotencyKey);
        if (prior) {
          if (prior.agent_id !== b.agent.id || prior.input !== b.input) throw new ApiError(409, "IDEMPOTENCY_MISMATCH", "this Idempotency-Key was used for a different run");
          return { row: prior, replayed: true };
        }
      }
      const id = newId("run");
      const now = this.#clock();
      this.#db.run(
        `INSERT INTO agent_runs (id, agent_id, merchant_id, connection_id, trigger, input, status, attempt, max_attempts, next_attempt_ms, idempotency_key,
           result_token_hash, skill_call_id, payer, created_by, created_ms, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        b.agent.id,
        b.agent.merchant_id,
        b.agent.connection_id,
        b.trigger,
        b.input,
        DEFAULT_MAX_ATTEMPTS,
        now,
        b.idempotencyKey ?? null,
        b.resultTokenHash ?? null,
        b.skillCallId ?? null,
        b.payer ?? null,
        b.createdBy ?? null,
        now,
        iso(now),
        iso(now),
      );
      const row = this.row(id)!;
      this.#lifecycle("agent_run.queued", row);
      this.#published(row);
      return { row, replayed: false };
    });
    if (!out.replayed) this.#onCreated?.();
    return out;
  }

  /** Cancels a queued run at once; a running run gets cancel_requested and stops at its next step. Finished runs are returned as they are. */
  requestCancel(merchantId: string, id: string): RunRow {
    const cur = this.get(merchantId, id);
    if (TERMINAL.has(cur.status)) return cur;
    this.#db.tx(() => {
      if (cur.status === "queued") {
        const ok = this.#db.run(
          "UPDATE agent_runs SET status = 'cancelled', cancel_requested = 1, error_code = 'CANCELLED', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
          "cancelled before it started",
          nowIso(),
          nowIso(),
          id,
        ).changes;
        if (ok) return this.#terminal(this.row(id)!);
      }
      this.#db.run("UPDATE agent_runs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')", nowIso(), id);
      this.#published(this.row(id)!);
    });
    this.#onCancel?.(id);
    return this.row(id)!;
  }

  /** Cancels every queued run of an agent (the agent was deleted). */
  cancelQueuedOf(agentId: string): number {
    const ids = this.#db.all<{ id: string; merchant_id: string }>("SELECT id, merchant_id FROM agent_runs WHERE agent_id = ? AND status IN ('queued', 'running')", agentId);
    for (const r of ids) this.requestCancel(r.merchant_id, r.id);
    return ids.length;
  }

  // ------------------------------------------------------------------ worker transitions

  /**
   * Claims the oldest due queued run atomically: one UPDATE ... WHERE id = (SELECT ...) RETURNING under SQLite's write
   * lock, so two workers (in this process or another) never get the same run. A business already running
   * `maxPerMerchant` runs is skipped, so one busy business cannot starve the others.
   */
  claim(owner: string, leaseMs: number, maxPerMerchant: number): RunRow | null {
    const now = this.#clock();
    return this.#db.tx(() => {
      const row = this.#db.get<RunRow>(
        `UPDATE agent_runs SET status = 'running', lease_owner = ?, lease_expires_ms = ?, attempt = attempt + 1,
           started_at = COALESCE(started_at, ?), updated_at = ?
         WHERE id = (
           SELECT r.id FROM agent_runs r
           WHERE r.status = 'queued' AND r.next_attempt_ms <= ?
             AND (SELECT COUNT(*) FROM agent_runs x WHERE x.merchant_id = r.merchant_id AND x.status = 'running') < ?
           ORDER BY r.created_ms, r.rowid LIMIT 1
         ) AND status = 'queued'
         RETURNING *`,
        owner,
        now + leaseMs,
        iso(now),
        iso(now),
        now,
        maxPerMerchant,
      );
      if (row) {
        this.#lifecycle("agent_run.started", row);
        this.#published(row);
      }
      return row ?? null;
    });
  }

  /** Renews the lease; false when this worker no longer holds the run. */
  heartbeat(id: string, owner: string, leaseMs: number): { held: boolean; cancelRequested: boolean } {
    const now = this.#clock();
    const held = this.#db.run("UPDATE agent_runs SET lease_expires_ms = ? WHERE id = ? AND lease_owner = ? AND status = 'running'", now + leaseMs, id, owner).changes === 1;
    return { held, cancelRequested: held && this.cancelRequested(id) };
  }

  /** Adds a turn's tokens to the run (all attempts count: they were billed). */
  recordUsage(id: string, owner: string, inputTokens: number, outputTokens: number, model: string, provider: string): boolean {
    return (
      this.#db.run(
        "UPDATE agent_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, model = ?, provider = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'",
        inputTokens,
        outputTokens,
        model,
        provider,
        nowIso(),
        id,
        owner,
      ).changes === 1
    );
  }

  /** Writes a step of a run the worker holds (or of any run, without `owner`). */
  step(id: string, attempt: number, type: RunEventType, data: Record<string, unknown>): void {
    this.#db.tx(() => {
      const seq = (this.#db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM agent_run_events WHERE run_id = ?", id)?.s ?? 0) + 1;
      const at = nowIso();
      this.#db.run("INSERT INTO agent_run_events (run_id, seq, type, attempt, data, at) VALUES (?, ?, ?, ?, ?, ?)", id, seq, type, attempt, JSON.stringify(data), at);
      const merchantId = this.#db.get<{ m: string }>("SELECT merchant_id AS m FROM agent_runs WHERE id = ?", id)!.m;
      this.#events.emit("agent_run.step", { merchant_id: merchantId, run_id: id, step: { run_id: id, seq, type, attempt, data, at } });
    });
  }

  /** Ends a run this worker holds. False when the lease was lost (someone else owns the run now). */
  finish(id: string, owner: string, status: Exclude<RunStatus, "queued" | "running">, o: { result?: { answer: string; data?: unknown }; errorCode?: string; errorMessage?: string } = {}): boolean {
    return this.#db.tx(() => {
      const now = nowIso();
      const changed = this.#db.run(
        `UPDATE agent_runs SET status = ?, result = ?, error_code = ?, error_message = ?, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_ms = NULL
         WHERE id = ? AND lease_owner = ? AND status = 'running'`,
        status,
        o.result ? JSON.stringify(o.result) : null,
        o.errorCode ?? null,
        o.errorMessage ?? null,
        now,
        now,
        id,
        owner,
      ).changes;
      if (!changed) return false;
      this.#terminal(this.row(id)!);
      return true;
    });
  }

  /**
   * Puts a held run back in the queue to start again at `atMs`. `refund` gives the attempt back (a shutdown is not
   * the run's fault).
   */
  requeue(id: string, owner: string, atMs: number, data: Record<string, unknown>, o: { refund?: boolean } = {}): boolean {
    return this.#db.tx(() => {
      const r = this.row(id);
      if (!r) return false;
      const changed = this.#db.run(
        `UPDATE agent_runs SET status = 'queued', next_attempt_ms = ?, lease_owner = NULL, lease_expires_ms = NULL, attempt = attempt - ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND status = 'running'`,
        atMs,
        o.refund ? 1 : 0,
        nowIso(),
        id,
        owner,
      ).changes;
      if (!changed) return false;
      this.step(id, r.attempt, "retry_scheduled", { attempt: r.attempt, ...data, next_attempt_at: iso(atMs) });
      this.#published(this.row(id)!);
      return true;
    });
  }

  /**
   * Runs whose lease expired (a worker crashed or was killed) go back to the queue, the attempt counted; a run that
   * used its last attempt fails with WORKER_LOST.
   */
  requeueExpired(): number {
    const now = this.#clock();
    const expired = this.#db.all<RunRow>("SELECT * FROM agent_runs WHERE status = 'running' AND lease_expires_ms < ?", now);
    let n = 0;
    for (const r of expired) {
      this.#db.tx(() => {
        if (r.attempt >= r.max_attempts) {
          const changed = this.#db.run(
            `UPDATE agent_runs SET status = 'failed', error_code = 'WORKER_LOST', error_message = ?, finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_ms = NULL
             WHERE id = ? AND status = 'running' AND lease_expires_ms = ?`,
            `the worker stopped answering on the last of ${r.max_attempts} attempts`,
            nowIso(),
            nowIso(),
            r.id,
            r.lease_expires_ms,
          ).changes;
          if (changed) (this.#terminal(this.row(r.id)!), n++);
          return;
        }
        const changed = this.#db.run(
          "UPDATE agent_runs SET status = 'queued', next_attempt_ms = ?, lease_owner = NULL, lease_expires_ms = NULL, updated_at = ? WHERE id = ? AND status = 'running' AND lease_expires_ms = ?",
          now,
          nowIso(),
          r.id,
          r.lease_expires_ms,
        ).changes;
        if (!changed) return;
        n++;
        this.step(r.id, r.attempt, "retry_scheduled", { attempt: r.attempt, reason: "lease_expired", error_code: "WORKER_LOST", error_message: "the worker stopped answering", next_attempt_at: iso(now) });
        this.#published(this.row(r.id)!);
      });
    }
    return n;
  }

  // ------------------------------------------------------------------ fan-out

  /** A named lifecycle event on the node stream (queued, started, and each terminal status), with the run. */
  #lifecycle(type: LifecycleEvent, r: RunRow): void {
    this.#events.emit(type, { merchant_id: r.merchant_id, run_id: r.id, run: runJson(r) });
  }

  #published(r: RunRow): void {
    this.#events.emit("agent_run.updated", { merchant_id: r.merchant_id, run_id: r.id, run: runJson(r) });
    this.#db.afterCommit(() => {
      for (const w of [...(this.#waiters.get(r.id) ?? [])]) w();
    });
  }

  /** The finished step, the stream event and the webhook of a terminal run (inside the caller's transaction). */
  #terminal(r: RunRow): void {
    this.step(r.id, r.attempt, "finished", { status: r.status, error_code: r.error_code, error_message: r.error_message, input_tokens: r.input_tokens, output_tokens: r.output_tokens });
    this.#lifecycle(`agent_run.${r.status}` as LifecycleEvent, r);
    this.#published(r);
    this.#webhooks?.emit(r.merchant_id, `agent_run.${r.status}`, r.id, null, runJson(r));
  }
}
