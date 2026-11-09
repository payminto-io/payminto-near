// A scripted OpenAI-compatible model for rehearsing the AI agents act without a model key: the shared mock provider
// (@payminto/models/mock-provider) answering by request. It plays three parts, told apart by the tools it is offered:
// the ops agent (merchant tools), the AI buyer (wallet tools) and the skill (no tools). Never a real model.
// Run alone: node scripts/scripted-model.ts [port]  (prints DEMO_AI_BASE_URL)
import { mockProvider, type MockAnswer, type MockProvider, type SeenRequest } from "@payminto/models/mock-provider";

export const SCRIPTED_MODEL = "scripted-demo-model";

type Msg = { role: string; content: string | null };

const turn = (calls: Array<{ name: string; args: Record<string, unknown> }>, n: number): MockAnswer => ({
  json: {
    model: SCRIPTED_MODEL,
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({ id: `call_${n}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 600, completion_tokens: 40 },
  },
});

const text = (t: string): MockAnswer => ({
  json: { model: SCRIPTED_MODEL, choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 80 } },
});

/** One answer for one request, from what the request offers and what came back from earlier tool calls. */
export function scriptedAnswer(r: SeenRequest): MockAnswer {
  if (r.method === "GET" && r.path.endsWith("/models")) return { json: { object: "list", data: [{ id: SCRIPTED_MODEL }] } };
  if (r.method !== "POST" || !r.path.endsWith("/chat/completions")) return { status: 404, json: { error: { message: `scripted model: no route ${r.method} ${r.path}` } } };
  const tools = ((r.body?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name);
  const results = ((r.body?.messages ?? []) as Msg[]).filter((m) => m.role === "tool").map((m) => m.content ?? "");
  if (tools.includes("call_paid_service")) {
    if (results.length === 0) return turn([{ name: "list_paid_services", args: {} }], 0);
    if (results.length === 1) {
      const quote = /https?:\/\/[^"\s\\]+\/v1\/quote/.exec(results[0]!)?.[0];
      if (!quote) return text("I could not find Market Data in the directory, so I spent nothing.");
      return turn([{ name: "call_paid_service", args: { url: quote, method: "GET", query: { symbol: "HSK" } } }], 1);
    }
    if (results.length === 2) {
      const url = /https?:\/\/[^"\s\\]+\/v1\/skills\/market-brief/.exec(results[0]!)?.[0];
      if (!url) return text("I could not find the HashKey market brief skill in the directory, so I spent only the quote.");
      return turn([{ name: "call_paid_service", args: { url, method: "POST", body: { input: `HSK treasury brief. Live quote: ${results[1]!.slice(0, 400)}` } } }], 2);
    }
    return text(
      "Risk note: HSK trades in a narrow range today with thin weekend liquidity. Counterparty risk on the scanned wallets is low. Keep treasury exposure under the current limit. Spent one quote from Market Data and one market brief from the skill, paid with vouchers.",
    );
  }
  if (tools.includes("get_overview")) {
    if (results.length === 0) return turn([{ name: "get_overview", args: {} }], 0);
    if (results.length === 1) return turn([{ name: "list_payments", args: {} }], 1);
    return text("Today the business earned what the overview shows, and every listed payment is accounted for. I listed the payments and found none still unpaid that need action.");
  }
  return text("HSK market brief: spot is steady, funding is neutral, and on-chain activity is in line with the weekly average. Risk outlook: low.");
}

/** Starts the scripted model on a random local port; `answers` bounds how many requests it serves. */
export async function startScriptedModel(answers = 1_000): Promise<MockProvider & { baseUrl: string }> {
  const mock = await mockProvider();
  for (let i = 0; i < answers; i++) mock.answer(scriptedAnswer);
  return { ...mock, baseUrl: `${mock.url}/v1` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startScriptedModel(100_000);
  process.stdout.write(`DEMO_AI_BASE_URL=${m.baseUrl}\n`);
  process.on("SIGINT", () => void m.close().then(() => process.exit(0)));
}
