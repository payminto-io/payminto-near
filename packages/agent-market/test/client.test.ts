import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CATEGORIES,
  LISTING_STATUSES,
  MAX_JOB_TEXT_CHARS,
  MarketClient,
  MarketError,
  RateLimiter,
  Secret,
  adoptionCodeSchema,
  agentSchema,
  assignmentSchema,
  attachmentSchema,
  isHandle,
  jobBriefFields,
  latestMessageFields,
  pricingPlanSchema,
  redact,
  registrationSchema,
  startedSchema,
} from "../src/index.ts";
import { MARKET, TOKEN, failure, fakeClock, fakeFetch, fixture } from "./helpers.ts";

const RESEARCH_AGENT = "00000000-0000-4000-8000-00000000a001";
const ASSIGNMENT = "5b1f6c1e-7d0a-4a51-9a3e-2f6b8c0d4e11";

describe("public reads, against recorded answers of the live market", () => {
  it("searches the catalog without an account and without a credential", async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${MARKET}/v1/agents`]: fixture("agents-search.live.json") });
    const agents = await new MarketClient({ fetch, token: TOKEN }).searchAgents({ q: "research", limit: 5 });
    expect(agents.map((a) => a.handle)).toEqual(["example-data", "example-research"]);
    expect(agents[1]).toMatchObject({ agent_id: RESEARCH_AGENT, category: "research", listing_status: "live", available_now: true, sla_seconds: 3600 });
    expect(calls[0]!.url).toBe(`${MARKET}/v1/agents?q=research&limit=5`);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.redirect).toBe("error");
  });

  it("drops fields it does not read, such as the owner's account id of the builder", async () => {
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents`]: fixture("agents-search.live.json") });
    const [agent] = await new MarketClient({ fetch }).searchAgents({ q: "research" });
    expect(Object.keys(agent!)).not.toContain("bio_markdown");
    expect(agent!.builder).toEqual({ display_name: expect.any(String), verification: { level: "none" } });
  });

  it("reads a real agent card and checks that its endpoint is on the agent's own host", async () => {
    const card = fixture("agent-card.live.json");
    const { fetch, calls } = fakeFetch({ "GET https://example-research.market.near.ai/.well-known/agent-card.json": card });
    const parsed = await new MarketClient({ fetch, token: TOKEN }).getAgentCard("example-research");
    expect(parsed.name).toBe("Example Research Agent");
    expect(parsed.supportedInterfaces[0]!.url).toBe("https://example-research.market.near.ai/a2a/v1");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("refuses a card whose endpoint points somewhere else", async () => {
    const card = structuredClone(fixture("agent-card.live.json"));
    (card.body as { supportedInterfaces: Array<{ url: string }> }).supportedInterfaces[0]!.url = "https://evil.example/a2a/v1";
    const { fetch } = fakeFetch({ "GET https://example-research.market.near.ai/.well-known/agent-card.json": card });
    expect((await failure(new MarketClient({ fetch }).getAgentCard("example-research"))).code).toBe("CARD_MISMATCH");
  });

  it("says what to do about an unknown handle", async () => {
    const { fetch } = fakeFetch({ "GET https://no-such-agent-zzz9.market.near.ai/.well-known/agent-card.json": fixture("agent-card-404.live.json") });
    const err = await failure(new MarketClient({ fetch }).getAgentCard("no-such-agent-zzz9"));
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404, marketCode: "not_found" });
    expect(err.nextStep).toMatch(/market search/);
  });

  it("reads real pricing plans and the real x402 recipients", async () => {
    const { fetch } = fakeFetch({
      [`GET ${MARKET}/v1/agents/${RESEARCH_AGENT}/pricing-plans`]: fixture("pricing-plans.live.json"),
      [`GET ${MARKET}/.well-known/x402`]: fixture("x402-recipients.live.json"),
    });
    const client = new MarketClient({ fetch });
    expect(await client.pricingPlans(RESEARCH_AGENT)).toMatchObject([{ model: "per_call", price_amount: "0.2500", is_default: true, listing_status: "live" }]);
    expect((await client.x402Recipients()).recipients).toEqual([
      { network: "near:mainnet", asset: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", payTo: "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc" },
    ]);
  });

  it("validates handles the way the market defines them", () => {
    for (const ok of ["abc", "example-research", "a1-b2", `a${"b".repeat(29)}`]) expect(isHandle(ok)).toBe(true);
    for (const bad of ["ab", "1abc", "Abc", "abc-", "ab--cd", "a.b.c", "abc/def", `a${"b".repeat(30)}`, "evil.example/x", ""]) expect(isHandle(bad)).toBe(false);
    expect(() => new MarketClient().agentOrigin("evil.example/x")).toThrow(MarketError);
  });
});

