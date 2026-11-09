import type { Database } from "./db/database.ts";

export const EVENT_TYPES = [
  "call.accepted",
  "call.denied",
  "mandate.opened",
  "mandate.revoked",
  "batch.started",
  "batch.submitted",
  "batch.included",
  "batch.confirmed",
  "batch.failed",
  "hsp.updated",
  "funds.warning",
  // Merchant AI agents (docs/AGENTS.md section 6): lifecycle, every state change, and each step. All carry merchant_id
  // and run_id.
  "agent_run.queued",
  "agent_run.started",
  "agent_run.updated",
  "agent_run.step",
  "agent_run.succeeded",
  "agent_run.failed",
  "agent_run.cancelled",
  "agent_run.timed_out",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** SSE payload: `id`, `at` and the entity in its API shape under a type-specific key. */
export type NodeEvent = { id: string; at: string; type: EventType } & Record<string, unknown>;

type Listener = (e: NodeEvent) => void;

/**
 * Durable event log plus in-process fan-out. Events written inside a transaction are published only after commit,
 * so SSE clients never see something that was rolled back. The table doubles as the replay log for Last-Event-ID.
 */
export class EventBus {
  readonly #db: Database;
  readonly #listeners = new Set<Listener>();

  constructor(db: Database) {
    this.#db = db;
  }

  emit(type: EventType, entity: Record<string, unknown>): void {
    const at = new Date().toISOString();
    const payload = JSON.stringify(entity);
    const { lastInsertRowid } = this.#db.run("INSERT INTO events (type, payload, at) VALUES (?, ?, ?)", type, payload, at);
    const event: NodeEvent = { id: String(lastInsertRowid), at, type, ...entity };
    this.#db.afterCommit(() => {
      for (const l of this.#listeners) {
        try {
          l(event);
        } catch {
          // A broken subscriber must never break the writer.
        }
      }
    });
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  since(lastId: number, limit = 500): NodeEvent[] {
    return this.#db
      .all<{ id: number; type: EventType; payload: string; at: string }>(
        "SELECT id, type, payload, at FROM events WHERE id > ? ORDER BY id LIMIT ?",
        lastId,
        limit,
      )
      .map((r) => ({ id: String(r.id), at: r.at, type: r.type, ...(JSON.parse(r.payload) as object) }));
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
