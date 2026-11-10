import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServerSpec } from "./mcp.ts";
import { DEFAULT_LIMITS, type RunLimits } from "./runtime.ts";
import { existsSync } from "node:fs";
import { defaultAgentKeyPath } from "@payminto/sdk";
import { createModelClient, DEFAULT_MODEL, ModelError, PROVIDER_IDS, providerInfo, type Effort, type ModelClient, type Provider } from "@payminto/models";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** The Payminto MCP server entry point (wallet mode by default, merchant mode with --merchant). */
export const MCP_MAIN = join(REPO_ROOT, "apps", "mcp", "src", "main.ts");

type Env = Record<string, string | undefined>;

/** No key for the CLI's provider in the environment: names the variable to export. */
export class MissingApiKeyError extends Error {
  readonly variable: string;
  constructor(variable = "ANTHROPIC_API_KEY", provider: Provider = "anthropic") {
    const how: Record<Provider, string> = {
      anthropic: "The Payminto agents call Claude through the Anthropic API: export ANTHROPIC_API_KEY=sk-ant-... (and optionally PAYMINTO_AGENT_MODEL, default claude-opus-5-5)",
      openai: "PAYMINTO_AGENT_PROVIDER is openai: export OPENAI_API_KEY=sk-... (and optionally PAYMINTO_AGENT_MODEL)",
      google: "PAYMINTO_AGENT_PROVIDER is google: export GOOGLE_API_KEY=... (a Gemini API key from Google AI Studio, and optionally PAYMINTO_AGENT_MODEL)",
      openai_compatible: "PAYMINTO_AGENT_PROVIDER is openai_compatible: export PAYMINTO_AGENT_API_KEY=... (the key of the endpoint at PAYMINTO_AGENT_BASE_URL)",
      replicate: "PAYMINTO_AGENT_PROVIDER is replicate: export REPLICATE_API_TOKEN=r8_... (an API token from https://replicate.com/account/api-tokens, and optionally PAYMINTO_AGENT_MODEL, default deepseek-ai/deepseek-v3.1)",
      nearai: "PAYMINTO_AGENT_PROVIDER is nearai: export NEARAI_API_KEY=sk-... (a NEAR AI Cloud key from API Keys at https://cloud.near.ai, and optionally PAYMINTO_AGENT_MODEL, default z-ai/glm-5.3-flash)",
    };
    super(`${variable} is not set. ${how[provider]}, then run the command again.`);
    this.name = "MissingApiKeyError";
    this.variable = variable;
  }
}


export class AgentConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid Payminto agent configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "AgentConfigError";
  }
}

/** Environment variables the wallet MCP server reads; only these are passed to it (never a model API key). */
export const WALLET_ENV = [
  "NODE_URL",
  "NETWORK",
  "HUB_ACCOUNT",
  "AGENT_KEY",
  "AGENT_KEY_FILE",
  "BUDGET_ID",
  "NEAR_RPC_URL",
  "CHAIN_READER",
  "PAYEE_CHECK",
  "PAYEE_CHECK_INDEXER",
  "PAYEE_CHECK_INDEXER_KEY",
  "MAX_PRICE_ATOMIC",
  "PAYABLE_HOSTS",
  "ALLOW_ANY_PAYEE",
  "TRUSTED_NODE_KEY",
  "RECEIPT_STORE_PATH",
  "PAYMINTO_DATA_DIR",
] as const;

/** Environment variables the merchant MCP server reads. */
export const MERCHANT_ENV = ["NODE_URL", "MERCHANT_API_KEY", "MERCHANT_ID", "PAYMINTO_DATA_DIR"] as const;

function pick(env: Env, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(names.flatMap((n) => (env[n] ? [[n, env[n]!]] : [])));
}

/**
 * An MCP server from one config value: an http(s) URL is Streamable HTTP; anything else is a command line split on
 * spaces (a leading `node` runs with this Node binary, so type stripping works the same way). `bearer` is the token
 * a Payminto MCP server over HTTP requires; it is sent only to a URL, never passed to a command.
 */
export function parseMcpSpec(name: string, value: string, env: Record<string, string> = {}, bearer?: string): McpServerSpec {
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) {
    try {
      return { name, url: new URL(v).toString(), ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) };
    } catch {
      throw new AgentConfigError([`${name}: ${v} is not a valid URL`]);
    }
  }
  const [cmd, ...args] = v.split(/\s+/).filter(Boolean);
  if (!cmd) throw new AgentConfigError([`${name}: empty MCP command`]);
  return { name, command: cmd === "node" ? process.execPath : cmd, args, env };
}

