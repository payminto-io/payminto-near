import { z } from "zod";
import { isAccountId, type AccountId } from "@payminto/chain";
import { gasless, RPC_URLS } from "@payminto/near-addons";

/** The networks this submission runs on. There is no mainnet mode. */
export type RelayerNetwork = "near:testnet" | "near:sandbox";

export const DEFAULT_RPC_URLS: Record<RelayerNetwork, string> = {
  "near:testnet": RPC_URLS.testnet,
  "near:sandbox": "http://127.0.0.1:3030",
};

/** One transaction cannot carry more gas than this on NEAR. */
export const PROTOCOL_MAX_TGAS = 300;
export const TGAS = 1_000_000_000_000n;
export const YOCTO_PER_NEAR = 10n ** 24n;

export type BucketConfig = { perMin: number; burst: number };

/**
 * Everything the HTTP app needs. It holds no key: `createRelayerApp` can be mounted in another service without the
 * relayer's secret ever entering that service's request path.
 */
export type RelayerAppConfig = {
  network: RelayerNetwork;
  /** The account that signs the outer transaction and pays the gas. */
  relayer: AccountId;
  /** The only receiver this relayer pays for. */
  hub: AccountId;
  /** Zero-deposit hub methods the relayer pays for. */
  methods: readonly string[];
  /** Upper bound on the gas of one delegate, summed over its actions. */
  maxGasTgas: number;
  /** How far past the current height a delegate may stay valid. */
  maxTtlBlocks: number;
  /** A delegate must stay valid for at least this many more blocks, so it can still land. */
  expiryMarginBlocks: number;
  /** Gas the relayer may attach per UTC day, across all senders. */
  dailyGasBudgetTgas: number;
  rateLimit: { ip: BucketConfig; sender: BucketConfig };
  /** Relays signed and waiting for the network at once. */
  maxPending: number;
  maxBodyBytes: number;
  /** Trusted reverse-proxy hops for X-Forwarded-For. */
  trustProxyHops: number;
  corsOrigins: readonly string[];
  /** The relayer warns when its balance is below this many yoctoNEAR. */
  lowBalanceYocto: bigint;
};

export type RelayerConfig = RelayerAppConfig & {
  port: number;
  host: string;
  rpcUrl: string;
  /** `ed25519:<base58>` secret key of the relayer account. Never logged. */
  relayerKey: string;
  /** JSON file that keeps the daily gas count across restarts; null keeps it in memory. */
  gasLedgerPath: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  readTimeoutMs: number;
  sendTimeoutMs: number;
};

const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,255}$/;

/** Empty strings in an env file mean "unset". */
const clean = (env: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === "string" && v.trim() === "" ? undefined : v]));

const required = (hint: string) => z.string({ error: (issue) => (issue.input === undefined ? `is required: ${hint}` : "must be a string") });

const account = (hint: string) => required(hint).refine((v) => isAccountId(v), `must be a NEAR account id: ${hint}`);

const intFromEnv = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return def;
      if (!/^\d+$/.test(v)) {
        ctx.addIssue({ code: "custom", message: `must be a whole number between ${min} and ${max} (default ${def})` });
        return z.NEVER;
      }
      const n = Number(v);
      if (n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `must be between ${min} and ${max} (default ${def})` });
        return z.NEVER;
      }
      return n;
    });

const isHttpUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const url = (hint: string) => z.string().refine(isHttpUrl, `must be an http or https URL: ${hint}`);

const listOf = (v: string): string[] => [...new Set(v.split(",").map((s) => s.trim()).filter(Boolean))];

const isOrigin = (o: string): boolean => {
  try {
    const u = new URL(o);
    return (u.protocol === "http:" || u.protocol === "https:") && u.origin === o;
  } catch {
    return false;
  }
};

