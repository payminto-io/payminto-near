import { describe, expect, it } from "vitest";
import { z } from "zod";
import { refusalSchema } from "@payminto/protocol";
import { MarketClient, QUOTE_MARKET_AGENT, quoteMarketAgentTool, usdcPolicy, type QuoteToolResult } from "../src/index.ts";
import { fakeFetch, fixture } from "./helpers.ts";

const ENDPOINT = "https://example-research.market.near.ai/a2a/v1";
const TREASURY = "ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc";
const market = () => fakeFetch({ [`POST ${ENDPOINT}`]: fixture("quote-402.live.json"), "POST https://example-analyst.market.near.ai/a2a/v1": fixture("quote-unavailable.live.json") });
const result = (r: { structuredContent?: Record<string, unknown> }) => r.structuredContent!.result as QuoteToolResult;

describe("the quote_market_agent MCP tool", () => {
  it("has the three things registerTool takes", () => {
    const tool = quoteMarketAgentTool({ client: new MarketClient({ fetch: market().fetch }), policy: usdcPolicy({ maxPerHire: "1000000", maxPerDay: "5000000" }) });
    expect(tool.name).toBe(QUOTE_MARKET_AGENT);
    expect(tool.name).toBe("quote_market_agent");
    expect(tool.config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool.config.description).toMatch(/cannot pay/);
    const input = z.object(tool.config.inputSchema);
    expect(input.safeParse({ handle: "example-research" }).success).toBe(true);
    expect(input.safeParse({ handle: "example-research", task: "Brief\nOn NEAR.", max_usdc: "0.10" }).success).toBe(true);
    for (const bad of [{}, { handle: "Bad Handle" }, { handle: "ok-handle", max_usdc: "-1" }, { handle: "ok-handle", max_usdc: "1e3" }, { handle: "ok-handle", task: "" }]) expect(input.safeParse(bad).success).toBe(false);
    expect(typeof tool.handler).toBe("function");
  });

  it("answers allow with the price, and says that nothing was paid", async () => {
    const { fetch, calls } = market();
    const tool = quoteMarketAgentTool({ client: new MarketClient({ fetch }), policy: usdcPolicy({ maxPerHire: "1000000", maxPerDay: "5000000" }) });
    const r = await tool.handler({ handle: "example-research" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toMatch(/^ALLOW: example-research quotes 0\.25 USDC, within the per-hire maximum of 1\.00 USDC\./);
    expect(result(r)).toMatchObject({
      handle: "example-research",
      decision: "allow",
      price: { atomic: "250000", display: "0.25 USDC", network: "near:mainnet", payTo: TREASURY, validForSeconds: 4200 },
      maxPerHire: { atomic: "1000000", display: "1.00 USDC" },
      refusal: null,
    });
    expect(result(r).note).toMatch(/Nothing was signed or paid/);
    expect(calls).toHaveLength(1);
  });

  it("answers refuse with the machine-readable reason", async () => {
    const tool = quoteMarketAgentTool({ client: new MarketClient({ fetch: market().fetch }), policy: usdcPolicy({ maxPerHire: "100000", maxPerDay: "5000000" }) });
    const r = await tool.handler({ handle: "example-research" });
    expect(r.content[0]!.text).toMatch(/^REFUSE by rule PER_HIRE_MAX: /);
    expect(r.content[0]!.text).toMatch(/Refused before signing, so nothing was paid\. This is the owner's policy; do not route around it\./);
    const { refusal } = result(r);
    expect(refusal).toMatchObject({ rule: "PER_HIRE_MAX", attemptedAmount: "250000", limit: "100000", remainingBudget: "5000000", retry: { kind: "never" }, enforcedBy: "agent" });
    expect(refusalSchema.safeParse(refusal).success).toBe(true);
  });

  it("lets the calling model tighten the maximum for one check, and never raise it", async () => {
    const tool = quoteMarketAgentTool({ client: new MarketClient({ fetch: market().fetch }), policy: usdcPolicy({ maxPerHire: "200000", maxPerDay: "5000000" }) });
    const raised = await tool.handler({ handle: "example-research", max_usdc: "999" });
    expect(result(raised)).toMatchObject({ decision: "refuse", maxPerHire: { atomic: "200000" } });
    const owner = quoteMarketAgentTool({ client: new MarketClient({ fetch: market().fetch }), policy: usdcPolicy({ maxPerHire: "1000000", maxPerDay: "5000000" }) });
    expect(result(await owner.handler({ handle: "example-research", max_usdc: "0.10" }))).toMatchObject({ decision: "refuse", maxPerHire: { atomic: "100000" } });
    expect(result(await owner.handler({ handle: "example-research", max_usdc: "0.25" })).decision).toBe("allow");
  });

  it("asks the payee check about the account the quote pays, and counts earlier hires", async () => {
    const asked: unknown[] = [];
    const tool = quoteMarketAgentTool({
      client: new MarketClient({ fetch: market().fetch }),
      policy: () => usdcPolicy({ maxPerHire: "1000000", maxPerDay: "400000" }),
      payeeVerdict: (payee) => {
        asked.push(payee);
        return { verdict: "block", payee: payee.account, reason: "on a deny list" };
      },
      recentHires: () => [{ amount: "300000", at: 1_794_299_000 }],
      now: () => 1_794_300_000,
    });
    const r = result(await tool.handler({ handle: "example-research" }));
    expect(asked).toEqual([{ account: TREASURY, network: "near:mainnet", asset: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" }]);
    expect(r.refusal).toMatchObject({ rule: "PAYEE_BLOCKED", remainingBudget: "100000" });
  });

  it("returns an error a model can act on when there is no quote", async () => {
    const tool = quoteMarketAgentTool({ client: new MarketClient({ fetch: market().fetch }), policy: usdcPolicy({ maxPerHire: "1000000", maxPerDay: "5000000" }) });
    const down = await tool.handler({ handle: "example-analyst" });
    expect(down.isError).toBe(true);
    expect(down.content[0]!.text).toMatch(/^No quote \(AGENT_UNAVAILABLE\): .*Nothing was signed or paid\.$/s);
    expect(down.structuredContent).toMatchObject({ error: { code: "AGENT_UNAVAILABLE", nextStep: expect.stringMatching(/pick another agent/) } });
    const bad = await tool.handler({ handle: "Not A Handle" });
    expect(bad).toMatchObject({ isError: true, structuredContent: { error: { code: "INVALID_ARGUMENT" } } });
  });
});