const atomic = z.string().regex(/^\d+$/, "must be a whole number of token base units");
const posInt = z.string().regex(/^[1-9]\d*$/, "must be a positive integer");

const limitsSchema = z.object({
  PAYMINTO_AGENT_MAX_TURNS: posInt.optional(),
  PAYMINTO_AGENT_MAX_OUTPUT_TOKENS: posInt.optional(),
  PAYMINTO_AGENT_MAX_TOKENS_PER_TURN: posInt.optional(),
  PAYMINTO_AGENT_MAX_SPEND_ATOMIC: atomic.optional(),
  PAYMINTO_AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});

function issues(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`);
}

/** Loop limits from the environment, with DEFAULT_LIMITS for anything unset. */
export function limitsFromEnv(env: Env = process.env): RunLimits & { effort: Effort | undefined } {
  const p = limitsSchema.safeParse(env);
  if (!p.success) throw new AgentConfigError(issues(p.error));
  const e = p.data;
  return {
    maxTurns: e.PAYMINTO_AGENT_MAX_TURNS ? Number(e.PAYMINTO_AGENT_MAX_TURNS) : DEFAULT_LIMITS.maxTurns,
    maxOutputTokens: e.PAYMINTO_AGENT_MAX_OUTPUT_TOKENS ? Number(e.PAYMINTO_AGENT_MAX_OUTPUT_TOKENS) : DEFAULT_LIMITS.maxOutputTokens,
    maxTokensPerTurn: e.PAYMINTO_AGENT_MAX_TOKENS_PER_TURN ? Number(e.PAYMINTO_AGENT_MAX_TOKENS_PER_TURN) : DEFAULT_LIMITS.maxTokensPerTurn,
    maxSpendAtomic: e.PAYMINTO_AGENT_MAX_SPEND_ATOMIC ? BigInt(e.PAYMINTO_AGENT_MAX_SPEND_ATOMIC) : DEFAULT_LIMITS.maxSpendAtomic,
    effort: e.PAYMINTO_AGENT_EFFORT,
  };
}

/**
 * The buyer's wallet: `node apps/mcp/src/main.ts` with the wallet variables passed through, or whatever
 * PAYMINTO_WALLET_MCP names (a command line or a Streamable HTTP URL such as http://127.0.0.1:3334/mcp). A wallet
 * over HTTP requires a bearer token: PAYMINTO_WALLET_MCP_TOKEN carries it.
 */
export function walletServerSpec(env: Env = process.env): McpServerSpec {
  const custom = env.PAYMINTO_WALLET_MCP?.trim();
  const pass = pick(env, WALLET_ENV);
  if (custom) return parseMcpSpec("payminto-wallet", custom, pass, env.PAYMINTO_WALLET_MCP_TOKEN?.trim() || undefined);
  const problems = ["NODE_URL", "BUDGET_ID"].filter((n) => !env[n]).map((n) => `${n}: required for the buyer agent's wallet (see apps/agent/README.md), or set PAYMINTO_WALLET_MCP`);
  // The wallet reads the key from a file; the path, never the key, is what crosses into its environment.
  if (!pass.AGENT_KEY && !pass.AGENT_KEY_FILE) {
    const path = defaultAgentKeyPath(env);
    if (existsSync(path)) pass.AGENT_KEY_FILE = path;
    else problems.push(`AGENT_KEY_FILE: no agent key at ${path}; run \`payminto-agent keygen\` (or set AGENT_KEY_FILE)`);
  }
  if (problems.length) throw new AgentConfigError(problems);
  return { name: "payminto-wallet", command: process.execPath, args: [MCP_MAIN], env: pass };
}

/**
 * The merchant MCP server for the ops agent: `node apps/mcp/src/main.ts --merchant` with NODE_URL and
 * MERCHANT_API_KEY, or whatever PAYMINTO_MERCHANT_MCP names.
 */
