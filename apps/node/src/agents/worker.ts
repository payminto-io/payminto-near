/**
 * The agent run worker (docs/AGENTS.md section 5), in the node process like the settlement and webhook workers.
 *
 * - Polls every `pollMs` while work is likely, backing off to `idlePollMs` when idle; a run created in this process
 *   wakes it at once.
 * - Claims one run at a time atomically (RunService.claim), up to `workers` at once and `maxPerMerchant` per business.
 * - Holds a lease it renews every `heartbeatMs`; a run whose lease expires goes back to the queue (requeueExpired).
 * - Retries retryable model errors with exponential backoff and jitter (2 s, 8 s, 30 s), honouring Retry-After; fails
 *   non-retryable errors at once; marks the connection invalid on a rejected key.
 * - Times each attempt out with an AbortSignal, checks cancel_requested before every model turn and tool call (and
 *   aborts the in-flight request when a cancel arrives), and checks the connection's monthly token limit before
 *   starting and after each turn.
 */
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { ModelError, totalInputTokens, type ChatMessage, type ModelClient, type ModelErrorKind, type Part, type ToolSpec } from "@payminto/models";
import type { Logger } from "../logger.ts";
import type { AgentService } from "./agents.ts";
import type { ConnectionService } from "./connections.ts";
import type { OpsToolbox, OpsToolFactory } from "./ops-tools.ts";
import { systemPrompt } from "./prompts.ts";
import { agentTools, excerpt, scrubSecrets, type AgentRow, type RunRow } from "./rows.ts";
import type { RunService } from "./runs.ts";
import { SecretError } from "./secrets.ts";

export const DEFAULT_RETRY_DELAYS_MS = [2_000, 8_000, 30_000];
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 15_000;
export const DEFAULT_IDLE_POLL_MS = 5_000;
/** Longest Retry-After the worker honours; a provider asking for more is retried after this. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;
/** max_tokens of one turn, capped by what is left of the agent's output budget. */
const MAX_TOKENS_PER_TURN = 16_000;

export type WorkerOptions = {
  runs: RunService;
  agents: AgentService;
  connections: ConnectionService;
  tools: OpsToolFactory;
  log: Logger;
  workers: number;
  maxPerMerchant: number;
  pollMs: number;
  idlePollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  retryDelaysMs?: number[];
  /** Model HTTP client (tests); the providers' own endpoints otherwise. */
  fetch?: typeof fetch;
  random?: () => number;
  /** Lease owner name; unique per worker by default. */
  owner?: string;
};

/** A run that ends with an error code of ours (not a provider error). */
class RunFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type ResolvedOptions = Required<Omit<WorkerOptions, "fetch" | "owner">> & { fetch?: typeof fetch };

type AbortReason = "cancel" | "timeout" | "shutdown" | "lease_lost";

const MODEL_ERROR_CODES: Record<ModelErrorKind, string> = {
  auth: "MODEL_AUTH_FAILED",
  rate_limit: "MODEL_RATE_LIMITED",
  overloaded: "MODEL_OVERLOADED",
  timeout: "MODEL_TIMEOUT",
  network: "MODEL_UNREACHABLE",
  bad_request: "MODEL_BAD_REQUEST",
  refusal: "MODEL_REFUSED",
  unknown: "MODEL_ERROR",
};

export class AgentWorker {
  readonly owner: string;
  readonly #o: ResolvedOptions;
  readonly #active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  #timer: NodeJS.Timeout | null = null;
  #idleMs: number;
  #running = false;
  #stopped = false;

