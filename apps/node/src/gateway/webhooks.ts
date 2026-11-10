import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  newDeliveryId,
  newEventId,
  newWebhookEndpointId,
  newWebhookSecret,
  signWebhook,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPE_HEADER,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  WEBHOOK_SIGNATURE_HEADER,
} from "@payminto/protocol";
import type { Database } from "../db/database.ts";
import { ApiError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { nowIso } from "../store.ts";
import { deliveryJson, endpointJson, isoOf, type DeliveryRow, type EndpointRow, type GatewayEventRow, type ModelContext } from "./model.ts";
import { checkWebhookUrl, guardedLookup, type UrlPolicy } from "./ssrf.ts";

/**
 * Events a business endpoint may subscribe to: payments and refunds, merchant.payout_changed, agent runs
 * (docs/AGENTS.md section 5), and budget.refused for refused agent payments to this business.
 */
export const SUBSCRIBABLE_EVENTS: readonly string[] = [
  ...WEBHOOK_EVENT_TYPES,
  "merchant.payout_changed",
  "agent_run.succeeded",
  "agent_run.failed",
  "agent_run.cancelled",
  "agent_run.timed_out",
];

/** Events a platform endpoint (no business) may subscribe to: clearing alerts for the node's Budgets. */
export const PLATFORM_EVENTS: readonly string[] = ["budget.refused"];

/** A business id, or null for the platform's own endpoints and events. */
export type WebhookScope = string | null;

export const DELIVERY_TIMEOUT_MS = 10_000;
/** An endpoint whose every attempt failed for this long is disabled (no event is emitted for it). */
export const AUTO_DISABLE_AFTER_SEC = 3 * 86_400;
const RESPONSE_BODY_LIMIT = 2048;

export type SendResult = { status: number; body: string };
/** One HTTP POST; injectable for tests. Rejects on network errors and timeouts. */
export type WebhookSender = (url: URL, body: string, headers: Record<string, string>, policy: UrlPolicy) => Promise<SendResult>;

/** POST with the SSRF-guarded lookup, no redirects, a 10 s budget and the first 2 KB of the body kept. */
export const httpSender: WebhookSender = (url, body, headers, policy) =>
  new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "POST",
        headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
        lookup: guardedLookup(policy) as never,
        timeout: DELIVERY_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < RESPONSE_BODY_LIMIT) chunks.push(c);
          size += c.length;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8").slice(0, RESPONSE_BODY_LIMIT) }));
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error(`no response within ${DELIVERY_TIMEOUT_MS / 1000}s`)), DELIVERY_TIMEOUT_MS);
    req.on("timeout", () => req.destroy(new Error(`no response within ${DELIVERY_TIMEOUT_MS / 1000}s`)));
    req.on("error", reject);
    req.on("close", () => clearTimeout(deadline));
    req.end(body);
  });

type DeliveryWithEvent = DeliveryRow & { event_type: GatewayEventRow["type"]; body: string };

/**
 * Webhook endpoints, the transactional outbox and its delivery worker (GATEWAY.md section 7).
 * `emit` runs inside the caller's transaction: the event row and one pending attempt per subscribed endpoint commit
 * with the state change, or not at all. Each attempt is one row; a failed attempt schedules the next row per
 * WEBHOOK_RETRY_SCHEDULE_SECONDS, and after the last one the delivery is failed.
 */
export class WebhookService {
  readonly #db: Database;
  readonly #ctx: ModelContext;
  readonly #log: Logger;
  readonly #policy: UrlPolicy;
  readonly #clock: () => number;
  readonly #send: WebhookSender;
  #busy: Promise<number> | null = null;
  #kick: (() => void) | null = null;

  constructor(o: { db: Database; ctx: ModelContext; log: Logger; allowPrivate: boolean; clock?: () => number; send?: WebhookSender }) {
    this.#db = o.db;
    this.#ctx = o.ctx;
    this.#log = o.log;
    this.#policy = { allowPrivate: o.allowPrivate };
    this.#clock = o.clock ?? (() => Math.floor(Date.now() / 1000));
    this.#send = o.send ?? httpSender;
  }

  /** Called after commit when new attempts are due now (the worker loop sets it). */
  onDue(fn: (() => void) | null) {
    this.#kick = fn;
  }

  // ------------------------------------------------------------------ endpoints

  endpoint(merchantId: WebhookScope, id: string): EndpointRow {
    const r = this.#db.get<EndpointRow>("SELECT * FROM webhook_endpoints WHERE id = ? AND merchant_id IS ? AND deleted_at IS NULL", id, merchantId);
    if (!r) throw new ApiError(404, "NOT_FOUND", "webhook endpoint not found");
    return r;
  }