const envSchema = z.object({
  RELAYER_ACCOUNT: account("the account that pays the gas, for example relayer.example.testnet"),
  RELAYER_KEY: required("the relayer account's secret key, ed25519:<base58>, from its credentials file").regex(
    /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/,
    "must be a NEAR ed25519 secret key: ed25519: followed by 80 to 90 base58 characters (the private_key field of a NEAR credentials file)",
  ),
  HUB_ACCOUNT: account("the Payminto hub contract, for example hub.example.testnet"),
  NETWORK: z
    .string()
    .optional()
    .transform((v, ctx): RelayerNetwork => {
      if (v === undefined) return "near:sandbox";
      if (v === "near:testnet" || v === "near:sandbox") return v;
      ctx.addIssue({
        code: "custom",
        message: /mainnet/i.test(v) ? "mainnet is refused in this submission; use near:testnet or near:sandbox" : "must be near:testnet or near:sandbox",
      });
      return z.NEVER;
    }),
  RPC_URL: url("the NEAR JSON-RPC endpoint, for example https://rpc.testnet.near.org")
    .refine((v) => !/mainnet/i.test(v), "points at mainnet; this submission runs on testnet and sandbox only")
    .optional(),
  PORT: intFromEnv(8790, 0, 65_535),
  // Loopback by default: put a TLS reverse proxy in front. A container sets 0.0.0.0.
  HOST: z.string().default("127.0.0.1"),
  // Default: the add-on's list (revoke_budget, reclaim, payout), so the names live in one place.
  ALLOWED_METHODS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const methods = v === undefined ? [...gasless.DEFAULT_RELAY_METHODS] : listOf(v);
      if (methods.length === 0) ctx.addIssue({ code: "custom", message: "must name at least one hub method, or be unset to use the default list" });
      if (methods.length > 32) ctx.addIssue({ code: "custom", message: "must name at most 32 methods" });
      for (const m of methods) {
        if (!METHOD_NAME.test(m)) ctx.addIssue({ code: "custom", message: `${JSON.stringify(m.slice(0, 40))} is not a contract method name (letters, digits and underscores, separated by commas)` });
      }
      return methods;
    }),
  MAX_GAS_TGAS: intFromEnv(PROTOCOL_MAX_TGAS, 1, PROTOCOL_MAX_TGAS),
  MAX_TTL_BLOCKS: intFromEnv(600, 10, 100_000),
  EXPIRY_MARGIN_BLOCKS: intFromEnv(5, 0, 1_000),
  DAILY_GAS_BUDGET_TGAS: intFromEnv(3_000, 1, 10_000_000),
  GAS_LEDGER_PATH: z.string().optional(),
  // Token buckets, requests per minute and burst. 0 per minute disables that limiter.
  RATE_LIMIT_IP_PER_MIN: intFromEnv(30, 0, 100_000),
  RATE_LIMIT_IP_BURST: intFromEnv(30, 1, 100_000),
  RATE_LIMIT_SENDER_PER_MIN: intFromEnv(6, 0, 100_000),
  RATE_LIMIT_SENDER_BURST: intFromEnv(6, 1, 100_000),
  MAX_PENDING_RELAYS: intFromEnv(16, 1, 1_000),
  MAX_BODY_BYTES: intFromEnv(16_384, 256, 1_048_576),
  // Number of reverse proxies in front whose X-Forwarded-For entries are trusted. 0 uses the socket address.
  TRUST_PROXY_HOPS: intFromEnv(0, 0, 16),
  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const origins = v === undefined ? ["http://localhost:3000"] : listOf(v);
      for (const o of origins) {
        if (o !== "*" && !isOrigin(o)) ctx.addIssue({ code: "custom", message: `${JSON.stringify(o.slice(0, 80))} is not an origin; use scheme://host[:port] with no path, separated by commas` });
      }
      return origins;
    }),
  LOW_BALANCE_NEAR: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const yocto = nearToYocto(v ?? "0.5");
      if (yocto === null) {
        ctx.addIssue({ code: "custom", message: "must be an amount of NEAR as a decimal number, for example 0.5" });
        return z.NEVER;
      }
      return yocto;
    }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"], { error: "must be debug, info, warn or error" }).default("info"),
  READ_TIMEOUT_MS: intFromEnv(15_000, 500, 600_000),
  SEND_TIMEOUT_MS: intFromEnv(60_000, 1_000, 600_000),
});

