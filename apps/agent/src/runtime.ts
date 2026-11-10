/**
 * The agent runtime: a provider-neutral tool-use loop over MCP tools, with limits enforced below the model. It talks
 * to one ModelClient (Claude, OpenAI, Gemini or any OpenAI-compatible endpoint, see src/providers/) in neutral types.
 *
 * Limits: max model turns, max output tokens for the whole task, and (when the tools are a Payminto wallet) a per-task
 * spend ceiling in token base units. The ceiling counts what left the Budget, not what a seller delivered:
 * - every paying call is booked from the wallet's own report of what it paid, on success, on a refusal and on an error
 *   alike, and an amount the wallet could not confirm either way counts as spent;
 * - get_budget is read before the first turn and after every paying call, so spend the results did not show (another
 *   process of this agent, a voucher booked late) still counts;
 * - before a paying call a known price is checked against what is left, and what is left goes to the wallet as the
 *   call's maximum price, so an unknown or changed price cannot pass the ceiling either.
 * A run that reaches the ceiling stops as spend_ceiling; it is never reported as completed.
 *
 * Paid content is data: a paying call may only target a service in the node's directory (list_paid_services) or a
 * URL the user wrote in the task, so an address planted inside a service response is never paid, whatever the model
 * decides. The wallet applies its own target rule underneath (its node's directory and the operator's host
 * allowlist), and the budget (wallet and node) enforces the owner's policy underneath both.
 */
import { formatAmount } from "@payminto/protocol";
import { describeModelError, ModelError, summarizeAttestation, textOf, toolCallsOf, type AttestationStatus, type ChatMessage, type ModelClient, type ModelTurn, type Part, type Provider } from "@payminto/models";
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

/**
 * A voucher the wallet signed and sent without learning what became of it. The seller can still collect it, so its
 * amount counts against the ceiling like a receipt.
 */
export type Unverified = Receipt & { note: string };

/**
 * A payment that was refused. `enforcedBy` says whose word it is: "agent" (the wallet, before signing, from the
 * Budget it verified), "runtime" (this loop), or "seller" (a seller's answer after a voucher was sent, which is not
 * authenticated and is not the owner's policy). "node" is what a wallet without that distinction reports.
 */
export type Refusal = {
  tool: string;
  rule: string;
  ruleText: string;
  enforcedBy: "agent" | "node" | "seller" | "runtime";
  target: string | null;
  /** The refused price in atomic units, when the wallet reported it. */
  attemptedAmount: string | null;
  /** What was left of the Budget at the refusal, in atomic units, when known. */
  remainingBudget: string | null;
  /** What the owner's policy says about retrying: never, after N seconds, after settlement, after funding, after an approval. */
  retry: { kind: string; [k: string]: unknown } | null;
  /** What a person does next about this refusal, in one sentence, or null when nothing helps. */
  nextStep: string | null;
};

/** The two rules of the payee check: the wallet (before signing) or the node refused because of who would be paid. */
const PAYEE_RULES = new Set(["PAYEE_BLOCKED", "PAYEE_NEEDS_APPROVAL"]);

/**
 * What to do next about a refusal, from its rule and retry hint. For a payee that waits for approval it names where
 * the owner decides: that address comes from the wallet's own clearing node, and it is for the person reading the
 * report, never something the agent acts on.
 */
export function nextStepOf(rule: string, retry: Refusal["retry"], o: { payee?: string | null; approveAt?: string | null } = {}): string | null {
  const payee = (typeof retry?.payee === "string" ? retry.payee : null) ?? o.payee ?? "the payee";
  const approveAt = (typeof retry?.approveAt === "string" ? retry.approveAt : null) ?? o.approveAt ?? null;
  if (rule === "PAYEE_NEEDS_APPROVAL") {
    if (retry?.kind === "after") return `The wallet could not ask its clearing node about ${payee}; run the task again in ${String(retry.seconds)} s.`;
    return `The Budget's owner approves or denies ${payee} in the Payminto dashboard${approveAt ? ` (${approveAt})` : ""}; run the task again after that.`;
  }
  if (rule === "PAYEE_BLOCKED") {
    if (retry?.kind === "after") return `${payee} could not be checked; run the task again in ${String(retry.seconds)} s.`;
    return `Do not pay ${payee}. If it should be paid, the Budget's owner reads the payee check's reasons in the Payminto dashboard and decides there.`;
  }
  switch (retry?.kind) {
    case "after":
      return `The same call can succeed in ${String(retry.seconds)} s.`;
    case "after_settlement":
      return "The same call can succeed after the next settlement.";
    case "fund":
      return `The owner adds ${String(retry.shortBy)} base units to the Budget's escrow.`;
    case "resign":
      return "The wallet signs again at the position its node reports.";
    default:
      return null;
  }
}

