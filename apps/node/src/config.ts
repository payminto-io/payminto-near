import { z } from "zod";
import { DEFAULT_CHECKOUT_TTL_SECONDS, MAX_EXPIRES_IN_SECONDS, MIN_EXPIRES_IN_SECONDS, isAccountId, networks, type AccountId as Address, type Network } from "@payminto/protocol";
import { smtpConfigFromEnv, type SmtpConfig } from "./auth/mailer.ts";
import { DEV_AGENT_SECRETS_KEY, parseSecretsKey } from "./agents/secrets.ts";

const account = z.string().refine((v) => isAccountId(v), "must be a NEAR account id");
const seedHex = z.string().regex(/^[0-9a-f]{64}$/, "must be 32 bytes as 64 lowercase hex characters");

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

/** Public networks, where keys and tokens are exposed to the world: dev defaults are refused there. */
export const LIVE_NETWORKS: readonly Network[] = ["near:testnet"];

/** The node signing seed in .env.example. Public, so it is refused on a live network. */
export const DEV_NODE_SEED = "11".repeat(32);

/** The local dev admin token used by scripts/dev-local.sh, the demo and .env.example. */
export const DEV_ADMIN_TOKEN = "dev-admin-token";
export const LIVE_ADMIN_TOKEN_MIN_LENGTH = 32;

/**
 * FUNDS_MAX_AGE_MS: the oldest hub snapshot (escrow, credit, revoked or not) a call may be decided on. Older snapshots
 * are re-read first, and if that read fails the call is refused. It bounds how long an on-chain revoke or a drained
 * escrow can go unseen, so it is kept short and capped.
 */
export const DEFAULT_FUNDS_MAX_AGE_MS = 10_000;
export const MAX_FUNDS_MAX_AGE_MS = 60_000;

/** Unsigned vouchers are never legitimate traffic, so their bucket is far smaller than the provider bucket. */
export const DEFAULT_UNSIGNED_LIMIT = { rps: 5, burst: 50 } as const;

