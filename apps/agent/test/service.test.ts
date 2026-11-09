import { describe, expect, it } from "vitest";
import { marketBriefApp } from "../src/seller.ts";
import { createAgentService, type RunTask } from "../src/service.ts";
import type { RunResult } from "../src/runtime.ts";
import type { AgentClient } from "@payminto/sdk";

const TOKEN = "test-token-0123456789-abcdef";

function fakeResult(task: string, ceiling: bigint | null): RunResult {
  return {
    status: "completed",
    answer: `done: ${task}`,
    provider: "anthropic",
    model: "scripted",
    turns: 1,
    usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    turnUsage: [],
    toolCalls: [],
    spend: { token: { symbol: "USDC", decimals: 6 }, mandateId: null, ceilingAtomic: ceiling?.toString() ?? null, ceiling: null, spentAtomic: "0", spent: "0 USDC", receipts: [], budgetLeftAtomic: null, budgetLeft: null, refusals: [] },
    note: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

describe("agent service", () => {
  const seen: Array<{ task: string; ceiling: bigint | null }> = [];
  let running = 0;
  let overlap = false;
  const runTask: RunTask = async (task, { maxSpendAtomic }) => {
    seen.push({ task, ceiling: maxSpendAtomic });
    if (running++) overlap = true;
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return fakeResult(task, maxSpendAtomic);
  };
  const svc = createAgentService({ token: TOKEN, runTask, maxSpendAtomic: 500_000n });
  const call = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    svc.app.request(path, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers } });

  it("requires the bearer token", async () => {
    expect((await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "x" }) }, null)).status).toBe(401);
    expect((await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "x" }) }, "wrong-token")).status).toBe(401);
    expect((await call("/v1/runs/run_x", {}, null)).status).toBe(401);
    expect((await call("/v1/health", {}, null)).status).toBe(200);
  });

  it("runs a task and returns the record, then serves it by id", async () => {
    const res = await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "compare HSK and ETH", maxSpendAtomic: "100000" }) });
    expect(res.status).toBe(200);
    const rec = (await res.json()) as { id: string; status: string; maxSpendAtomic: string; result: { answer: string } };
    expect(rec).toMatchObject({ status: "finished", maxSpendAtomic: "100000", result: { answer: "done: compare HSK and ETH" } });
    expect(seen.at(-1)).toEqual({ task: "compare HSK and ETH", ceiling: 100_000n });
    const again = await call(`/v1/runs/${rec.id}`);
    expect(((await again.json()) as { status: string }).status).toBe("finished");
    expect((await call("/v1/runs/run_missing")).status).toBe(404);
  });

  it("uses the service ceiling by default and refuses a request to raise it", async () => {
    await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "default ceiling" }) });
    expect(seen.at(-1)!.ceiling).toBe(500_000n);
    const high = await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "x", maxSpendAtomic: 900_000 }) });
    expect(high.status).toBe(400);
    expect(((await high.json()) as { error: { code: string } }).error.code).toBe("SPEND_CEILING_TOO_HIGH");
    expect((await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "" }) })).status).toBe(400);
  });

  it("accepts wait: false with 202 and runs tasks one at a time", async () => {
    const a = await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "a", wait: false }) });
    const b = await call("/v1/runs", { method: "POST", body: JSON.stringify({ task: "b", wait: false }) });
    expect(a.status).toBe(202);
    const idB = ((await b.json()) as { id: string }).id;
    await svc.close();
    expect(((await (await call(`/v1/runs/${idB}`)).json()) as { status: string }).status).toBe("finished");
    expect(overlap).toBe(false);
  });
});

describe("seller without a model", () => {
  it("answers 503 before the paywall, so nothing is charged", async () => {
    const app = marketBriefApp({
      nodeUrl: "http://127.0.0.1:1",
      provider: { id: "prv_x", apiKey: "pmk_x" },
      price: 30_000n,
      buyer: { address: "0x0000000000000000000000000000000000000001" } as unknown as AgentClient,
      inputs: { quoteUrl: "http://127.0.0.1:1/q", riskUrl: "http://127.0.0.1:1/r" },
      model: null,
    });
    const res = await app.request("/v1/brief", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(503);
    expect(res.headers.get("payment-required")).toBeNull();
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "MODEL_UNAVAILABLE", message: expect.stringMatching(/nothing was charged/) });
    expect(((await (await app.request("/")).json()) as { ready: boolean }).ready).toBe(false);
  });
});
