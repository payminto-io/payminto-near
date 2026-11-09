/**
 * The agent runtime: a provider-neutral tool-use loop over MCP tools, with limits enforced below the model. It talks
 * to one ModelClient (Claude, OpenAI, Gemini or any OpenAI-compatible endpoint, see src/providers/) in neutral types.
 *
 * Limits: max model turns, max output tokens for the whole task, and (when the tools are a Payminto wallet) a per-task
 * spend ceiling in token base units. The ceiling is checked against the wallet itself: get_budget before the first
 * turn and after every paying tool round, and a known price is checked before a paying call is made. When spend
 * reaches the ceiling the loop stops and reports.
 *
 * Paid content is data: a paying call may only target a service in the node's directory (list_paid_services) or a
 * URL the user wrote in the task, so an address planted inside a service response is never paid, whatever the model
 * decides. The mandate (wallet and node) enforces the owner's policy underneath both.
 */
import { formatAmount } from "@payminto/protocol";
import { describeModelError, ModelError, textOf, toolCallsOf, type ChatMessage, type ModelClient, type ModelTurn, type Part, type Provider } from "@payminto/models";
import type { ToolHost, ToolOutcome } from "./mcp.ts";
import { toolJson } from "./scripted.ts";

export type RunLimits = {
  /** Model turns (requests to the model) before the loop stops. */
  maxTurns: number;
  /** Output tokens across the whole task, thinking included. */
  maxOutputTokens: number;
  /** max_tokens of one turn (capped by what is left of maxOutputTokens). */
  maxTokensPerTurn: number;
  /** Per-task spend ceiling in token base units; null for agents that do not spend. */
  maxSpendAtomic: bigint | null;
};

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 16, maxOutputTokens: 64_000, maxTokensPerTurn: 16_000, maxSpendAtomic: 500_000n };

export type RunStatus =
  | "completed"
  | "max_turns"
  | "max_output_tokens"
  | "spend_ceiling"
  /** The model declined the task (a refusal or safety stop; for Claude, after the server-side fallback). */
  | "model_refusal"
  | "model_error"
  | "aborted";

export type Receipt = { callId: string; tool: string; service: string | null; payee: string; amountAtomic: string; amount: string };

/** A payment that was refused: by the mandate (wallet before signing, or the node), or by this runtime. */
export type Refusal = { tool: string; rule: string; ruleText: string; enforcedBy: "agent" | "node" | "runtime"; target: string | null };

export type SpendReport = {
  token: { symbol: string; decimals: number };
  mandateId: string | null;
  ceilingAtomic: string | null;
  ceiling: string | null;
  /** What this task spent: the wallet's budget delta, never less than the sum of its receipts. */
  spentAtomic: string;
  spent: string;
  receipts: Receipt[];
  budgetLeftAtomic: string | null;
  budgetLeft: string | null;
  refusals: Refusal[];
};

export type ToolCallLog = { turn: number; name: string; server: string | null; input: Record<string, unknown>; isError: boolean; ms: number; summary: string };

/** What one model turn used, as the provider reported it. */
export type TurnUsageLog = {
  turn: number;
  model: string;
  stop: ModelTurn["stop"];
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  ms: number;
};

export type RunResult = {
  status: RunStatus;
  /** The model's final answer (or the last text it wrote before a limit stopped it). */
  answer: string;
  provider: Provider;
  model: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
  /** One entry per model turn that returned. */
  turnUsage: TurnUsageLog[];
  toolCalls: ToolCallLog[];
  /** Null when the tools are not a Payminto wallet. */
  spend: SpendReport | null;
  /** Why the run stopped early, in one line. */
  note: string | null;
  /**
   * The provider failure that ended a model_error run, unchanged, so a caller (the node worker) can decide on a retry
   * from its kind, retryable flag and retryAfterMs. Null otherwise. A non-provider failure is wrapped as kind unknown.
   */
  error: ModelError | null;
  startedAt: string;
  finishedAt: string;
};