const envSchema = z.object({
  PORT: intFromEnv(8787),
  // Loopback by default: expose the node through a reverse proxy (docs/OPERATIONS.md). The Docker image sets 0.0.0.0.
  HOST: z.string().min(1).default("127.0.0.1"),
  NETWORK: z.enum(["near:testnet", "near:sandbox"]).default("near:sandbox"),
  RPC_URL: z.url().optional(),
  HUB_ACCOUNT: account,
  TOKEN_ACCOUNT: account.optional(),
  // The account that settles. Budgets name it as `settler`.
  OPERATOR_ACCOUNT: account,
  // Its function-call key, limited to settle_batch and payout on the hub.
  OPERATOR_KEY: z
    .string()
    .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/, "must be a NEAR ed25519 secret key: ed25519: followed by base58"),
  // Seed of the ed25519 key that signs per-call acceptance receipts and checkout terms. Not a NEAR account key.
  NODE_SIGNING_SEED: seedHex,
  ADMIN_TOKEN: z.string().min(12, "must be at least 12 characters"),
  DB_PATH: z.string().min(1).default("./data/clearing.db"),
  SETTLE_INTERVAL_SEC: intFromEnv(0),
  SETTLE_MIN_CALLS: intFromEnv(1, 1),
  // Pays out hub credit to the node's creditors this often (0 = only on POST /v1/payouts).
  PAYOUT_INTERVAL_SEC: intFromEnv(300),
  PUBLIC_URL: z.url().default("http://localhost:8787"),
  // Default: the dashboard origin (PUBLIC_DASHBOARD_URL, PUBLIC_CHECKOUT_URL) plus http://localhost:3000.
  CORS_ORIGINS: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  FUNDS_REFRESH_SEC: intFromEnv(30, 1),
  // Oldest hub snapshot a call may be decided on; past it the node re-reads the hub and refuses if it cannot.
  FUNDS_MAX_AGE_MS: intFromEnv(DEFAULT_FUNDS_MAX_AGE_MS, 500).refine((n) => n <= MAX_FUNDS_MAX_AGE_MS, `must be <= ${MAX_FUNDS_MAX_AGE_MS}`),
  // Token buckets (requests per second, burst). 0 rps disables that limiter. Agents read their position before every
  // paid call, so one agent host legitimately makes about as many public reads as it makes calls.
  RATE_LIMIT_PROVIDER_RPS: intFromEnv(200),
  RATE_LIMIT_PROVIDER_BURST: intFromEnv(1000, 1),
  RATE_LIMIT_IP_RPS: intFromEnv(100),
  RATE_LIMIT_IP_BURST: intFromEnv(1000, 1),
  // Vouchers that are not signed by their Budget's agent key, per provider key (and per IP on the public pay routes).
  // They are answered with a plain error and never recorded; past this bucket the answer is 429.
  RATE_LIMIT_UNSIGNED_RPS: intFromEnv(DEFAULT_UNSIGNED_LIMIT.rps),
  RATE_LIMIT_UNSIGNED_BURST: intFromEnv(DEFAULT_UNSIGNED_LIMIT.burst, 1),
  // Number of reverse proxies in front of the node whose X-Forwarded-For entries are trusted. 0 uses the socket address.
  TRUST_PROXY_HOPS: intFromEnv(0),
  // Identical denials within this window are folded into one row with a repeat count.
  DENIAL_DEDUP_SEC: intFromEnv(60),
  // Oldest denial rows beyond this count are pruned periodically.
  DENIALS_MAX_ROWS: intFromEnv(100_000, 1_000),
  // Oldest rows of the SSE replay log beyond this count are pruned periodically.
  EVENTS_MAX_ROWS: intFromEnv(200_000, 1_000),
  // Payminto Gateway (docs/GATEWAY.md sections 11 and 14). GATEWAY_PAYOUT_ACCOUNT seeds the default merchant's payout
  // at first boot; GATEWAY_ENABLED=true turns the gateway on without one (operator creates merchants).
  GATEWAY_PAYOUT_ACCOUNT: account.optional(),
  GATEWAY_ENABLED: z.enum(["true", "false"]).optional(),
  PLATFORM_NAME: z.string().trim().min(1).max(120).default("Payminto"),
  // Platform treasury that receives platform and method fees; required before any fee can be non-zero.
  PLATFORM_FEE_ACCOUNT: account.optional(),
  PUBLIC_CHECKOUT_URL: z.url().default("http://localhost:3000"),
  CHECKOUT_TTL_SECONDS: intFromEnv(DEFAULT_CHECKOUT_TTL_SECONDS, MIN_EXPIRES_IN_SECONDS),
  WEBHOOK_ALLOW_PRIVATE: z.enum(["true", "false"]).optional(),
  GATEWAY_WATCH_INTERVAL_MS: intFromEnv(2_000, 250),
  // Accounts (docs/PRODUCT.md sections 4 and 10). The dashboard origin: links in emails, the CSRF Origin check and the
  // cookie's Secure flag. Defaults to PUBLIC_CHECKOUT_URL (the dashboard serves the checkout).
  PUBLIC_DASHBOARD_URL: z.url().optional(),
  // The recovery key (ADMIN_TOKEN) keeps working after setup only with this set; every use is audited.
  ADMIN_TOKEN_BREAK_GLASS: z.enum(["true", "false"]).default("false"),
  // A separate Prometheus scrape token; ADMIN_TOKEN also works for /metrics.
  METRICS_TOKEN: z.string().min(16, "must be at least 16 characters").optional(),
  // scrypt cost as log2(N); 17 by default and the minimum on NEAR testnet.
  PASSWORD_HASH_COST: intFromEnv(17, 14),
  // Auth requests per minute per IP across /v1/auth/*, /v1/setup* and the invite routes.
  AUTH_RATE_LIMIT_PER_MIN: intFromEnv(20, 1),
  // The JSON-RPC a browser wallet should use (served as network.rpc_url); defaults to the chain's public RPC.
  PUBLIC_RPC_URL: z.url().optional(),
  // Merchant AI agents (docs/AGENTS.md). On by default on local chains when the gateway is on; off by default on
  // NEAR testnet. AGENT_SECRETS_KEY (base64, 32 bytes) seals the businesses' model API keys.
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
  // The payee check (packages/payee-check): judges every payee as allow, warn or block before a Budget pays it.
  PAYEE_CHECK: z.enum(["on", "off"]).default("on"),
  // Where account ages come from. nearblocks on near:testnet; a local chain has no indexer, so off there.
  PAYEE_CHECK_INDEXER: z.enum(["nearblocks", "off"]).optional(),
  // Optional NearBlocks API key, sent as a bearer token. The keyless tier is rate limited.
  PAYEE_CHECK_INDEXER_KEY: z.string().min(8, "must be at least 8 characters").max(200).optional(),
  // Any-chain checkout through NEAR Intents (docs/DEVELOPERS.md, "Any-chain checkout"). Off by default; simulated runs
  // against the fake 1Click server; live moves real money on NEAR mainnet and is only ever turned on by the operator.
  INTENTS_CHECKOUT: z.enum(["off", "simulated", "live"]).default("off"),
  ONECLICK_BASE_URL: z.url().optional(),
  // Live mode refuses any 1Click URL but the published one unless this is true.
  ONECLICK_ALLOW_CUSTOM_URL: z.enum(["true", "false"]).default("false"),
  ONECLICK_API_KEY: z.string().min(8, "must be at least 8 characters").max(4000).optional(),
  // Simulated mode only: the fake server's test key. Live mode always checks quotes against the published 1Click key.
  ONECLICK_MANAGER_PUBLIC_KEY: z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/, "must be ed25519:<base58>").optional(),
  // Where the node reads deliveries and merchant accounts: NEAR mainnet live, the local chain when simulated.
  NEAR_MAINNET_RPC_URL: z.url().optional(),
  // Simulated mode only: the NEP-141 that stands in for native USDC on the local chain.
  INTENTS_USDC_CONTRACT: account.optional(),
  // Accounts that may sign 1Click's delivery transactions (NEAR RPC needs a sender to find a transaction), comma separated.
  INTENTS_DELIVERY_SENDERS: z.string().optional(),
  // 1Click asset ids buyers may pay with, comma separated; default every offered origin.
  INTENTS_ORIGINS: z.string().optional(),
  INTENTS_SLIPPAGE_STABLE_BPS: intFromEnv(10).refine((n) => n <= 10_000, "must be <= 10000"),
  INTENTS_SLIPPAGE_VOLATILE_BPS: intFromEnv(100).refine((n) => n <= 10_000, "must be <= 10000"),
  INTENTS_REFERRAL: z
    .string()
    .regex(/^(?:[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/, "lowercase letters and digits with single - _ or . between them")
    .max(57)
    .default("payminto"),
});