/** `"0.5"` to yoctoNEAR, or null when it is not a plain decimal with at most 24 fraction digits. */
export function nearToYocto(v: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{1,24}))?$/.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1]!) * YOCTO_PER_NEAR + BigInt((m[2] ?? "").padEnd(24, "0"));
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid relayer configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Parses and validates the environment once at startup. Every missing or malformed variable is reported in one go;
 * rules that span two variables are checked once each variable is well-formed. Each problem names its variable and says
 * what to put there, and none prints a secret.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): RelayerConfig {
  const parsed = envSchema.safeParse(clean(env));
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];

  if (e.RELAYER_ACCOUNT === e.HUB_ACCOUNT) problems.push("RELAYER_ACCOUNT: must be a separate account from HUB_ACCOUNT; create a dedicated account that only pays gas");
  if (e.NETWORK === "near:testnet") {
    for (const [name, v] of [["RELAYER_ACCOUNT", e.RELAYER_ACCOUNT], ["HUB_ACCOUNT", e.HUB_ACCOUNT]] as const) {
      if (v.endsWith(".near")) problems.push(`${name}: is a mainnet account name; this submission runs on testnet and sandbox only`);
    }
  }
  if (e.EXPIRY_MARGIN_BLOCKS >= e.MAX_TTL_BLOCKS) problems.push("EXPIRY_MARGIN_BLOCKS: must be smaller than MAX_TTL_BLOCKS, or no delegate could ever be relayed");
  if (e.DAILY_GAS_BUDGET_TGAS < e.MAX_GAS_TGAS + RELAY_OVERHEAD_TGAS) {
    problems.push(`DAILY_GAS_BUDGET_TGAS: must be at least MAX_GAS_TGAS + ${RELAY_OVERHEAD_TGAS}, or the largest allowed call could never be relayed`);
  }
  if (problems.length) throw new ConfigError(problems);

  return {
    network: e.NETWORK,
    relayer: e.RELAYER_ACCOUNT,
    relayerKey: e.RELAYER_KEY,
    hub: e.HUB_ACCOUNT,
    rpcUrl: e.RPC_URL ?? DEFAULT_RPC_URLS[e.NETWORK],
    port: e.PORT,
    host: e.HOST,
    methods: e.ALLOWED_METHODS,
    maxGasTgas: e.MAX_GAS_TGAS,
    maxTtlBlocks: e.MAX_TTL_BLOCKS,
    expiryMarginBlocks: e.EXPIRY_MARGIN_BLOCKS,
    dailyGasBudgetTgas: e.DAILY_GAS_BUDGET_TGAS,
    gasLedgerPath: e.GAS_LEDGER_PATH ?? null,
    rateLimit: {
      ip: { perMin: e.RATE_LIMIT_IP_PER_MIN, burst: e.RATE_LIMIT_IP_BURST },
      sender: { perMin: e.RATE_LIMIT_SENDER_PER_MIN, burst: e.RATE_LIMIT_SENDER_BURST },
    },
    maxPending: e.MAX_PENDING_RELAYS,
    maxBodyBytes: e.MAX_BODY_BYTES,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    corsOrigins: e.CORS_ORIGINS,
    lowBalanceYocto: e.LOW_BALANCE_NEAR,
    logLevel: e.LOG_LEVEL,
    readTimeoutMs: e.READ_TIMEOUT_MS,
    sendTimeoutMs: e.SEND_TIMEOUT_MS,
  };
}

/**
 * Gas counted against the daily budget on top of what a delegate attaches: a margin for the fees of the outer
 * transaction and the delegate receipt. A generous estimate, not a measurement.
 */
export const RELAY_OVERHEAD_TGAS = 5;

/** Config summary that is safe to log: no key. */
export function redactedConfig(c: RelayerConfig) {
  const { relayerKey: _key, rpcUrl, lowBalanceYocto, ...rest } = c;
  return { ...rest, rpcUrl: redactUrl(rpcUrl), lowBalanceYocto: lowBalanceYocto.toString() };
}

/** Hides basic-auth credentials and API keys in RPC URL paths or queries (many providers put the key there). */
export function redactUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const hasSecret = parsed.username || parsed.password || parsed.search || /[0-9a-f]{16,}|[A-Za-z0-9_-]{24,}/.test(parsed.pathname);
    return hasSecret ? `${parsed.protocol}//${parsed.host}/***` : u;
  } catch {
    return "***";
  }
}