  constructor(o: WorkerOptions) {
    this.owner = o.owner ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
    this.#o = {
      idlePollMs: DEFAULT_IDLE_POLL_MS,
      leaseMs: DEFAULT_LEASE_MS,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
      random: Math.random,
      // An option passed as undefined (an unset config value) keeps its default instead of becoming NaN.
      ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)),
    } as ResolvedOptions;
    this.#idleMs = this.#o.pollMs;
  }

  get activeCount(): number {
    return this.#active.size;
  }

  start(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    this.#o.runs.onCreated(() => this.wake());
    this.#o.runs.onCancel((id) => this.#active.get(id)?.controller.abort("cancel" satisfies AbortReason));
    this.#schedule(0);
  }

  /** Poll now (a run was created or a slot freed). */
  wake(): void {
    if (!this.#running || this.#stopped) return;
    this.#idleMs = this.#o.pollMs;
    this.#schedule(0);
  }

  /** Stops claiming, aborts runs in flight (they go back to the queue with their attempt given back), and waits. */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#o.runs.onCreated(null);
    this.#o.runs.onCancel(null);
    for (const a of this.#active.values()) a.controller.abort("shutdown" satisfies AbortReason);
    await Promise.allSettled([...this.#active.values()].map((a) => a.done));
  }

  /** Waits until no run is in flight (tests). */
  async idle(): Promise<void> {
    while (this.#active.size) await Promise.allSettled([...this.#active.values()].map((a) => a.done));
  }

  #schedule(ms: number): void {
    if (this.#stopped) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.tick()
        .then((claimed) => {
          // Work likely while something is running or was just claimed; back off when the queue is empty.
          this.#idleMs = claimed > 0 || this.#active.size > 0 ? this.#o.pollMs : Math.min(this.#idleMs * 2, this.#o.idlePollMs);
        })
        .catch((err) => this.#o.log.warn("agent worker tick failed", { err }))
        .finally(() => {
          if (this.#running && !this.#timer) this.#schedule(this.#idleMs);
        });
    }, ms);
    this.#timer.unref();
  }

  /** Requeues expired leases, then claims runs into free slots. Returns how many were claimed. */
  tick(): Promise<number> {
    // Synchronous (the database calls are), so two ticks can never interleave.
    try {
      this.#o.runs.requeueExpired();
      let claimed = 0;
      while (!this.#stopped && this.#active.size < this.#o.workers) {
        const row = this.#o.runs.claim(this.owner, this.#o.leaseMs, this.#o.maxPerMerchant);
        if (!row) break;
        claimed++;
        this.#launch(row);
      }
      return Promise.resolve(claimed);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  #launch(row: RunRow): void {
    const controller = new AbortController();
    const done = this.#execute(row, controller)
      .catch((err) => this.#o.log.error("agent run crashed", { runId: row.id, err }))
      .finally(() => {
        this.#active.delete(row.id);
        this.wake();
      });
    this.#active.set(row.id, { controller, done });
  }

  // ------------------------------------------------------------------ one attempt

  async #execute(row: RunRow, controller: AbortController): Promise<void> {
    const { runs, connections, agents, log } = this.#o;
    const signal = controller.signal;
    const abort = (r: AbortReason) => controller.abort(r);
    const heartbeat = setInterval(() => {
      try {
        const h = runs.heartbeat(row.id, this.owner, this.#o.leaseMs);
        if (!h.held) abort("lease_lost");
        else if (h.cancelRequested) abort("cancel");
      } catch (err) {
        log.warn("agent run heartbeat failed", { runId: row.id, err });
      }
    }, this.#o.heartbeatMs);
    heartbeat.unref();
    let timeout: NodeJS.Timeout | null = null;
    let tools: OpsToolbox | null = null;
    let apiKey: string | undefined;
    let connectionId = row.connection_id;
    try {
      const agent = agents.row(row.agent_id);
      if (!agent || agent.deleted_at) throw new RunFailure("AGENT_DELETED", "the agent was deleted");
      if (runs.cancelRequested(row.id)) throw new CancelSignal("cancel requested");
      const conn = connections.row(row.connection_id);
      if (!conn || conn.deleted_at) throw new RunFailure("CONNECTION_NOT_FOUND", "the AI connection was deleted");
      if (conn.status === "disabled") throw new RunFailure("CONNECTION_DISABLED", "the AI connection is disabled");
      if (conn.status === "invalid") throw new RunFailure("MODEL_AUTH_FAILED", "the AI provider rejected the connection's key; fix it in Settings > AI models");
      connectionId = conn.id;
      if (connections.overLimit(conn)) throw new RunFailure("TOKEN_LIMIT_REACHED", "this month's token limit of the AI connection is reached");
      timeout = setTimeout(() => abort("timeout"), agent.timeout_seconds * 1000);
      timeout.unref();
      let client: ModelClient;
      try {
        const spec = connections.spec(conn, agent.model);
        apiKey = spec.apiKey;
        if (conn.base_url) await connections.checkBaseUrl(conn.base_url);
        client = connections.models.createModelClient(spec, { fetch: this.#o.fetch, maxRetries: 0 });
      } catch (err) {
        if (err instanceof ModelError) throw err;
        if (err instanceof SecretError) throw new RunFailure("SECRET_UNAVAILABLE", err.message);
        throw new RunFailure("MODEL_UNAVAILABLE", err instanceof Error ? err.message : String(err));
      }
      if (agent.kind === "ops") {
        try {
          tools = await this.#o.tools({
            merchantId: row.merchant_id,
            runId: row.id,
            attempt: row.attempt,
            allowed: agentTools(agent),
            expiresAt: new Date(runs.now() + agent.timeout_seconds * 1000 + this.#o.leaseMs),
          });
        } catch (err) {
          throw new RunFailure("TOOL_FAILED", `the merchant tools did not start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      runs.step(row.id, row.attempt, "started", { attempt: row.attempt, provider: client.provider, model: client.model, tools: tools?.specs.map((t) => t.name) ?? [] });
      const result = await this.#loop(row, agent, client, tools, conn.id, signal);
      if (!runs.finish(row.id, this.owner, "succeeded", { result })) log.warn("agent run lost its lease before finishing", { runId: row.id });
    } catch (err) {
      this.#settle(row, err, signal, connectionId, apiKey);
    } finally {
      clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      try {
        tools?.close();
      } catch (err) {
        log.warn("revoking the run's key failed", { runId: row.id, err });
      }
    }
  }

  /** The tool-use loop on the neutral model interface. */
  async #loop(row: RunRow, agent: AgentRow, client: ModelClient, tools: OpsToolbox | null, connectionId: string, signal: AbortSignal) {
    const { runs, connections } = this.#o;
    const specs: ToolSpec[] = tools?.specs ?? [];
    const system = systemPrompt(agent.kind, { instructions: agent.instructions, name: agent.name, description: agent.description });
    const messages: ChatMessage[] = [{ role: "user", parts: [{ type: "text", text: row.input }] }];
    const checkpoint = () => {
      if (signal.aborted) throw new Error("aborted");
      if (runs.cancelRequested(row.id)) throw new CancelSignal("cancel requested");
    };
    const limitCheck = () => {
      const conn = connections.row(connectionId);
      if (conn && connections.overLimit(conn)) throw new RunFailure("TOKEN_LIMIT_REACHED", "this month's token limit of the AI connection is reached");
    };
    let outputTokens = 0;
    let ordinal = 0;
    let answer = "";
    for (let turn = 1; turn <= agent.max_turns; turn++) {
      checkpoint();
      limitCheck();
      const maxTokens = Math.min(MAX_TOKENS_PER_TURN, agent.max_output_tokens - outputTokens);
      if (maxTokens <= 0) throw new RunFailure("OUTPUT_LIMIT_REACHED", `the agent used its ${agent.max_output_tokens} output tokens`);
      const started = Date.now();
      const t = await client.turn({ system, tools: specs, messages, maxTokens }, { signal });
      outputTokens += t.usage.outputTokens;
      const inputTokens = totalInputTokens(t.usage);
      runs.recordUsage(row.id, this.owner, inputTokens, t.usage.outputTokens, t.model, client.provider);
      const text = t.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n").trim();
      if (text) answer = text;
      const calls = t.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
      runs.step(row.id, row.attempt, "model_turn", {
        turn,
        stop: t.stop,
        model: t.model,
        input_tokens: inputTokens,
        output_tokens: t.usage.outputTokens,
        cache_read_input_tokens: t.usage.cacheReadInputTokens ?? 0,
        ms: Date.now() - started,
        text: excerpt(text, 2_000),
        tool_calls: calls.map((c) => c.name),
      });
      messages.push({ role: "assistant", parts: t.parts, ...(t.native ? { native: t.native } : {}) });
      if (t.stop === "refusal") throw new RunFailure("MODEL_REFUSED", t.refusal?.explanation ?? "the model declined the task");
      if (calls.length === 0) {
        if (t.stop === "max_tokens" && !answer) throw new RunFailure("OUTPUT_LIMIT_REACHED", "the model hit its token limit before answering");
        return { answer, data: { turns: turn, tool_calls: ordinal, ...(t.stop === "max_tokens" ? { truncated: true } : {}) } };
      }
      limitCheck();
      const results: Part[] = [];
      for (const call of calls) {
        checkpoint();
        ordinal++;
        runs.step(row.id, row.attempt, "tool_call", { ordinal, id: call.id, name: call.name, input: call.input });
        let out: { isError: boolean; content: string };
        if (call.inputError) out = { isError: true, content: `Invalid arguments: ${call.inputError}` };
        else if (!tools) out = { isError: true, content: `This agent has no tools; ${call.name} is not available.` };
        else {
          try {
            out = await tools.call(call.name, call.input, ordinal);
          } catch (err) {
            out = { isError: true, content: `The tool failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        runs.step(row.id, row.attempt, "tool_result", { ordinal, id: call.id, name: call.name, is_error: out.isError, summary: excerpt(out.content, 500) });
        results.push({ type: "tool_result", id: call.id, content: out.content, isError: out.isError });
      }
      messages.push({ role: "user", parts: results });
    }
    throw new RunFailure("MAX_TURNS_REACHED", `the agent used its ${agent.max_turns} turns without a final answer`);
  }

  /** Decides what an attempt that threw becomes: retry, failure, timeout, cancel, or nothing (lease lost). */
  #settle(row: RunRow, err: unknown, signal: AbortSignal, connectionId: string, apiKey: string | undefined): void {
    const { runs, connections, log } = this.#o;
    const reason = (signal.aborted ? signal.reason : err instanceof CancelSignal ? "cancel" : null) as AbortReason | null;
    const finish = (status: "failed" | "cancelled" | "timed_out", code: string, message: string) => {
      if (!runs.finish(row.id, this.owner, status, { errorCode: code, errorMessage: scrubSecrets(message, apiKey) })) log.warn("agent run lost its lease before finishing", { runId: row.id });
    };
    if (reason === "lease_lost") return void log.warn("agent run lease lost; another worker owns it", { runId: row.id });
    if (reason === "shutdown") return void runs.requeue(row.id, this.owner, runs.now(), { reason: "shutdown" }, { refund: true });
    if (reason === "cancel") return finish("cancelled", "CANCELLED", "cancelled while running");
    if (reason === "timeout") return finish("timed_out", "TIMEOUT", "the attempt ran out of time");
    if (err instanceof RunFailure) return finish("failed", err.code, err.message);
    if (err instanceof ModelError) {
      if (err.kind === "auth") {
        connections.markInvalid(connectionId, err, apiKey);
        return finish("failed", "MODEL_AUTH_FAILED", `the AI provider rejected the key: ${err.message}`);
      }
      if (err.retryable && row.attempt < row.max_attempts) {
        const delay = this.retryDelay(row.attempt, err.retryAfterMs);
        runs.requeue(row.id, this.owner, runs.now() + delay, {
          reason: err.kind,
          error_code: MODEL_ERROR_CODES[err.kind],
          error_message: scrubSecrets(err.message, apiKey),
          status: err.status,
          delay_ms: delay,
          retry_after_ms: err.retryAfterMs,
        });
        return;
      }
      return finish("failed", MODEL_ERROR_CODES[err.kind], err.message);
    }
    log.error("agent run failed unexpectedly", { runId: row.id, err });
    finish("failed", "INTERNAL", "the run failed inside the server");
  }

  /** Backoff for the attempt that just failed (2 s, 8 s, 30 s with plus or minus 20 % jitter), at least Retry-After. */
  retryDelay(attempt: number, retryAfterMs: number | null): number {
    const d = this.#o.retryDelaysMs;
    const base = d[Math.min(attempt - 1, d.length - 1)] ?? 0;
    const jittered = Math.round(base * (0.8 + 0.4 * this.#o.random()));
    return Math.max(jittered, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
  }
}

/** Thrown by a checkpoint that saw cancel_requested before any abort happened. */
class CancelSignal extends Error {}
