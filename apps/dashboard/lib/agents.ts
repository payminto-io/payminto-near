/**
 * Plain words and pure logic for the merchant AI agent screens (docs/AGENTS.md section 7): names for kinds, providers
 * and statuses, run errors in plain words with what to do, the run timeline built from steps, when to stop polling,
 * and who may do what. Kept free of React so every rule here is unit tested.
 */
import { can, type Grants, type Scope } from "./permissions";
import { formatInt } from "./format";
import type { Agent, AgentKind, AgentRun, AgentRunEvent, AgentRunStatus, AiConnection, AiConnectionStatus, AiProvider, AgentStatus } from "./schemas";

type Tone = "positive" | "warning" | "negative" | "info" | "neutral";

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export const KIND_LABEL: Record<AgentKind, string> = { ops: "Back office", skill: "Paid skill", buyer: "Buyer" };

export const KIND_HINT: Record<AgentKind, string> = {
  ops: "Answers questions about your business: earnings, payments, links, refund requests and blocked payers. Only your team can use it.",
  skill: "An AI service you sell per call. People and their agents pay the price, then get the answer.",
  buyer: "Spends from a budget to pay for services. Coming later.",
};

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  openai_compatible: "OpenAI-compatible",
  replicate: "Replicate",
  nearai: "NEAR AI Cloud",
};

/** The provider's name for people: the server's own name when it sends one, else ours, else the id. */
export function providerName(id: string | null | undefined, providers?: AiProvider[] | null): string {
  if (!id) return "your AI provider";
  return providers?.find((p) => p.id === id)?.name ?? PROVIDER_LABEL[id] ?? id;
}

/** A short name for default connection labels ("Team Replicate"): ours where we have one, else the provider's name. */
export function shortProviderName(id: string, providers?: AiProvider[] | null): string {
  return PROVIDER_LABEL[id] ?? providerName(id, providers);
}

/**
 * Who answered a run, for sentences like "Your OpenAI key was rejected": the provider's name, except for an
 * OpenAI-compatible endpoint, where the connection's own name ("OpenRouter") is what people recognise.
 */
export function whoAnswers(provider: string | null | undefined, providers?: AiProvider[] | null, connectionLabel?: string | null): string {
  if (provider === "openai_compatible" && connectionLabel) return connectionLabel;
  return providerName(provider, providers);
}

export const CONNECTION_STATUS: Record<AiConnectionStatus, { tone: Tone; label: string; text: string }> = {
  active: { tone: "positive", label: "Active", text: "The provider accepted this key at the last check." },
  invalid: { tone: "negative", label: "Key rejected", text: "The provider rejected this key. Agents on it cannot run until you rotate the key." },
  disabled: { tone: "neutral", label: "Turned off", text: "Turned off by an Admin. Agents on it cannot run." },
};

export const AGENT_STATUS: Record<AgentStatus, { tone: Tone; label: string }> = {
  active: { tone: "positive", label: "Active" },
  paused: { tone: "neutral", label: "Paused" },
};

