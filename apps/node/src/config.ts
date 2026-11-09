import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_CHECKOUT_TTL_SECONDS, hashkeyNetworkFacts, MAX_EXPIRES_IN_SECONDS, MIN_EXPIRES_IN_SECONDS, networks } from "@payminto/protocol";
import { smtpConfigFromEnv, type SmtpConfig } from "./auth/mailer.ts";
import { DEV_AGENT_SECRETS_KEY, parseSecretsKey } from "./agents/secrets.ts";

export const DEFAULT_DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "deployments");

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));

const privateKey = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
  .transform((v) => v as Hex);

const intFromEnv = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return def;
      if (!/^\d+$/.test(v)) {
        ctx.addIssue({ code: "custom", message: "must be a non-negative integer" });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min) {
        ctx.addIssue({ code: "custom", message: `must be >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

/** Public chains (real money, or public testnets where keys are exposed to the world): dev defaults are refused there. */
export const LIVE_CHAIN_IDS: readonly number[] = [133, 177, 11155111];

/**
 * The ten private keys every anvil and hardhat install derives from the public "test test ... junk" mnemonic.
 * Anything sent to their addresses on a real chain is swept by bots within seconds.
 */
export const PUBLIC_DEV_KEYS: readonly Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e",
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97",
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
];

/** The local dev admin token used by scripts/dev-local.sh, the demo and .env.example. */
export const DEV_ADMIN_TOKEN = "dev-admin-token";
export const LIVE_ADMIN_TOKEN_MIN_LENGTH = 32;

/** Unset means "use the network defaults"; "none" disables; otherwise a comma-separated list of URLs. */
const urlList = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim() === "none" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean)))
  .pipe(z.array(z.url()).optional());

const envSchema = z.object({
  PORT: intFromEnv(8787),
  // Loopback by default: expose the node through a reverse proxy (docs/OPERATIONS.md). The Docker image sets 0.0.0.0.
  HOST: z.string().min(1).default("127.0.0.1"),
  CHAIN_ID: intFromEnv(31337).refine((n) => n in networks, `must be one of ${Object.keys(networks).join(", ")}`),
  RPC_URL: z.url().optional(),
  RPC_FALLBACK_URLS: urlList,
  DEPLOY_BLOCK: intFromEnv(-1),
  HUB_ADDRESS: address.optional(),
  TOKEN_ADDRESS: address.optional(),
  OPERATOR_KEY: privateKey,
  ADMIN_TOKEN: z.string().min(12, "must be at least 12 characters"),
  DB_PATH: z.string().min(1).default("./data/clearing.db"),
  SETTLE_INTERVAL_SEC: intFromEnv(0),
  SETTLE_MIN_CALLS: intFromEnv(1, 1),
  PUBLIC_URL: z.url().default("http://localhost:8787"),
  HSP_MODE: z.enum(["local", "coordinator"]).default("local"),
  HSP_COORDINATOR_URL: z.url().optional(),
  HSP_API_KEY: z.string().min(1).optional(),
  HSP_CHAIN_NAME: z.string().min(1).optional(),
  HSP_VERIFYING_CONTRACT: address.optional(),
  HSP_COSIGN_TIMEOUT_SEC: intFromEnv(20),
  // Comma-separated capabilities written into every HSP mandate in coordinator mode (local mode uses its own set).
  HSP_REQUIRED_CAPABILITIES: z.string().optional(),
  // Finality head a settlement must reach before the ledger and HSP are updated. Default: safe on HashKey Chain, latest on anvil.
  CONFIRM_TAG: z.enum(["latest", "safe", "finalized"]).optional(),
  // Send a same-nonce replacement with a 12.5 % fee bump when a settlement is not included after this many blocks.
  TX_BUMP_AFTER_BLOCKS: intFromEnv(5, 1),
  TX_MAX_BUMPS: intFromEnv(5),
  TX_INCLUSION_TIMEOUT_SEC: intFromEnv(300, 1),
  // Retries for transient JSON-RPC failures (network errors, HTTP 429 and 5xx), with exponential backoff and jitter.
  RPC_RETRIES: intFromEnv(4),
  // Attest every confirmed batch on EAS (HashKey Chain predeploy). Needs EAS code at the predeploy address.
  EAS_ATTEST: z.enum(["true", "false"]).default("false"),
  // Default: the dashboard origin (PUBLIC_DASHBOARD_URL, PUBLIC_CHECKOUT_URL) plus http://localhost:3000.
  CORS_ORIGINS: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEPLOYMENTS_DIR: z.string().optional(),
  FUNDS_REFRESH_SEC: intFromEnv(30, 1),
  // Token buckets (requests per second, burst). 0 rps disables that limiter. Agents read their position before every
  // paid call, so one agent host legitimately makes about as many public reads as it makes calls.
  RATE_LIMIT_PROVIDER_RPS: intFromEnv(200),
  RATE_LIMIT_PROVIDER_BURST: intFromEnv(1000, 1),
  RATE_LIMIT_IP_RPS: intFromEnv(100),
  RATE_LIMIT_IP_BURST: intFromEnv(1000, 1),
  // Number of reverse proxies in front of the node whose X-Forwarded-For entries are trusted. 0 uses the socket address.
  TRUST_PROXY_HOPS: intFromEnv(0),
  // Identical denials within this window are folded into one row with a repeat count.
  DENIAL_DEDUP_SEC: intFromEnv(60),
  // Oldest denial rows beyond this count are pruned periodically.
  DENIALS_MAX_ROWS: intFromEnv(100_000, 1_000),
  // Oldest rows of the SSE replay log beyond this count are pruned periodically.
  EVENTS_MAX_ROWS: intFromEnv(200_000, 1_000),
  // Payminto Gateway (docs/GATEWAY.md sections 11 and 14). GATEWAY_PAYOUT_ADDRESS seeds the default merchant's payout
  // at first boot; GATEWAY_ENABLED=true turns the gateway on without one (operator creates merchants).
  GATEWAY_PAYOUT_ADDRESS: address.optional(),
  GATEWAY_ENABLED: z.enum(["true", "false"]).optional(),
  PLATFORM_NAME: z.string().trim().min(1).max(120).default("Payminto"),
  // Platform treasury that receives platform and method fees; required before any fee can be non-zero.
  PLATFORM_FEE_ADDRESS: address.optional(),
  // PaymentRouter (section 14.2) override; defaults to paymentRouter in the deployments json.
  PAYMENT_ROUTER_ADDRESS: address.optional(),
  PUBLIC_CHECKOUT_URL: z.url().default("http://localhost:3000"),
  DEPOSIT_FACTORY_ADDRESS: address.optional(),
  CHECKOUT_TTL_SECONDS: intFromEnv(DEFAULT_CHECKOUT_TTL_SECONDS, MIN_EXPIRES_IN_SECONDS),
  WEBHOOK_ALLOW_PRIVATE: z.enum(["true", "false"]).optional(),
  GATEWAY_WATCH_INTERVAL_MS: intFromEnv(2_000, 250),
  // Intake screening: refuse payer wallets with fewer sent transactions than this (0 = off).
  SCREEN_MIN_PAYER_NONCE: intFromEnv(0),
  // HSP payment method (docs/GATEWAY.md section 17): HashKey's HSP Agentic Payment MCP server. Unset = method off.
  // HSP_MERCHANT_NAME is the team's reporting name; HashKey aggregates payments by it, so it must never change.
  HSP_MCP_URL: z.url().optional(),
  HSP_MERCHANT_NAME: z.string().trim().min(1).max(120).optional(),
  HSP_POLL_INTERVAL_MS: intFromEnv(15_000, 1_000),
  // Accounts (docs/PRODUCT.md sections 4 and 10). The dashboard origin: links in emails, the CSRF Origin check and the
  // cookie's Secure flag. Defaults to PUBLIC_CHECKOUT_URL (the dashboard serves the checkout).
  PUBLIC_DASHBOARD_URL: z.url().optional(),
  // The recovery key (ADMIN_TOKEN) keeps working after setup only with this set; every use is audited.
  ADMIN_TOKEN_BREAK_GLASS: z.enum(["true", "false"]).default("false"),
  // A separate Prometheus scrape token; ADMIN_TOKEN also works for /metrics.
  METRICS_TOKEN: z.string().min(16, "must be at least 16 characters").optional(),
  // scrypt cost as log2(N); 17 by default and the minimum on HashKey Chain.
  PASSWORD_HASH_COST: intFromEnv(17, 14),
  // Auth requests per minute per IP across /v1/auth/*, /v1/setup* and the invite routes.
  AUTH_RATE_LIMIT_PER_MIN: intFromEnv(20, 1),
  // The JSON-RPC a browser wallet should use (served as network.rpc_url); defaults to the chain's public RPC.
  PUBLIC_RPC_URL: z.url().optional(),
  // Merchant AI agents (docs/AGENTS.md). On by default on local chains when the gateway is on; off by default on
  // HashKey Chain. AGENT_SECRETS_KEY (base64, 32 bytes) seals the businesses' model API keys.
  AGENTS_ENABLED: z.enum(["true", "false"]).optional(),
  AGENT_SECRETS_KEY: z.string().optional(),
  // Rotation (docs/OPERATIONS.md): the version new secrets are sealed with, and the previous key still readable.
  AGENT_SECRETS_KEY_VERSION: intFromEnv(1, 1),
  AGENT_SECRETS_KEY_PREVIOUS: z.string().optional(),
  // Lets OpenAI-compatible base URLs point at private and loopback addresses (Ollama, vLLM on the same box).
  AGENT_ALLOW_PRIVATE_MODEL_URLS: z.enum(["true", "false"]).default("false"),
  // Runs at once in this node (0 = this node runs no agent worker), and at most this many per business.
  AGENT_WORKERS: intFromEnv(2),
  AGENT_MAX_PER_MERCHANT: intFromEnv(1, 1),
  // Worker poll interval while work is likely; it backs off to 5,000 ms when idle.
  AGENT_POLL_MS: intFromEnv(1_000, 50),
});

export type Config = {
  port: number;
  host: string;
  chainId: number;
  rpcUrl: string;
  hub: Address;
  token: Address;
  operatorKey: Hex;
  adminToken: string;
  dbPath: string;
  settleIntervalSec: number;
  settleMinCalls: number;
  publicUrl: string;
  hsp: {
    mode: "local" | "coordinator";
    coordinatorUrl?: string;
    apiKey?: string;
    chainName?: string;
    /** Local mode: the HSP domain contract (default the hub). Coordinator mode: the pin, checked against GET /chains. */
    verifyingContract: Address;
    /** True when HSP_VERIFYING_CONTRACT was set explicitly; coordinator mode then refuses to start on a mismatch. */
    verifyingContractPinned?: boolean;
    /** Coordinator mode: capabilities committed to in every HSP mandate. */
    requiredCapabilities?: string[];
    cosignTimeoutSec: number;
  };
  /** Finality head for settlement batches. */
  confirmTag?: ConfirmTag;
  tx?: TxPolicy;
  rpcRetries?: number;
  easAttest?: boolean;
  corsOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  fundsRefreshSec: number;
  /** Block the hub was deployed at, for event scans. */
  deployBlock: bigint;
  /** Extra JSON-RPC endpoints tried in order when RPC_URL fails. */
  rpcFallbackUrls: string[];
  rateLimit: RateLimitConfig;
  /** Trusted reverse-proxy hops for X-Forwarded-For. */
  trustProxyHops: number;
  denials: { dedupWindowSec: number; maxRows: number };
  eventsMaxRows: number;
  /** Payminto Gateway; absent when GATEWAY_PAYOUT_ADDRESS is unset (gateway off). */
  gateway?: GatewayConfig;
  /** Accounts; every field has a default, so a Config built in code may leave it out. */
  auth?: AuthConfig;
  /** Merchant AI agents; absent means the defaults for the chain (see agentsConfigOf). */
  agents?: AgentsConfig;
};

export type AgentsConfig = {
  enabled: boolean;
  /** Base64 server keys by version (AGENT_SECRETS_KEY and AGENT_SECRETS_KEY_PREVIOUS). Never logged. */
  secretsKeys: Record<number, string>;
  /** The version new secrets are sealed with. */
  secretsKeyVersion: number;
  /** True when AGENT_SECRETS_KEY was unset and the documented dev key is in use (refused on HashKey Chain). */
  usingDevKey: boolean;
  allowPrivateModelUrls: boolean;
  /** Runs at once in this node; 0 runs no worker here. */
  workers: number;
  maxPerMerchant: number;
  pollMs: number;
  /** Test knobs; production uses the documented defaults. */
  idlePollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  /** Retry backoff per attempt (2 s, 8 s, 30 s). */
  retryDelaysMs?: number[];
  /** How long a paid skill call waits for its result before answering 202. */
  skillWaitMs?: number;
};

/** The agents section with defaults filled in: on locally with the dev key, off on HashKey Chain. */
export function agentsConfigOf(c: Pick<Config, "agents" | "chainId" | "gateway">): AgentsConfig {
  if (c.agents) return c.agents;
  return {
    enabled: !LIVE_CHAIN_IDS.includes(c.chainId) && !!c.gateway,
    secretsKeys: { 1: DEV_AGENT_SECRETS_KEY },
    secretsKeyVersion: 1,
    usingDevKey: true,
    allowPrivateModelUrls: false,
    workers: 2,
    maxPerMerchant: 1,
    pollMs: 1_000,
  };
}

export type AuthConfig = {
  /** Dashboard origin, no trailing slash. Default: the gateway checkout URL, else the first CORS origin. */
  dashboardUrl?: string;
  breakGlass?: boolean;
  metricsToken?: string | null;
  smtp?: SmtpConfig | null;
  /** scrypt log2(N). */
  scryptLogN?: number;
  rateLimitPerMin?: number;
  setupPerMin?: number;
  emailPerHour?: number;
  /** Search queries per second per session (burst is twice this). */
  searchRps?: number;
  publicRpcUrl?: string | null;
  sessionIdlePlatformSec?: number;
  sessionIdleBusinessSec?: number;
  sessionAbsoluteSec?: number;
};

export type GatewayConfig = {
  /** Seed payout of the default merchant created at first boot; null when the operator creates merchants. */
  seedPayout: Address | null;
  platformName: string;
  /** Platform treasury for fees (PLATFORM_FEE_ADDRESS); null keeps every fee at zero. */
  feeRecipient: Address | null;
  /** PaymentRouter: the wallet method and gasless refunds pay through it (section 14.2). */
  paymentRouter: Address;
  /** Origin of the hosted checkout (the dashboard), no trailing slash. */
  checkoutBaseUrl: string;
  depositFactory: Address;
  /** Block the factory was deployed at: where the deposit watcher starts. */
  depositFactoryBlock: bigint;
  /** DepositForwarder implementation; read from the factory at boot when unknown. */
  forwarderImplementation: Address | null;
  checkoutTtlSec: number;
  /** false: webhook URLs must be https and resolve to public addresses only. */
  webhookAllowPrivate: boolean;
  watchIntervalMs: number;
  /** Minimum transaction count of a payer wallet (0 = off). */
  screenMinPayerNonce: number;
  /** HSP payment method (section 17); absent or null when HSP_MCP_URL is unset. */
  hsp?: HspMethodConfig | null;
};

export type HspMethodConfig = {
  /** HSP Agentic Payment MCP server (Streamable HTTP). */
  mcpUrl: string;
  /** Team reporting name, identical on every create_order and query_payment. */
  merchantName: string;
  /** query_payment interval for payments in flight; HashKey asks for 15 s. */
  pollIntervalMs: number;
};

export type ConfirmTag = "latest" | "safe" | "finalized";

export type TxPolicy = { bumpAfterBlocks: number; maxBumps: number; inclusionTimeoutSec: number };

export const DEFAULT_TX_POLICY: TxPolicy = { bumpAfterBlocks: 5, maxBumps: 5, inclusionTimeoutSec: 300 };

/** HashKey Chain books a settlement as final at the safe head (batch data posted to Ethereum); anvil has no reorgs. */
export function defaultConfirmTag(chainId: number): ConfirmTag {
  return LIVE_CHAIN_IDS.includes(chainId) ? "safe" : "latest";
}

export type RateLimitConfig = {
  provider: { rps: number; burst: number };
  ip: { rps: number; burst: number };
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { provider: { rps: 200, burst: 1000 }, ip: { rps: 100, burst: 1000 } };

const deploymentSchema = z.object({
  clearingHub: address,
  token: address.optional(),
  chainId: z.number().int(),
  blockNumber: z.number().int().nonnegative().optional(),
  depositFactory: address.optional(),
  depositFactoryBlock: z.number().int().nonnegative().optional(),
  depositForwarderImplementation: address.optional(),
  paymentRouter: address.optional(),
  paymentRouterBlock: z.number().int().nonnegative().optional(),
});

export type Deployment = z.infer<typeof deploymentSchema>;

export function readDeployment(chainId: number, dir = DEFAULT_DEPLOYMENTS_DIR): Deployment | null {
  const file = join(dir, `${chainId}.json`);
  if (!existsSync(file)) return null;
  const parsed = deploymentSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new ConfigError([`${file}: ${z.prettifyError(parsed.error)}`]);
  if (parsed.data.chainId !== chainId) throw new ConfigError([`${file}: chainId ${parsed.data.chainId} does not match ${chainId}`]);
  return parsed.data;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** Parses and validates the environment once at startup. Error messages name variables, never their values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = parsed.data;
  const net = networks[e.CHAIN_ID]!;
  const problems: string[] = [];
  const deployment = readDeployment(e.CHAIN_ID, e.DEPLOYMENTS_DIR ?? DEFAULT_DEPLOYMENTS_DIR);

  const hub = e.HUB_ADDRESS ?? deployment?.clearingHub ?? net.clearingHub;
  if (!hub) problems.push(`HUB_ADDRESS: required (no contracts/deployments/${e.CHAIN_ID}.json found)`);

  const zero = "0x0000000000000000000000000000000000000000";
  const defaultToken = net.token.address !== zero ? net.token.address : undefined;
  const token = e.TOKEN_ADDRESS ?? deployment?.token ?? defaultToken;
  if (!token) problems.push(`TOKEN_ADDRESS: required (no token in contracts/deployments/${e.CHAIN_ID}.json)`);

  if (e.HSP_MODE === "coordinator") {
    if (!e.HSP_COORDINATOR_URL) problems.push("HSP_COORDINATOR_URL: required when HSP_MODE=coordinator");
    if (!e.HSP_API_KEY) problems.push("HSP_API_KEY: required when HSP_MODE=coordinator");
    // HSP_CHAIN_NAME and HSP_VERIFYING_CONTRACT are optional: the node resolves both from GET /chains by chain id,
    // uses HSP_CHAIN_NAME only as a fallback, and refuses to start when the pinned contract differs.
  }
  const rpcUrl = e.RPC_URL ?? net.chain.rpcUrls.default.http[0];
  if (!rpcUrl) problems.push("RPC_URL: required");

  // Real-money chains: refuse the public dev defaults outright instead of trusting the operator to notice.
  const live = LIVE_CHAIN_IDS.includes(e.CHAIN_ID);
  if (live) {
    if (PUBLIC_DEV_KEYS.includes(e.OPERATOR_KEY.toLowerCase() as Hex)) {
      problems.push(`OPERATOR_KEY: is a public anvil/hardhat dev key; refusing to use it on chain ${e.CHAIN_ID}`);
    }
    if (e.PASSWORD_HASH_COST < 17) problems.push(`PASSWORD_HASH_COST: must be at least 17 on chain ${e.CHAIN_ID}`);
    if (e.PUBLIC_DASHBOARD_URL && !e.PUBLIC_DASHBOARD_URL.startsWith("https:")) problems.push(`PUBLIC_DASHBOARD_URL: must be https on chain ${e.CHAIN_ID}`);
    if (e.ADMIN_TOKEN === DEV_ADMIN_TOKEN) problems.push(`ADMIN_TOKEN: is the public dev token; refusing to use it on chain ${e.CHAIN_ID}`);
    else if (e.ADMIN_TOKEN.length < LIVE_ADMIN_TOKEN_MIN_LENGTH) {
      problems.push(`ADMIN_TOKEN: must be at least ${LIVE_ADMIN_TOKEN_MIN_LENGTH} characters on chain ${e.CHAIN_ID} (try: openssl rand -hex 32)`);
    }
  }

  // The revocation scan starts at the hub deployment block; scanning a live chain from genesis is not an option.
  const deployBlock = e.DEPLOY_BLOCK >= 0 ? e.DEPLOY_BLOCK : deployment?.blockNumber;
  if (deployBlock === undefined && live) {
    problems.push(`DEPLOY_BLOCK: required on chain ${e.CHAIN_ID} (no blockNumber in contracts/deployments/${e.CHAIN_ID}.json)`);
  }
  const gateway = gatewayConfig(e, deployment, live, deployBlock, problems);
  const agents = agentsConfig(e, live, !!gateway, problems);
  let smtp: SmtpConfig | null = null;
  try {
    smtp = smtpConfigFromEnv(env);
  } catch (err) {
    problems.push(`SMTP_URL: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (problems.length) throw new ConfigError(problems);

  return {
    port: e.PORT,
    host: e.HOST,
    chainId: e.CHAIN_ID,
    rpcUrl: rpcUrl!,
    hub: hub!,
    token: token!,
    operatorKey: e.OPERATOR_KEY,
    adminToken: e.ADMIN_TOKEN,
    dbPath: e.DB_PATH,
    settleIntervalSec: e.SETTLE_INTERVAL_SEC,
    settleMinCalls: e.SETTLE_MIN_CALLS,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    hsp: {
      mode: e.HSP_MODE,
      coordinatorUrl: e.HSP_COORDINATOR_URL?.replace(/\/+$/, ""),
      apiKey: e.HSP_API_KEY,
      chainName: e.HSP_CHAIN_NAME,
      verifyingContract: e.HSP_VERIFYING_CONTRACT ?? hub!,
      verifyingContractPinned: e.HSP_VERIFYING_CONTRACT !== undefined,
      requiredCapabilities: (e.HSP_REQUIRED_CAPABILITIES ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      cosignTimeoutSec: e.HSP_COSIGN_TIMEOUT_SEC,
    },
    confirmTag: e.CONFIRM_TAG ?? defaultConfirmTag(e.CHAIN_ID),
    tx: { bumpAfterBlocks: e.TX_BUMP_AFTER_BLOCKS, maxBumps: e.TX_MAX_BUMPS, inclusionTimeoutSec: e.TX_INCLUSION_TIMEOUT_SEC },
    rpcRetries: e.RPC_RETRIES,
    easAttest: e.EAS_ATTEST === "true",
    corsOrigins: (
      e.CORS_ORIGINS ??
      [...new Set([e.PUBLIC_DASHBOARD_URL, e.PUBLIC_CHECKOUT_URL, "http://localhost:3000"].filter((u): u is string => !!u).map((u) => new URL(u).origin))].join(",")
    ).split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    fundsRefreshSec: e.FUNDS_REFRESH_SEC,
    deployBlock: BigInt(deployBlock ?? 0),
    rpcFallbackUrls: e.RPC_FALLBACK_URLS ?? defaultFallbacks(e.CHAIN_ID),
    rateLimit: {
      provider: { rps: e.RATE_LIMIT_PROVIDER_RPS, burst: e.RATE_LIMIT_PROVIDER_BURST },
      ip: { rps: e.RATE_LIMIT_IP_RPS, burst: e.RATE_LIMIT_IP_BURST },
    },
    trustProxyHops: e.TRUST_PROXY_HOPS,
    denials: { dedupWindowSec: e.DENIAL_DEDUP_SEC, maxRows: e.DENIALS_MAX_ROWS },
    eventsMaxRows: e.EVENTS_MAX_ROWS,
    ...(gateway ? { gateway } : {}),
    agents,
    auth: {
      dashboardUrl: (e.PUBLIC_DASHBOARD_URL ?? e.PUBLIC_CHECKOUT_URL).replace(/\/+$/, ""),
      breakGlass: e.ADMIN_TOKEN_BREAK_GLASS === "true",
      metricsToken: e.METRICS_TOKEN ?? null,
      smtp,
      scryptLogN: e.PASSWORD_HASH_COST,
      rateLimitPerMin: e.AUTH_RATE_LIMIT_PER_MIN,
      publicRpcUrl: e.PUBLIC_RPC_URL ?? null,
    },
  };
}

/** The dashboard origin the account system uses (see AuthConfig.dashboardUrl). */
export function dashboardUrlOf(c: Config): string {
  const explicit = c.auth?.dashboardUrl ?? c.gateway?.checkoutBaseUrl ?? c.corsOrigins.find((o) => o !== "*") ?? "http://localhost:3000";
  return explicit.replace(/\/+$/, "");
}

/** Addresses of the public dev keys: never a payout on a real chain. */
const PUBLIC_DEV_ADDRESSES = new Set(PUBLIC_DEV_KEYS.map((k) => privateKeyToAccount(k).address.toLowerCase()));

function isLocalOrigin(u: string): boolean {
  const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host) || host === "0.0.0.0";
}

/** The gateway section, or undefined when GATEWAY_PAYOUT_ADDRESS is unset. Problems are appended, never thrown. */
function gatewayConfig(
  e: z.infer<typeof envSchema>,
  deployment: Deployment | null,
  live: boolean,
  hubDeployBlock: number | undefined,
  problems: string[],
): GatewayConfig | undefined {
  const payout = e.GATEWAY_PAYOUT_ADDRESS ?? null;
  const enabled = e.GATEWAY_ENABLED === undefined ? payout !== null : e.GATEWAY_ENABLED === "true";
  if (!enabled) return undefined;
  const n = problems.length;
  const operator = privateKeyToAccount(e.OPERATOR_KEY).address.toLowerCase();
  for (const [name, a] of [["GATEWAY_PAYOUT_ADDRESS", payout], ["PLATFORM_FEE_ADDRESS", e.PLATFORM_FEE_ADDRESS ?? null]] as const) {
    if (!a) continue;
    if (a === zeroAddress) problems.push(`${name}: must not be the zero address`);
    if (live && PUBLIC_DEV_ADDRESSES.has(a.toLowerCase())) problems.push(`${name}: belongs to a public anvil/hardhat dev key; refusing it on chain ${e.CHAIN_ID}`);
    if (live && a.toLowerCase() === operator) {
      problems.push(`${name}: must not be the operator wallet on chain ${e.CHAIN_ID} (the node must never hold merchant or platform funds)`);
    }
  }
  const factory = e.DEPOSIT_FACTORY_ADDRESS ?? deployment?.depositFactory;
  if (!factory) problems.push(`DEPOSIT_FACTORY_ADDRESS: required when the gateway is on (no depositFactory in contracts/deployments/${e.CHAIN_ID}.json)`);
  const router = e.PAYMENT_ROUTER_ADDRESS ?? deployment?.paymentRouter;
  if (!router) problems.push(`PAYMENT_ROUTER_ADDRESS: required when the gateway is on (no paymentRouter in contracts/deployments/${e.CHAIN_ID}.json)`);
  if (e.CHECKOUT_TTL_SECONDS > MAX_EXPIRES_IN_SECONDS) problems.push(`CHECKOUT_TTL_SECONDS: must be <= ${MAX_EXPIRES_IN_SECONDS}`);
  // An overridden factory has no known deploy block, so the watcher starts where the hub was deployed.
  const factoryBlock = e.DEPOSIT_FACTORY_ADDRESS ? hubDeployBlock : (deployment?.depositFactoryBlock ?? hubDeployBlock);
  const allowPrivate = e.WEBHOOK_ALLOW_PRIVATE === undefined ? !live : e.WEBHOOK_ALLOW_PRIVATE === "true";
  if (live) {
    if (allowPrivate) problems.push(`WEBHOOK_ALLOW_PRIVATE: refusing true on chain ${e.CHAIN_ID} (webhooks could reach private networks)`);
    const checkout = new URL(e.PUBLIC_CHECKOUT_URL);
    if (checkout.protocol !== "https:" || isLocalOrigin(e.PUBLIC_CHECKOUT_URL)) {
      problems.push(`PUBLIC_CHECKOUT_URL: must be a public https origin on chain ${e.CHAIN_ID}`);
    }
    if (factoryBlock === undefined) problems.push(`DEPOSIT_FACTORY_ADDRESS: no deploy block known on chain ${e.CHAIN_ID}; set DEPLOY_BLOCK`);
  }
  if (e.HSP_MCP_URL && !e.HSP_MERCHANT_NAME) problems.push("HSP_MERCHANT_NAME: required when HSP_MCP_URL is set (HashKey aggregates payments by this name)");
  if (problems.length > n) return undefined;
  const forwarderImplementation = e.DEPOSIT_FACTORY_ADDRESS ? null : (deployment?.depositForwarderImplementation ?? null);
  return {
    seedPayout: payout,
    platformName: e.PLATFORM_NAME,
    feeRecipient: e.PLATFORM_FEE_ADDRESS ?? null,
    paymentRouter: router!,
    checkoutBaseUrl: e.PUBLIC_CHECKOUT_URL.replace(/\/+$/, ""),
    depositFactory: factory!,
    depositFactoryBlock: BigInt(factoryBlock ?? 0),
    forwarderImplementation,
    checkoutTtlSec: e.CHECKOUT_TTL_SECONDS,
    webhookAllowPrivate: allowPrivate,
    watchIntervalMs: e.GATEWAY_WATCH_INTERVAL_MS,
    screenMinPayerNonce: e.SCREEN_MIN_PAYER_NONCE,
    hsp: e.HSP_MCP_URL ? { mcpUrl: e.HSP_MCP_URL, merchantName: e.HSP_MERCHANT_NAME!, pollIntervalMs: e.HSP_POLL_INTERVAL_MS } : null,
  };
}

/** The agents section. Problems are appended, never thrown; messages name variables, never their values. */
function agentsConfig(e: z.infer<typeof envSchema>, live: boolean, gatewayOn: boolean, problems: string[]): AgentsConfig {
  const explicit = e.AGENTS_ENABLED === undefined ? null : e.AGENTS_ENABLED === "true";
  if (explicit === true && !gatewayOn) problems.push("AGENTS_ENABLED: agents belong to businesses and need the gateway on (GATEWAY_PAYOUT_ADDRESS or GATEWAY_ENABLED=true)");
  const enabled = (explicit ?? !live) && gatewayOn;
  const version = e.AGENT_SECRETS_KEY_VERSION;
  const keys: Record<number, string> = {};
  let usingDevKey = false;
  const current = e.AGENT_SECRETS_KEY?.trim() || undefined;
  if (current) {
    try {
      parseSecretsKey(current);
      keys[version] = current;
    } catch (err) {
      problems.push(err instanceof Error ? err.message : "AGENT_SECRETS_KEY: invalid");
    }
  } else {
    keys[version] = DEV_AGENT_SECRETS_KEY;
    usingDevKey = true;
  }
  const previous = e.AGENT_SECRETS_KEY_PREVIOUS?.trim() || undefined;
  if (previous) {
    if (version < 2) problems.push("AGENT_SECRETS_KEY_PREVIOUS: set AGENT_SECRETS_KEY_VERSION to 2 or more when a previous key is kept");
    try {
      parseSecretsKey(previous, "AGENT_SECRETS_KEY_PREVIOUS");
      keys[version - 1] = previous;
    } catch (err) {
      problems.push(err instanceof Error ? err.message : "AGENT_SECRETS_KEY_PREVIOUS: invalid");
    }
  }
  if (live && enabled) {
    // Real-money chains: the businesses' model keys must be sealed with a key only this operator has.
    if (!current) problems.push(`AGENT_SECRETS_KEY: required on chain ${e.CHAIN_ID} while agents are on (try: openssl rand -base64 32), or set AGENTS_ENABLED=false`);
    else if (current === DEV_AGENT_SECRETS_KEY) problems.push(`AGENT_SECRETS_KEY: is the documented dev key; refusing to use it on chain ${e.CHAIN_ID}`);
    if (previous === DEV_AGENT_SECRETS_KEY) problems.push(`AGENT_SECRETS_KEY_PREVIOUS: is the documented dev key; refusing to use it on chain ${e.CHAIN_ID}`);
  }
  return {
    enabled,
    secretsKeys: keys,
    secretsKeyVersion: version,
    usingDevKey,
    allowPrivateModelUrls: e.AGENT_ALLOW_PRIVATE_MODEL_URLS === "true",
    workers: e.AGENT_WORKERS,
    maxPerMerchant: e.AGENT_MAX_PER_MERCHANT,
    pollMs: e.AGENT_POLL_MS,
  };
}

/** Config summary that is safe to log or expose: no keys, no tokens. */
export function redactedConfig(c: Config) {
  return {
    port: c.port,
    chainId: c.chainId,
    host: c.host,
    rpcUrl: redactUrl(c.rpcUrl),
    rpcFallbackUrls: c.rpcFallbackUrls.map(redactUrl),
    deployBlock: c.deployBlock.toString(),
    rateLimit: c.rateLimit,
    trustProxyHops: c.trustProxyHops,
    hub: c.hub,
    token: c.token,
    dbPath: c.dbPath,
    settleIntervalSec: c.settleIntervalSec,
    settleMinCalls: c.settleMinCalls,
    publicUrl: c.publicUrl,
    hspMode: c.hsp.mode,
    hspCoordinatorUrl: c.hsp.coordinatorUrl,
    hspVerifyingContract: c.hsp.verifyingContract,
    hspCosignTimeoutSec: c.hsp.cosignTimeoutSec,
    confirmTag: c.confirmTag ?? defaultConfirmTag(c.chainId),
    tx: c.tx ?? DEFAULT_TX_POLICY,
    easAttest: c.easAttest ?? false,
    corsOrigins: c.corsOrigins,
    auth: c.auth
      ? {
          dashboardUrl: c.auth.dashboardUrl,
          breakGlass: c.auth.breakGlass ?? false,
          smtp: c.auth.smtp ? { host: c.auth.smtp.host, port: c.auth.smtp.port, from: c.auth.smtp.from } : null,
          scryptLogN: c.auth.scryptLogN,
          publicRpcUrl: c.auth.publicRpcUrl ? redactUrl(c.auth.publicRpcUrl) : null,
        }
      : null,
    gateway: c.gateway
      ? {
          seedPayout: c.gateway.seedPayout,
          feeRecipient: c.gateway.feeRecipient,
          paymentRouter: c.gateway.paymentRouter,
          checkoutBaseUrl: c.gateway.checkoutBaseUrl,
          depositFactory: c.gateway.depositFactory,
          depositFactoryBlock: c.gateway.depositFactoryBlock.toString(),
          checkoutTtlSec: c.gateway.checkoutTtlSec,
          webhookAllowPrivate: c.gateway.webhookAllowPrivate,
          hsp: c.gateway.hsp ? { mcpUrl: redactUrl(c.gateway.hsp.mcpUrl), merchantName: c.gateway.hsp.merchantName } : null,
        }
      : null,
    agents: (() => {
      const a = agentsConfigOf(c);
      return {
        enabled: a.enabled,
        secretsKeyVersion: a.secretsKeyVersion,
        secretsKeyVersions: Object.keys(a.secretsKeys).map(Number),
        usingDevKey: a.usingDevKey,
        allowPrivateModelUrls: a.allowPrivateModelUrls,
        workers: a.workers,
        maxPerMerchant: a.maxPerMerchant,
        pollMs: a.pollMs,
      };
    })(),
  };
}

/** Hides basic-auth credentials and API keys in RPC URL paths or queries (many providers put the key there). */
function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    const hasSecret = url.username || url.password || url.search || /[0-9a-f]{16,}|[A-Za-z0-9_-]{24,}/.test(url.pathname);
    return hasSecret ? `${url.protocol}//${url.host}/***` : u;
  } catch {
    return "***";
  }
}

function defaultFallbacks(chainId: number): string[] {
  const facts = (hashkeyNetworkFacts as Record<number, { fallbackRpcUrls: readonly string[] } | undefined>)[chainId];
  return facts ? [...facts.fallbackRpcUrls] : [];
}