/** The published 1Click base URL. Live mode uses it unless ONECLICK_ALLOW_CUSTOM_URL=true. */
export const ONECLICK_LIVE_URL = "https://1click.chaindefuser.com";
export const NEAR_MAINNET_RPC = "https://rpc.mainnet.near.org";

export type Config = {
  port: number;
  host: string;
  network: Network;
  rpcUrl: string;
  hub: Address;
  token: Address;
  /** The account that settles. */
  operator: Address;
  operatorKey: string;
  /** 32-byte hex seed of the node's receipt and checkout signing key. */
  nodeSigningSeed: string;
  adminToken: string;
  dbPath: string;
  settleIntervalSec: number;
  settleMinCalls: number;
  /** Seconds between scheduled payouts of hub credit; 0 or absent pays out only on demand. */
  payoutIntervalSec?: number;
  publicUrl: string;
  corsOrigins: string[];
  logLevel: "debug" | "info" | "warn" | "error";
  fundsRefreshSec: number;
  /** FUNDS_MAX_AGE_MS; absent means DEFAULT_FUNDS_MAX_AGE_MS. */
  fundsMaxAgeMs?: number;
  rateLimit: RateLimitConfig;
  /** Trusted reverse-proxy hops for X-Forwarded-For. */
  trustProxyHops: number;
  denials: { dedupWindowSec: number; maxRows: number };
  eventsMaxRows: number;
  /** Payminto Gateway; absent when GATEWAY_PAYOUT_ACCOUNT is unset (gateway off). */
  gateway?: GatewayConfig;
  /** Accounts; every field has a default, so a Config built in code may leave it out. */
  auth?: AuthConfig;
  /** Merchant AI agents; absent means the defaults for the chain (see agentsConfigOf). */
  agents?: AgentsConfig;
  /** The payee check; absent means the defaults for the chain (see payeeCheckConfigOf). */
  payeeCheck?: PayeeCheckConfig;
};