export type SpendReport = {
  token: { symbol: string; decimals: number };
  budgetId: string | null;
  ceilingAtomic: string | null;
  ceiling: string | null;
  /** What this task spent: the wallet's budget delta, never less than its receipts plus its unverified vouchers. */
  spentAtomic: string;
  spent: string;
  receipts: Receipt[];
  /** Vouchers sent with an unknown outcome. Counted in spentAtomic. */
  unverified: Unverified[];
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
  /**
   * Set when the provider ran this turn in an attested enclave and checked it (NEAR AI Cloud): the status its check
   * reached and its own summary of what was shown and what was not. Absent for every other provider.
   */
  attestation?: { status: AttestationStatus; summary: string };
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
/** The wallet argument that holds one call to a maximum price (apps/mcp server.ts). */
const MAX_ARG = "maxAmountAtomic";
const ATOMIC = /^(0|[1-9]\d{0,38})$/;

type Json = Record<string, unknown>;
type DirectoryEntry = { id: string; name: string; url: string; type: string; priceAtomic: string | null; payee: string | null };

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

/** Wallet-side bookkeeping for one task: baseline budget, receipts, unverified vouchers, refusals and the ceiling. */
class SpendTracker {
  readonly #tools: ToolHost;
  readonly #ceiling: bigint | null;
  readonly #taskUrls: Set<string>;
  /** Paying tools whose schema takes a maximum price for the call. */
  readonly #limitable: Set<string>;
  #directory: DirectoryEntry[] | null = null;
  token = { symbol: "", decimals: 6 };
  budgetId: string | null = null;
  baseline: bigint | null = null;
  current: bigint | null = null;
  remaining: bigint | null = null;
  readonly receipts: Receipt[] = [];
  readonly unverified: Unverified[] = [];
  readonly refusals: Refusal[] = [];
  /**
   * Payees and targets the payee check stopped in this task, with the rule. Nothing the agent can do changes such a
   * refusal, so a second attempt is answered here and never reaches the wallet.
   */
  readonly #stopped = new Map<string, { rule: string; nextStep: string | null }>();

  constructor(tools: ToolHost, ceiling: bigint | null, task: string) {
    this.#tools = tools;
    this.#ceiling = ceiling;
    this.#taskUrls = new Set((task.match(/https?:\/\/[^\s"'<>)]+/g) ?? []).flatMap((u) => endpointKey(u) ?? []));
    this.#limitable = new Set(tools.tools.filter((t) => PAYING.has(t.name) && asJson(asJson(t.inputSchema)?.properties)?.[MAX_ARG] !== undefined).map((t) => t.name));
  }

  fmt(atomic: bigint): string {
    return `${formatAmount(atomic, this.token.decimals)}${this.token.symbol ? ` ${this.token.symbol}` : ""}`;
  }

  /** Reads get_budget; returns false when the wallet did not answer (the run then counts what the tools reported). */
  async refresh(): Promise<boolean> {
    const o = await this.#tools.call("get_budget", {});
    const b = o.isError ? null : asJson(resultOf(o));
    if (!b) return false;
    const token = asJson(b.token);
    if (token && typeof token.symbol === "string" && typeof token.decimals === "number") this.token = { symbol: token.symbol, decimals: token.decimals };
    this.budgetId = str(b.budgetId) ?? this.budgetId;
    const spent = str(asJson(b.spent)?.totalAtomic);
    if (spent && /^\d+$/.test(spent)) {
      this.current = BigInt(spent);
      this.baseline ??= this.current;
    }
    const rem = str(b.remainingAtomic);
    this.remaining = rem && /^\d+$/.test(rem) ? BigInt(rem) : null;
    return true;
  }

  /**
   * What this task spent: the Budget's own delta, or what the paying tools reported (receipts plus vouchers whose
   * outcome is unknown), whichever is larger. A voucher that is booked later moves from the second into the first, so
   * it is never counted twice.
   */
  spent(): bigint {
    const sum = (list: Receipt[]) => list.reduce((s, r) => s + BigInt(r.amountAtomic), 0n);
    const reported = sum(this.receipts) + sum(this.unverified);
    const fromBudget = this.baseline !== null && this.current !== null && this.current > this.baseline ? this.current - this.baseline : 0n;
    return fromBudget > reported ? fromBudget : reported;
  }

  /** What is left under the ceiling; null without one. Never negative. */
  left(): bigint | null {
    if (this.#ceiling === null) return null;
    const spent = this.spent();
    return this.#ceiling > spent ? this.#ceiling - spent : 0n;
  }

  reached(): boolean {
    return this.left() === 0n;
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
      return [{ id, name: str(e.name) ?? id, url, type: str(e.type) ?? "endpoint", priceAtomic: str(e.priceAtomic), payee: str(e.payee) }];
    });
  }

  async #ensureDirectory(): Promise<DirectoryEntry[]> {
    if (!this.#directory) this.remember("list_paid_services", await this.#tools.call("list_paid_services", {}));
    return this.#directory ?? [];
  }

  /**
   * Decides whether a paying call may go out. Returns a refusal text for the model, or null to proceed.
   * The target must be listed in the directory or written by the user; nothing goes out once the ceiling is reached;
   * and a known price must fit under what is left.
   */
  async gate(name: string, input: Json): Promise<string | null> {
    const dir = await this.#ensureDirectory();
    const url = str(input.url);
    const id = str(input.serviceId) ?? str(input.linkId);
    let entry: DirectoryEntry | undefined;
    let target: string | null = url ?? id;
    if (url) {
      const key = endpointKey(url);
      entry = dir.find((d) => endpointKey(d.url) === key);
      if (!entry && !(key && this.#taskUrls.has(key))) {
        return this.#refuse(name, "NOT_IN_DIRECTORY", "Target is neither in the node's service directory nor written by the user in the task", target);
      }
    } else if (id) {
      entry = dir.find((d) => d.id === id || d.name === id);
      if (!entry) return this.#refuse(name, "NOT_IN_DIRECTORY", "Service id is not in the node's service directory", target);
      target = entry.name;
    } else return null; // the wallet itself rejects a call without a target
    // A payee the check already stopped in this task stays stopped: asking again would only loop.
    const stopped = this.#stopped.get(`payee:${entry?.payee ?? ""}`) ?? this.#stopped.get(`target:${entry?.id ?? endpointKey(url ?? "") ?? target ?? ""}`);
    if (stopped) {
      const waits = stopped.rule === "PAYEE_NEEDS_APPROVAL";
      const text = waits ? "This payee already waits for the owner's approval in this task" : "The payee check already refused this payee in this task";
      this.refusals.push({ tool: name, rule: stopped.rule, ruleText: text, enforcedBy: "runtime", target, attemptedAmount: null, remainingBudget: this.remaining?.toString() ?? null, retry: { kind: "never" }, nextStep: stopped.nextStep });
      return `Payment refused by the agent runtime, rule ${stopped.rule}: ${text}. Nothing was signed, so nothing was paid. ${waits ? "Only the Budget's owner can approve it, outside this task." : "Do not pay this account."} Do not try it again or another way; finish the task with what you have and report this.`;
    }
    const left = this.left();
    if (left === null) return null;
    if (left === 0n) {
      return this.#refuse(name, "TASK_SPEND_CEILING", `This task has reached its spend ceiling of ${this.fmt(this.#ceiling!)} (spent ${this.fmt(this.spent())})`, target);
    }
    const amount = str(input.amountAtomic) ?? entry?.priceAtomic ?? null;
    if (amount && /^\d+$/.test(amount) && BigInt(amount) > left) {
      return this.#refuse(
        name,
        "TASK_SPEND_CEILING",
        `Price ${this.fmt(BigInt(amount))} would take this task past its spend ceiling of ${this.fmt(this.#ceiling!)} (spent ${this.fmt(this.spent())})`,
        target,
      );
    }
    return null;
  }

  /**
   * The arguments a paying call goes out with: the model's, plus what is left under the ceiling as the call's maximum
   * price (the lower of that and any maximum the model gave). The wallet refuses a higher price before it signs, so a
   * price this runtime could not know in advance still cannot pass the ceiling.
   */
  limit(name: string, input: Json): Json {
    const left = this.left();
    if (left === null || !this.#limitable.has(name)) return input;
    const own = str(input[MAX_ARG]);
    const max = own && ATOMIC.test(own) && BigInt(own) < left ? BigInt(own) : left;
    return { ...input, [MAX_ARG]: max.toString() };
  }

  #refuse(tool: string, rule: string, ruleText: string, target: string | null): string {
    this.refusals.push({ tool, rule, ruleText, enforcedBy: "runtime", target, attemptedAmount: null, remainingBudget: this.remaining?.toString() ?? null, retry: { kind: "never" }, nextStep: null });
    return `Payment refused by the agent runtime, rule ${rule}: ${ruleText}. Nothing was paid. This limit is set by the owner for this task; do not retry it another way.`;
  }

  #row(tool: string, service: string | null, x: Json | null): Receipt | null {
    const callId = str(x?.callId);
    const amountAtomic = str(x?.amountAtomic) ?? str(x?.amount);
    if (!x || !callId || !amountAtomic || !/^\d+$/.test(amountAtomic)) return null;
    return { callId, tool, service, payee: str(x.payee) ?? "", amountAtomic, amount: this.fmt(BigInt(amountAtomic)) };
  }

  /**
   * Books what a paying tool returned: what it paid and, for an error, the refusal. The wallet reports what was paid
   * in `spend` on every outcome, so a call that failed or was refused after its voucher was sent is booked like one
   * that succeeded.
   */
  record(name: string, input: Json, o: ToolOutcome) {
    const structured = asJson(o.structured);
    const result = asJson(resultOf(o));
    // Success: { result: {..., spend} }. Failure: { error | refusal, spend } (also the JSON half of the text).
    const body = o.isError ? (structured ?? asJson(toolJson(o.text))) : result;
    const info = asJson(body?.error) ?? asJson(body?.refusal) ?? body;
    const linkId = name === "pay_link" ? str(result?.paymentId) : null;
    const label = (i: number) => (linkId ? `link ${linkId}${i > 0 ? " (platform fee)" : ""}` : (str(info?.service) ?? str(info?.url) ?? str(input.url) ?? str(input.serviceId) ?? str(input.linkId)));
    const known = new Set([...this.receipts, ...this.unverified].map((r) => r.callId));
    const add = (list: Receipt[], row: Receipt | null, extra: Json = {}) => {
      if (!row || known.has(row.callId)) return;
      known.add(row.callId);
      list.push({ ...row, ...extra } as Receipt);
    };
    const spend = asJson(body?.spend);
    if (spend) {
      (Array.isArray(spend.receipts) ? spend.receipts : []).forEach((x, i) => add(this.receipts, this.#row(name, label(i), asJson(x))));
      (Array.isArray(spend.unverified) ? spend.unverified : []).forEach((x, i) => add(this.unverified, this.#row(name, label(i), asJson(x)), { note: str(asJson(x)?.note) ?? "" }));
    } else if (!o.isError && result) {
      // A wallet that does not report `spend`: the receipt of a successful call, or the vouchers of a paid link.
      if (name === "call_paid_service") add(this.receipts, this.#row(name, label(0), asJson(result.payment)));
      const vouchers = asJson(result.breakdown)?.vouchers;
      (Array.isArray(vouchers) ? vouchers : []).forEach((x, i) => add(this.receipts, this.#row(name, label(asJson(x)?.role === "platform fee" ? 1 : i), asJson(x))));
    }
    if (!o.isError) return;
    const x = asJson(body?.refusal);
    const rule = str(x?.rule) ?? /(?:budget|wallet) rule ([A-Z0-9_]+)/.exec(o.text)?.[1];
    if (!rule) return;
    const by = str(x?.enforcedBy);
    const retry = (asJson(x?.retry) as Refusal["retry"]) ?? null;
    // Who would have been paid, and where the owner decides: from the wallet's own refusal, or from what its node
    // confirmed about a refusal a seller relayed. Never from the seller's words.
    const nodeSays = asJson(x?.nodeSays);
    const payee = str(asJson(x?.details)?.payee) ?? (typeof retry?.payee === "string" ? retry.payee : null);
    const nextStep = nextStepOf(rule, retry, { payee, approveAt: str(asJson(asJson(x?.details)?.approval)?.approveAt) ?? str(nodeSays?.approveAt) });
    this.refusals.push({
      tool: name,
      rule,
      ruleText: str(x?.ruleText) ?? "",
      enforcedBy: by === "agent" || by === "node" || by === "seller" ? by : "node",
      target: str(x?.service) ?? str(x?.url) ?? str(input.url) ?? str(input.serviceId) ?? str(input.linkId),
      attemptedAmount: str(x?.attemptedAmount),
      remainingBudget: str(x?.remainingBudget),
      retry,
      nextStep,
    });
    // A payee refusal the wallet decided, or one its node confirmed, ends that payee for this task. A refusal that
    // only asks to try again shortly (the check could not run) does not.
    if (PAYEE_RULES.has(rule) && retry?.kind !== "after" && (by === "agent" || nodeSays)) {
      const stop = { rule, nextStep };
      if (payee) this.#stopped.set(`payee:${payee}`, stop);
      const dir = this.#directory ?? [];
      const url = str(x?.url) ?? str(input.url);
      const id = str(input.serviceId) ?? str(input.linkId);
      const entry = (id ? dir.find((d) => d.id === id || d.name === id) : undefined) ?? (url ? dir.find((d) => endpointKey(d.url) === endpointKey(url)) : undefined);
      if (entry?.payee) this.#stopped.set(`payee:${entry.payee}`, stop);
      const key = entry?.id ?? (url ? endpointKey(url) : null) ?? id;
      if (key) this.#stopped.set(`target:${key}`, stop);
    }
  }

  report(): SpendReport {
    const spent = this.spent();
    return {
      token: this.token,
      budgetId: this.budgetId,
      ceilingAtomic: this.#ceiling?.toString() ?? null,
      ceiling: this.#ceiling === null ? null : this.fmt(this.#ceiling),
      spentAtomic: spent.toString(),
      spent: this.fmt(spent),
      receipts: this.receipts,
      unverified: this.unverified,
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
        ...(msg.attestation ? { attestation: (({ status, summary }) => ({ status, summary }))(summarizeAttestation(msg.attestation)) } : {}),
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
      // True once a paying call of this turn reached the wallet, whatever it answered.
      let attempted = false;
      for (const use of uses) {
        let input = asJson(use.input) ?? {};
        const t0 = Date.now();
        let outcome: ToolOutcome;
        // Arguments the provider could not give as a JSON object never reach a tool; the model gets to try again.
        const badInput = use.inputError
          ? `Tool ${use.name} was not run: its ${use.inputError}. Call it again with the arguments as one JSON object that matches the tool's input schema.`
          : null;
        const blocked = badInput ?? (wallet && PAYING.has(use.name) ? await wallet.gate(use.name, input) : null);
        if (blocked) outcome = { isError: true, text: blocked, structured: undefined };
        else {
          const paying = wallet !== null && PAYING.has(use.name);
          // What is left under the ceiling goes to the wallet as this call's maximum price.
          if (wallet && paying) input = wallet.limit(use.name, input);
          outcome = await o.tools.call(use.name, input);
          if (wallet) {
            wallet.remember(use.name, outcome);
            if (paying) {
              // Whatever the call answered, it may have paid: book what the wallet reports, then read the Budget, so
              // the next call of this same turn is held to what is really left.
              attempted = true;
              wallet.record(use.name, input, outcome);
              await wallet.refresh();
            }
          }
        }
        toolCalls.push({ turn: turns, name: use.name, server: o.tools.serverOf(use.name) ?? null, input, isError: outcome.isError, ms: Date.now() - t0, summary: firstLine(outcome.text) });
        emit({ type: "tool", turn: turns, name: use.name, input, outcome });
        results.push({ type: "tool_result", id: use.id, content: outcome.text || "(empty)", isError: outcome.isError });
      }
      // All results of one turn go back in a single user message.
      messages.push({ role: "user", parts: results });

      if (attempted && wallet?.reached()) {
        status = "spend_ceiling";
        break;
      }
    }
  } finally {
    // The final budget read is best effort: the report still lists every receipt the tools returned.
    if (wallet) await wallet.refresh().catch(() => false);
  }
  // A run whose spend reached the ceiling is over the ceiling, however it ended: a last Budget read can show spend no
  // tool result did (a voucher booked late), and a run that looks finished is still not reported as completed then.
  if (wallet && (status === "spend_ceiling" || (status === "completed" && wallet.spent() > 0n && wallet.reached()))) {
    status = "spend_ceiling";
    note = `stopped: this task spent ${wallet.fmt(wallet.spent())}, which reaches its spend ceiling of ${wallet.fmt(limits.maxSpendAtomic!)}`;
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
  // Enclave attestation, when the provider checks it: counted per status, in the provider's own words, and never rounded up.
  const attested = r.turnUsage.flatMap((t) => (t.attestation ? [t.attestation] : []));
  if (attested.length > 0) {
    const n = (s: AttestationStatus) => attested.filter((a) => a.status === s).length;
    out.push(`attestation: ${attested.length} of ${r.turnUsage.length} model turns ran in an attested enclave: ${n("verified")} verified, ${n("partially_verified")} partially verified, ${n("failed")} failed`);
    const last = attested.at(-1)!;
    out.push(`  last turn: ${last.status === "verified" ? "verified" : last.status === "partially_verified" ? "partially verified" : "failed"}. ${last.summary}`);
  }
  const s = r.spend;
  if (s) {
    out.push("");
    out.push("Spend report");
    out.push(`  spent ${s.spent}${s.ceiling ? ` of a ${s.ceiling} task ceiling` : ""}${s.budgetLeft ? `, Budget left ${s.budgetLeft}` : ""}`);
    if (s.receipts.length === 0 && s.unverified.length === 0) out.push("  no paid calls");
    for (const x of s.receipts) out.push(`  receipt ${x.callId}  ${x.amount.padStart(14)}  ${x.service ?? ""}  -> ${x.payee}`);
    for (const x of s.unverified) out.push(`  unverified ${x.callId}  ${x.amount.padStart(11)}  ${x.service ?? ""}  -> ${x.payee} (voucher sent, outcome unknown: counted as spent)`);
    for (const x of s.refusals) {
      const amount = x.attemptedAmount ? `, attempted ${x.attemptedAmount}` : "";
      const left = x.remainingBudget ? `, Budget left ${x.remainingBudget}` : "";
      const hint = x.retry?.kind === "after" ? `after ${String(x.retry.seconds)} s` : x.retry?.kind === "approval" ? "after the owner approves the payee" : x.retry?.kind;
      const retry = x.retry ? `, retry ${hint}` : "";
      out.push(`  refused ${x.rule} (${x.enforcedBy}${amount}${left}${retry}): ${x.ruleText}${x.target ? ` [${x.target}]` : ""}`);
      if (x.nextStep) out.push(`    next: ${x.nextStep}`);
    }
  }
  return out.join("\n");
}