export type RunEvent =
  | { type: "turn"; turn: number }
  | { type: "model_turn"; turn: number; usage: TurnUsageLog }
  | { type: "text"; turn: number; text: string }
  | { type: "tool"; turn: number; name: string; input: Record<string, unknown>; outcome: ToolOutcome }
  | { type: "stop"; status: RunStatus; note: string | null };

export type RunOptions = {
  model: ModelClient;
  tools: ToolHost;
  system: string;
  task: string;
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
};

const PAYING = new Set(["call_paid_service", "pay_link"]);
const WALLET_TOOLS = ["get_budget", "list_paid_services", "call_paid_service"];

type Json = Record<string, unknown>;
type DirectoryEntry = { id: string; name: string; url: string; type: string; priceAtomic: string | null };

const asJson = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The `result` a Payminto MCP tool returned (structuredContent first, then the JSON in its text). */
function resultOf(o: ToolOutcome): unknown {
  const s = asJson(o.structured);
  if (s && "result" in s) return s.result;
  return toolJson(o.text);
}

/** origin + path, so a call with a different query string still matches its directory entry. */
function endpointKey(u: string): string | null {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

/** Wallet-side bookkeeping for one task: baseline budget, receipts, refusals and the ceiling. */
class SpendTracker {
  readonly #tools: ToolHost;
  readonly #ceiling: bigint | null;
  readonly #taskUrls: Set<string>;
  #directory: DirectoryEntry[] | null = null;
  token = { symbol: "", decimals: 6 };
  mandateId: string | null = null;
  baseline: bigint | null = null;
  current: bigint | null = null;
  remaining: bigint | null = null;
  readonly receipts: Receipt[] = [];
  readonly refusals: Refusal[] = [];

  constructor(tools: ToolHost, ceiling: bigint | null, task: string) {
    this.#tools = tools;
    this.#ceiling = ceiling;
    this.#taskUrls = new Set((task.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).flatMap((u) => endpointKey(u) ?? []));
  }

  fmt(atomic: bigint): string {
    return `${formatAmount(atomic, this.token.decimals)}${this.token.symbol ? ` ${this.token.symbol}` : ""}`;
  }

  /** Reads get_budget; returns false when the wallet did not answer (the run then counts receipts only). */
  async refresh(): Promise<boolean> {
    const o = await this.#tools.call("get_budget", {});
    const b = o.isError ? null : asJson(resultOf(o));
    if (!b) return false;
    const token = asJson(b.token);
    if (token && typeof token.symbol === "string" && typeof token.decimals === "number") this.token = { symbol: token.symbol, decimals: token.decimals };
    this.mandateId = str(b.mandateId) ?? this.mandateId;
    const spent = str(asJson(b.spent)?.totalAtomic);
    if (spent && /^\d+$/.test(spent)) {
      this.current = BigInt(spent);
      this.baseline ??= this.current;
    }
    const rem = str(b.remainingAtomic);
    this.remaining = rem && /^\d+$/.test(rem) ? BigInt(rem) : null;
    return true;
  }

  spent(): bigint {
    const fromReceipts = this.receipts.reduce((s, r) => s + BigInt(r.amountAtomic), 0n);
    const fromBudget = this.baseline !== null && this.current !== null ? this.current - this.baseline : 0n;
    return fromBudget > fromReceipts ? fromBudget : fromReceipts;
  }

  reached(): boolean {
    return this.#ceiling !== null && this.spent() >= this.#ceiling;
  }

  remember(name: string, o: ToolOutcome) {
    if (name !== "list_paid_services" || o.isError) return;
    const list = resultOf(o);
    if (!Array.isArray(list)) return;
    this.#directory = list.flatMap((x) => {
      const e = asJson(x);
      const id = str(e?.id);
      const url = str(e?.url);
      if (!e || !id || !url) return [];
      return [{ id, name: str(e.name) ?? id, url, type: str(e.type) ?? "endpoint", priceAtomic: str(e.priceAtomic) }];
    });
  }

  async #ensureDirectory(): Promise<DirectoryEntry[]> {
    if (!this.#directory) this.remember("list_paid_services", await this.#tools.call("list_paid_services", {}));
    return this.#directory ?? [];
  }

  /**
   * Decides whether a paying call may go out. Returns a refusal text for the model, or null to proceed.
   * The target must be listed in the directory or written by the user; a known price must fit under the ceiling.
   */
  async gate(name: string, input: Json): Promise<string | null> {
    const dir = await this.#ensureDirectory();
    const url = str(input.url);
    const serviceId = str(input.serviceId);
    let entry: DirectoryEntry | undefined;
    let target: string | null = url ?? serviceId;
    if (url) {
      const key = endpointKey(url);
      entry = dir.find((d) => endpointKey(d.url) === key);
      if (!entry && !(key && this.#taskUrls.has(key))) {
        return this.#refuse(name, "NOT_IN_DIRECTORY", "Target is neither in the node's service directory nor written by the user in the task", target);
      }
    } else if (serviceId) {
      entry = dir.find((d) => d.id === serviceId || d.name === serviceId);
      if (!entry) return this.#refuse(name, "NOT_IN_DIRECTORY", "Service id is not in the node's service directory", target);
      target = entry.name;
    } else return null; // the wallet itself rejects a call without a target
    if (this.#ceiling === null) return null;
    const amount = str(input.amountAtomic) ?? entry?.priceAtomic ?? null;
    if (amount && /^\d+$/.test(amount) && this.spent() + BigInt(amount) > this.#ceiling) {
      return this.#refuse(
        name,
        "TASK_SPEND_CEILING",
        `Price ${this.fmt(BigInt(amount))} would take this task past its spend ceiling of ${this.fmt(this.#ceiling)} (spent ${this.fmt(this.spent())})`,
        target,
      );
    }
    return null;
  }

  #refuse(tool: string, rule: string, ruleText: string, target: string | null): string {
    this.refusals.push({ tool, rule, ruleText, enforcedBy: "runtime", target });
    return `Payment refused by the agent runtime, rule ${rule}: ${ruleText}. Nothing was paid. This limit is set by the owner for this task; do not retry it another way.`;
  }

  /** Books the receipts or the refusal a paying tool returned. */
  record(name: string, input: Json, o: ToolOutcome) {
    const r = asJson(resultOf(o));
    if (o.isError) {
      const m = /mandate rule ([A-Z0-9_]+)/.exec(o.text);
      if (!m) return;
      const by = str(r?.enforcedBy);
      this.refusals.push({
        tool: name,
        rule: str(r?.rule) ?? m[1]!,
        ruleText: str(r?.ruleText) ?? "",
        enforcedBy: by === "agent" || by === "node" ? by : "node",
        target: str(r?.service) ?? str(r?.url) ?? str(input.url) ?? str(input.serviceId),
      });
      return;
    }
    if (!r) return;
    if (name === "call_paid_service") {
      const p = asJson(r.payment);
      const callId = str(p?.callId);
      const amountAtomic = str(p?.amountAtomic);
      if (p && callId && amountAtomic) {
        this.receipts.push({ callId, tool: name, service: str(r.service) ?? str(r.url), payee: str(p.payee) ?? "", amountAtomic, amount: this.fmt(BigInt(amountAtomic)) });
      }
    } else if (name === "pay_link") {
      const vouchers = asJson(r.breakdown)?.vouchers;
      for (const v of Array.isArray(vouchers) ? vouchers : []) {
        const x = asJson(v);
        const callId = str(x?.callId);
        const amountAtomic = str(x?.amount);
        if (x && callId && amountAtomic) {
          const label = `link ${str(r.paymentId) ?? ""}${x.role === "platform fee" ? " (platform fee)" : ""}`.trim();
          this.receipts.push({ callId, tool: name, service: label, payee: str(x.payee) ?? "", amountAtomic, amount: this.fmt(BigInt(amountAtomic)) });
        }
      }
    }
  }

  report(): SpendReport {
    const spent = this.spent();
    return {
      token: this.token,
      mandateId: this.mandateId,
      ceilingAtomic: this.#ceiling?.toString() ?? null,
      ceiling: this.#ceiling === null ? null : this.fmt(this.#ceiling),
      spentAtomic: spent.toString(),
      spent: this.fmt(spent),
      receipts: this.receipts,
      budgetLeftAtomic: this.remaining?.toString() ?? null,
      budgetLeft: this.remaining === null ? null : this.fmt(this.remaining),
      refusals: this.refusals,
    };
  }
}

