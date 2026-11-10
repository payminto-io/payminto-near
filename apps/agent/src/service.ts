/**
 * The agent service: other software hands the buyer agent work over HTTP.
 *
 *   POST /v1/runs      { task, maxSpendAtomic?, wait? }  runs the buyer agent; returns the run (200) or, with
 *                                                         wait: false, its id right away (202)
 *   GET  /v1/runs/:id                                    the run record: status, answer and spend report
 *   GET  /v1/health                                      liveness (no token)
 *
 * Every /v1/runs call needs `Authorization: Bearer $AGENT_SERVICE_TOKEN`. Runs execute one at a time: they share one
 * budget, and a per-task spend ceiling is only meaningful when no other task spends from it at the same moment.
 * Run records live in memory (the newest AGENT_SERVICE_MAX_RUNS); receipts are durable in the wallet's own store.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { RunResult } from "./runtime.ts";

export type RunRecord = {
  id: string;
  status: "queued" | "running" | "finished" | "failed";
  task: string;
  maxSpendAtomic: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: RunResult | null;
  error: string | null;
};

export type RunTask = (task: string, o: { maxSpendAtomic: bigint | null; signal: AbortSignal }) => Promise<RunResult>;

export type AgentServiceOptions = {
  token: string;
  runTask: RunTask;
  /** The operator's ceiling; a request may lower it, never raise it. Null: requests must name one. */
  maxSpendAtomic: bigint | null;
  maxRuns?: number;
};

const runRequest = z.object({
  task: z.string().trim().min(1, "task is required").max(8_000, "task is at most 8000 characters"),
  maxSpendAtomic: z
    .union([z.string().regex(/^\d+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
    .optional()
    .transform((v) => (v === undefined ? undefined : BigInt(v))),
  wait: z.boolean().default(true),
});

const digest = (s: string) => createHash("sha256").update(s).digest();

function err(code: string, message: string) {
  return { error: { code, message } };
}

export function createAgentService(o: AgentServiceOptions) {
  const runs = new Map<string, RunRecord>();
  const expected = digest(o.token);
  const maxRuns = o.maxRuns ?? 200;
  const abort = new AbortController();
  let queue: Promise<void> = Promise.resolve();

  const auth: MiddlewareHandler = async (c, next) => {
    const h = c.req.header("authorization") ?? "";
    const m = /^Bearer (.+)$/.exec(h);
    if (!m || !timingSafeEqual(digest(m[1]!), expected)) return c.json(err("UNAUTHORIZED", "send Authorization: Bearer <AGENT_SERVICE_TOKEN>"), 401);
    await next();
  };

  const prune = () => {
    if (runs.size <= maxRuns) return;
    for (const [id, r] of runs) {
      if (runs.size <= maxRuns) break;
      if (r.status === "finished" || r.status === "failed") runs.delete(id);
    }
  };

  const start = (task: string, maxSpend: bigint | null): { record: RunRecord; done: Promise<void> } => {
    const record: RunRecord = {
      id: `run_${randomBytes(9).toString("base64url")}`,
      status: "queued",
      task,
      maxSpendAtomic: maxSpend?.toString() ?? null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    };
    runs.set(record.id, record);
    prune();
    const done = queue.then(async () => {
      record.status = "running";
      record.startedAt = new Date().toISOString();
      try {
        record.result = await o.runTask(task, { maxSpendAtomic: maxSpend, signal: abort.signal });
        record.status = "finished";
      } catch (e) {
        record.status = "failed";
        record.error = e instanceof Error ? e.message : String(e);
      } finally {
        record.finishedAt = new Date().toISOString();
      }
    });
    queue = done;
    return { record, done };
  };

  const app = new Hono();
  app.get("/v1/health", (c) => c.json({ ok: true, runs: runs.size }));
  app.use("/v1/runs", auth);
  app.use("/v1/runs/*", auth);
  app.post("/v1/runs", async (c) => {
    const body = runRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(err("VALIDATION_ERROR", body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")), 400);
    const asked = body.data.maxSpendAtomic;
    if (asked !== undefined && o.maxSpendAtomic !== null && asked > o.maxSpendAtomic) {
      return c.json(err("SPEND_CEILING_TOO_HIGH", `maxSpendAtomic ${asked} is above this service's ceiling of ${o.maxSpendAtomic}; ask for less`), 400);
    }
    const ceiling = asked ?? o.maxSpendAtomic;
    if (ceiling === null) return c.json(err("VALIDATION_ERROR", "maxSpendAtomic is required by this service"), 400);
    const { record, done } = start(body.data.task, ceiling);
    if (!body.data.wait) return c.json(record, 202);
    await done;
    return c.json(record, record.status === "finished" ? 200 : 500);
  });
  app.get("/v1/runs/:id", (c) => {
    const r = runs.get(c.req.param("id"));
    return r ? c.json(r) : c.json(err("NOT_FOUND", "no such run (records are kept in memory and reset on restart)"), 404);
  });
  app.notFound((c) => c.json(err("NOT_FOUND", "unknown route"), 404));
  app.onError((e, c) => c.json(err("INTERNAL", e.message), 500));

  return {
    app,
    runs,
    /** Cancels the running task and waits for the queue to drain. */
    async close() {
      abort.abort();
      await queue.catch(() => {});
    },
  };
}

export type Listening = { url: string; port: number; close(): Promise<void> };

/** Serves a Hono app on host:port (port 0 picks a free one). */
export function listen(app: { fetch: (request: Request) => Response | Promise<Response> }, port: number, host = "127.0.0.1"): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, (info: AddressInfo) => {
      const h = host.includes(":") ? `[${host}]` : host;
      resolve({
        url: `http://${h}:${info.port}`,
        port: info.port,
        close: () =>
          new Promise<void>((r) => {
            s.close(() => r());
            (s as Server).closeAllConnections?.();
          }),
      });
    }) as Server;
    s.once("error", reject);
  });
}
