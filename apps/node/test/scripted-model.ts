/**
 * A scripted stand-in for a model provider, so the agents suite runs every worker path without a network or a key.
 * The provider adapters themselves are covered in packages/models and, end to end, in agents-providers.test.ts.
 */
import { ModelError, type ModelClient, type ModelRequest, type ModelTurn, type Part, type Provider } from "@payminto/models";

export type ScriptReply = {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  stop?: ModelTurn["stop"];
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number };
};

/** One turn: a reply, a function of the request (may wait, may throw a ModelError), or an error to throw. */
export type ScriptStep = ScriptReply | ModelError | ((req: ModelRequest, turn: number, signal: AbortSignal | undefined) => ScriptReply | Promise<ScriptReply>);

export type ScriptedClient = ModelClient & { readonly requests: ModelRequest[] };

/**
 * Plays a fixed script, one step per turn, and records every request. A step that waits is cut short by the turn's
 * AbortSignal, like a real provider call. Running past the script is an error.
 */
export function scriptedModel(steps: ScriptStep[], o: { model?: string; provider?: Provider } = {}): ScriptedClient {
  const requests: ModelRequest[] = [];
  let ids = 0;
  return {
    provider: o.provider ?? "anthropic",
    model: o.model ?? "scripted-stand-in",
    requests,
    async turn(req, opts) {
      requests.push(structuredClone(req));
      const turn = requests.length - 1;
      const step = steps[turn];
      if (step === undefined) throw new ModelError("bad_request", `scripted model: no step ${turn + 1} (script has ${steps.length})`);
      if (step instanceof ModelError) throw step;
      const signal = opts?.signal;
      if (signal?.aborted) throw abortErrorOf(signal);
      const pending = Promise.resolve(typeof step === "function" ? step(req, turn, signal) : step);
      const reply = signal
        ? await new Promise<ScriptReply>((resolve, reject) => {
            const onAbort = () => reject(abortErrorOf(signal));
            signal.addEventListener("abort", onAbort, { once: true });
            pending.then(
              (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
              (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
            );
          })
        : await pending;
      const parts: Part[] = [];
      if (reply.text !== undefined) parts.push({ type: "text", text: reply.text });
      for (const t of reply.toolCalls ?? []) parts.push({ type: "tool_call", id: `call_scripted_${++ids}`, name: t.name, input: t.input });
      return {
        parts,
        stop: reply.stop ?? (reply.toolCalls?.length ? "tool_use" : "end"),
        usage: { ...reply.usage, inputTokens: reply.usage?.inputTokens ?? 100, outputTokens: reply.usage?.outputTokens ?? 50 },
        model: this.model,
      };
    },
  };
}

function abortErrorOf(signal: AbortSignal): Error {
  const e = new Error("the model request was aborted");
  e.name = "AbortError";
  (e as Error & { cause?: unknown }).cause = signal.reason;
  return e;
}