describe("the agent token", () => {
  it("is sent to the market origin only, and only on authenticated calls", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${MARKET}/v1/agents/me/assignments`]: fixture("assignments.synthetic.json"),
      [`POST ${MARKET}/v1/assignments/${ASSIGNMENT}/start`]: { body: { startedAt: "2026-11-10T12:00:05Z" } },
    });
    const client = new MarketClient({ fetch, token: TOKEN });
    await client.myAssignments();
    await client.startAssignment(ASSIGNMENT);
    expect(calls.map((c) => c.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
  });

  it("never appears in an error, a string, JSON or an inspection", async () => {
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents/me/assignments`]: { status: 400, body: { error: "validation_error", message: `bad bearer ${TOKEN} given as Bearer ${TOKEN}` } } });
    const client = new MarketClient({ fetch, token: TOKEN });
    const err = await failure(client.myAssignments());
    for (const text of [err.message, String(err), inspect(err), inspect(client, { depth: 5, showHidden: true }), JSON.stringify(client)]) expect(text).not.toContain(TOKEN);
    expect(err.message).toContain("[redacted]");
    const secret = new Secret(TOKEN);
    expect([String(secret), `${secret}`, JSON.stringify({ secret }), inspect(secret), inspect({ nested: { secret } })].join(" ")).not.toContain(TOKEN);
    expect(redact(`Authorization: Bearer ${TOKEN}`)).toBe("Authorization: Bearer [redacted]");
  });

  it("is required for the worker loop, with the next step spelled out", async () => {
    const err = await failure(new MarketClient({ fetch: fakeFetch({}).fetch }).myAssignments());
    expect(err.code).toBe("TOKEN_REQUIRED");
    expect(err.nextStep).toMatch(/AGENT_MARKET_TOKEN/);
  });

  it("is refused when it does not look like an agent token", () => {
    expect(() => new MarketClient({ token: "sk-not-an-agent-token" })).toThrow(/aat_/);
  });

  it("wraps the token a registration returns, and the adoption link", async () => {
    const { fetch, calls } = fakeFetch({
      [`POST ${MARKET}/v1/agents/register`]: fixture("registration.synthetic.json"),
      [`POST ${MARKET}/v1/agents/me/adoption-code`]: { status: 201, body: { code: "adopt-123", adoptionUrl: "https://market.near.ai/adopt/adopt-123", expiresAt: "2026-11-10T13:00:00Z" } },
    });
    const r = await new MarketClient({ fetch }).registerAgent({ handle: "payminto-brief", name: "Payminto Brief", category: "research", slaSeconds: 3600 });
    expect(r.apiToken).toBeInstanceOf(Secret);
    expect(JSON.stringify(r)).not.toContain("feedface");
    expect(r.apiToken.reveal()).toBe("aat_feedfacefeedfacefeedfacefeedface");
    expect(calls[0]!.body).toEqual({ handle: "payminto-brief", name: "Payminto Brief", category: "research", sla_seconds: 3600 });
    const code = await new MarketClient({ fetch, token: r.apiToken }).createAdoptionCode();
    expect(JSON.stringify(code)).not.toContain("adopt-123");
    expect(code.adoptionUrl.reveal()).toBe("https://market.near.ai/adopt/adopt-123");
  });
});

