/**
 * In-browser stand-in for the merchant AI agent routes (docs/AGENTS.md section 6) in NEXT_PUBLIC_MOCK mode.
 * Acme Store has two AI connections (one with a rejected key), a back-office agent, a paid skill and a paused agent,
 * and runs in every status with their steps and usage. A small worker plays new runs step by step, honours cancel,
 * fails runs on a rejected key, and publishes `agent_run.*` events on the mock event stream, so the live run page and
 * the polling fallback both have something real to follow. Other businesses start empty. Nothing calls a model.
 */
import { ApiError } from "../http";
import { getMerchantScope } from "../merchant-scope";
import type { AgentsApi, CallOptions, CreateAgentBody, CreateConnectionBody, RunsQuery, UpdateAgentBody, UpdateConnectionBody } from "../agents-api";
import type { GatewayPage } from "../gateway-api";
import { AGENT_LIMIT_DEFAULTS, type Agent, type AgentRun, type AgentRunEvent, type AgentRunEventType, type AiConnection, type AiProvider, type AiUsage, type NodeEvent } from "../schemas";
import { currentMonth, isTerminal, SLUG_PATTERN } from "../agents";
import { mockBusinesses } from "./gateway";

const EMPTY = process.env.NEXT_PUBLIC_MOCK === "empty";
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const delay = (ms = 140 + Math.round(Math.random() * 180)) => new Promise((r) => setTimeout(r, ms));
let idSeq = 1;
const rid = (p: string) => `${p}_${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export const MOCK_PROVIDERS: AiProvider[] = [
  { id: "anthropic", name: "Anthropic", needs_base_url: false, default_base_url: "https://api.anthropic.com", suggested_models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5"], note: null },
  { id: "openai", name: "OpenAI", needs_base_url: false, default_base_url: "https://api.openai.com/v1", suggested_models: ["gpt-5.1", "gpt-5.1-mini"], note: null },
  { id: "google", name: "Google Gemini", needs_base_url: false, default_base_url: "https://generativelanguage.googleapis.com", suggested_models: ["gemini-2.5-pro", "gemini-2.5-flash"], note: null },
  {
    id: "openai_compatible",
    name: "OpenAI-compatible",
    needs_base_url: true,
    default_base_url: null,
    suggested_models: ["meta-llama/llama-4-maverick", "deepseek/deepseek-chat", "mistralai/mistral-large", "qwen/qwen3-coder"],
    note: null,
  },
  {
    id: "replicate",
    name: "Replicate (DeepSeek and others)",
    needs_base_url: false,
    default_base_url: "https://api.replicate.com",
    suggested_models: ["deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3"],
    note: "Models on Replicate have no native tool calling. Payminto emulates tools with a JSON reply format in the prompt, which works well with DeepSeek V3.1 but is less reliable than native tools.",
  },
];

/** The fuller list a provider would return from its models route, for the model picker. */
const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5", "claude-sonnet-4-5"],
  openai: ["gpt-5.1", "gpt-5.1-mini", "gpt-5.1-nano", "o4-mini"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  openai_compatible: ["meta-llama/llama-4-maverick", "meta-llama/llama-4-scout", "deepseek/deepseek-chat", "mistralai/mistral-large", "qwen/qwen3-coder"],
  replicate: ["deepseek-ai/deepseek-v3.1", "deepseek-ai/deepseek-v3"],
};

type MockRun = AgentRun & { events: AgentRunEvent[] };
type Store = { connections: AiConnection[]; agents: Agent[]; runs: MockRun[]; baseUsage: Record<string, number> };

// ---------------------------------------------------------------------------
// Live events and long-poll watchers
// ---------------------------------------------------------------------------

type Listener = (e: NodeEvent) => void;
const listeners = new Set<Listener>();
const watchers = new Map<string, Set<() => void>>();
let eventSeq = 0;

export function subscribeAgentEvents(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function publish(run: MockRun, type: AgentRunEventType, step?: AgentRunEvent) {
  const e: NodeEvent = { type, id: `aev_${++eventSeq}`, at: new Date().toISOString(), data: { run_id: run.id, agent_id: run.agent_id, status: run.status, ...(step ? { event: step } : {}) } };
  for (const l of listeners) l(e);
  for (const w of watchers.get(run.id) ?? []) w();
}

function step(run: MockRun, type: string, data: Record<string, unknown>, at = Date.now()) {
  const e: AgentRunEvent = { seq: (run.events.at(-1)?.seq ?? 0) + 1, run_id: run.id, type, data, at: iso(at) };
  run.events.push(e);
  return e;
}

// ---------------------------------------------------------------------------
// Seed: Acme Store
// ---------------------------------------------------------------------------

const ANSWERS = {
  week: [
    "This week you earned 2,948.75 USDC from 131 payments, 412.50 USDC of it today.",
    "",
    "Two refund requests are waiting for an Admin:",
    "- 25.00 USDC on the Pro plan payment from yesterday",
    "- 12.50 USDC on a Starter kit payment from 3 hours ago",
    "",
    "You can approve or decline them on the Refunds page.",
  ].join("\n"),
  link: "Done. I created the payment link \"Starter kit\" for 49.00 USDC. It is active and listed for AI agents; share it from Payment links.",
  copy: [
    "Meet the Trail Flask 750: double-walled steel that keeps coffee hot for 12 hours and water cold for a full day.",
    "The leak-proof lid clicks shut with one hand, and the powder-coated finish shrugs off scratches on the trail.",
  ].join(" "),
  blocked: "Three payers are blocked right now: two wallets you added yourself and one frozen by the USDC issuer. None tried to pay in the last 24 hours.",
  generic: "Here is what I found: 18 payments today for 412.50 USDC, no failed payments, and no blocked attempts in the last hour.",
};

function turn(run: MockRun, at: number, n: number, input: number, output: number, stop: string, model: string, text?: string) {
  step(run, "model_turn", { turn: n, input_tokens: input, output_tokens: output, stop, model, ...(text ? { text } : {}) }, at);
}
function tool(run: MockRun, at: number, id: string, name: string, input: Record<string, unknown>, summary: string | null, isError = false) {
  step(run, "tool_call", { id, name, input }, at);
  if (summary !== null) step(run, "tool_result", { id, name, summary, is_error: isError }, at + 900);
}

function baseRun(p: { id: string; agent: Agent; input: string; trigger?: string; createdAt: number; status: AgentRun["status"] }): MockRun {
  return {
    id: p.id,
    agent_id: p.agent.id,
    merchant_id: p.agent.merchant_id,
    trigger: p.trigger ?? "dashboard",
    input: p.input,
    status: p.status,
    attempt: 1,
    max_attempts: 3,
    next_attempt_at: null,
    cancel_requested: false,
    result: null,
    error_code: null,
    error_message: null,
    usage: null,
    created_at: iso(p.createdAt),
    started_at: null,
    finished_at: null,
    events: [],
  };
}

function finish(run: MockRun, at: number, status: AgentRun["status"], extra: Partial<AgentRun> = {}) {
  Object.assign(run, { status, finished_at: iso(at), ...extra });
  step(run, "finished", { status, ...(extra.error_code ? { error_code: extra.error_code } : {}) }, at);
}

function usageOf(run: MockRun, provider: string): AgentRun["usage"] {
  let input = 0;
  let output = 0;
  let model: string | null = null;
  for (const e of run.events) {
    if (e.type !== "model_turn") continue;
    input += Number(e.data.input_tokens ?? 0);
    output += Number(e.data.output_tokens ?? 0);
    model = typeof e.data.model === "string" ? e.data.model : model;
  }
  return input || output ? { input_tokens: input, output_tokens: output, model, provider } : null;
}

function seedAcme(merchantId: string, now: number): Store {
  const anthropic: AiConnection = {
    id: "aic_team_anthropic",
    merchant_id: merchantId,
    provider: "anthropic",
    label: "Team Anthropic",
    base_url: null,
    default_model: "claude-sonnet-5-5",
    key_hint: "4f2a",
    status: "active",
    verified_at: iso(now - 2 * HOUR),
    last_error: null,
    monthly_token_limit: 2_000_000,
    created_at: iso(now - 21 * DAY),
    created_by: "Ana Lopez",
    rotated_at: iso(now - 6 * DAY),
  };
  const openrouter: AiConnection = {
    id: "aic_openrouter",
    merchant_id: merchantId,
    provider: "openai_compatible",
    label: "OpenRouter",
    base_url: "https://openrouter.ai/api/v1",
    default_model: "meta-llama/llama-4-maverick",
    key_hint: "9c1e",
    status: "invalid",
    verified_at: iso(now - 1 * DAY),
    last_error: "The provider answered 401 Unauthorized: this key was revoked or never existed.",
    monthly_token_limit: null,
    created_at: iso(now - 9 * DAY),
    created_by: "Ana Lopez",
    rotated_at: null,
  };
  const assistant: Agent = {
    id: "agt_store_assistant",
    merchant_id: merchantId,
    kind: "ops",
    name: "Store assistant",
    description: "Answers questions about payments, links, refunds and blocked payers.",
    connection_id: anthropic.id,
    model: "claude-sonnet-5-5",
    instructions: "Answer in short sentences. Amounts always in USDC with two decimals. Never approve refunds; only request them.",
    tools: ["get_overview", "list_payments", "get_payment", "create_link", "request_refund", "get_reconciliation", "list_blocked"],
    limits: { ...AGENT_LIMIT_DEFAULTS },
    status: "active",
    slug: null,
    price: null,
    input_hint: null,
    created_at: iso(now - 20 * DAY),
    updated_at: iso(now - 4 * DAY),
  };
  const copy: Agent = {
    id: "agt_product_copy",
    merchant_id: merchantId,
    kind: "skill",
    name: "Product copy writer",
    description: "Writes a two-sentence product description for a shop page from a name and a few facts.",
    connection_id: anthropic.id,
    model: "claude-haiku-5",
    instructions: "Two sentences, warm and concrete, no superlatives, no emoji.",
    tools: [],
    limits: { max_turns: 2, max_output_tokens: 1_200, timeout_seconds: 60 },
    status: "active",
    slug: "product-copy",
    price: "250000",
    input_hint: "Trail Flask 750: steel, keeps drinks hot 12 h, one-hand lid",
    created_at: iso(now - 14 * DAY),
    updated_at: iso(now - 14 * DAY),
  };
  const triage: Agent = {
    id: "agt_refund_triage",
    merchant_id: merchantId,
    kind: "ops",
    name: "Refund triage",
    description: "Reads new refund requests and suggests which to approve.",
    connection_id: openrouter.id,
    model: "meta-llama/llama-4-maverick",
    instructions: null,
    tools: ["list_payments", "get_payment", "request_refund"],
    limits: { max_turns: 8, max_output_tokens: 8_000, timeout_seconds: 120 },
    status: "paused",
    slug: null,
    price: null,
    input_hint: null,
    created_at: iso(now - 9 * DAY),
    updated_at: iso(now - 1 * DAY),
  };

  const runs: MockRun[] = [];
  const sonnet = "claude-sonnet-5-5";

  // Done: earnings and waiting refunds, two tool calls.
  {
    const t = now - 2 * HOUR;
    const r = baseRun({ id: "run_week_summary", agent: assistant, input: "How much did we earn this week, and are any refunds waiting?", createdAt: t, status: "succeeded" });
    r.started_at = iso(t + 800);
    step(r, "started", { attempt: 1 }, t + 800);
    turn(r, t + 2_600, 1, 1_840, 96, "tool_use", sonnet);
    tool(r, t + 2_700, "tc_1", "get_overview", { range: "7d" }, "This week 2,948.75 USDC from 131 payments; today 412.50 USDC from 18 payments.");
    tool(r, t + 3_900, "tc_2", "list_payments", { refund_requested: true, limit: 20 }, "2 refund requests waiting: 25.00 USDC (pay_8f2c), 12.50 USDC (pay_1c9a).");
    turn(r, t + 7_400, 2, 2_410, 182, "end", sonnet, ANSWERS.week);
    finish(r, t + 7_500, "succeeded", { result: { answer: ANSWERS.week } });
    r.usage = usageOf(r, "anthropic");
    runs.push(r);
  }
  // Working: creating a link; the worker finishes it shortly after the page loads.
  {
    const t = now - 40 * SEC;
    const r = baseRun({ id: "run_starter_link", agent: assistant, input: "Make a payment link for the 49 USDC starter kit", createdAt: t, status: "running" });
    r.started_at = iso(t + 600);
    step(r, "started", { attempt: 1 }, t + 600);
    turn(r, t + 2_200, 1, 1_712, 64, "tool_use", sonnet);
    tool(r, t + 2_300, "tc_1", "create_link", { title: "Starter kit", amount: "49.00", listed: true }, null);
    runs.push(r);
  }
  // Waiting: the provider was busy; a retry is scheduled.
  {
    const t = now - 25 * SEC;
    const r = baseRun({ id: "run_repeat_customers", agent: assistant, input: "Which customers paid more than once this month?", createdAt: t, status: "queued" });
    r.started_at = iso(t + 500);
    r.next_attempt_at = iso(now + 30 * SEC);
    r.error_code = "MODEL_RATE_LIMITED";
    r.error_message = "Anthropic answered 429: rate limit reached for this organization.";
    step(r, "started", { attempt: 1 }, t + 500);
    step(r, "retry_scheduled", { attempt: 1, next_attempt_at: r.next_attempt_at, error_code: "MODEL_RATE_LIMITED", error_message: r.error_message, retry_after_ms: 30_000 }, t + 1_900);
    runs.push(r);
  }
  // Failed: the OpenRouter key was rejected.
  {
    const t = now - 1 * DAY;
    const r = baseRun({ id: "run_refund_triage", agent: triage, input: "Check the refund requests from yesterday and suggest which to approve.", createdAt: t, status: "failed" });
    r.started_at = iso(t + 700);
    step(r, "started", { attempt: 1 }, t + 700);
    finish(r, t + 1_600, "failed", { error_code: "MODEL_AUTH_FAILED", error_message: "The provider answered 401 Unauthorized." });
    r.usage = { input_tokens: 0, output_tokens: 0, model: triage.model, provider: "openai_compatible" };
    runs.push(r);
  }
  // Timed out: a reconciliation that ran past its time limit.
  {
    const t = now - 3 * DAY;
    const r = baseRun({ id: "run_reconcile_all", agent: assistant, input: "Reconcile every payment since January against the settlements and list anything that does not match.", createdAt: t, status: "timed_out" });
    r.started_at = iso(t + 900);
    step(r, "started", { attempt: 1 }, t + 900);
    turn(r, t + 3_100, 1, 1_902, 120, "tool_use", sonnet);
    tool(r, t + 3_200, "tc_1", "get_reconciliation", { from: "2026-01-01", to: "2026-10-29" }, "4,812 rows; the report is long, so it was split into pages.");
    turn(r, t + 62_000, 2, 48_310, 1_904, "tool_use", sonnet);
    tool(r, t + 62_100, "tc_2", "get_reconciliation", { from: "2026-04-01", to: "2026-06-30", page: 2 }, null);
    finish(r, t + 180_900, "timed_out", { error_code: "TIMEOUT", error_message: "The run passed its 180 second limit." });
    r.usage = usageOf(r, "anthropic");
    runs.push(r);
  }
  // Cancelled by a person.
  {
    const t = now - 2 * DAY;
    const r = baseRun({ id: "run_blocked_list", agent: assistant, input: "List every blocked payer and when each was blocked", createdAt: t, status: "cancelled" });
    r.started_at = iso(t + 600);
    step(r, "started", { attempt: 1 }, t + 600);
    turn(r, t + 2_000, 1, 1_650, 58, "tool_use", sonnet);
    r.cancel_requested = true;
    finish(r, t + 2_400, "cancelled");
    r.usage = usageOf(r, "anthropic");
    runs.push(r);
  }
  // Paid skill calls.
  const facts = ["Trail Flask 750: steel, keeps drinks hot 12 h, one-hand lid", "Linen apron: stonewashed, two pockets, adjustable strap", "Pour-over kit: glass dripper, 40 filters, 600 ml server"];
  facts.forEach((input, i) => {
    const t = now - (i * 5 + 1) * HOUR - i * 17 * MIN;
    const r = baseRun({ id: `run_copy_${i + 1}`, agent: copy, input, trigger: "skill_call", createdAt: t, status: "succeeded" });
    r.started_at = iso(t + 400);
    step(r, "started", { attempt: 1 }, t + 400);
    const answer = i === 0 ? ANSWERS.copy : `A ${input.split(":")[0]!.toLowerCase()} made to be used every day, with the details that matter: ${input.split(":")[1]!.trim()}.`;
    turn(r, t + 2_900, 1, 412 + i * 31, 88 + i * 9, "end", copy.model, answer);
    finish(r, t + 3_000, "succeeded", { result: { answer } });
    r.usage = usageOf(r, "anthropic");
    runs.push(r);
  });
  {
    const t = now - 26 * HOUR;
    const r = baseRun({ id: "run_copy_busy", agent: copy, input: "Wool socks: merino, cushioned sole", trigger: "skill_call", createdAt: t, status: "failed" });
    r.attempt = 3;
    r.started_at = iso(t + 400);
    step(r, "started", { attempt: 1 }, t + 400);
    step(r, "retry_scheduled", { attempt: 1, next_attempt_at: iso(t + 2_400), error_code: "MODEL_OVERLOADED", error_message: "Anthropic answered 529: overloaded." }, t + 900);
    step(r, "started", { attempt: 2 }, t + 2_500);
    step(r, "retry_scheduled", { attempt: 2, next_attempt_at: iso(t + 10_500), error_code: "MODEL_OVERLOADED", error_message: "Anthropic answered 529: overloaded." }, t + 3_000);
    step(r, "started", { attempt: 3 }, t + 10_600);
    finish(r, t + 11_200, "failed", { error_code: "MODEL_OVERLOADED", error_message: "Anthropic answered 529: overloaded." });
    runs.push(r);
  }

  runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return {
    connections: [anthropic, openrouter],
    agents: [assistant, copy, triage],
    runs,
    // Tokens from earlier this month that the seeded runs do not account for.
    baseUsage: { [anthropic.id]: 1_243_480, [openrouter.id]: 18_204, [assistant.id]: 1_126_910, [copy.id]: 116_570, [triage.id]: 18_204 },
  };
}

const stores = new Map<string, Store>();

function acmeId(): string {
  return mockBusinesses()[0]!.id;
}

function store(): Store {
  const merchantId = getMerchantScope();
  if (!merchantId) throw new ApiError(400, "MERCHANT_REQUIRED", "Open a business first: AI agents belong to one business.");
  let s = stores.get(merchantId);
  if (!s) {
    s = !EMPTY && merchantId === acmeId() ? seedAcme(merchantId, Date.now()) : { connections: [], agents: [], runs: [], baseUsage: {} };
    stores.set(merchantId, s);
    resumeSeeded(s);
  }
  return s;
}

// ---------------------------------------------------------------------------
// The worker: plays a run step by step
// ---------------------------------------------------------------------------

type Script = { tools: { name: string; input: Record<string, unknown>; summary: string }[]; answer: string };

function scriptFor(agent: Agent, input: string): Script {
  if (agent.kind === "skill") return { tools: [], answer: input.toLowerCase().includes("flask") ? ANSWERS.copy : `Here is a short description: ${input.trim().replace(/\.$/, "")}. Made to be used every day and built to last.` };
  const q = input.toLowerCase();
  if (/link/.test(q)) return { tools: [{ name: "create_link", input: { title: "Starter kit", amount: "49.00", listed: true }, summary: "Created plink_starter (49.00 USDC, active, listed for AI agents)." }], answer: ANSWERS.link };
  if (/block/.test(q)) return { tools: [{ name: "list_blocked", input: { limit: 50 }, summary: "3 blocked payers: 2 on your list, 1 frozen by the USDC issuer." }], answer: ANSWERS.blocked };
  if (/refund|earn|week|month/.test(q))
    return {
      tools: [
        { name: "get_overview", input: { range: "7d" }, summary: "This week 2,948.75 USDC from 131 payments; today 412.50 USDC from 18 payments." },
        { name: "list_payments", input: { refund_requested: true, limit: 20 }, summary: "2 refund requests waiting: 25.00 USDC (pay_8f2c), 12.50 USDC (pay_1c9a)." },
      ],
      answer: ANSWERS.week,
    };
  return { tools: [{ name: "get_overview", input: { range: "1d" }, summary: "Today 412.50 USDC from 18 payments; nothing failed." }], answer: ANSWERS.generic };
}

function connectionOf(s: Store, agent: Agent): AiConnection | undefined {
  return s.connections.find((c) => c.id === agent.connection_id);
}

/** Checked before every step: true when the run already ended, or ends here because someone cancelled it. */
function halted(run: MockRun): boolean {
  if (isTerminal(run.status)) return true;
  if (!run.cancel_requested) return false;
  finish(run, Date.now(), "cancelled");
  publish(run, "agent_run.cancelled", run.events.at(-1));
  return true;
}

async function play(s: Store, run: MockRun, from: { turn: number; toolIndex: number } = { turn: 1, toolIndex: 0 }) {
  const agent = s.agents.find((a) => a.id === run.agent_id)!;
  const conn = connectionOf(s, agent);
  const provider = conn?.provider ?? "anthropic";
  const wait = (ms: number) => delay(ms + Math.round(Math.random() * 400));
  if (halted(run)) return;
  if (run.status === "queued") {
    await wait(700);
    if (halted(run)) return;
    run.status = "running";
    run.started_at ??= new Date().toISOString();
    run.next_attempt_at = null;
    publish(run, "agent_run.started", step(run, "started", { attempt: run.attempt }));
  }
  if (!conn || conn.status !== "active") {
    await wait(900);
    if (halted(run)) return;
    const auth = conn?.status === "invalid";
    finish(run, Date.now(), "failed", { error_code: auth ? "MODEL_AUTH_FAILED" : "MODEL_UNAVAILABLE", error_message: auth ? "The provider answered 401 Unauthorized." : "This AI connection is turned off." });
    run.usage = { input_tokens: 0, output_tokens: 0, model: agent.model, provider };
    publish(run, "agent_run.failed", run.events.at(-1));
    return;
  }
  const script = scriptFor(agent, run.input ?? "");
  let n = from.turn;
  for (let i = from.toolIndex; i < script.tools.length; i++) {
    const t = script.tools[i]!;
    const open = run.events.findLast((e) => e.type === "tool_call" && e.data.name === t.name && !run.events.some((r) => r.type === "tool_result" && r.data.id === e.data.id));
    if (!open) {
      await wait(1_300);
      if (halted(run)) return;
      publish(run, "agent_run.step", step(run, "model_turn", { turn: n++, input_tokens: 1_700 + i * 520, output_tokens: 60 + i * 14, stop: "tool_use", model: agent.model }));
      await wait(500);
      if (halted(run)) return;
      publish(run, "agent_run.step", step(run, "tool_call", { id: `tc_${i + 1}`, name: t.name, input: t.input }));
    }
    await wait(1_100);
    if (halted(run)) return;
    const callId = open?.data.id ?? `tc_${i + 1}`;
    publish(run, "agent_run.step", step(run, "tool_result", { id: callId, name: t.name, summary: t.summary, is_error: false }));
  }
  await wait(1_800);
  if (halted(run)) return;
  publish(run, "agent_run.step", step(run, "model_turn", { turn: n, input_tokens: 2_300, output_tokens: Math.round(script.answer.length / 4), stop: "end", model: agent.model, text: script.answer }));
  finish(run, Date.now(), "succeeded", { result: { answer: script.answer }, error_code: null, error_message: null });
  run.usage = usageOf(run, provider);
  publish(run, "agent_run.succeeded", run.events.at(-1));
}

/** The seeded running and waiting runs carry on, so the live page has something to follow right after loading. */
function resumeSeeded(s: Store) {
  if (typeof window === "undefined") return;
  for (const run of s.runs) {
    if (run.status === "running") setTimeout(() => void play(s, run, { turn: 2, toolIndex: 0 }), 6_000);
    if (run.status === "queued" && run.next_attempt_at) {
      const at = new Date(run.next_attempt_at).getTime() - Date.now();
      setTimeout(() => {
        if (isTerminal(run.status)) return;
        run.attempt += 1;
        run.error_code = null;
        run.error_message = null;
        void play(s, run);
      }, Math.max(0, at));
    }
  }
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

function strip(run: MockRun): AgentRun {
  const { events: _e, ...rest } = run;
  void _e;
  return { ...rest };
}

function withLastRun(s: Store, a: Agent): Agent {
  const last = s.runs.find((r) => r.agent_id === a.id);
  return { ...a, last_run: last ? { id: last.id, status: last.status, created_at: last.created_at } : null };
}

function findConnection(s: Store, id: string): AiConnection {
  const c = s.connections.find((x) => x.id === id);
  if (!c) throw new ApiError(404, "CONNECTION_NOT_FOUND", `No AI connection ${id}.`);
  return c;
}
function findAgent(s: Store, id: string): Agent {
  const a = s.agents.find((x) => x.id === id);
  if (!a) throw new ApiError(404, "AGENT_NOT_FOUND", `No agent ${id}.`);
  return a;
}
function findRun(s: Store, id: string): MockRun {
  const r = s.runs.find((x) => x.id === id);
  if (!r) throw new ApiError(404, "RUN_NOT_FOUND", `No run ${id}.`);
  return r;
}

/** A pretend verification: keys with "bad" in them, or too short, are rejected like a provider's 401. */
function verify(provider: string, key: string): { ok: true } | { ok: false; error: string } {
  if (key.length < 12 || /bad|invalid|wrong/i.test(key)) return { ok: false, error: `${MOCK_PROVIDERS.find((p) => p.id === provider)?.name ?? provider} answered 401 Unauthorized: the key was not accepted.` };
  return { ok: true };
}

function checkBaseUrl(url: string | null | undefined, required: boolean) {
  if (!url) {
    if (required) throw new ApiError(400, "BASE_URL_REQUIRED", "This provider needs a base URL, for example https://openrouter.ai/api/v1.");
    return;
  }
  if (!/^https:\/\/[^/\s]+/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) throw new ApiError(400, "BASE_URL_INVALID", "Use an https:// address.");
}

export class MockAgentsApi implements AgentsApi {
  async providers() {
    await delay(90);
    return MOCK_PROVIDERS.map((p) => ({ ...p, suggested_models: [...p.suggested_models] }));
  }
  async connections() {
    await delay();
    return store().connections.map((c) => ({ ...c }));
  }
  async createConnection(body: CreateConnectionBody) {
    await delay(700);
    const s = store();
    const p = MOCK_PROVIDERS.find((x) => x.id === body.provider);
    if (!p) throw new ApiError(400, "PROVIDER_UNSUPPORTED", `Payminto does not support ${body.provider} yet.`);
    if (!body.label.trim()) throw new ApiError(400, "LABEL_REQUIRED", "Give the connection a name.");
    if (!body.api_key.trim()) throw new ApiError(400, "API_KEY_REQUIRED", "Paste the API key from your provider.");
    checkBaseUrl(body.base_url, p.needs_base_url);
    const v = verify(p.id, body.api_key.trim());
    const now = Date.now();
    const c: AiConnection = {
      id: rid("aic"),
      merchant_id: getMerchantScope() ?? undefined,
      provider: p.id,
      label: body.label.trim(),
      base_url: body.base_url || null,
      default_model: body.default_model,
      key_hint: body.api_key.trim().slice(-4),
      status: v.ok ? "active" : "invalid",
      verified_at: iso(now),
      last_error: v.ok ? null : v.error,
      monthly_token_limit: body.monthly_token_limit ?? null,
      created_at: iso(now),
      created_by: "You",
      rotated_at: null,
    };
    s.connections.push(c);
    return { ...c };
  }
  async updateConnection(id: string, patch: UpdateConnectionBody) {
    await delay(patch.api_key ? 700 : 250);
    const s = store();
    const c = findConnection(s, id);
    const p = MOCK_PROVIDERS.find((x) => x.id === c.provider);
    if (patch.base_url !== undefined) checkBaseUrl(patch.base_url, Boolean(p?.needs_base_url));
    if (patch.label !== undefined) c.label = patch.label.trim() || c.label;
    if (patch.base_url !== undefined) c.base_url = patch.base_url || null;
    if (patch.default_model !== undefined) c.default_model = patch.default_model;
    if (patch.monthly_token_limit !== undefined) c.monthly_token_limit = patch.monthly_token_limit;
    if (patch.api_key !== undefined) {
      const v = verify(c.provider, patch.api_key.trim());
      c.key_hint = patch.api_key.trim().slice(-4);
      c.rotated_at = iso(Date.now());
      c.verified_at = iso(Date.now());
      c.status = v.ok ? "active" : "invalid";
      c.last_error = v.ok ? null : v.error;
    }
    if (patch.status === "disabled") c.status = "disabled";
    if (patch.status === "active" && c.status === "disabled") c.status = c.last_error ? "invalid" : "active";
    return { ...c };
  }
  async deleteConnection(id: string) {
    await delay(300);
    const s = store();
    const c = findConnection(s, id);
    const users = s.agents.filter((a) => a.connection_id === c.id && a.status === "active");
    if (users.length) throw new ApiError(409, "CONNECTION_IN_USE", `${users.length} active agent${users.length === 1 ? "" : "s"} use this connection.`, { agents: users.map((a) => ({ id: a.id, name: a.name })) });
    s.connections = s.connections.filter((x) => x.id !== id);
    for (const a of s.agents) if (a.connection_id === id) a.connection_id = null;
  }
  async verifyConnection(id: string) {
    await delay(800);
    const c = findConnection(store(), id);
    c.verified_at = iso(Date.now());
    // The mock keeps its verdict: a rejected key stays rejected until it is rotated.
    return { ...c };
  }
  async models(connectionId: string) {
    await delay(350);
    const c = findConnection(store(), connectionId);
    if (c.status === "invalid") throw new ApiError(502, "MODEL_AUTH_FAILED", "The provider rejected this key, so its model list could not be read.");
    return [...(PROVIDER_MODELS[c.provider] ?? [])];
  }
  async usage(month?: string): Promise<AiUsage> {
    await delay();
    const s = store();
    const m = month ?? currentMonth();
    const inMonth = s.runs.filter((r) => r.created_at.slice(0, 7) === m && r.usage);
    const tally = (pick: (r: MockRun) => string | null | undefined, ids: string[]) =>
      ids.map((id) => {
        const rs = inMonth.filter((r) => pick(r) === id);
        const base = m === currentMonth() ? s.baseUsage[id] ?? 0 : 0;
        return {
          id,
          input_tokens: rs.reduce((n, r) => n + (r.usage?.input_tokens ?? 0), 0) + Math.round(base * 0.86),
          output_tokens: rs.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0) + Math.round(base * 0.14),
          runs: rs.length,
        };
      });
    const agentConn = (r: MockRun) => s.agents.find((a) => a.id === r.agent_id)?.connection_id;
    return {
      month: m,
      connections: tally(agentConn, s.connections.map((c) => c.id)).map(({ id, ...u }) => ({ connection_id: id, ...u })),
      agents: tally((r) => r.agent_id, s.agents.map((a) => a.id)).map(({ id, ...u }) => ({ agent_id: id, ...u })),
    };
  }
  async agents() {
    await delay();
    const s = store();
    return s.agents.map((a) => withLastRun(s, a));
  }
  async agent(id: string) {
    await delay();
    const s = store();
    return withLastRun(s, findAgent(s, id));
  }
  async createAgent(body: CreateAgentBody) {
    await delay(500);
    const s = store();
    if (!body.name.trim()) throw new ApiError(400, "NAME_REQUIRED", "Give the agent a name.");
    findConnection(s, body.connection_id);
    if (body.kind === "buyer") throw new ApiError(400, "KIND_UNSUPPORTED", "Buyer agents come later; run them with payminto-agent for now.");
    if (body.kind === "skill") {
      if (!body.slug || !SLUG_PATTERN.test(body.slug)) throw new ApiError(400, "SLUG_INVALID", "Use lowercase letters, numbers and dashes.");
      if (s.agents.some((a) => a.slug === body.slug)) throw new ApiError(409, "SLUG_TAKEN", "Another skill already uses this address.");
      if (!body.price || BigInt(body.price) <= 0n) throw new ApiError(400, "PRICE_REQUIRED", "Set a price above zero.");
    }
    const now = Date.now();
    const a: Agent = {
      id: rid("agt"),
      merchant_id: getMerchantScope() ?? undefined,
      kind: body.kind,
      name: body.name.trim(),
      description: body.description ?? null,
      connection_id: body.connection_id,
      model: body.model,
      instructions: body.instructions ?? null,
      tools: body.tools ?? [],
      limits: { ...AGENT_LIMIT_DEFAULTS, ...body.limits },
      status: "active",
      slug: body.kind === "skill" ? body.slug! : null,
      price: body.kind === "skill" ? body.price! : null,
      input_hint: body.input_hint ?? null,
      created_at: iso(now),
      updated_at: iso(now),
    };
    s.agents.unshift(a);
    return withLastRun(s, a);
  }
  async updateAgent(id: string, patch: UpdateAgentBody) {
    await delay(300);
    const s = store();
    const a = findAgent(s, id);
    if (patch.connection_id) findConnection(s, patch.connection_id);
    if (patch.slug !== undefined && patch.slug !== a.slug) {
      if (!SLUG_PATTERN.test(patch.slug)) throw new ApiError(400, "SLUG_INVALID", "Use lowercase letters, numbers and dashes.");
      if (s.agents.some((x) => x.slug === patch.slug && x.id !== id)) throw new ApiError(409, "SLUG_TAKEN", "Another skill already uses this address.");
    }
    const { limits, ...rest } = patch;
    Object.assign(a, rest, limits ? { limits: { ...a.limits, ...limits } } : {}, { updated_at: iso(Date.now()) });
    return withLastRun(s, a);
  }
  async deleteAgent(id: string) {
    await delay(300);
    const s = store();
    findAgent(s, id);
    s.agents = s.agents.filter((a) => a.id !== id);
  }
  async startRun(agentId: string, input: string) {
    await delay(260);
    const s = store();
    const a = findAgent(s, agentId);
    if (a.status === "paused") throw new ApiError(409, "AGENT_PAUSED", "This agent is paused. Resume it to run it.");
    if (!input.trim()) throw new ApiError(400, "INPUT_REQUIRED", "Type a question or task.");
    const run = baseRun({ id: rid("run"), agent: a, input: input.trim(), createdAt: Date.now(), status: "queued" });
    run.attempt = 1;
    s.runs.unshift(run);
    publish(run, "agent_run.queued");
    void play(s, run);
    return strip(run);
  }
  async runs(q: RunsQuery = {}): Promise<GatewayPage<AgentRun>> {
    await delay();
    const s = store();
    const all = s.runs.filter((r) => (!q.agent_id || r.agent_id === q.agent_id) && (!q.status || r.status === q.status));
    const start = q.cursor ? Number(q.cursor) : 0;
    const limit = q.limit ?? 25;
    const items = all.slice(start, start + limit).map(strip);
    return { items, nextCursor: start + limit < all.length ? String(start + limit) : null, counts: null };
  }
  async run(id: string, wait = 0, o: CallOptions = {}) {
    const s = store();
    const run = findRun(s, id);
    if (wait > 0 && !isTerminal(run.status)) {
      const status = run.status;
      await new Promise<void>((resolve) => {
        const set = watchers.get(id) ?? new Set();
        watchers.set(id, set);
        const done = () => {
          clearTimeout(t);
          set.delete(check);
          o.signal?.removeEventListener("abort", done);
          resolve();
        };
        const check = () => run.status !== status && done();
        const t = setTimeout(done, Math.min(wait, 30) * SEC);
        set.add(check);
        o.signal?.addEventListener("abort", done);
      });
    } else await delay(120);
    return strip(run);
  }
  async runEvents(id: string, after?: number) {
    await delay(90);
    const run = findRun(store(), id);
    return run.events.filter((e) => after === undefined || e.seq > after).map((e) => ({ ...e }));
  }
  async cancelRun(id: string) {
    await delay(200);
    const run = findRun(store(), id);
    if (isTerminal(run.status)) throw new ApiError(409, "RUN_FINISHED", "This run already finished.");
    run.cancel_requested = true;
    publish(run, "agent_run.updated");
    // A played run stops at its next step; a waiting run has no step coming soon, so it stops here.
    setTimeout(() => halted(run), 1_500);
    return strip(run);
  }
}