export function merchantServerSpec(env: Env = process.env): McpServerSpec {
  const custom = env.PAYMINTO_MERCHANT_MCP?.trim();
  const pass = pick(env, MERCHANT_ENV);
  if (custom) return parseMcpSpec("payminto-merchant", custom, pass, env.PAYMINTO_MERCHANT_MCP_TOKEN?.trim() || undefined);
  const missing = ["NODE_URL", "MERCHANT_API_KEY"].filter((n) => !env[n]);
  if (missing.length) {
    throw new AgentConfigError(missing.map((n) => `${n}: required for the ops agent's merchant tools (see apps/agent/README.md), or set PAYMINTO_MERCHANT_MCP`));
  }
  return { name: "payminto-merchant", command: process.execPath, args: [MCP_MAIN, "--merchant"], env: pass };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const serviceSchema = z.object({
  AGENT_SERVICE_TOKEN: z.string().min(24, "must be at least 24 characters (it is the bearer token callers send)"),
  AGENT_SERVICE_PORT: z.string().regex(/^\d+$/).default("3340").transform(Number),
  AGENT_SERVICE_HOST: z.string().default("127.0.0.1"),
  /** Set to 1 to listen beyond loopback (put TLS in front). */
  AGENT_SERVICE_ALLOW_REMOTE: z.enum(["0", "1"]).optional(),
  AGENT_SERVICE_MAX_RUNS: z.string().regex(/^\d+$/).default("200").transform(Number),
});

export type ServiceConfig = { token: string; port: number; host: string; maxRuns: number };

export function serviceConfig(env: Env = process.env): ServiceConfig {
  const p = serviceSchema.safeParse(env);
  if (!p.success) throw new AgentConfigError(issues(p.error));
  const e = p.data;
  if (!LOOPBACK.has(e.AGENT_SERVICE_HOST) && e.AGENT_SERVICE_ALLOW_REMOTE !== "1") {
    throw new AgentConfigError([`AGENT_SERVICE_HOST: ${e.AGENT_SERVICE_HOST} is not loopback; set AGENT_SERVICE_ALLOW_REMOTE=1 to listen there (and put TLS in front)`]);
  }
  return { token: e.AGENT_SERVICE_TOKEN, port: e.AGENT_SERVICE_PORT, host: e.AGENT_SERVICE_HOST, maxRuns: e.AGENT_SERVICE_MAX_RUNS };
}

/** Where each provider's key comes from in the environment. */
export const KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  openai_compatible: "PAYMINTO_AGENT_API_KEY",
  replicate: "REPLICATE_API_TOKEN",
  nearai: "NEARAI_API_KEY",
};

/**
 * The CLI's model from the environment: PAYMINTO_AGENT_PROVIDER (default anthropic), PAYMINTO_AGENT_MODEL,
 * PAYMINTO_AGENT_BASE_URL (ANTHROPIC_BASE_URL also works for Anthropic) and the provider's key variable (KEY_ENV).
 * Throws MissingApiKeyError naming the variable to set, or AgentConfigError for anything else that is missing or wrong.
 * An OpenAI-compatible server on this machine (Ollama, LM Studio) may run without a key.
 */
export function modelFromEnv(env: Env = process.env, o: { effort?: Effort; maxRetries?: number } = {}): ModelClient {
  const raw = env.PAYMINTO_AGENT_PROVIDER?.trim() || "anthropic";
  if (!(PROVIDER_IDS as readonly string[]).includes(raw)) throw new AgentConfigError([`PAYMINTO_AGENT_PROVIDER: ${raw} is not a provider; use one of ${PROVIDER_IDS.join(", ")}`]);
  const provider = raw as Provider;
  const keyVar = KEY_ENV[provider];
  const apiKey = env[keyVar]?.trim() ?? "";
  const baseUrl = env.PAYMINTO_AGENT_BASE_URL?.trim() || (provider === "anthropic" ? env.ANTHROPIC_BASE_URL?.trim() : undefined) || undefined;
  if (provider === "openai_compatible" && !baseUrl) {
    throw new AgentConfigError(["PAYMINTO_AGENT_BASE_URL: required when PAYMINTO_AGENT_PROVIDER is openai_compatible, for example https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1"]);
  }
  let local = false;
  try {
    local = baseUrl ? LOOPBACK.has(new URL(baseUrl).hostname.replace(/^\[|\]$/g, "")) : false;
  } catch {
    throw new AgentConfigError([`PAYMINTO_AGENT_BASE_URL: ${baseUrl} is not a valid URL`]);
  }
  if (!apiKey && !(provider === "openai_compatible" && local)) throw new MissingApiKeyError(keyVar, provider);
  const model = env.PAYMINTO_AGENT_MODEL?.trim() || (provider === "anthropic" ? DEFAULT_MODEL : provider === "openai_compatible" ? "" : providerInfo(provider).suggestedModels[0]!);
  if (!model) {
    throw new AgentConfigError(["PAYMINTO_AGENT_MODEL: required when PAYMINTO_AGENT_PROVIDER is openai_compatible (the model id your endpoint serves, for example meta-llama/llama-4-maverick)"]);
  }
  try {
    // The CLI has no worker above it, so the client retries a busy provider itself.
    return createModelClient({ provider, apiKey, baseUrl, model }, { effort: o.effort, maxRetries: o.maxRetries ?? 2 });
  } catch (err) {
    if (err instanceof ModelError) throw new AgentConfigError([err.message]);
    throw err;
  }
}