/** True when the tool set is a Payminto wallet (spend tracking and the directory guard switch on). */
export function isWalletToolset(tools: ToolHost): boolean {
  const names = new Set(tools.tools.map((t) => t.name));
  return WALLET_TOOLS.every((n) => names.has(n));
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}...` : line;
}

/**
 * Runs one task to completion or until a limit stops it. Never throws for model or tool failures: they end the run
 * with a status and a note, so a caller always gets the spend report of whatever was bought.
 */
export async function runAgent(o: RunOptions): Promise<RunResult> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...o.limits };
  const startedAt = new Date().toISOString();
  const emit = (e: RunEvent) => {
    try {
      o.onEvent?.(e);
    } catch {
      // a logging hook never breaks a run
    }
  };
  const wallet = isWalletToolset(o.tools) ? new SpendTracker(o.tools, limits.maxSpendAtomic, o.task) : null;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const toolCalls: ToolCallLog[] = [];
  let turns = 0;
  let answer = "";
  let status: RunStatus = "max_turns";
  let note: string | null = null;

  if (wallet) await wallet.refresh();
  const ceilingLine = wallet && limits.maxSpendAtomic !== null ? `\n\nSpend ceiling for this task: ${wallet.fmt(limits.maxSpendAtomic)} (${limits.maxSpendAtomic} base units).` : "";
  const messages: ChatMessage[] = [{ role: "user", parts: [{ type: "text", text: `${o.task}${ceilingLine}` }] }];
  const turnUsage: TurnUsageLog[] = [];
  let error: ModelError | null = null;

  try {
    for (;;) {
      if (o.signal?.aborted) {
        status = "aborted";
        note = "the run was cancelled";
        break;
      }
      if (turns >= limits.maxTurns) {
        status = "max_turns";
        note = `stopped after ${limits.maxTurns} model turns (max turns)`;
        break;
      }
      const left = limits.maxOutputTokens - usage.outputTokens;
      if (left < 1_024) {
        status = "max_output_tokens";
        note = `stopped after ${usage.outputTokens} output tokens (limit ${limits.maxOutputTokens})`;
        break;
      }
      turns++;
      emit({ type: "turn", turn: turns });
      let msg: ModelTurn;
      const t0 = Date.now();
      try {
        msg = await o.model.turn({ system: o.system, tools: o.tools.tools, messages, maxTokens: Math.min(limits.maxTokensPerTurn, left) }, { signal: o.signal });
      } catch (err) {
        if (o.signal?.aborted) {
          status = "aborted";
          note = "the run was cancelled";
        } else {
          status = "model_error";
          error = err instanceof ModelError ? err : new ModelError("unknown", describeModelError(err), { provider: o.model.provider, cause: err });
          note = describeModelError(error);
        }
        break;
      }
      const used: TurnUsageLog = {
        turn: turns,
        model: msg.model,
        stop: msg.stop,
        inputTokens: msg.usage.inputTokens,
        outputTokens: msg.usage.outputTokens,
        cacheReadInputTokens: msg.usage.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: msg.usage.cacheCreationInputTokens ?? 0,
        ms: Date.now() - t0,
      };
      turnUsage.push(used);
      emit({ type: "model_turn", turn: turns, usage: used });
      usage.inputTokens += used.inputTokens;
      usage.outputTokens += used.outputTokens;
      usage.cacheReadInputTokens += used.cacheReadInputTokens;
      usage.cacheCreationInputTokens += used.cacheCreationInputTokens;
      // Append-only history: the whole assistant turn goes back unchanged (its native content carries Claude's
      // thinking blocks and Gemini's thought signatures).
      messages.push({ role: "assistant", parts: msg.parts, ...(msg.native ? { native: msg.native } : {}) });
      const text = textOf(msg);
      if (text) {
        answer = text;
        emit({ type: "text", turn: turns, text });
      }

      if (msg.stop === "refusal") {
        status = "model_refusal";
        const d = msg.refusal;
        note = `the model declined this task${d?.category ? ` (${d.category})` : ""}${d?.explanation ? `: ${d.explanation}` : ""}`;
        break;
      }
      const uses = toolCallsOf(msg);
      if (msg.stop === "max_tokens") {
        // A tool input cut off at max_tokens can parse as a valid partial object: never run it.
        status = "max_output_tokens";
        note = `a model turn hit its max_tokens (${Math.min(limits.maxTokensPerTurn, left)}) before finishing`;
        break;
      }
      if (uses.length === 0) {
        status = "completed";
        break;
      }

      const results: Part[] = [];
      let paid = false;
      for (const use of uses) {
        const input = asJson(use.input) ?? {};
        const t0 = Date.now();
        let outcome: ToolOutcome;
        // Arguments the provider could not give as a JSON object never reach a tool; the model gets to try again.
        const badInput = use.inputError
          ? `Tool ${use.name} was not run: its ${use.inputError}. Call it again with the arguments as one JSON object that matches the tool's input schema.`
          : null;
        const blocked = badInput ?? (wallet && PAYING.has(use.name) ? await wallet.gate(use.name, input) : null);
        if (blocked) outcome = { isError: true, text: blocked, structured: undefined };
        else {
          outcome = await o.tools.call(use.name, input);
          if (wallet) {
            wallet.remember(use.name, outcome);
            if (PAYING.has(use.name)) {
              wallet.record(use.name, input, outcome);
              paid ||= !outcome.isError;
            }
          }
        }
        toolCalls.push({ turn: turns, name: use.name, server: o.tools.serverOf(use.name) ?? null, input, isError: outcome.isError, ms: Date.now() - t0, summary: firstLine(outcome.text) });
        emit({ type: "tool", turn: turns, name: use.name, input, outcome });
        results.push({ type: "tool_result", id: use.id, content: outcome.text || "(empty)", isError: outcome.isError });
      }
      // All results of one turn go back in a single user message.
      messages.push({ role: "user", parts: results });

      if (wallet && paid) {
        await wallet.refresh();
        if (wallet.reached()) {
          status = "spend_ceiling";
          note = `stopped: this task spent ${wallet.fmt(wallet.spent())}, which reaches its spend ceiling of ${wallet.fmt(limits.maxSpendAtomic!)}`;
          break;
        }
      }
    }
  } finally {
    // The final budget read is best effort: the report still lists every receipt the tools returned.
    if (wallet) await wallet.refresh().catch(() => false);
  }
  emit({ type: "stop", status, note });
  return {
    status,
    answer,
    provider: o.model.provider,
    model: o.model.model,
    turns,
    usage,
    turnUsage,
    toolCalls,
    spend: wallet?.report() ?? null,
    note,
    error,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** A plain-text rendering of a run for terminals: answer, then the spend report. */
export function renderRun(r: RunResult): string {
  const out: string[] = [];
  out.push(r.answer || "(no answer)");
  out.push("");
  out.push(`status: ${r.status}${r.note ? ` (${r.note})` : ""}`);
  out.push(`model: ${r.provider}/${r.model}, ${r.turns} turns, ${r.usage.outputTokens} output tokens, ${r.toolCalls.length} tool calls`);
  const s = r.spend;
  if (s) {
    out.push("");
    out.push("Spend report");
    out.push(`  spent ${s.spent}${s.ceiling ? ` of a ${s.ceiling} task ceiling` : ""}${s.budgetLeft ? `, mandate budget left ${s.budgetLeft}` : ""}`);
    if (s.receipts.length === 0) out.push("  no paid calls");
    for (const x of s.receipts) out.push(`  receipt ${x.callId}  ${x.amount.padStart(14)}  ${x.service ?? ""}  -> ${x.payee}`);
    for (const x of s.refusals) out.push(`  refused ${x.rule} (${x.enforcedBy}): ${x.ruleText}${x.target ? ` [${x.target}]` : ""}`);
  }
  return out.join("\n");
}