export type PayeeCheckConfig = {
  /** PAYEE_CHECK. Off: vouchers are judged by the Budget alone, and the check route says how to turn it on. */
  enabled: boolean;
  /** PAYEE_CHECK_INDEXER: where account ages come from. `off` leaves the age unchecked, and a verdict says so. */
  indexer: "nearblocks" | "off";
  /** PAYEE_CHECK_INDEXER_KEY. Never logged. */
  indexerKey: string | null;
};

/** The payee check section with defaults filled in: on, with the NearBlocks indexer on testnet and none on a local chain. */
export function payeeCheckConfigOf(c: Pick<Config, "payeeCheck" | "network">): PayeeCheckConfig {
  return c.payeeCheck ?? { enabled: true, indexer: LIVE_NETWORKS.includes(c.network) ? "nearblocks" : "off", indexerKey: null };
}

export type AgentsConfig = {
  enabled: boolean;
  /** Base64 server keys by version (AGENT_SECRETS_KEY and AGENT_SECRETS_KEY_PREVIOUS). Never logged. */
  secretsKeys: Record<number, string>;
  /** The version new secrets are sealed with. */
  secretsKeyVersion: number;
  /** True when AGENT_SECRETS_KEY was unset and the documented dev key is in use (refused on NEAR testnet). */
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

/** The agents section with defaults filled in: on locally with the dev key, off on NEAR testnet. */
export function agentsConfigOf(c: Pick<Config, "agents" | "network" | "gateway">): AgentsConfig {
  if (c.agents) return c.agents;
  return {
    enabled: !LIVE_NETWORKS.includes(c.network) && !!c.gateway,
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
  /** Platform treasury for fees (PLATFORM_FEE_ACCOUNT); null keeps every fee at zero. */
  feeRecipient: Address | null;
  /** Origin of the hosted checkout (the dashboard), no trailing slash. */
  checkoutBaseUrl: string;
  checkoutTtlSec: number;
  /** false: webhook URLs must be https and resolve to public addresses only. */
  webhookAllowPrivate: boolean;
  watchIntervalMs: number;
  /** The any-chain checkout (INTENTS_CHECKOUT); absent when it is off. */
  intents?: IntentsConfig;
};

/** INTENTS_CHECKOUT=simulated|live and its settings. The node loads @payminto/near-addons only when this is present. */
export type IntentsConfig = {
  mode: "simulated" | "live";
  /** The 1Click API: the published URL live, the fake server's simulated. */
  baseUrl: string;
  apiKey: string | null;
  /** Null: the published 1Click manager key (always, live). Simulated: the fake server's test key. */
  managerPublicKey: string | null;
  /** NEAR mainnet live; the local chain the fake server delivers on, simulated. */
  nearRpcUrl: string;
  /** Null: native USDC on NEAR mainnet (always, live). Simulated: the local token that stands in for it. */
  usdcContract: Address | null;
  /** Accounts tried as the sender when reading a delivery transaction. */
  deliverySenders: Address[];
  /** Asset ids buyers may pay with; null for every offered origin. */
  origins: string[] | null;
  slippage: { stable: number; volatile: number };
  referral: string | null;
};

export type RateLimitConfig = {
  provider: { rps: number; burst: number };
  ip: { rps: number; burst: number };
  /** Vouchers not signed by their Budget's agent key, per provider key or client IP. Default: DEFAULT_UNSIGNED_LIMIT. */
  unsigned?: { rps: number; burst: number };
};

export const DEFAULT_RATE_LIMIT: RateLimitConfig = { provider: { rps: 200, burst: 1000 }, ip: { rps: 100, burst: 1000 } };

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
  const net = networks[e.NETWORK]!;
  const problems: string[] = [];

  // Public networks: refuse the public dev defaults outright instead of trusting the operator to notice.
  const live = LIVE_NETWORKS.includes(e.NETWORK);
  if (live) {
    if (e.NODE_SIGNING_SEED === DEV_NODE_SEED) problems.push(`NODE_SIGNING_SEED: is the public dev seed; refusing to use it on ${e.NETWORK}`);
    if (e.PASSWORD_HASH_COST < 17) problems.push(`PASSWORD_HASH_COST: must be at least 17 on ${e.NETWORK}`);
    if (e.PUBLIC_DASHBOARD_URL && !e.PUBLIC_DASHBOARD_URL.startsWith("https:")) problems.push(`PUBLIC_DASHBOARD_URL: must be https on ${e.NETWORK}`);
    if (e.ADMIN_TOKEN === DEV_ADMIN_TOKEN) problems.push(`ADMIN_TOKEN: is the public dev token; refusing to use it on ${e.NETWORK}`);
    else if (e.ADMIN_TOKEN.length < LIVE_ADMIN_TOKEN_MIN_LENGTH) {
      problems.push(`ADMIN_TOKEN: must be at least ${LIVE_ADMIN_TOKEN_MIN_LENGTH} characters on ${e.NETWORK} (try: openssl rand -hex 32)`);
    }
  }
  const gateway = gatewayConfig(e, live, problems);
  if (e.INTENTS_CHECKOUT !== "off" && !gateway && !problems.length) problems.push("INTENTS_CHECKOUT: the any-chain checkout belongs to the gateway; turn it on (GATEWAY_PAYOUT_ACCOUNT or GATEWAY_ENABLED=true)");
  const agents = agentsConfig(e, live, !!gateway, problems);
  // NearBlocks indexes testnet and mainnet. Asking it about a local chain would judge other people's accounts.
  if (e.PAYEE_CHECK_INDEXER === "nearblocks" && !live) problems.push(`PAYEE_CHECK_INDEXER: nearblocks has no index of ${e.NETWORK}; use off (the default there)`);
  const payeeCheck: PayeeCheckConfig = { enabled: e.PAYEE_CHECK === "on", indexer: e.PAYEE_CHECK_INDEXER ?? (live ? "nearblocks" : "off"), indexerKey: e.PAYEE_CHECK_INDEXER_KEY ?? null };
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
    network: e.NETWORK,
    rpcUrl: e.RPC_URL ?? net.rpcUrl,
    hub: e.HUB_ACCOUNT,
    token: e.TOKEN_ACCOUNT ?? net.token.address,
    operator: e.OPERATOR_ACCOUNT,
    operatorKey: e.OPERATOR_KEY,
    nodeSigningSeed: e.NODE_SIGNING_SEED,
    adminToken: e.ADMIN_TOKEN,
    dbPath: e.DB_PATH,
    settleIntervalSec: e.SETTLE_INTERVAL_SEC,
    settleMinCalls: e.SETTLE_MIN_CALLS,
    payoutIntervalSec: e.PAYOUT_INTERVAL_SEC,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ""),
    corsOrigins: (
      e.CORS_ORIGINS ??
      [...new Set([e.PUBLIC_DASHBOARD_URL, e.PUBLIC_CHECKOUT_URL, "http://localhost:3000"].filter((u): u is string => !!u).map((u) => new URL(u).origin))].join(",")
    ).split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    logLevel: e.LOG_LEVEL,
    fundsRefreshSec: e.FUNDS_REFRESH_SEC,
    fundsMaxAgeMs: e.FUNDS_MAX_AGE_MS,
    rateLimit: {
      provider: { rps: e.RATE_LIMIT_PROVIDER_RPS, burst: e.RATE_LIMIT_PROVIDER_BURST },
      ip: { rps: e.RATE_LIMIT_IP_RPS, burst: e.RATE_LIMIT_IP_BURST },
      unsigned: { rps: e.RATE_LIMIT_UNSIGNED_RPS, burst: e.RATE_LIMIT_UNSIGNED_BURST },
    },
    trustProxyHops: e.TRUST_PROXY_HOPS,
    denials: { dedupWindowSec: e.DENIAL_DEDUP_SEC, maxRows: e.DENIALS_MAX_ROWS },
    eventsMaxRows: e.EVENTS_MAX_ROWS,
    ...(gateway ? { gateway } : {}),
    agents,
    payeeCheck,
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

function isLocalOrigin(u: string): boolean {
  const host = new URL(u).hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host) || host === "0.0.0.0";
}

