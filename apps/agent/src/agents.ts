import { merchantServerSpec, modelFromEnv, walletServerSpec } from "./config.ts";
import { connectMcp, type McpServerSpec, type ToolHost } from "./mcp.ts";
import type { Effort, ModelClient } from "@payminto/models";
import { BUYER_SYSTEM, OPS_SYSTEM } from "./prompts.ts";
import { runAgent, type RunEvent, type RunLimits, type RunResult } from "./runtime.ts";

type Env = Record<string, string | undefined>;

export type AgentTaskOptions = {
  task: string;
  env?: Env;
  /** Defaults to the model the environment names (PAYMINTO_AGENT_PROVIDER, PAYMINTO_AGENT_MODEL and the provider's key). */
  model?: ModelClient;
  effort?: Effort;
  limits?: Partial<RunLimits>;
  /** Already connected tools (tests); otherwise the agent's MCP server is started from `env`. */
  tools?: ToolHost;
  /** More MCP servers next to the agent's own (tool names must not collide). */
  extraServers?: McpServerSpec[];
  /** Where MCP child processes write their logs (default: this process's stderr). */
  stderr?: "inherit" | "ignore" | "pipe";
  signal?: AbortSignal;
  onEvent?: (e: RunEvent) => void;
};

async function runWith(system: string, server: () => McpServerSpec, o: AgentTaskOptions, limits: Partial<RunLimits>): Promise<RunResult> {
  const env = o.env ?? process.env;
  // The model is resolved first, so a missing key fails before any tool server starts.
  const model = o.model ?? modelFromEnv(env, { effort: o.effort });
  const tools = o.tools ?? (await connectMcp([server(), ...(o.extraServers ?? [])], { stderr: o.stderr }));
  try {
    return await runAgent({ model, tools, system, task: o.task, limits: { ...limits, ...o.limits }, signal: o.signal, onEvent: o.onEvent });
  } finally {
    if (!o.tools) await tools.close();
  }
}

/**
 * Buyer agent (plan 5.1): runs a task with the Payminto wallet MCP server bound to one mandate, under a per-task
 * spend ceiling. Every call it buys comes back in the spend report with its receipt.
 */
export function runBuyerTask(o: AgentTaskOptions): Promise<RunResult> {
  return runWith(BUYER_SYSTEM, () => walletServerSpec(o.env ?? process.env), o, {});
}

/**
 * Ops agent (plan 5.3): answers back-office questions with the merchant MCP server (business API key). It does not
 * spend, so it has no spend ceiling; refunds go through request_refund and the business's approval rule.
 */
export function runOpsTask(o: AgentTaskOptions): Promise<RunResult> {
  return runWith(OPS_SYSTEM, () => merchantServerSpec(o.env ?? process.env), o, { maxSpendAtomic: null });
}