  endpoints(merchantId: WebhookScope): EndpointRow[] {
    return this.#db.all<EndpointRow>("SELECT * FROM webhook_endpoints WHERE merchant_id IS ? AND deleted_at IS NULL ORDER BY created_at DESC", merchantId);
  }

  #events(merchantId: WebhookScope, events: string[]): string {
    if (events.length === 0) throw new ApiError(400, "VALIDATION_ERROR", "events must list at least one event type or *");
    if (events.includes("*")) return JSON.stringify(["*"]);
    const allowed = merchantId === null ? PLATFORM_EVENTS : SUBSCRIBABLE_EVENTS;
    const bad = events.filter((e) => !allowed.includes(e));
    if (bad.length) throw new ApiError(400, "VALIDATION_ERROR", `unknown event types: ${bad.join(", ")}`);
    return JSON.stringify([...new Set(events)]);
  }

  async create(merchantId: WebhookScope, b: { url: string; description?: string | null; events: string[] }) {
    await checkWebhookUrl(b.url, this.#policy);
    const id = newWebhookEndpointId();
    const now = nowIso();
    this.#db.run(
      "INSERT INTO webhook_endpoints (id, merchant_id, url, description, events, active, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
      id,
      merchantId,
      b.url,
      b.description ?? null,
      this.#events(merchantId, b.events),
      newWebhookSecret(),
      now,
      now,
    );
    return this.json(this.endpoint(merchantId, id), true);
  }

  /** WebhookEndpoint plus its health: 7-day success rate, last attempt, and why it was disabled. */
  json(e: EndpointRow, withSecret = false) {
    const since = isoOf(this.#clock() - 7 * 86_400);
    const s = this.#db.get<{ ok: number; n: number; last: string | null }>(
      `SELECT COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS ok, COUNT(*) AS n,
              (SELECT MAX(attempted_at) FROM webhook_deliveries WHERE endpoint_id = ?) AS last
       FROM webhook_deliveries WHERE endpoint_id = ? AND attempted_at IS NOT NULL AND attempted_at >= ?`,
      e.id,
      e.id,
      since,
    )!;
    return {
      ...endpointJson(e, this.#ctx, withSecret),
      success_rate_7d: s.n === 0 ? null : s.ok / s.n,
      last_delivery_at: s.last,
      disabled_reason: e.disabled_reason,
    };
  }

  async update(merchantId: WebhookScope, id: string, b: { url?: string; description?: string | null; events?: string[]; active?: boolean }) {
    const cur = this.endpoint(merchantId, id);
    if (b.url !== undefined) await checkWebhookUrl(b.url, this.#policy);
    // Re-enabling clears the auto-disable state, so the endpoint gets a fresh 3-day window.
    const reenable = b.active === true;
    this.#db.run(
      `UPDATE webhook_endpoints SET url = ?, description = ?, events = ?, active = ?, updated_at = ?,
              disabled_reason = CASE WHEN ? THEN NULL ELSE disabled_reason END, failing_since = CASE WHEN ? THEN NULL ELSE failing_since END
       WHERE id = ?`,
      b.url ?? cur.url,
      b.description === undefined ? cur.description : b.description,
      b.events ? this.#events(merchantId, b.events) : cur.events,
      b.active === undefined ? cur.active : b.active ? 1 : 0,
      nowIso(),
      reenable ? 1 : 0,
      reenable ? 1 : 0,
      id,
    );
    return this.json(this.endpoint(merchantId, id));
  }

  remove(merchantId: WebhookScope, id: string): void {
    this.endpoint(merchantId, id);
    this.#db.tx(() => {
      this.#db.run("UPDATE webhook_endpoints SET deleted_at = ?, active = 0, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);
      this.#db.run("UPDATE webhook_deliveries SET status = 'failed', error = 'endpoint deleted' WHERE endpoint_id = ? AND status = 'pending'", id);
    });
  }

  rotateSecret(merchantId: WebhookScope, id: string) {
    this.endpoint(merchantId, id);
    this.#db.run("UPDATE webhook_endpoints SET secret = ?, updated_at = ? WHERE id = ?", newWebhookSecret(), nowIso(), id);
    return this.json(this.endpoint(merchantId, id), true);
  }

  // ------------------------------------------------------------------ outbox

  /** True when an active endpoint of this scope would receive `type`. */
  hasSubscribers(merchantId: WebhookScope, type: string): boolean {
    return this.#db
      .all<{ events: string }>("SELECT events FROM webhook_endpoints WHERE merchant_id IS ? AND active = 1 AND deleted_at IS NULL", merchantId)
      .some((e) => {
        const events = JSON.parse(e.events) as string[];
        return events.includes("*") || events.includes(type);
      });
  }

  /** Writes the event and one pending attempt per subscribed active endpoint. Must run inside the state-change tx. */
  emit(merchantId: WebhookScope, type: string, objectId: string, paymentId: string | null, object: unknown): string {
    const id = newEventId();
    const created = this.#clock();
    const body = JSON.stringify({ id, type, created, livemode: this.#ctx.livemode, data: { object } });
    this.#db.run(
      "INSERT INTO gateway_events (id, merchant_id, type, object_id, payment_id, body, created, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      merchantId,
      type,
      objectId,
      paymentId,
      body,
      created,
      isoOf(created),
    );
    if (type === "ping") return id;
    let due = 0;
    for (const e of this.#db.all<EndpointRow>("SELECT * FROM webhook_endpoints WHERE merchant_id IS ? AND active = 1 AND deleted_at IS NULL", merchantId)) {
      const events = JSON.parse(e.events) as string[];
      if (!events.includes("*") && !events.includes(type)) continue;
      this.#schedule(id, e, 1, created, false);
      due++;
    }
    if (due) this.#db.afterCommit(() => this.#kick?.());
    return id;
  }

  #schedule(eventId: string, e: Pick<EndpointRow, "id" | "url">, attempt: number, at: number, manual: boolean): string {
    const id = newDeliveryId();
    this.#db.run(
      `INSERT INTO webhook_deliveries (id, event_id, endpoint_id, url, attempt, manual, status, scheduled_unix, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      eventId,
      e.id,
      e.url,
      attempt,
      manual ? 1 : 0,
      at,
      isoOf(at),
      nowIso(),
    );
    return id;
  }

  /** Timeline of one payment: its payment.* and refund.* events. */
  timeline(paymentId: string) {
    return this.#db
      .all<GatewayEventRow>("SELECT * FROM gateway_events WHERE payment_id = ? ORDER BY seq", paymentId)
      .map((e) => {
        const obj = (JSON.parse(e.body) as { data: { object: Record<string, unknown> } }).data.object;
        return { id: e.id, type: e.type, created_at: e.created_at, data: { status: obj.status ?? null, amount_paid: obj.amount_paid ?? null, amount: obj.amount ?? null } };
      });
  }

  // ------------------------------------------------------------------ deliveries

  #delivery(id: string): DeliveryWithEvent | undefined {
    return this.#db.get<DeliveryWithEvent>(
      "SELECT d.*, e.type AS event_type, e.body AS body FROM webhook_deliveries d JOIN gateway_events e ON e.id = d.event_id WHERE d.id = ?",
      id,
    );
  }

  deliveries(merchantId: WebhookScope, endpointId: string, limit: number, cursor?: number) {
    this.endpoint(merchantId, endpointId);
    const rows = this.#db.all<DeliveryWithEvent>(
      `SELECT d.*, e.type AS event_type, e.body AS body FROM webhook_deliveries d JOIN gateway_events e ON e.id = d.event_id
       WHERE d.endpoint_id = ? ${cursor !== undefined ? "AND d.seq < ?" : ""} ORDER BY d.seq DESC LIMIT ?`,
      ...(cursor !== undefined ? [endpointId, cursor, limit + 1] : [endpointId, limit + 1]),
    );
    const page = rows.slice(0, limit);
    return { items: page.map(deliveryJson), next_cursor: rows.length > limit && page.length ? String(page[page.length - 1]!.seq) : null };
  }

  /** Manual resend: a new attempt row due now that does not continue the schedule. */
  async retry(merchantId: WebhookScope, deliveryId: string) {
    const d = this.#delivery(deliveryId);
    if (!d) throw new ApiError(404, "NOT_FOUND", "delivery not found");
    const e = this.endpoint(merchantId, d.endpoint_id);
    const last = this.#db.get<{ n: number }>("SELECT MAX(attempt) AS n FROM webhook_deliveries WHERE event_id = ? AND endpoint_id = ?", d.event_id, e.id)!.n;
    const id = this.#db.tx(() => this.#schedule(d.event_id, e, last + 1, this.#clock(), true));
    await this.#attempt(this.#delivery(id)!);
    return deliveryJson(this.#delivery(id)!);
  }

  /** Sends a `ping` event to one endpoint now and returns the attempt. */
  async test(merchantId: WebhookScope, endpointId: string) {
    const e = this.endpoint(merchantId, endpointId);
    const id = this.#db.tx(() => {
      const eventId = this.emit(merchantId, "ping", e.id, null, endpointJson(e, this.#ctx));
      return this.#schedule(eventId, e, 1, this.#clock(), true);
    });
    await this.#attempt(this.#delivery(id)!);
    return deliveryJson(this.#delivery(id)!);
  }

  /** Delivers every attempt that is due. Overlapping calls share one run. */
  tick(): Promise<number> {
    this.#busy ??= this.#run().finally(() => {
      this.#busy = null;
    });
    return this.#busy;
  }

  async #run(): Promise<number> {
    let done = 0;
    for (;;) {
      const due = this.#db.all<DeliveryWithEvent>(
        `SELECT d.*, e.type AS event_type, e.body AS body FROM webhook_deliveries d JOIN gateway_events e ON e.id = d.event_id
         WHERE d.status = 'pending' AND d.scheduled_unix <= ? ORDER BY d.scheduled_unix, d.seq LIMIT 16`,
        this.#clock(),
      );
      if (due.length === 0) return done;
      // In order per endpoint (a receiver sees payment.created before payment.paid), in parallel across endpoints.
      const byEndpoint = new Map<string, DeliveryWithEvent[]>();
      for (const d of due) byEndpoint.set(d.endpoint_id, [...(byEndpoint.get(d.endpoint_id) ?? []), d]);
      await Promise.all(
        [...byEndpoint.values()].map(async (list) => {
          for (const d of list) await this.#attempt(d);
        }),
      );
      done += due.length;
    }
  }

  /** Success resets the failure streak; three days of nothing but failures disables the endpoint and drops its queue. */
  #trackHealth(e: EndpointRow, ok: boolean, t: number) {
    if (ok) {
      if (e.failing_since !== null) this.#db.run("UPDATE webhook_endpoints SET failing_since = NULL WHERE id = ?", e.id);
      return;
    }
    const since = e.failing_since ?? t;
    if (e.failing_since === null) this.#db.run("UPDATE webhook_endpoints SET failing_since = ? WHERE id = ?", t, e.id);
    if (t - since < AUTO_DISABLE_AFTER_SEC) return;
    this.#db.run(
      "UPDATE webhook_endpoints SET active = 0, disabled_reason = ?, updated_at = ? WHERE id = ? AND active = 1",
      `every delivery failed since ${isoOf(since)}; disabled after 3 days (PATCH active: true to re-enable)`,
      nowIso(),
      e.id,
    );
    this.#db.run("UPDATE webhook_deliveries SET status = 'failed', error = 'endpoint disabled after 3 days of failures' WHERE endpoint_id = ? AND status = 'pending'", e.id);
    this.#log.warn("webhook endpoint disabled after 3 days of failed deliveries", { endpointId: e.id });
  }

  async #attempt(d: DeliveryWithEvent): Promise<void> {
    const e = this.#db.get<EndpointRow>("SELECT * FROM webhook_endpoints WHERE id = ?", d.endpoint_id)!;
    if (!e.active || e.deleted_at) {
      this.#db.run("UPDATE webhook_deliveries SET status = 'failed', error = ?, attempted_at = ? WHERE id = ?", "endpoint disabled", nowIso(), d.id);
      return;
    }
    const t = this.#clock();
    const started = performance.now();
    let status: number | null = null;
    let body: string | null = null;
    let error: string | null = null;
    try {
      const url = await checkWebhookUrl(d.url, this.#policy);
      const r = await this.#send(url, d.body, {
        "content-type": "application/json",
        "user-agent": "Payminto-Webhooks/1.0",
        [WEBHOOK_SIGNATURE_HEADER]: await signWebhook(e.secret, d.body, t),
        [WEBHOOK_EVENT_ID_HEADER]: d.event_id,
        [WEBHOOK_EVENT_TYPE_HEADER]: d.event_type,
      }, this.#policy);
      status = r.status;
      body = r.body.slice(0, RESPONSE_BODY_LIMIT);
      if (status < 200 || status >= 300) error = `HTTP ${status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ms = Math.round(performance.now() - started);
    const ok = error === null;
    this.#db.tx(() => {
      let next: number | null = null;
      if (!ok && !d.manual && d.attempt < WEBHOOK_RETRY_SCHEDULE_SECONDS.length) {
        next = t + WEBHOOK_RETRY_SCHEDULE_SECONDS[d.attempt]!;
        this.#schedule(d.event_id, { id: e.id, url: e.url }, d.attempt + 1, next, false);
      }
      this.#db.run(
        `UPDATE webhook_deliveries SET status = ?, response_status = ?, response_body = ?, duration_ms = ?, error = ?, next_attempt_at = ?, attempted_at = ?
         WHERE id = ?`,
        ok ? "succeeded" : "failed",
        status,
        body,
        ms,
        error,
        next === null ? null : isoOf(next),
        isoOf(t),
        d.id,
      );
      this.#trackHealth(e, ok, t);
    });
    if (!ok) this.#log.debug("webhook attempt failed", { deliveryId: d.id, endpointId: e.id, attempt: d.attempt, error });
  }
}