/** The gateway section, or undefined when GATEWAY_PAYOUT_ACCOUNT is unset. Problems are appended, never thrown. */
function gatewayConfig(e: z.infer<typeof envSchema>, live: boolean, problems: string[]): GatewayConfig | undefined {
  const payout = e.GATEWAY_PAYOUT_ACCOUNT ?? null;
  const enabled = e.GATEWAY_ENABLED === undefined ? payout !== null : e.GATEWAY_ENABLED === "true";
  if (!enabled) return undefined;
  const n = problems.length;
  for (const [name, a] of [["GATEWAY_PAYOUT_ACCOUNT", payout], ["PLATFORM_FEE_ACCOUNT", e.PLATFORM_FEE_ACCOUNT ?? null]] as const) {
    if (a && live && a === e.OPERATOR_ACCOUNT) problems.push(`${name}: must not be the operator account on ${e.NETWORK} (the node must never hold merchant or platform funds)`);
  }
  if (e.CHECKOUT_TTL_SECONDS > MAX_EXPIRES_IN_SECONDS) problems.push(`CHECKOUT_TTL_SECONDS: must be <= ${MAX_EXPIRES_IN_SECONDS}`);
  const allowPrivate = e.WEBHOOK_ALLOW_PRIVATE === undefined ? !live : e.WEBHOOK_ALLOW_PRIVATE === "true";
  if (live) {
    if (allowPrivate) problems.push(`WEBHOOK_ALLOW_PRIVATE: refusing true on ${e.NETWORK} (webhooks could reach private networks)`);
    const checkout = new URL(e.PUBLIC_CHECKOUT_URL);
    if (checkout.protocol !== "https:" || isLocalOrigin(e.PUBLIC_CHECKOUT_URL)) problems.push(`PUBLIC_CHECKOUT_URL: must be a public https origin on ${e.NETWORK}`);
  }
  const intents = intentsConfig(e, problems);
  if (problems.length > n) return undefined;
  return {
    seedPayout: payout,
    platformName: e.PLATFORM_NAME,
    feeRecipient: e.PLATFORM_FEE_ACCOUNT ?? null,
    checkoutBaseUrl: e.PUBLIC_CHECKOUT_URL.replace(/\/+$/, ""),
    checkoutTtlSec: e.CHECKOUT_TTL_SECONDS,
    webhookAllowPrivate: allowPrivate,
    watchIntervalMs: e.GATEWAY_WATCH_INTERVAL_MS,
    ...(intents ? { intents } : {}),
  };
}

