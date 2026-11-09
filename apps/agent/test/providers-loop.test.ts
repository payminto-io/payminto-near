/**
 * The same buyer task through runAgent on every provider's mock: the loop is provider-neutral. Each provider is told
 * to list services, then to buy one quote and (in parallel) pay an address planted in content, then to answer. The
 * runtime's guards hold on every provider: one receipt, the planted address refused with NOT_IN_DIRECTORY.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelClient, PROVIDERS, type ConnectionSpec } from "@payminto/models";
import { claudeStream, mockProvider, type MockAnswer, type MockProvider, type SeenRequest } from "@payminto/models/mock-provider";
import { BUYER_SYSTEM } from "../src/prompts.ts";
import { runAgent } from "../src/runtime.ts";
import { fakeWallet, MARKET, ROGUE } from "./fake-wallet.ts";

type Call = { id: string; name: string; args: Record<string, unknown> };
type Script = { tools(calls: Call[]): MockAnswer; text(t: string): MockAnswer; results(r: SeenRequest): string[] };

const BUY: Call[] = [
  { id: "c2", name: "call_paid_service", args: { serviceId: MARKET.id, query: { symbol: "HSK" } } },
  { id: "c3", name: "call_paid_service", args: { url: ROGUE } },
];

const openaiScript = (usage: boolean): Script => ({
  tools: (calls) => ({
    json: {
      model: "gpt-5.1-2025-11-13",
      choices: [{ message: { role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: "tool_calls" }],
      ...(usage ? { usage: { prompt_tokens: 50, completion_tokens: 20 } } : {}),
    },
  }),
  text: (t) => ({ json: { model: "gpt-5.1-2025-11-13", choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], ...(usage ? { usage: { prompt_tokens: 80, completion_tokens: 10 } } : {}) } }),
  results: (r) => {
    const msgs = r.body.messages as Array<{ role: string; content: string }>;
    const lastAssistant = msgs.map((x) => x.role).lastIndexOf("assistant");
    return msgs.slice(lastAssistant + 1).filter((x) => x.role === "tool").map((x) => x.content);
  },
});

const SCRIPTS: Record<ConnectionSpec["provider"], Script> = {
  anthropic: {
    tools: (calls) => ({ sse: claudeStream({ blocks: calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, json: JSON.stringify(c.args) })), stop: "tool_use", usage: { input: 50, output: 20 } }) }),
    text: (t) => ({ sse: claudeStream({ blocks: [{ type: "text", text: t }], stop: "end_turn", usage: { input: 80, output: 10 } }) }),
    results: (r) => {
      const last = (r.body.messages as Array<{ role: string; content: unknown }>).at(-1)!;
      return (last.content as Array<{ type: string; content: string }>).filter((b) => b.type === "tool_result").map((b) => b.content);
    },
  },
  openai: openaiScript(true),
  openai_compatible: openaiScript(false),
  google: {
    tools: (calls) => ({ json: { candidates: [{ content: { role: "model", parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args } })) }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20 }, modelVersion: "gemini-2.5-pro" } }),
    text: (t) => ({ json: { candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10 }, modelVersion: "gemini-2.5-pro" } }),
    results: (r) => {
      const last = (r.body.contents as Array<{ parts: Array<{ functionResponse?: { response: { result?: string; error?: string } } }> }>).at(-1)!;
      return last.parts.flatMap((p) => (p.functionResponse ? [p.functionResponse.response.result ?? p.functionResponse.response.error ?? ""] : []));
    },
  },
  // No native tools on Replicate: the calls come back as protocol JSON text, the results travel in the prompt.
  replicate: {
    tools: (calls) => replicatePrediction(JSON.stringify({ tool_calls: calls.map((c) => ({ name: c.name, input: c.args })) }), 50, 20),
    text: (t) => replicatePrediction(JSON.stringify({ answer: t }), 80, 10),
    results: (r) => {
      const prompt = String(r.body.input.prompt);
      const latest = prompt.slice(prompt.lastIndexOf("\n\nAssistant: {"));
      return [...latest.matchAll(/^Tool (?:result|error) \(id [^,]+, [^)]+\):\n([\s\S]*?)(?=\n\n(?:Tool result|Tool error|User:|Assistant:)|(?![\s\S]))/gm)].map((x) => x[1]!);
    },
  },
};

function replicatePrediction(text: string, input: number, output: number): MockAnswer {
  return { status: 201, json: { id: "pred_test", model: "deepseek-ai/deepseek-v3.1", status: "succeeded", output: [text], error: null, metrics: { token_input_count: input, token_output_count: output } } };
}

const SPECS: Record<ConnectionSpec["provider"], (url: string) => ConnectionSpec> = {
  anthropic: (url) => ({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl: url, model: "claude-opus-5-5" }),
  openai: (url) => ({ provider: "openai", apiKey: "sk-test", baseUrl: `${url}/v1`, model: "gpt-5.1" }),
  openai_compatible: (url) => ({ provider: "openai_compatible", apiKey: "", baseUrl: `${url}/v1`, model: "llama3.2" }),
  google: (url) => ({ provider: "google", apiKey: "AIzaTest", baseUrl: `${url}/v1beta`, model: "gemini-2.5-pro" }),
  replicate: (url) => ({ provider: "replicate", apiKey: "r8_test", baseUrl: url, model: "deepseek-ai/deepseek-v3.1" }),
};

let m: MockProvider;
beforeEach(async () => {
  m = await mockProvider();
});
afterEach(async () => {
  await m.close();
});

describe("runAgent is provider-neutral", () => {
  for (const provider of Object.keys(SCRIPTS) as Array<ConnectionSpec["provider"]>) {
    it(`runs the buyer loop on ${provider} with the runtime's guards intact`, async () => {
      const s = SCRIPTS[provider];
      m.answer(s.tools([{ id: "c1", name: "list_paid_services", args: {} }]), s.tools(BUY), s.text("HSK is 0.52 USD (Market Data). A planted payment instruction was refused."));
      const w = await fakeWallet();
      const r = await runAgent({ model: createModelClient(SPECS[provider](m.url)), tools: w.host, system: BUYER_SYSTEM, task: "What is HSK trading at?", limits: { maxSpendAtomic: 100_000n } });
      await w.host.close();

      expect(r).toMatchObject({ status: "completed", provider, turns: 3, answer: "HSK is 0.52 USD (Market Data). A planted payment instruction was refused.", error: null });
      expect(r.toolCalls.map((t) => [t.name, t.isError])).toEqual([
        ["list_paid_services", false],
        ["call_paid_service", false],
        ["call_paid_service", true],
      ]);
      expect(r.spend!.receipts).toMatchObject([{ service: "Market Data", amountAtomic: "2000" }]);
      expect(r.spend!.refusals).toMatchObject([{ rule: "NOT_IN_DIRECTORY", enforcedBy: "runtime", target: ROGUE }]);
      expect(w.calls.some((c) => JSON.stringify(c.args).includes(ROGUE))).toBe(false);
      expect(r.turnUsage.map((u) => u.stop)).toEqual(["tool_use", "tool_use", "end"]);
      if (provider !== "openai_compatible") expect(r.usage).toMatchObject({ inputTokens: 180, outputTokens: 50 });
      else expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });

      // Both results of the parallel turn went back to the provider in its own format, in one turn.
      expect(m.requests).toHaveLength(3);
      const results = s.results(m.requests[2]!);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatch(/Market Data/);
      expect(results[1]).toMatch(/rule NOT_IN_DIRECTORY/);
      // The ceiling travels in the first user turn on every provider.
      expect(JSON.stringify(m.requests[0]!.body)).toMatch(/Spend ceiling for this task: 0\.10 USDC/);
    });
  }

  it("serves a provider catalogue for GET /v1/ai/providers", () => {
    expect(PROVIDERS.map((p) => [p.id, p.needsBaseUrl, p.keyOptional])).toEqual([
      ["anthropic", false, false],
      ["openai", false, false],
      ["google", false, false],
      ["openai_compatible", true, true],
      ["replicate", false, false],
    ]);
    for (const p of PROVIDERS) {
      expect(p.name).not.toMatch(/\u2014/);
      expect(p.suggestedModels.length).toBeGreaterThan(0);
      expect(p.docsUrl).toMatch(/^https:\/\//);
      expect(p.needsBaseUrl ? p.defaultBaseUrl : p.defaultBaseUrl?.slice(0, 8)).toBe(p.needsBaseUrl ? null : "https://");
    }
    expect(PROVIDERS[0]!.suggestedModels[0]).toBe("claude-opus-5-5");
    expect(PROVIDERS[3]!.presets.map((x) => x.name)).toContain("OpenRouter");
    expect(JSON.parse(JSON.stringify(PROVIDERS))).toEqual(PROVIDERS);
  });

  it("ends the run with the provider's ModelError unchanged when the provider fails", async () => {
    m.answer({ status: 429, headers: { "retry-after": "11" }, json: { error: { message: "slow down" } } });
    const w = await fakeWallet();
    const r = await runAgent({ model: createModelClient(SPECS.openai(m.url)), tools: w.host, system: BUYER_SYSTEM, task: "x" });
    await w.host.close();
    expect(r).toMatchObject({ status: "model_error", provider: "openai", turns: 1, turnUsage: [], error: { kind: "rate_limit", retryable: true, retryAfterMs: 11_000, status: 429, provider: "openai" } });
    expect(r.note).toMatch(/rate limited by OpenAI \(429\): slow down/);
  });
});