describe("listing and the worker loop", () => {
  const AGENT = "7a3e9f10-52c4-4d6b-b8a1-4e0f2c9d6b57";

  it("sends the documented bodies for a pricing plan and a listing status", async () => {
    const plan = (fixture("pricing-plans.live.json").body as unknown[])[0];
    const { fetch, calls } = fakeFetch({
      [`POST ${MARKET}/v1/agents/${AGENT}/pricing-plans`]: { status: 201, body: plan },
      [`PATCH ${MARKET}/v1/agents/${AGENT}`]: { body: { agent_id: AGENT, handle: "payminto-brief", name: "Payminto Brief", listing_status: "live", webhook_url: "https://secret.example/hook", webhook_enabled: true } },
    });
    const client = new MarketClient({ fetch, token: TOKEN });
    await client.createPricingPlan(AGENT, { priceAmount: "0.25", slaSeconds: 3600 });
    const listing = await client.setListingStatus(AGENT, "live");
    expect(calls[0]!.body).toEqual({ model: "per_call", price_amount: "0.25", sla_seconds: 3600 });
    expect(calls[1]!.body).toEqual({ listing_status: "live" });
    expect(listing).toEqual({ agent_id: AGENT, handle: "payminto-brief", name: "Payminto Brief", listing_status: "live" });
  });

  it("refuses bad arguments before anything is sent", async () => {
    const { fetch, calls } = fakeFetch({});
    const client = new MarketClient({ fetch, token: TOKEN });
    for (const attempt of [
      () => client.registerAgent({ handle: "Bad Handle", name: "x", category: "research" }),
      () => client.registerAgent({ handle: "fine-handle", name: "x", category: "nonsense" as never }),
      () => client.createPricingPlan(AGENT, { priceAmount: "free" }),
      () => client.setListingStatus(AGENT, "deleted" as never),
      () => client.startAssignment("../../v1/agents/register"),
      () => client.submitDeliverable(ASSIGNMENT, ""),
      () => client.submitDeliverable(ASSIGNMENT, "x".repeat(256 * 1024 + 1)),
      () => client.searchAgents({ limit: 500 }),
    ]) {
      expect((await failure(attempt)).code).toBe("INVALID_ARGUMENT");
    }
    expect(calls).toEqual([]);
  });

  it("keeps the good rows of an assignment list, skips the malformed one and drops unknown fields", async () => {
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents/me/assignments`]: fixture("assignments.synthetic.json") });
    const { rows, skipped } = await new MarketClient({ fetch, token: TOKEN }).myAssignments();
    expect(skipped).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignment).toMatchObject({ assignmentId: ASSIGNMENT, status: "in_progress", escrowAmount: "0.250000000000", escrowToken: "USDC" });
    expect(Object.keys(rows[0]!)).toEqual(["assignment", "job", "latestMessage"]);
  });

  it("cuts oversized text from another party and says so", async () => {
    const list = structuredClone(fixture("assignments.synthetic.json"));
    const row = (list.body as { assignments: Array<{ job: { title: string; description: string }; latestMessage: unknown }> }).assignments[0]!;
    row.job.title = "T".repeat(5_000);
    row.job.description = "D".repeat(MAX_JOB_TEXT_CHARS + 10);
    row.latestMessage = { senderSide: "buyer", origin: "direct", body: "M".repeat(20_000), truncated: false, attachments: [], createdAt: "2026-11-10T12:30:00Z" };
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents/me/assignments`]: list });
    const { rows } = await new MarketClient({ fetch, token: TOKEN }).myAssignments();
    expect(rows[0]!.job.title).toHaveLength(300);
    expect(rows[0]!.job.description).toHaveLength(MAX_JOB_TEXT_CHARS);
    expect(rows[0]!.job.descriptionTruncated).toBe(true);
    expect(rows[0]!.latestMessage).toMatchObject({ truncated: true });
    expect(rows[0]!.latestMessage!.body).toHaveLength(8_000);
  });
});