/**
 * The any-chain checkout section. Live mode is reachable only with INTENTS_CHECKOUT=live, and then refuses everything
 * that could make a simulated quote pass as a real one: a test manager key, another 1Click URL (unless explicitly
 * allowed), a stand-in USDC, and a plain-http RPC. Problems are appended, never thrown.
 */
function intentsConfig(e: z.infer<typeof envSchema>, problems: string[]): IntentsConfig | undefined {
  const mode = e.INTENTS_CHECKOUT;
  const simulatedOnly: Array<[string, unknown]> = [
    ["ONECLICK_MANAGER_PUBLIC_KEY", e.ONECLICK_MANAGER_PUBLIC_KEY],
    ["INTENTS_USDC_CONTRACT", e.INTENTS_USDC_CONTRACT],
  ];
  if (mode === "off") return undefined;
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const senders = list(e.INTENTS_DELIVERY_SENDERS);
  for (const s of senders) if (!isAccountId(s)) problems.push("INTENTS_DELIVERY_SENDERS: every entry must be a NEAR account id");
  const origins = list(e.INTENTS_ORIGINS);
  // Amounts pass through as USDC base units, so the node's token must have USDC's 6 decimals.
  if (networks[e.NETWORK]!.token.decimals !== 6) problems.push(`INTENTS_CHECKOUT: needs a 6-decimal token on ${e.NETWORK}`);
  if (mode === "live") {
    for (const [name, v] of simulatedOnly) if (v !== undefined) problems.push(`${name}: only for INTENTS_CHECKOUT=simulated; live mode always uses the published 1Click key and native USDC`);
    const base = e.ONECLICK_BASE_URL ?? ONECLICK_LIVE_URL;
    if (!base.startsWith("https:")) problems.push("ONECLICK_BASE_URL: must be https in live mode");
    else if (base.replace(/\/+$/, "") !== ONECLICK_LIVE_URL && e.ONECLICK_ALLOW_CUSTOM_URL !== "true") problems.push(`ONECLICK_BASE_URL: live mode uses ${ONECLICK_LIVE_URL}; set ONECLICK_ALLOW_CUSTOM_URL=true to use another`);
    const rpc = e.NEAR_MAINNET_RPC_URL ?? NEAR_MAINNET_RPC;
    if (!rpc.startsWith("https:")) problems.push("NEAR_MAINNET_RPC_URL: must be https in live mode");
    return {
      mode,
      baseUrl: base.replace(/\/+$/, ""),
      apiKey: e.ONECLICK_API_KEY ?? null,
      managerPublicKey: null,
      nearRpcUrl: rpc,
      usdcContract: null,
      deliverySenders: senders,
      origins: origins.length ? origins : null,
      slippage: { stable: e.INTENTS_SLIPPAGE_STABLE_BPS, volatile: e.INTENTS_SLIPPAGE_VOLATILE_BPS },
      referral: e.INTENTS_REFERRAL || null,
    };
  }
  // Simulated: everything points at the fake server and the local chain, named explicitly.
  if (!e.ONECLICK_BASE_URL) problems.push("ONECLICK_BASE_URL: required with INTENTS_CHECKOUT=simulated (the fake 1Click server)");
  else if (e.ONECLICK_BASE_URL.replace(/\/+$/, "") === ONECLICK_LIVE_URL) problems.push("ONECLICK_BASE_URL: simulated mode never talks to the live 1Click API; point it at the fake server");
  if (!e.ONECLICK_MANAGER_PUBLIC_KEY) problems.push("ONECLICK_MANAGER_PUBLIC_KEY: required with INTENTS_CHECKOUT=simulated (the fake server's test key)");
  if (!e.NEAR_MAINNET_RPC_URL) problems.push("NEAR_MAINNET_RPC_URL: required with INTENTS_CHECKOUT=simulated (the local chain the fake server delivers on)");
  if (!e.INTENTS_USDC_CONTRACT) problems.push("INTENTS_USDC_CONTRACT: required with INTENTS_CHECKOUT=simulated (the token the fake server delivers)");
  if (!e.ONECLICK_BASE_URL || !e.ONECLICK_MANAGER_PUBLIC_KEY || !e.NEAR_MAINNET_RPC_URL || !e.INTENTS_USDC_CONTRACT) return undefined;
  return {
    mode,
    baseUrl: e.ONECLICK_BASE_URL.replace(/\/+$/, ""),
    apiKey: e.ONECLICK_API_KEY ?? null,
    managerPublicKey: e.ONECLICK_MANAGER_PUBLIC_KEY,
    nearRpcUrl: e.NEAR_MAINNET_RPC_URL,
    usdcContract: e.INTENTS_USDC_CONTRACT,
    deliverySenders: senders,
    origins: origins.length ? origins : null,
    slippage: { stable: e.INTENTS_SLIPPAGE_STABLE_BPS, volatile: e.INTENTS_SLIPPAGE_VOLATILE_BPS },
    referral: e.INTENTS_REFERRAL || null,
  };
}