export const RUN_STATUS: Record<AgentRunStatus, { tone: Tone; label: string }> = {
  queued: { tone: "info", label: "Waiting" },
  running: { tone: "info", label: "Working" },
  succeeded: { tone: "positive", label: "Done" },
  failed: { tone: "negative", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  timed_out: { tone: "warning", label: "Timed out" },
};

export const TRIGGER_LABEL: Record<string, string> = { dashboard: "Dashboard", api: "API", skill_call: "Paid call" };

/** The merchant tools an ops agent may use (apps/mcp merchant server), with what each does in plain words. */
export const OPS_TOOLS: { name: string; label: string; done: string }[] = [
  { name: "get_overview", label: "Read the overview", done: "Read the overview" },
  { name: "list_payments", label: "Look up payments", done: "Looked up payments" },
  { name: "get_payment", label: "Open a payment", done: "Opened a payment" },
  { name: "create_link", label: "Create payment links", done: "Created a payment link" },
  { name: "request_refund", label: "Request refunds (an Admin approves)", done: "Requested a refund" },
  { name: "get_reconciliation", label: "Read the reconciliation report", done: "Read the reconciliation report" },
  { name: "list_blocked", label: "List blocked payers", done: "Listed blocked payers" },
];

export function toolLabel(name: string): string {
  return OPS_TOOLS.find((t) => t.name === name)?.done ?? name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** "12,480 tokens", "1 token". */
export function formatTokens(n: number): string {
  return `${formatInt(Math.round(n))} ${n === 1 ? "token" : "tokens"}`;
}

/** "1.2M", "48k", "950", for tight table cells. */
export function compactTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

/** This month as YYYY-MM in UTC, the server's billing month. */
export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Share of the monthly limit used, 0 to 100; null when there is no limit. */
export function limitShare(used: number, limit: number | null | undefined): number | null {
  if (!limit || limit <= 0) return null;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

// ---------------------------------------------------------------------------
// Errors in plain words
// ---------------------------------------------------------------------------

export type PlainError = { title: string; action: string; href?: string; hrefLabel?: string };

const SETTINGS_AI = "/settings/ai";

/**
 * A failed or timed-out run in plain words, with what to do next (PRODUCT.md: one sentence per code). `provider` is
 * the provider id from the run's usage or its connection; `limits` names the time limit on a timeout.
 */
export function runErrorText(run: Pick<AgentRun, "status" | "error_code" | "error_message" | "attempt">, ctx: { provider?: string | null; providers?: AiProvider[] | null; connectionLabel?: string | null; timeoutSeconds?: number | null } = {}): PlainError | null {
  if (run.status !== "failed" && run.status !== "timed_out") return null;
  const who = whoAnswers(ctx.provider, ctx.providers, ctx.connectionLabel);
  const code = run.error_code ?? (run.status === "timed_out" ? "TIMEOUT" : null);
  const fix = { href: SETTINGS_AI, hrefLabel: "Open AI models" };
  switch (code) {
    case "MODEL_AUTH_FAILED":
      return { title: `Your ${who} key was rejected.`, action: "Update it in Settings > AI models, then run this again.", ...fix };
    case "MODEL_RATE_LIMITED":
      return { title: `${who} is limiting requests from your account.`, action: `${run.attempt > 1 ? `Payminto tried ${run.attempt} times. ` : ""}Wait a few minutes and run it again, or raise your limit with ${who}.` };
    case "MODEL_OVERLOADED":
      return { title: `${who} was too busy to answer.`, action: "This is on the provider's side. Wait a few minutes and run it again." };
    case "TOKEN_LIMIT_REACHED":
      return { title: "This AI connection reached its monthly token limit.", action: "Raise the limit in Settings > AI models, or wait until next month.", ...fix };
    case "MODEL_UNAVAILABLE":
    case "CONNECTION_DISABLED":
    case "CONNECTION_NOT_FOUND":
      return { title: "This agent's AI connection is not available.", action: "Check it in Settings > AI models, or edit the agent to use another connection.", ...fix };
    case "MODEL_BAD_REQUEST":
      return { title: `${who} refused the request.`, action: "Check that the model name on this agent is one your account can use." };
    case "MODEL_REFUSED":
      return { title: "The model declined to answer.", action: "Rephrase the question and run it again." };
    case "MAX_TURNS_REACHED":
      return { title: "The agent used all its steps without finishing.", action: "Ask a narrower question, or raise the step limit on the agent." };
    case "TIMEOUT":
      return {
        title: ctx.timeoutSeconds ? `The agent took longer than its ${formatInt(ctx.timeoutSeconds)} second limit.` : "The agent took longer than its time limit.",
        action: "Ask a narrower question, or raise the time limit on the agent.",
      };
    case "TOOL_FAILED":
      return { title: "One of the agent's steps could not read or change your data.", action: run.error_message ? `The server said: ${run.error_message} Run it again; if it keeps failing, tell your platform owner.` : "Run it again; if it keeps failing, tell your platform owner." };
    default:
      return { title: "The run stopped with an error.", action: run.error_message ?? "Run it again; if it keeps failing, tell your platform owner." };
  }
}

/** Why a connection cannot be deleted, naming the agents that use it. `inUse` comes from the 409 details or the agent list. */
export function deleteRefusalText(connection: Pick<AiConnection, "label">, inUse: { name: string }[]): string {
  if (inUse.length === 0) return `${connection.label} is still used by an active agent. Pause that agent or move it to another connection first.`;
  const names = inUse.map((a) => a.name);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  const them = names.length === 1 ? "that agent" : "those agents";
  return `${connection.label} is used by ${list}. Pause ${them} or move ${names.length === 1 ? "it" : "them"} to another connection first.`;
}

/** Active agents on a connection, the ones that block deleting it. */
export function agentsUsing(connectionId: string, agents: Agent[]): Agent[] {
  return agents.filter((a) => a.connection_id === connectionId && a.status === "active");
}

/** Agent names from a 409 refusal's details, when the server lists them. */
export function inUseFromDetails(details: unknown): { name: string }[] {
  if (!details || typeof details !== "object") return [];
  const list = (details as { agents?: unknown }).agents;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a) => (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" ? [{ name: (a as { name: string }).name }] : []));
}

// ---------------------------------------------------------------------------
// Runs: terminal states, merging polled steps, and when to stop polling
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

export function isTerminal(status: AgentRunStatus): boolean {
  return TERMINAL.has(status);
}

export function canCancel(run: Pick<AgentRun, "status" | "cancel_requested">): boolean {
  return (run.status === "queued" || run.status === "running") && !run.cancel_requested;
}

/** Run again is offered for runs that did not finish well; it creates a new run with the same input. */
export function canRunAgain(run: Pick<AgentRun, "status" | "trigger">): boolean {
  return (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled") && run.trigger !== "skill_call";
}

/**
 * Steps from several polls as one list: one entry per `seq` (a repeated step keeps its latest copy), oldest first.
 * Polls overlap and the stream can deliver a step the poll also returns, so this is the only place steps are joined.
 */
export function mergeEvents(prev: readonly AgentRunEvent[], next: readonly AgentRunEvent[]): AgentRunEvent[] {
  if (next.length === 0) return prev as AgentRunEvent[];
  const bySeq = new Map<number, AgentRunEvent>();
  for (const e of prev) bySeq.set(e.seq, e);
  for (const e of next) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The highest step number seen, for `events?after=`; undefined before the first step. */
export function lastSeq(events: readonly AgentRunEvent[]): number | undefined {
  let max: number | undefined;
  for (const e of events) if (max === undefined || e.seq > max) max = e.seq;
  return max;
}

export type PollPlan = { stop: true } | { stop: false; waitSeconds: number; eventsEveryMs: number };

/**
 * How to follow a run: stop on a terminal state; with the live stream, only a slow safety check (the stream says when
 * to look again); without it, long-poll the run with `wait=25` and read new steps every 1.5 seconds while it works.
 */
export function pollPlan(run: Pick<AgentRun, "status"> | null, live: boolean): PollPlan {
  if (run && isTerminal(run.status)) return { stop: true };
  if (live) return { stop: false, waitSeconds: 0, eventsEveryMs: 15_000 };
  return { stop: false, waitSeconds: 25, eventsEveryMs: run?.status === "queued" ? 4_000 : 1_500 };
}

/** The run a live stream event is about, or null when it is not a run event. */
export function runIdOfEvent(e: { type: string; data: Record<string, unknown> }): string | null {
  if (!e.type.startsWith("agent_run.")) return null;
  const d = e.data;
  const id = d.run_id ?? (d.object === "agent_run" ? d.id : undefined) ?? (d.run && typeof d.run === "object" ? (d.run as { id?: unknown }).id : undefined);
  return typeof id === "string" ? id : null;
}

// ---------------------------------------------------------------------------
// The run timeline
// ---------------------------------------------------------------------------

/**
 * What the enclave attestation of one model turn showed (NEAR AI Cloud). The node stores it with the step; the claim
 * is limited to that turn. `partially_verified` means no check failed and some were not run by the node.
 */
export type StepAttestation = {
  status: "verified" | "partially_verified" | "failed";
  summary: string | null;
  requestHash: string | null;
  responseHash: string | null;
  /** `provider_tee`: a model enclave signed the answer. `gateway`: only the gateway enclave did. */
  signatureKind: string | null;
  signer: string | null;
  /** The node's check ids that ran and failed, and those that did not run. */
  failed: string[];
  notVerified: string[];
};

/**
 * What a model turn's attestation comes to for a person. `partial` is the normal result: no check failed and some did
 * not run. `unavailable` is a failed result whose cause is missing evidence (no signature, no report), told apart from
 * `failed`, where evidence came back and a check did not pass. `none` is a turn that carries no attestation at all.
 */
export type AttestationState = "verified" | "partial" | "failed" | "unavailable" | "none";

/**
 * The word for each state. `positive` is kept for a result where every check passed; a partial result is neutral, so
 * it never reads as a green "verified". `warning` colours only the shield of a result whose evidence never arrived.
 * `short` is the one-line form for tight places.
 */
export const ATTESTATION_STATE: Record<AttestationState, { tone: Tone; label: string; short: string }> = {
  verified: { tone: "positive", label: "Verified", short: "Attestation verified" },
  partial: { tone: "neutral", label: "Partially verified", short: "Attestation partially verified" },
  failed: { tone: "negative", label: "Verification failed", short: "Attestation failed" },
  unavailable: { tone: "warning", label: "Could not be checked", short: "Attestation could not be checked" },
  none: { tone: "neutral", label: "No attestation", short: "No attestation" },
};

/** True under every result: an attestation is about who signed the bytes, never about what the answer says. */
export const ATTESTATION_LIMIT = "An attestation shows which enclave signed the request and the answer. It does not show that the answer is correct.";

/** Evidence that never arrived: no signature for the answer, or no enclave report to check it against. */
const MISSING_EVIDENCE = ["signature_available", "report_fetched"];

export function attestationState(a: StepAttestation | null | undefined): AttestationState {
  if (!a) return "none";
  if (a.status === "verified") return "verified";
  if (a.status === "partially_verified") return "partial";
  return a.failed.some((id) => MISSING_EVIDENCE.includes(id)) ? "unavailable" : "failed";
}

/** A check that did not run, in plain words. The technical names stay with the node. */
const UNCHECKED: Record<string, string> = {
  model_binding: "Which model wrote the answer, because only the gateway signed it",
  tcb_status: "Whether Intel counts the enclave's hardware and firmware as up to date",
  gpu_verdict: "Whether NVIDIA accepts the evidence from the GPU",
  measurement_policy: "Whether the software in the enclave is a build you accept",
  enclave_attestation: "Parts of the enclave's own report, named in the node's note",
};

/** How the node's summary names the checks of an enclave report that it left open (packages/models, attestation). */
const NODE_PHRASE: Record<string, string> = {
  "Intel's TCB status of the platform": "tcb_status",
  "NVIDIA's verdict on the GPU evidence": "gpu_verdict",
  "whether the measured software is on an accepted list": "measurement_policy",
};

/** What each open check of an enclave report would take. Payminto uses none of them yet, so these checks never run. */
const CHECK_NEEDS: Record<string, string> = {
  tcb_status: "Intel's own service",
  gpu_verdict: "NVIDIA's own service",
  measurement_policy: "a list of builds you accept",
};

/** "a", "a and b", "a, b and c". */
const listed = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** Why the open checks of an enclave report did not run, naming only what the checks on this list would take. */
function whyUnchecked(open: string[]): string | null {
  const needs = open.flatMap((id) => (CHECK_NEEDS[id] ? [CHECK_NEEDS[id]] : []));
  if (needs.length === 0) return null;
  return `${needs.length === 1 ? "The check on the enclave itself needs" : "The checks on the enclave itself need"} ${listed(needs)}. Payminto does not use ${needs.length === 1 ? "it" : "them"} yet.`;
}

/**
 * A sentence split around the keys and hashes in it (0x plus 40 hex characters, or 64 hex characters), so each can be
 * set on one line of its own type instead of breaking wherever the sentence wraps.
 */
export function splitIds(text: string): Array<{ text: string; id: boolean }> {
  return text
    .split(/(0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F]))/)
    .map((t, i) => ({ text: t, id: i % 2 === 1 }))
    .filter((p) => p.text.length > 0);
}

/** A check that ran and did not pass, in one plain sentence. */
const FAILED_CHECK: Record<string, string> = {
  signature_kind: "The signature does not say whether the model enclave or the gateway signed.",
  signed_text: "The signature covers a different request or answer than the one your node sent and received.",
  signature_valid: "The signature is not valid for the key it names.",
  signer_attested: "The signing key is not the key of an enclave your node checked before the request.",
  preflight_fresh: "The enclave was not checked shortly before the request.",
  model_binding: "No model enclave signature ties the answer to the model.",
};

const words = (id: string) => id.replace(/[_-]+/g, " ").trim();

/**
 * The checks that did not run, as ids, the one that matters most first. The node stores one id for "the enclave's own
 * report is only partly checked" and names the open checks of that report in its summary, so they are read from there.
 */
function openChecks(a: StepAttestation): string[] {
  const ids: string[] = [];
  for (const id of a.notVerified) {
    if (id !== "enclave_attestation") {
      ids.push(id);
      continue;
    }
    const named = (/not checked in this process: ([^.;]*)/.exec(a.summary ?? "")?.[1] ?? "").split(", ").map((p) => p.trim()).filter(Boolean);
    ids.push(...(named.length ? named.map((p) => NODE_PHRASE[p] ?? p) : [id]));
  }
  return [...new Set(ids)].sort((x, y) => Number(y === "model_binding") - Number(x === "model_binding"));
}

export type AttestationView = {
  state: AttestationState;
  tone: Tone;
  label: string;
  short: string;
  /** What the result means, in plain sentences: what was checked, who signed, what was left unchecked. */
  meaning: string;
  /** The key in the signature. `who` is set only when the checks tie that key to an enclave. */
  signer: { title: string; who: string | null; key: string } | null;
  /** What the node checked and found in order, for a result where no check failed. The technical words live here. */
  checked: string[];
  /** Checks that did not run, in plain words. */
  unchecked: string[];
  /** Why those checks did not run, when that is known. */
  uncheckedWhy: string | null;
  /** Checks that ran and did not pass, in plain sentences. */
  problems: string[];
  /** What to do next, when there is something to do. */
  next: string | null;
  /** The node's own sentence, kept for the cases where its detail adds to the plain words. */
  nodeNote: string | null;
};

/**
 * One model turn's attestation in plain words. It claims no more than the node's checks do: a partial result names
 * what was not checked, a failed one says the answer is unverified, and none of them speaks about the answer itself.
 */
export function attestationView(a: StepAttestation | null | undefined): AttestationView {
  const state = attestationState(a);
  const base = { state, ...ATTESTATION_STATE[state], signer: null, checked: [], unchecked: [], uncheckedWhy: null, problems: [], next: null, nodeNote: null };
  if (!a || state === "none") return { ...base, meaning: "Nothing was checked about where this turn ran. Only agents on a NEAR AI Cloud connection get an attestation." };

  if (state === "unavailable") {
    const what = a.failed.includes("signature_available") ? "NEAR AI Cloud returned no signature for this answer" : "The enclave report could not be fetched from NEAR AI Cloud";
    return {
      ...base,
      meaning: `${what}, so nothing could be checked. The answer was still delivered and is unverified.`,
      next: "Run the agent again to get a signed answer. If this keeps happening, NEAR AI Cloud may not be recording signatures.",
      nodeNote: a.summary,
    };
  }

  if (state === "failed") {
    // A model enclave signature that fails any check also fails to tie the answer to the model; say that only when it is the whole story.
    const failed = a.failed.filter((id) => id !== "model_binding" || a.failed.length === 1);
    return {
      ...base,
      meaning: "A check did not pass, so nothing ties this answer to a checked enclave. Treat the answer as unverified.",
      signer: a.signer ? { title: "Key in the signature", who: null, key: a.signer } : null,
      problems: failed.map((id) => FAILED_CHECK[id] ?? `The check "${words(id)}" did not pass.`),
      next: "Run the agent again for a fresh check. If it fails again, treat answers from this connection as unverified.",
      nodeNote: a.summary,
    };
  }

  const gateway = a.signatureKind === "gateway";
  const who = a.signatureKind === "provider_tee" ? "The model enclave" : gateway ? "The NEAR AI Cloud gateway enclave" : "An enclave";
  const signer = a.signer ? { title: "Signed by", who, key: a.signer } : null;
  // A result that did not fail means each of these passed: the node fails the result when any one of them does not.
  const checked = [
    "The signature is valid and covers the exact request sent and the answer received",
    `The signing key is the one ${gateway ? "the gateway enclave" : a.signatureKind === "provider_tee" ? "the model enclave" : "the enclave"} presented when your node checked it before the request`,
    "That enclave's Intel TDX quote chains to Intel's root certificate, answers your node's own challenge and shows debug mode off",
  ];
  if (state === "verified") return { ...base, signer, checked, meaning: `${who} signed this exact request and answer, and every check your Payminto node ran passed.` };

  const open = openChecks(a);
  const left = open.length === 0 ? "left some checks unrun" : `did not run ${open.length} other ${open.length === 1 ? "check" : "checks"}`;
  return {
    ...base,
    signer,
    checked,
    meaning: gateway
      ? `Only the NEAR AI Cloud gateway enclave signed this exact request and answer, so nothing ties the answer to a model. Your Payminto node checked the signature and the gateway's hardware report from Intel, and ${left}.`
      : `${who} signed this exact request and answer. Your Payminto node checked the signature and the enclave's hardware report from Intel, and ${left}. This is the normal result.`,
    unchecked: open.map((id) => UNCHECKED[id] ?? `${words(id).charAt(0).toUpperCase()}${words(id).slice(1)}`),
    uncheckedWhy: whyUnchecked(open),
    next: gateway ? "To tie answers to a model enclave, choose a model that NEAR AI Cloud runs in its own enclaves." : null,
    // Without a plain list, the node's sentence is the only place that names what was left open.
    nodeNote: open.length === 0 || open.includes("enclave_attestation") ? a.summary : null,
  };
}

export type TimelineStep =
  | { kind: "started"; key: string; at: string; attempt: number | null }
  | { kind: "model"; key: string; at: string; turn: number | null; inputTokens: number; outputTokens: number; text: string | null; stop: string | null; model: string | null; attestation?: StepAttestation }
  | { kind: "tool"; key: string; at: string; name: string; label: string; input: Record<string, unknown> | null; result: string | null; isError: boolean; done: boolean }
  | { kind: "retry"; key: string; at: string; attempt: number | null; nextAt: string | null; code: string | null; message: string | null }
  | { kind: "finished"; key: string; at: string; status: string | null; code: string | null }
  | { kind: "other"; key: string; at: string; type: string };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

function stepAttestation(v: unknown): StepAttestation | null {
  const a = obj(v);
  if (!a || (a.status !== "verified" && a.status !== "partially_verified" && a.status !== "failed")) return null;
  const ids = (list: unknown): string[] => (Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
  return {
    status: a.status,
    summary: str(a.summary),
    requestHash: str(a.request_hash),
    responseHash: str(a.response_hash),
    signatureKind: str(a.signature_kind),
    signer: str(a.signer),
    failed: ids(a.failed),
    notVerified: ids(a.not_verified),
  };
}

/** A tool result as one short line; long or structured results are summarised by the server, this only trims. */
function resultSummary(d: Record<string, unknown>): string | null {
  const s = str(d.summary) ?? str(d.content) ?? str(d.result);
  if (!s) return null;
  return s.length > 280 ? `${s.slice(0, 277)}...` : s;
}

/**
 * Steps as timeline rows, oldest first. A `tool_call` and its `tool_result` (same `id`, or the next result for that
 * tool) become one row with the input and the result, so a call still waiting for its result shows as in progress.
 */
export function timelineSteps(events: readonly AgentRunEvent[]): TimelineStep[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const out: TimelineStep[] = [];
  const openTools = new Map<string, number>();
  for (const e of sorted) {
    const d = e.data;
    const key = `s${e.seq}`;
    switch (e.type) {
      case "started":
        out.push({ kind: "started", key, at: e.at, attempt: num(d.attempt) });
        break;
      case "model_turn": {
        const usage = obj(d.usage);
        const attestation = stepAttestation(d.attestation);
        out.push({
          kind: "model",
          key,
          at: e.at,
          turn: num(d.turn),
          inputTokens: num(d.input_tokens) ?? num(usage?.input_tokens) ?? num(usage?.inputTokens) ?? 0,
          outputTokens: num(d.output_tokens) ?? num(usage?.output_tokens) ?? num(usage?.outputTokens) ?? 0,
          text: str(d.text),
          stop: str(d.stop),
          model: str(d.model),
          ...(attestation ? { attestation } : {}),
        });
        break;
      }
      case "tool_call": {
        const name = str(d.name) ?? "tool";
        const id = str(d.id) ?? `${name}#${e.seq}`;
        openTools.set(id, out.length);
        out.push({ kind: "tool", key, at: e.at, name, label: toolLabel(name), input: obj(d.input), result: null, isError: false, done: false });
        break;
      }
      case "tool_result": {
        const name = str(d.name);
        let id = str(d.id);
        if (!id || !openTools.has(id)) id = [...openTools.keys()].find((k) => !name || (out[openTools.get(k)!] as { name?: string }).name === name) ?? null;
        const at = id !== null ? openTools.get(id) : undefined;
        const isError = d.is_error === true || d.isError === true;
        if (at !== undefined && id !== null) {
          const row = out[at] as Extract<TimelineStep, { kind: "tool" }>;
          out[at] = { ...row, result: resultSummary(d), isError, done: true };
          openTools.delete(id);
        } else {
          out.push({ kind: "tool", key, at: e.at, name: name ?? "tool", label: toolLabel(name ?? "tool"), input: null, result: resultSummary(d), isError, done: true });
        }
        break;
      }
      case "retry_scheduled":
        out.push({ kind: "retry", key, at: e.at, attempt: num(d.attempt), nextAt: str(d.next_attempt_at), code: str(d.error_code) ?? str(d.code), message: str(d.error_message) ?? str(d.message) });
        break;
      case "finished":
        out.push({ kind: "finished", key, at: e.at, status: str(d.status), code: str(d.error_code) });
        break;
      default:
        out.push({ kind: "other", key, at: e.at, type: e.type });
    }
  }
  return out;
}

/** Tokens a run used, from its usage or, while it works, from the model turns so far. */
export function runTokens(run: Pick<AgentRun, "usage">, events: readonly AgentRunEvent[]): { input: number; output: number } {
  if (run.usage && (run.usage.input_tokens || run.usage.output_tokens)) return { input: run.usage.input_tokens, output: run.usage.output_tokens };
  let input = 0;
  let output = 0;
  for (const s of timelineSteps(events)) if (s.kind === "model") {
    input += s.inputTokens;
    output += s.outputTokens;
  }
  return { input, output };
}

// ---------------------------------------------------------------------------
// Who may do what (docs/AGENTS.md sections 2 and 6, on the PRODUCT.md 10.4 table)
// ---------------------------------------------------------------------------

export type AgentAccess = {
  /** See connections, agents, runs and usage: every member of the business. */
  read: boolean;
  /** Start and cancel runs: Staff and up. */
  run: boolean;
  /** Add, rotate, turn off and delete connections; create, edit, pause and delete agents: Admins only. */
  manage: boolean;
};

/**
 * The routes in section 6 are "any", "Staff+" and "Admin". The permission table has no agent names yet, so they map
 * onto the existing ones: any member reads payments, Staff and up create payments, only Admins change business
 * settings. AI agents belong to one business, so on the platform view nothing applies until a business is open.
 */
export function agentAccess(grants: Grants, scope: Scope): AgentAccess {
  if (scope.kind !== "business") return { read: false, run: false, manage: false };
  return {
    read: can(grants, "payments.read", scope),
    run: can(grants, "payments.write", scope),
    manage: can(grants, "business.update", scope),
  };
}

// ---------------------------------------------------------------------------
// Skills: slug, public URL and copyable examples
// ---------------------------------------------------------------------------

/** "Product copy writer" -> "product-copy-writer". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/^-|-$/g, "");
}

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

/** The public URL buyers call: the server's own when it sends one, else the server address plus the skill path. */
export function skillUrl(agent: Pick<Agent, "slug" | "skill_url">, serverUrl: string): string | null {
  if (agent.skill_url) return agent.skill_url;
  if (!agent.slug) return null;
  return `${serverUrl.replace(/\/+$/, "")}/v1/skills/${agent.slug}`;
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A first call without payment: the answer is 402 with the price, which any x402 client then pays. */
export function curlExample(url: string, inputHint: string | null | undefined): string {
  const body = JSON.stringify({ input: inputHint?.trim() || "Your request" });
  return [`curl -i -X POST ${url} \\`, `  -H 'Content-Type: application/json' \\`, `  -d ${shellQuote(body)}`].join("\n");
}

/** A buyer agent that pays the price with a Budget voucher and reads the answer (or the poll URL on 202). */
export function agentExample(url: string, priceAtomic: string | null | undefined, inputHint: string | null | undefined): string {
  const max = priceAtomic && /^\d+$/.test(priceAtomic) ? `${priceAtomic}n` : "1_000_000n";
  return [
    `import { AgentClient } from "@payminto/sdk";`,
    `import { keypairFromSeed } from "@payminto/chain";`,
    ``,
    `// The agent key from \`payminto-agent keygen\`; it signs vouchers within its Budget and holds no funds.`,
    `const agent = new AgentClient({`,
    `  network: "near:testnet",`,
    `  hub: process.env.PAYMINTO_HUB,`,
    `  nodeUrl: process.env.PAYMINTO_NODE_URL,`,
    `  budgetId: process.env.PAYMINTO_BUDGET_ID,`,
    `  keypair: keypairFromSeed(Buffer.from(process.env.AGENT_SEED, "hex")),`,
    `  maxPrice: ${max}, // never pays more than the price`,
    `});`,
    `const res = await agent.fetch(${JSON.stringify(url)}, {`,
    `  method: "POST",`,
    `  headers: { "Content-Type": "application/json" },`,
    `  body: JSON.stringify({ input: ${JSON.stringify(inputHint?.trim() || "Your request")} }),`,
    `});`,
    `// 200 carries the answer; 202 carries a poll URL for the run you paid for.`,
    `console.log(await res.json());`,
  ].join("\n");
}