describe("failures", () => {
  it("turns a 429 into a typed error with the wait and the next step", async () => {
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents`]: { status: 429, text: "Too Many Requests", headers: { "retry-after": "17" } } });
    const err = await failure(new MarketClient({ fetch }).searchAgents({ q: "x" }));
    expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 17, retryable: true });
    expect(err.nextStep).toMatch(/Wait 17 seconds/);
  });

  it("times out, and tells a timeout from a caller's abort", async () => {
    const hang: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("aborted by signal"))));
    const client = new MarketClient({ fetch: hang as never, timeoutMs: 20 });
    expect((await failure(client.searchAgents({ q: "x" }))).code).toBe("TIMEOUT");
    const stop = new AbortController();
    const pending = failure(new MarketClient({ fetch: hang as never, timeoutMs: 5_000 }).searchAgents({ q: "x" }, stop.signal));
    setTimeout(() => stop.abort(), 20);
    expect((await pending).code).toBe("ABORTED");
    // A signal that fired before the call sends nothing at all.
    const { fetch, calls } = fakeFetch({});
    expect((await failure(new MarketClient({ fetch }).searchAgents({ q: "x" }, stop.signal))).code).toBe("ABORTED");
    expect(calls).toEqual([]);
  });

  it("stops reading a response that is too large", async () => {
    const { fetch } = fakeFetch({ "GET https://example-research.market.near.ai/.well-known/agent-card.json": { text: JSON.stringify({ name: "x".repeat(200_000) }) } });
    expect((await failure(new MarketClient({ fetch }).getAgentCard("example-research"))).code).toBe("RESPONSE_TOO_LARGE");
  });

  it("reports a body that is not JSON, or not the documented shape, without echoing it", async () => {
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents`]: { text: "<html>secret-looking-page</html>" }, [`GET ${MARKET}/.well-known/x402`]: { body: { recipients: "nope" } } });
    const client = new MarketClient({ fetch });
    const notJson = await failure(client.searchAgents({ q: "x" }));
    expect(notJson.code).toBe("MALFORMED_RESPONSE");
    expect(notJson.message).not.toContain("secret-looking-page");
    expect((await failure(client.x402Recipients())).code).toBe("MALFORMED_RESPONSE");
  });

  it("maps server errors as retryable and client errors as not", async () => {
    const { fetch } = fakeFetch({
      [`GET ${MARKET}/v1/agents`]: { status: 503, text: "down" },
      [`POST ${MARKET}/v1/assignments/${ASSIGNMENT}/submit`]: { status: 400, body: { error: "invalid_state_transition", message: "cannot transition from 'accepted' to 'submitted'" } },
    });
    const client = new MarketClient({ fetch, token: TOKEN });
    expect(await failure(client.searchAgents({ q: "x" }))).toMatchObject({ code: "SERVER", retryable: true });
    expect(await failure(client.submitDeliverable(ASSIGNMENT, "# done"))).toMatchObject({ code: "REJECTED", retryable: false, marketCode: "invalid_state_transition" });
  });

  it("requests https only", () => {
    expect(() => new MarketClient({ origin: "http://market.near.ai" })).toThrow(/https/);
    expect(() => new MarketClient({ origin: "https://user:pw@market.near.ai" })).toThrow(/credentials/);
    expect(() => new MarketClient({ origin: "https://market.near.ai/v1" })).toThrow(/path/);
  });
});

describe("rate limit awareness", () => {
  it("waits instead of sending more than the limit in one minute", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, clock);
    for (let i = 0; i < 3; i++) await limiter.take();
    expect(clock.slept).toEqual([]);
    await limiter.take();
    expect(clock.slept).toEqual([60_001]);
  });

  it("never allows more than the market's own limit", () => {
    expect(() => new RateLimiter(61)).toThrow(/1 to 60/);
  });

  it("shares one limiter across everything a client sends", async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch({ [`GET ${MARKET}/v1/agents`]: { body: { agents: [] } }, [`GET ${MARKET}/.well-known/x402`]: fixture("x402-recipients.live.json") });
    const client = new MarketClient({ fetch, clock, requestsPerMinute: 2 });
    await client.searchAgents({ q: "a" });
    await client.x402Recipients();
    await client.searchAgents({ q: "b" });
    expect(clock.slept).toHaveLength(1);
  });
});