/** The agents section. Problems are appended, never thrown; messages name variables, never their values. */
function agentsConfig(e: z.infer<typeof envSchema>, live: boolean, gatewayOn: boolean, problems: string[]): AgentsConfig {
  const explicit = e.AGENTS_ENABLED === undefined ? null : e.AGENTS_ENABLED === "true";
  if (explicit === true && !gatewayOn) problems.push("AGENTS_ENABLED: agents belong to businesses and need the gateway on (GATEWAY_PAYOUT_ACCOUNT or GATEWAY_ENABLED=true)");
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
    if (!current) problems.push(`AGENT_SECRETS_KEY: required on ${e.NETWORK} while agents are on (try: openssl rand -base64 32), or set AGENTS_ENABLED=false`);
    else if (current === DEV_AGENT_SECRETS_KEY) problems.push(`AGENT_SECRETS_KEY: is the documented dev key; refusing to use it on ${e.NETWORK}`);
    if (previous === DEV_AGENT_SECRETS_KEY) problems.push(`AGENT_SECRETS_KEY_PREVIOUS: is the documented dev key; refusing to use it on ${e.NETWORK}`);
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
    network: c.network,
    host: c.host,
    rpcUrl: redactUrl(c.rpcUrl),
    rateLimit: c.rateLimit,
    trustProxyHops: c.trustProxyHops,
    hub: c.hub,
    token: c.token,
    operator: c.operator,
    dbPath: c.dbPath,
    settleIntervalSec: c.settleIntervalSec,
    settleMinCalls: c.settleMinCalls,
    fundsMaxAgeMs: c.fundsMaxAgeMs ?? DEFAULT_FUNDS_MAX_AGE_MS,
    payoutIntervalSec: c.payoutIntervalSec ?? 0,
    publicUrl: c.publicUrl,
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
          checkoutBaseUrl: c.gateway.checkoutBaseUrl,
          checkoutTtlSec: c.gateway.checkoutTtlSec,
          webhookAllowPrivate: c.gateway.webhookAllowPrivate,
          intents: c.gateway.intents
            ? {
                mode: c.gateway.intents.mode,
                baseUrl: redactUrl(c.gateway.intents.baseUrl),
                apiKey: c.gateway.intents.apiKey ? "set" : null,
                managerKey: c.gateway.intents.managerPublicKey ? "test" : "1click",
                nearRpcUrl: redactUrl(c.gateway.intents.nearRpcUrl),
                usdcContract: c.gateway.intents.usdcContract,
              }
            : { mode: "off" },
        }
      : null,
    payeeCheck: (() => {
      const p = payeeCheckConfigOf(c);
      return { enabled: p.enabled, indexer: p.indexer, indexerKey: p.indexerKey ? "set" : null };
    })(),
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
