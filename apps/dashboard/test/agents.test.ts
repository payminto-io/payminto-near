import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentAccess,
  agentExample,
  attestationState,
  canCancel,
  canRunAgain,
  curlExample,
  deleteRefusalText,
  inUseFromDetails,
  isTerminal,
  lastSeq,
  mergeEvents,
  pollPlan,
  runErrorText,
  runIdOfEvent,
  runTokens,
  skillUrl,
  slugify,
  SLUG_PATTERN,
  timelineSteps,
} from "@/lib/agents";
import { RunFollower } from "@/lib/run-follower";
import { ApiError } from "@/lib/http";
import { grantsFor } from "@/lib/permissions";
import { setView } from "@/lib/merchant-scope";
import { MockAgentsApi } from "@/lib/mock/agents";
import { mockBusinesses } from "@/lib/mock/gateway";
import {
  agentOneSchema,
  agentRunEventsSchema,
  agentRunOneSchema,
  agentRunSchema,
  agentsSchema,
  aiConnectionsSchema,
  aiModelsSchema,
  aiProvidersSchema,
  aiUsageSchema,
  gatewayPageSchema,
  type AgentRun,
  type AgentRunEvent,
} from "@/lib/schemas";

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): AgentRunEvent => ({ seq, type, data, at: new Date(1_700_000_000_000 + seq * 1000).toISOString() });
const run = (over: Partial<AgentRun> = {}): AgentRun =>
  agentRunSchema.parse({ id: "run_1", agent_id: "agt_1", status: "running", created_at: "2026-11-01T10:00:00Z", ...over });