/**
 * The contract with the market's own OpenAPI document. For every answer this package reads: each field it reads exists
 * in the documented schema, and each field it requires is one the market promises. For every body it sends: the
 * fields are documented and the required ones are present. A change on the market's side shows up here first.
 */
describe("the OpenAPI document's shapes", () => {
  type Shape = { required?: string[]; properties: Record<string, unknown>; enum?: string[] };
  const doc = fixture("openapi-shapes.live.json") as unknown as { schemas: Record<string, Shape> };
  const requiredKeys = (schema: z.ZodObject) => Object.entries(schema.shape).flatMap(([k, v]) => ((v as z.ZodType).safeParse(undefined).success ? [] : [k]));

  it.each([
    ["AgentPublic", agentSchema],
    ["PricingPlan", pricingPlanSchema],
    ["RegisterResponse", registrationSchema],
    ["AdoptionCodeResponse", adoptionCodeSchema],
    ["JobAssignment", assignmentSchema],
    ["WorkerJobBrief", jobBriefFields],
    ["LatestMessageBrief", latestMessageFields],
    ["AttachmentBrief", attachmentSchema],
    ["StartAssignmentResponse", startedSchema],
  ] as Array<[string, z.ZodObject]>)("%s covers what this package reads", (name, schema) => {
    const documented = doc.schemas[name]!;
    for (const key of Object.keys(schema.shape)) expect(Object.keys(documented.properties), `${name}.${key} is documented`).toContain(key);
    for (const key of requiredKeys(schema)) expect(documented.required ?? [], `${name}.${key} is promised`).toContain(key);
  });

  it("has the categories and listing statuses this package sends", () => {
    expect(doc.schemas.Category!.enum).toEqual([...CATEGORIES]);
    expect(doc.schemas.ListingStatus!.enum).toEqual([...LISTING_STATUSES]);
    expect(doc.schemas.PricingModel!.enum).toContain("per_call");
    expect(doc.schemas.WorkerCancelReason!.enum).toEqual(["rejected", "failed"]);
  });

  it("documents every field of the bodies this package sends", async () => {
    const AGENT = "7a3e9f10-52c4-4d6b-b8a1-4e0f2c9d6b57";
    const plan = (fixture("pricing-plans.live.json").body as unknown[])[0];
    const assignment = (fixture("assignments.synthetic.json").body as { assignments: Array<{ assignment: unknown }> }).assignments[0]!.assignment;
    const { fetch, calls } = fakeFetch({
      [`POST ${MARKET}/v1/agents/register`]: fixture("registration.synthetic.json"),
      [`POST ${MARKET}/v1/agents/${AGENT}/pricing-plans`]: { status: 201, body: plan },
      [`PATCH ${MARKET}/v1/agents/${AGENT}`]: { body: { agent_id: AGENT, handle: "payminto-brief", name: "x", listing_status: "live" } },
      [`POST ${MARKET}/v1/assignments/${ASSIGNMENT}/submit`]: { body: assignment },
      [`POST ${MARKET}/v1/assignments/${ASSIGNMENT}/decline`]: { body: assignment },
    });
    const client = new MarketClient({ fetch, token: TOKEN });
    await client.registerAgent({ handle: "payminto-brief", name: "Payminto Brief", category: "research", email: "owner@example.com", slaSeconds: 60 });
    await client.createPricingPlan(AGENT, { priceAmount: "1.00", slaSeconds: 60, displayName: "Brief", description: "One brief" });
    await client.setListingStatus(AGENT, "live");
    await client.submitDeliverable(ASSIGNMENT, "# done");
    await client.declineAssignment(ASSIGNMENT, "failed", "could not finish");
    const bodies = ["RegisterRequest", "CreatePricingPlanRequest", "PatchAgentRequest", "SubmitRequest", "DeclineAssignmentRequest"];
    calls.forEach((call, i) => {
      const documented = doc.schemas[bodies[i]!]!;
      const sent = Object.keys(call.body as object);
      for (const key of sent) expect(Object.keys(documented.properties), `${bodies[i]}.${key}`).toContain(key);
      for (const key of documented.required ?? []) expect(sent, `${bodies[i]} requires ${key}`).toContain(key);
    });
  });
});
