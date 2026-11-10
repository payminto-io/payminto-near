import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT, USAGE, runCli, type CliDeps } from "../src/cli.ts";
import { MARKET, TOKEN, fakeFetch, fixture } from "./helpers.ts";

const RESEARCH_AGENT = "https://example-research.market.near.ai";
const ASSIGNMENT = "5b1f6c1e-7d0a-4a51-9a3e-2f6b8c0d4e11";
const ECHO = fileURLToPath(new URL("./fixtures/echo-fulfil.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "payminto-market-cli-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const liveRoutes = () => ({
  [`GET ${MARKET}/v1/agents`]: fixture("agents-search.live.json"),
  [`GET ${RESEARCH_AGENT}/.well-known/agent-card.json`]: fixture("agent-card.live.json"),
  [`POST ${RESEARCH_AGENT}/a2a/v1`]: fixture("quote-402.live.json"),
  [`GET ${MARKET}/.well-known/x402`]: fixture("x402-recipients.live.json"),
});

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = liveRoutes(), deps: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const { fetch, calls } = fakeFetch(routes);
  const code = await runCli(argv, { fetch, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, ...deps });
  const all = [...out, ...err].join("\n");
  // An expected failure is two plain lines, never a stack trace, and never a credential.
  expect(all).not.toMatch(/^\s+at .+\(.+:\d+:\d+\)$/m);
  expect(all).not.toContain(TOKEN);
  return { code, out: out.join("\n"), err: err.join("\n"), calls };
}

describe("market search", () => {
  it("lists real agents and says what to do next", async () => {
    const r = await run(["search", "research", "--limit", "5"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain('2 agents for "research" on https://market.near.ai');
    expect(r.out).toMatch(/^example-research\s+research\s+yes\s+1\s+Example Research Agent$/m);
    expect(r.out).toMatch(/Next: market quote example-data$/);
    expect(r.calls[0]!.url).toBe(`${MARKET}/v1/agents?q=research&limit=5`);
  });

  it("prints JSON when asked, and helps when nothing matches", async () => {
    const json = await run(["search", "research", "--json"]);
    expect((JSON.parse(json.out) as { agents: unknown[] }).agents).toHaveLength(2);
    const none = await run(["search", "zzzz"], { [`GET ${MARKET}/v1/agents`]: { body: { agents: [] } } });
    expect(none.code).toBe(EXIT.ok);
    expect(none.out).toMatch(/No live agent matches "zzzz"\.\nNext: try a broader word/);
  });

  it("removes terminal control characters from a builder's text", async () => {
    const list = structuredClone(fixture("agents-search.live.json"));
    (list.body as { agents: Array<{ name: string }> }).agents[0]!.name = `Nice${String.fromCharCode(27)}[2J${String.fromCharCode(7)} Agent`;
    const r = await run(["search", "research"], { [`GET ${MARKET}/v1/agents`]: list });
    expect(r.out).not.toContain(String.fromCharCode(27));
    expect(r.out).toContain("Nice [2J Agent");
  });
});

describe("market quote", () => {
  it("prints ALLOW for a real quote under the maximum", async () => {
    const r = await run(["quote", "example-research", "--max", "1.00"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Agent      Example Research Agent (example-research)");
    expect(r.out).toContain("Quote      0.25 USDC per call, on near:mainnet");
    expect(r.out).toContain("that is the market's own treasury account, as its /.well-known/x402 lists it, not the agent");
    expect(r.out).toContain("Policy     at most 1.00 USDC per hire and 5.00 USDC per 24 hours");
    expect(r.out).toContain("Decision   ALLOW");
    expect(r.out).toMatch(/Nothing was signed or paid\. A hire on the Agent Market is paid through the market itself\.$/);
    expect(r.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(r.calls.every((c) => c.headers.authorization === undefined && c.headers["x-payment"] === undefined)).toBe(true);
  });

  it("warns when the quote pays an account the market does not list, and says so when it cannot compare", async () => {
    const elsewhere = structuredClone(fixture("x402-recipients.live.json"));
    (elsewhere.body as { recipients: Array<{ payTo: string }> }).recipients[0]!.payTo = "someone-else.near";
    const warned = await run(["quote", "example-research"], { ...liveRoutes(), [`GET ${MARKET}/.well-known/x402`]: elsewhere });
    expect(warned.out).toContain("WARNING: that is not a treasury account the market lists at /.well-known/x402");
    const unread = await run(["quote", "example-research", "--json"], { ...liveRoutes(), [`GET ${MARKET}/.well-known/x402`]: { status: 503, text: "down" } });
    expect((JSON.parse(unread.out) as { payeeListedByMarket: unknown }).payeeListedByMarket).toBeNull();
    const plain = await run(["quote", "example-research"], { ...liveRoutes(), [`GET ${MARKET}/.well-known/x402`]: { status: 503, text: "down" } });
    expect(plain.code).toBe(EXIT.ok);
    expect(plain.out).toContain("could not be read, so this account was not compared with it");
  });

  it("prints REFUSE with the rule and the reason for a maximum below the quote, and exits 3", async () => {
    const r = await run(["quote", "example-research", "--max", "0.10"]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.out).toContain("Decision   REFUSE by rule PER_HIRE_MAX");
    expect(r.out).toContain("The quoted price exceeds the per-hire maximum.");
    expect(r.out).toContain("attempted 0.25 USDC, limit 0.10 USDC, left for today 5.00 USDC");
    expect(r.out).toContain("retry: do not retry: waiting will not change this");
    expect(r.out).toContain("Refused before signing, so this cost nothing.");
  });

  it("prints the decision as JSON with --json", async () => {
    const r = await run(["quote", "example-research", "--max=0.10", "--daily=2", "--json", "--message", "Brief\nOn NEAR."]);
    expect(r.code).toBe(EXIT.refused);
    const json = JSON.parse(r.out) as { decision: string; refusal: { rule: string }; maxPerDay: { atomic: string }; agent: { name: string } };
    expect(json).toMatchObject({ decision: "refuse", refusal: { rule: "PER_HIRE_MAX" }, maxPerDay: { atomic: "2000000" }, agent: { name: "Example Research Agent" } });
    expect((r.calls[1]!.body as { params: { message: { parts: Array<{ text: string }> } } }).params.message.parts[0]!.text).toBe("Brief\nOn NEAR.");
  });

  it("reads its default maximums from the environment", async () => {
    const r = await run(["quote", "example-research"], liveRoutes(), { env: { PAYMINTO_MARKET_MAX_PER_HIRE_USDC: "0.20" } });
    expect(r.code).toBe(EXIT.refused);
    expect(r.out).toContain("at most 0.20 USDC per hire");
  });

  it("keeps the default daily maximum at least as large as the per-hire maximum", async () => {
    expect((await run(["quote", "example-research", "--max", "25"])).out).toContain("at most 25.00 USDC per hire and 25.00 USDC per 24 hours");
    expect((await run(["quote", "example-research", "--max", "25", "--daily", "3"])).out).toContain("at most 25.00 USDC per hire and 3.00 USDC per 24 hours");
  });

  it("tells the user what to do about an unknown handle", async () => {
    const r = await run(["quote", "no-such-agent-zzz9"], { "GET https://no-such-agent-zzz9.market.near.ai/.well-known/agent-card.json": fixture("agent-card-404.live.json") });
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/^market: .*HTTP 404 not_found.*\(NOT_FOUND\)\nNext: No published agent has the handle no-such-agent-zzz9\. Run `market search <query>` to find live agents\.$/);
  });

  it("tells the user what to do about an agent that is listed but not live", async () => {
    const card = structuredClone(fixture("agent-card.live.json"));
    (card.body as { supportedInterfaces: Array<{ url: string }> }).supportedInterfaces[0]!.url = "https://example-analyst.market.near.ai/a2a/v1";
    const r = await run(["quote", "example-analyst"], {
      "GET https://example-analyst.market.near.ai/.well-known/agent-card.json": card,
      "POST https://example-analyst.market.near.ai/a2a/v1": fixture("quote-unavailable.live.json"),
    });
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toBe(
      "market: example-analyst has no reachable backend right now (AGENT_UNAVAILABLE)\nNext: The agent example-analyst is listed but not answering. Try again in a few minutes, or pick another agent with `market search <query>`.",
    );
  });

  it("tells the user how long to wait when rate limited", async () => {
    const r = await run(["quote", "example-research"], { [`GET ${RESEARCH_AGENT}/.well-known/agent-card.json`]: { status: 429, text: "Too Many Requests", headers: { "retry-after": "42" } } });
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/\(RATE_LIMITED\)\nNext: The market allows 60 requests per minute per IP\. Wait 42 seconds, then try again\.$/);
  });

  it("says so plainly when the market answers in a shape it does not know", async () => {
    const odd = structuredClone(fixture("quote-402.live.json"));
    (odd.body as { accepts: Array<Record<string, unknown>> }).accepts[0]!.amount = 0.25;
    const r = await run(["quote", "example-research"], { ...liveRoutes(), [`POST ${RESEARCH_AGENT}/a2a/v1`]: odd });
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/does not have the documented shape: amount: .*\(MALFORMED_RESPONSE\)\nNext: The market answered in a shape this version does not know\. Nothing was done\./);
  });

  it("says so plainly when the market cannot be reached", async () => {
    const r = await run(["quote", "example-research"], {
      [`GET ${RESEARCH_AGENT}/.well-known/agent-card.json`]: () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(r.code).toBe(EXIT.error);
    expect(r.err).toMatch(/\(NETWORK\)\nNext: The market could not be reached\. Check the network connection, then try again\.$/);
  });

  it("refuses bad arguments with the fix, before any request", async () => {
    for (const argv of [["quote"], ["quote", "a", "b"], ["quote", "example-research", "--max", "lots"], ["quote", "example-research", "--max"], ["quote", "example-research", "--speed", "9"], ["quote", "Bad Handle"], ["search"], ["search", "x", "--category", "nope"], ["dance"]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(EXIT.usage);
      expect(r.err, argv.join(" ")).toMatch(/^market: .+\nNext: .+/);
      expect(r.calls).toEqual([]);
    }
  });
});

describe("market work", () => {
  it("without a token explains what a person must do, and exits 4", async () => {
    const r = await run(["work"]);
    expect(r.code).toBe(EXIT.needsPerson);
    expect(r.err).toContain("market work needs AGENT_MARKET_TOKEN");
    expect(r.err).toContain("1. Create an account at https://market.near.ai and confirm its email address.");
    expect(r.err).toContain("4. Under Agent API tokens click Create token and copy the aat_ value. It is shown once.");
    expect(r.err).toContain("To see the whole seller flow now, with no account: market work --dry-run");
    expect(r.calls).toEqual([]);
  });

  it("--dry-run shows the whole seller flow with no account and no request", async () => {
    const r = await run(["work", "--dry-run"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("DRY RUN: nothing is sent to the market, and no account or token is used.");
    expect(r.out).toContain("Spend ceiling per job, set by you: 0.50 USDC. Job text cannot change it.");
    expect(r.out).toContain(`  start ${ASSIGNMENT}`);
    expect(r.out).toMatch(new RegExp(`  submit ${ASSIGNMENT} \\(\\d+ bytes of Markdown\\)`));
    expect(r.out).toContain("## Verifiable costs");
    expect(r.out).toContain("DRY RUN: the receipts below are samples.");
    expect(r.out).toMatch(/pnpm verify:near --rpc-url https:\/\/rpc\.testnet\.near\.org --hub hub\.payminto\.testnet --receipt receipts\/[0-9a-f]{16}\.json/);
    expect(r.out).toContain("Payminto did not settle, hold or route that payment.");
  });

  it("--dry-run takes a ceiling, a fulfil module and rows recorded from a real account", async () => {
    const small = await run(["work", "--dry-run", "--ceiling", "0.015"]);
    expect(small.out).toContain("Inputs bought: 1 of 2.");
    const file = join(scratch, "assignments.json");
    writeFileSync(file, JSON.stringify(fixture("assignments.synthetic.json").body));
    const r = await run(["work", "--dry-run", "--fulfil", ECHO, "--assignment", file, "--ceiling", "0.20"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("# Echo\n\nRound fresh, ceiling 200000, 2 tags.");
    expect(r.out).toContain("The agent bought no paid inputs for this job, out of the 0.20 USDC it was allowed to spend on them.");
  });

  it("--dry-run explains itself when there is nothing to work on", async () => {
    const file = join(scratch, "empty.json");
    writeFileSync(file, JSON.stringify({ assignments: [{ nonsense: true }] }));
    const r = await run(["work", "--dry-run", "--assignment", file]);
    expect(r.code).toBe(EXIT.error);
    expect(r.out).toMatch(/No deliverable was produced\.\nNext: check that the recorded rows have the shape of GET \/v1\/agents\/me\/assignments/);
    const missing = await run(["work", "--dry-run", "--assignment", join(scratch, "nope.json")]);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toMatch(/^market: cannot read .*nope\.json as JSON/);
  });

  it("with a token works the market once: start, fulfil, submit", async () => {
    const list = fixture("assignments.synthetic.json");
    const routes = {
      [`GET ${MARKET}/v1/agents/me/assignments`]: list,
      [`POST ${MARKET}/v1/assignments/${ASSIGNMENT}/start`]: { body: { startedAt: "2026-11-10T12:00:05Z" } },
      [`POST ${MARKET}/v1/assignments/${ASSIGNMENT}/submit`]: { body: (list.body as { assignments: Array<{ assignment: unknown }> }).assignments[0]!.assignment },
    };
    const r = await run(["work", "--fulfil", ECHO, "--ceiling", "0.20", "--once"], routes, { env: { AGENT_MARKET_TOKEN: TOKEN } });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toContain("Working the market as your agent. Spend ceiling per job: 0.20 USDC.");
    expect(r.out).toContain("poll: 1 assignment(s) in progress, 1 row(s) skipped as malformed");
    expect(r.out).toMatch(new RegExp(`submitted: ${ASSIGNMENT}, \\d+ bytes, 0 receipt\\(s\\)`));
    expect(r.out).toContain("Done: 1 submitted, 0 declined, 0 failed, 1 poll(s).");
    expect(r.calls.map((c) => c.method)).toEqual(["GET", "POST", "POST"]);
    expect((r.calls[2]!.body as { deliverableMarkdown: string }).deliverableMarkdown).toContain("## Verifiable costs");
  });

  it("with a token still needs the fulfil module and the ceiling, and says so", async () => {
    const env = { AGENT_MARKET_TOKEN: TOKEN };
    const noFulfil = await run(["work"], {}, { env });
    expect(noFulfil.code).toBe(EXIT.usage);
    expect(noFulfil.err).toMatch(/work needs --fulfil <module>/);
    const noCeiling = await run(["work", "--fulfil", ECHO], {}, { env });
    expect(noCeiling.code).toBe(EXIT.usage);
    expect(noCeiling.err).toMatch(/work needs --ceiling <usdc>/);
    const notAModule = await run(["work", "--fulfil", join(scratch, "missing.ts"), "--ceiling", "1"], {}, { env });
    expect(notAModule.code).toBe(EXIT.usage);
    expect(notAModule.err).toMatch(/cannot load the fulfil module/);
  });

  it("stops and names the fix when the market rejects the token", async () => {
    const r = await run(["work", "--fulfil", ECHO, "--ceiling", "0", "--once"], { [`GET ${MARKET}/v1/agents/me/assignments`]: { status: 401, body: { error: "unauthorized" } } }, { env: { AGENT_MARKET_TOKEN: TOKEN } });
    expect(r.code).toBe(EXIT.needsPerson);
    expect(r.err).toContain("The market no longer accepts this token.");
    expect(r.err).toContain("Next: ask the agent's owner to create a new token");
  });

  it("refuses a token that is not an agent token without echoing it", async () => {
    const r = await run(["work", "--fulfil", ECHO, "--ceiling", "0", "--once"], {}, { env: { AGENT_MARKET_TOKEN: "sk-live-something-else" } });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).not.toContain("sk-live-something-else");
    expect(r.err).toMatch(/Next: Copy the token again from the agent's Edit page/);
  });
});

describe("market help", () => {
  it("prints the usage, and exits 2 when no command is given", async () => {
    expect((await run(["help"])).out).toBe(USAGE);
    expect((await run(["quote", "--help"])).code).toBe(EXIT.ok);
    expect((await run([])).code).toBe(EXIT.usage);
    expect(USAGE).toContain("market work --dry-run");
  });
});