describe("AI agent schemas (docs/AGENTS.md sections 2, 4, 5 and 6)", () => {
  const acme = mockBusinesses()[0]!.id;
  const api = new MockAgentsApi();
  beforeAll(() => setView({ kind: "business", merchantId: acme }));
  afterAll(() => setView(null));

  it("parse every mock screen's data with the wire schemas", { timeout: 20_000 }, async () => {
    expect(aiProvidersSchema.parse(await api.providers()).map((p) => p.id)).toEqual(["anthropic", "openai", "google", "openai_compatible", "replicate", "nearai"]);
    const connections = aiConnectionsSchema.parse(await api.connections());
    expect(connections.map((c) => c.status).sort()).toEqual(["active", "active", "invalid"]);
    expect(connections.every((c) => c.key_hint?.length === 4)).toBe(true);
    const agents = agentsSchema.parse(await api.agents());
    expect(new Set(agents.map((a) => a.kind))).toEqual(new Set(["ops", "skill"]));
    const page = gatewayPageSchema(agentRunSchema).parse(await api.runs({ limit: 50 }));
    expect(new Set(page.items.map((r) => r.status))).toEqual(new Set(["queued", "running", "succeeded", "failed", "cancelled", "timed_out"]));
    for (const r of page.items) {
      const steps = agentRunEventsSchema.parse(await api.runEvents(r.id));
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.map((s) => s.seq)).toEqual([...steps.map((s) => s.seq)].sort((a, b) => a - b));
    }
    // The runs on NEAR AI Cloud show every attestation state a model turn can have; the others carry none.
    const states = new Set<string>();
    for (const r of page.items) for (const s of timelineSteps(await api.runEvents(r.id))) if (s.kind === "model") states.add(`${attestationState(s.attestation)}${s.attestation?.signatureKind === "gateway" ? ":gateway" : ""}`);
    expect(states).toEqual(new Set(["none", "partial", "partial:gateway", "failed", "unavailable"]));
    const usage = aiUsageSchema.parse(await api.usage());
    expect(usage.connections.find((u) => u.connection_id === "aic_team_anthropic")!.input_tokens).toBeGreaterThan(0);
  });

  it("refuses to delete a connection an active agent uses, naming the agents", async () => {
    const err = await api.deleteConnection("aic_team_anthropic").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect(inUseFromDetails((err as ApiError).details).map((a) => a.name)).toEqual(["Store assistant", "Product copy writer"]);
  });

  it("tolerate envelopes, string counts, aliases and extra fields", () => {
    const providers = aiProvidersSchema.parse({ providers: [{ provider: "openai_compatible", requires_base_url: true, models: ["m"], logo: "x" }] });
    expect(providers[0]).toEqual({ id: "openai_compatible", name: null, needs_base_url: true, default_base_url: null, suggested_models: ["m"], note: null });
    // The node serves the model layer's catalogue in camelCase.
    const served = aiProvidersSchema.parse({ items: [{ id: "replicate", name: "Replicate (DeepSeek and others)", needsBaseUrl: false, defaultBaseUrl: "https://api.replicate.com", keyOptional: false, suggestedModels: ["deepseek-ai/deepseek-v3.1"], docsUrl: "x", presets: [], note: "Tools are emulated." }] });
    expect(served[0]).toEqual({ id: "replicate", name: "Replicate (DeepSeek and others)", needs_base_url: false, default_base_url: "https://api.replicate.com", suggested_models: ["deepseek-ai/deepseek-v3.1"], note: "Tools are emulated." });
    expect(aiProvidersSchema.parse({ items: [{ id: "openai_compatible", needsBaseUrl: true, suggestedModels: [] }] })[0]!.needs_base_url).toBe(true);
    const r = agentRunOneSchema.parse({ run: { id: "run_x", agent_id: "agt_1", status: "queued", created_at: 1_761_998_400, usage: { input_tokens: "12", output_tokens: 3 }, lease_owner: "w1" } });
    expect(r.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
    expect(r.attempt).toBe(0);
    expect("lease_owner" in r).toBe(false);
    expect(agentOneSchema.parse({ agent: { id: "agt_1", kind: "skill", name: "S", connection_id: null, model: "m", status: "active", created_at: "2026-11-01T00:00:00Z", price: 250000 } }).price).toBe("250000");
    expect(aiUsageSchema.parse({ month: "2026-11", connections: { aic_1: { input_tokens: 5, output_tokens: 1 } } }).connections).toEqual([{ connection_id: "aic_1", input_tokens: 5, output_tokens: 1 }]);
    expect(aiModelsSchema.parse({ models: null })).toBeNull();
    expect(aiModelsSchema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(agentRunEventsSchema.parse({ items: [{ seq: "2", type: "started", data: null, at: "2026-11-01T00:00:00Z" }] })[0]!.data).toEqual({});
  });
});

describe("merging polled steps", () => {
  it("keeps one step per seq, oldest first, whatever order the polls arrive in", () => {
    const a = [ev(1, "started"), ev(2, "model_turn"), ev(3, "tool_call")];
    const b = [ev(3, "tool_call", { again: true }), ev(5, "finished"), ev(4, "tool_result")];
    const merged = mergeEvents(a, b);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(merged[2]!.data).toEqual({ again: true });
    expect(lastSeq(merged)).toBe(5);
    expect(lastSeq([])).toBeUndefined();
  });
  it("returns the same list when a poll brings nothing new", () => {
    const a = [ev(1, "started")];
    expect(mergeEvents(a, [])).toBe(a);
  });
});

describe("the run timeline", () => {
  it("joins a tool call with its result and shows a call still waiting", () => {
    const steps = timelineSteps([
      ev(1, "started", { attempt: 1 }),
      ev(2, "model_turn", { turn: 1, input_tokens: 1840, output_tokens: 96, stop: "tool_use" }),
      ev(3, "tool_call", { id: "tc_1", name: "get_overview", input: { range: "7d" } }),
      ev(4, "tool_result", { id: "tc_1", name: "get_overview", summary: "This week 2,948.75 USDC" }),
      ev(6, "tool_call", { id: "tc_2", name: "list_payments", input: {} }),
      ev(5, "retry_scheduled", { attempt: 1, next_attempt_at: "2026-11-01T10:00:30Z", error_code: "MODEL_RATE_LIMITED" }),
    ]);
    expect(steps.map((s) => s.kind)).toEqual(["started", "model", "tool", "retry", "tool"]);
    expect(steps[1]).toMatchObject({ inputTokens: 1840, outputTokens: 96 });
    expect(steps[2]).toMatchObject({ label: "Read the overview", result: "This week 2,948.75 USDC", done: true, input: { range: "7d" } });
    expect(steps[4]).toMatchObject({ label: "Looked up payments", done: false, result: null });
  });
  it("carries the enclave attestation of a model turn, and only a well-formed one", () => {
    const attestation = { status: "partially_verified", summary: "Signed by the model enclave.", request_hash: "aa", response_hash: "bb", signature_kind: "provider_tee", signer: "0x01", passed: ["signed_text"], failed: [], not_verified: ["enclave_attestation"] };
    const steps = timelineSteps([ev(1, "model_turn", { turn: 1, stop: "end", attestation }), ev(2, "model_turn", { turn: 2, stop: "end", attestation: { status: "trusted" } }), ev(3, "model_turn", { turn: 3, stop: "end" })]);
    expect(steps[0]).toMatchObject({ kind: "model", attestation: { status: "partially_verified", summary: "Signed by the model enclave.", requestHash: "aa", responseHash: "bb", signatureKind: "provider_tee", signer: "0x01" } });
    expect("attestation" in steps[1]!).toBe(false);
    expect("attestation" in steps[2]!).toBe(false);
  });
  it("counts tokens from the steps until the run reports its usage", () => {
    const events = [ev(1, "model_turn", { input_tokens: 10, output_tokens: 2 }), ev(2, "model_turn", { usage: { inputTokens: 5, outputTokens: 1 } })];
    expect(runTokens(run(), events)).toEqual({ input: 15, output: 3 });
    expect(runTokens(run({ usage: { input_tokens: 100, output_tokens: 9, model: null, provider: null } }), events)).toEqual({ input: 100, output: 9 });
  });
});

describe("run errors in plain words", () => {
  it("names the provider and where to fix a rejected key", () => {
    const e = runErrorText(run({ status: "failed", error_code: "MODEL_AUTH_FAILED" }), { provider: "openai" })!;
    expect(e.title).toBe("Your OpenAI key was rejected.");
    expect(e.action).toContain("Settings > AI models");
    expect(e.href).toBe("/settings/ai");
    // An OpenAI-compatible endpoint is named after the connection people gave it.
    expect(runErrorText(run({ status: "failed", error_code: "MODEL_AUTH_FAILED" }), { provider: "openai_compatible", connectionLabel: "OpenRouter" })!.title).toBe("Your OpenRouter key was rejected.");
  });
  it("explains a timeout with the agent's limit, even without a code", () => {
    expect(runErrorText(run({ status: "timed_out" }), { timeoutSeconds: 180 })!.title).toBe("The agent took longer than its 180 second limit.");
  });
  it("covers the token limit and rate limits, and falls back to the server's message", () => {
    expect(runErrorText(run({ status: "failed", error_code: "TOKEN_LIMIT_REACHED" }))!.href).toBe("/settings/ai");
    expect(runErrorText(run({ status: "failed", error_code: "MODEL_RATE_LIMITED", attempt: 3 }), { provider: "anthropic" })!.action).toContain("tried 3 times");
    expect(runErrorText(run({ status: "failed", error_code: "SOMETHING_NEW", error_message: "Disk full." }))!.action).toBe("Disk full.");
  });
  it("says nothing for runs that did not fail", () => {
    for (const status of ["queued", "running", "succeeded", "cancelled"] as const) expect(runErrorText(run({ status }))).toBeNull();
  });
  it("words a delete refusal with the agents that block it", () => {
    expect(deleteRefusalText({ label: "Team OpenAI" }, [{ name: "Store assistant" }])).toBe("Team OpenAI is used by Store assistant. Pause that agent or move it to another connection first.");
    expect(deleteRefusalText({ label: "X" }, [{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("X is used by A, B and C. Pause those agents or move them to another connection first.");
    expect(inUseFromDetails({ agents: [{ id: "agt_1", name: "A" }, { id: 2 }] })).toEqual([{ name: "A" }]);
    expect(inUseFromDetails(null)).toEqual([]);
  });
});

describe("who may do what with AI agents", () => {
  const A = "mer_acme";
  const business = { kind: "business" as const, merchantId: A };
  const as = (role: "admin" | "staff" | "viewer") => agentAccess(grantsFor({ platformRole: null, memberships: [{ merchantId: A, role }] }), business);
  it("lets Admins manage, Staff run, Viewers read", () => {
    expect(as("admin")).toEqual({ read: true, run: true, manage: true });
    expect(as("staff")).toEqual({ read: true, run: true, manage: false });
    expect(as("viewer")).toEqual({ read: true, run: false, manage: false });
  });
  it("gives platform roles full access inside a business and nothing on the platform view", () => {
    const owner = grantsFor({ platformRole: "owner", memberships: [] });
    expect(agentAccess(owner, business)).toEqual({ read: true, run: true, manage: true });
    expect(agentAccess(owner, { kind: "platform" })).toEqual({ read: false, run: false, manage: false });
  });
  it("keeps another business's members out", () => {
    const other = grantsFor({ platformRole: null, memberships: [{ merchantId: "mer_other", role: "admin" }] });
    expect(agentAccess(other, business).read).toBe(false);
  });
});

describe("when to stop polling", () => {
  it("stops on every terminal state and only there", () => {
    for (const s of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(pollPlan({ status: s }, false)).toEqual({ stop: true });
      expect(pollPlan({ status: s }, true)).toEqual({ stop: true });
    }
    expect(pollPlan({ status: "running" }, false)).toEqual({ stop: false, waitSeconds: 25, eventsEveryMs: 1_500 });
    expect(pollPlan({ status: "queued" }, false)).toMatchObject({ stop: false, waitSeconds: 25 });
    expect(pollPlan(null, false)).toMatchObject({ stop: false });
  });
  it("only checks slowly once the live stream carries the run", () => {
    expect(pollPlan({ status: "running" }, true)).toEqual({ stop: false, waitSeconds: 0, eventsEveryMs: 15_000 });
  });
  it("offers cancel while waiting or working, and run again after a failure", () => {
    expect(canCancel(run({ status: "queued" }))).toBe(true);
    expect(canCancel(run({ status: "running", cancel_requested: true }))).toBe(false);
    expect(canCancel(run({ status: "succeeded" }))).toBe(false);
    expect(canRunAgain(run({ status: "failed" }))).toBe(true);
    expect(canRunAgain(run({ status: "failed", trigger: "skill_call" }))).toBe(false);
    expect(canRunAgain(run({ status: "succeeded" }))).toBe(false);
  });
  it("picks the run id out of a stream event", () => {
    expect(runIdOfEvent({ type: "agent_run.step", data: { run_id: "run_1" } })).toBe("run_1");
    expect(runIdOfEvent({ type: "agent_run.succeeded", data: { object: "agent_run", id: "run_2" } })).toBe("run_2");
    expect(runIdOfEvent({ type: "call.accepted", data: { run_id: "run_1" } })).toBeNull();
  });
});

describe("RunFollower", () => {
  /** A server that moves the run one status per long poll and adds steps as it goes; steps overlap between reads. */
  function scripted(statuses: AgentRun["status"][]) {
    const calls = { run: 0, waits: [] as number[], events: 0 };
    let i = 0;
    const all = [ev(1, "started"), ev(2, "model_turn"), ev(3, "tool_call", { id: "t" }), ev(4, "tool_result", { id: "t" }), ev(5, "finished", { status: "succeeded" })];
    const api = {
      async run(_id: string, wait = 0) {
        calls.run++;
        calls.waits.push(wait);
        if (wait > 0 && i < statuses.length - 1) i++;
        return run({ status: statuses[i]! });
      },
      async runEvents(_id: string, after?: number) {
        calls.events++;
        const upTo = Math.min(all.length, 1 + i * 2);
        // Re-sends the last step it already sent, like a poll racing the stream.
        return all.slice(0, upTo).filter((e) => after === undefined || e.seq >= after);
      },
    };
    return { api, calls };
  }

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("long-polls until the run ends, then reads the steps once more and stops", async () => {
    const { api, calls } = scripted(["queued", "running", "succeeded"]);
    const f = new RunFollower("run_1", api, { delay: () => 0 });
    await f.start();
    for (let n = 0; n < 50 && !f.snapshot.done; n++) await settle();
    expect(f.snapshot.done).toBe(true);
    expect(f.snapshot.run?.status).toBe("succeeded");
    expect(f.snapshot.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(calls.waits.filter((w) => w === 25).length).toBeGreaterThanOrEqual(2);
    const after = { ...calls };
    await settle();
    await settle();
    expect(calls.run).toBe(after.run);
    expect(calls.events).toBe(after.events);
    f.stop();
  });

  it("stops when the run does not exist", async () => {
    const f = new RunFollower("run_missing", {
      run: async () => {
        throw new ApiError(404, "RUN_NOT_FOUND", "No run.");
      },
      runEvents: async () => {
        throw new ApiError(404, "RUN_NOT_FOUND", "No run.");
      },
    });
    await f.start();
    expect(f.snapshot.done).toBe(true);
    expect((f.snapshot.error as ApiError).status).toBe(404);
  });

  it("drops the long poll once the stream proves it carries the run", async () => {
    const { api, calls } = scripted(["running", "running"]);
    const f = new RunFollower("run_1", api, { delay: (ms) => (ms > 5_000 ? 60_000 : 0) });
    f.setStream(true);
    f.streamEvent();
    await f.start();
    await settle();
    const polls = calls.waits.filter((w) => w > 0).length;
    await settle();
    expect(calls.waits.filter((w) => w > 0).length).toBe(polls);
    f.stop();
  });
});

describe("paid skills", () => {
  it("makes a valid address from a name", () => {
    expect(slugify("Product copy writer!")).toBe("product-copy-writer");
    expect(SLUG_PATTERN.test(slugify("  Été  menu  "))).toBe(true);
    expect(SLUG_PATTERN.test("-bad")).toBe(false);
  });
  it("builds the public URL and copyable examples", () => {
    const url = skillUrl({ slug: "product-copy", skill_url: null }, "https://pay.example.com/");
    expect(url).toBe("https://pay.example.com/v1/skills/product-copy");
    expect(skillUrl({ slug: "x", skill_url: "https://cdn.example/x" }, "https://a")).toBe("https://cdn.example/x");
    expect(curlExample(url!, "It's a flask")).toContain(`-d '{"input":"It'\\''s a flask"}'`);
    expect(agentExample(url!, "250000", null)).toContain("maxPrice: 250000n");
  });
});
