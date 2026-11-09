import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { formatAmount, networks, toAtomic } from "@payminto/protocol";
import { PROVIDER_IDS, type Provider } from "@payminto/models";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEMO_DIR = resolve(REPO_ROOT, "apps", "demo");
export const LIVE_CHAINS = [133, 177, 11155111] as const;

/** Anvil default dev keys: publicly known, local only. Refused on any live network. */
export const ANVIL_KEYS = [
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
] as const satisfies readonly Hex[];

/** Anvil's public dev mnemonic. Accounts 10 and up are deterministic but hold no ETH until the demo funds them. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

function anvilKey(index: number): Hex {
  return toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey!);
}

/**
 * The gateway act's wallets: the store and platform, the Northwind merchant, two people and three agents. Locally they
 * come from the anvil mnemonic; on a live network (DEMO_GATEWAY=1) each is an explicit, funded testnet key.
 */
export type GatewayKeys = {
  storePayout: Hex;
  platformFees: Hex;
  merchantPayout: Hex;
  walletPayer: Hex;
  depositPayer: Hex;
  x402Agent: Hex;
  mandateAgent: Hex;
  flagged: Hex;
};

export function localGatewayKeys(): GatewayKeys {
  return {
    storePayout: anvilKey(10),
    platformFees: anvilKey(11),
    merchantPayout: anvilKey(12),
    walletPayer: anvilKey(13),
    depositPayer: anvilKey(14),
    x402Agent: anvilKey(15),
    mandateAgent: anvilKey(16),
    flagged: anvilKey(17),
  };
}

/** The env variable that holds each gateway wallet's key on a live network. */
export const GATEWAY_KEY_ENV = {
  storePayout: "DEMO_STORE_PAYOUT_KEY",
  platformFees: "DEMO_PLATFORM_FEES_KEY",
  merchantPayout: "DEMO_NORTHWIND_PAYOUT_KEY",
  walletPayer: "DEMO_HUMAN_PAYER_KEY",
  depositPayer: "DEMO_DEPOSIT_PAYER_KEY",
  x402Agent: "DEMO_X402_AGENT_KEY",
  mandateAgent: "DEMO_MANDATE_AGENT_KEY",
  flagged: "DEMO_FLAGGED_KEY",
} as const satisfies Record<keyof GatewayKeys, string>;

/** What the gateway act charges: SPEC-sized locally, about a hundredth of that on a live network. */
export type GatewayAmounts = {
  /** The link's price. */
  link: bigint;
  /** The Northwind fee plan: bps plus a fixed part. */
  planFixed: bigint;
  /** The customer-borne deposit fee. */
  depositFee: bigint;
  refund: bigint;
  /** The Procurement Agent's mandate cap (it pays the link once with two vouchers). */
  mandateCap: bigint;
  /** What each paying wallet is given locally, or must hold on a live network. */
  payerFunds: bigint;
};
export const LOCAL_GATEWAY_AMOUNTS: GatewayAmounts = { link: 2_000_000n, planFixed: 10_000n, depositFee: 50_000n, refund: 500_000n, mandateCap: 10_000_000n, payerFunds: 10_000_000n };
export const LIVE_GATEWAY_AMOUNTS: GatewayAmounts = { link: 20_000n, planFixed: 100n, depositFee: 500n, refund: 5_000n, mandateCap: 50_000n, payerFunds: 30_000n };

/** Upper bound the gateway act moves out of the payers' wallets: four payments of the link, one with the deposit fee. */
export function gatewaySpend(a: GatewayAmounts): bigint {
  return 4n * a.link + a.depositFee;
}

export type Prices = { market: bigint; risk: bigint; writer: bigint; deep: bigint; rogue: bigint };

/** Prices on the local chain match SPEC 8; live networks use tiny prices so a full rehearsal costs cents. */
export const LOCAL_PRICES: Prices = { market: 2_000n, risk: 10_000n, writer: 50_000n, deep: 250_000n, rogue: 20_000n };
export const LIVE_PRICES: Prices = { market: 100n, risk: 500n, writer: 2_500n, deep: 12_500n, rogue: 1_000n };

export type Plan = {
  treasuryMarket: number;
  treasuryRisk: number;
  briefs: number;
  /** Each brief makes the Research Writer buy this many quotes and scans. */
  briefQuotes: number;
  briefScans: number;
  tradingMarket: number;
  tradingRisk: number;
};

/** Splits a target call count into the scenario mix. Every brief adds 1 + briefQuotes + briefScans paid calls. */
export function planFor(totalCalls: number): Plan {
  const n = Math.max(20, Math.floor(totalCalls));
  const briefs = Math.max(1, Math.round(n * 0.04));
  const treasuryMarket = Math.round(n * 0.24);
  const treasuryRisk = Math.round(n * 0.12);
  const tradingRisk = Math.round(n * 0.08);
  const used = treasuryMarket + treasuryRisk + briefs * 4 + tradingRisk;
  return { treasuryMarket, treasuryRisk, briefs, briefQuotes: 2, briefScans: 1, tradingMarket: Math.max(1, n - used), tradingRisk };
}

export function plannedCalls(p: Plan): number {
  return p.treasuryMarket + p.treasuryRisk + p.briefs * (1 + p.briefQuotes + p.briefScans) + p.tradingMarket + p.tradingRisk;
}

/**
 * Upper bound of what the run can move, counting the two attack attempts as if they were paid. `aiCeiling` is the
 * AI buyer agent's per-task spend ceiling (the AI agents act), which it spends from the Treasury Agent's mandate.
 */
export function plannedSpend(p: Plan, prices: Prices, aiCeiling = 0n) {
  const treasury = BigInt(p.treasuryMarket) * prices.market + BigInt(p.treasuryRisk) * prices.risk + BigInt(p.briefs) * prices.writer + prices.deep + aiCeiling;
  const trading = BigInt(p.tradingMarket) * prices.market + BigInt(p.tradingRisk) * prices.risk + prices.rogue;
  const writer = BigInt(p.briefs) * (BigInt(p.briefQuotes) * prices.market + BigInt(p.briefScans) * prices.risk);
  return { treasury, trading, writer, total: treasury + trading + writer };
}

const key = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
  .transform((v) => v as Hex);
const addr = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));
const int = (def: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)));

const envSchema = z.object({
  DEMO_CHAIN_ID: int(31337),
  DEMO_RPC_URL: z.url().optional(),
  DEMO_CALLS: int(500),
  DEMO_CONCURRENCY: int(24),
  DEMO_NODE_PORT: int(8787),
  DEMO_PROVIDER_BASE_PORT: int(4101),
  DEMO_OFFLINE: z.enum(["0", "1"]).optional(),
  DEMO_DATA_DIR: z.string().optional(),
  DEMO_ADMIN_TOKEN: z.string().min(12, "must be at least 12 characters").optional(),
  DEMO_HSP_COSIGN_TIMEOUT_SEC: int(15),
  // Live networks only.
  DEMO_LIVE_NETWORK_CONFIRM: z.string().optional(),
  DEMO_MAX_SPEND_USDC: z.string().regex(/^\d+(\.\d{1,6})?$/, "must be a decimal USDC amount").default("1"),
  DEMO_OPERATOR_KEY: key.optional(),
  DEMO_OWNER_KEY: key.optional(),
  DEMO_TREASURY_KEY: key.optional(),
  DEMO_TRADING_KEY: key.optional(),
  DEMO_WRITER_KEY: key.optional(),
  DEMO_MARKET_PAYEE: addr.optional(),
  DEMO_RISK_PAYEE: addr.optional(),
  DEMO_ROGUE_PAYEE: addr.optional(),
  // AI agents act (README "AI agents act"): opt-in, with the business's own model key.
  DEMO_AI: z.enum(["0", "1"]).optional(),
  DEMO_AI_PROVIDER: z.enum(PROVIDER_IDS).default("openai"),
  DEMO_AI_MODEL: z.string().trim().min(1).optional(),
  DEMO_AI_BASE_URL: z.url().optional(),
  DEMO_AI_API_KEY: z.string().trim().min(1).optional(),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  GOOGLE_API_KEY: z.string().trim().min(1).optional(),
  REPLICATE_API_TOKEN: z.string().trim().min(1).optional(),
  /** Live networks with DEMO_AI=1: the business that sells the skill is paid here (never the operator). */
  DEMO_MERCHANT_PAYOUT: addr.optional(),
  /** Live networks with DEMO_AI=1: the node needs a public https checkout origin once the gateway is on. */
  DEMO_PUBLIC_CHECKOUT_URL: z.url().optional(),
  // Gateway act on a live network (README "Gateway act on a live network"): opt-in, every wallet explicit.
  DEMO_GATEWAY: z.enum(["0", "1"]).optional(),
  DEMO_STORE_PAYOUT_KEY: key.optional(),
  DEMO_PLATFORM_FEES_KEY: key.optional(),
  DEMO_NORTHWIND_PAYOUT_KEY: key.optional(),
  DEMO_HUMAN_PAYER_KEY: key.optional(),
  DEMO_DEPOSIT_PAYER_KEY: key.optional(),
  DEMO_X402_AGENT_KEY: key.optional(),
  DEMO_MANDATE_AGENT_KEY: key.optional(),
  DEMO_FLAGGED_KEY: key.optional(),
  /** Live networks: a public https endpoint that receives the merchant's webhooks (the node refuses private targets there). */
  DEMO_WEBHOOK_URL: z.url().optional(),
  /** The node's CONFIRM_TAG; unset keeps the node's default (safe on public chains). */
  DEMO_CONFIRM_TAG: z.enum(["latest", "safe", "finalized"]).optional(),
});

/** The default model per provider for the AI act: the cheapest one that calls tools well. */
export const AI_DEFAULT_MODELS: Record<Provider, string | null> = {
  openai: "gpt-5-mini",
  anthropic: "claude-haiku-5-5",
  google: "gemini-2.5-flash",
  openai_compatible: null,
  replicate: "deepseek-ai/deepseek-v3.1",
};

/** Where each provider's key comes from; DEMO_AI_API_KEY overrides any of them. */
export const AI_KEY_ENV = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai_compatible: "DEMO_AI_API_KEY",
  replicate: "REPLICATE_API_TOKEN",
} as const satisfies Record<Provider, string>;

export type AiConfig = {
  provider: Provider;
  model: string;
  /** Never printed; null only for an OpenAI-compatible server on this machine. */
  apiKey: string | null;
  keyHint: string | null;
  baseUrl: string | null;
  /** True when baseUrl is on this machine (a local model server or the test stand-in). */
  localModel: boolean;
  /** What the HashKey market brief skill costs per call: the Research Writer's price. */
  skillPrice: bigint;
  /** The AI buyer agent's per-task spend ceiling (two briefs). */
  buyerCeiling: bigint;
  /** Live only: the payout of the business that sells the skill; locally the seeded store's payout. */
  merchantPayout: Address | null;
  /** Live only: PUBLIC_CHECKOUT_URL for the node. */
  checkoutUrl: string | null;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export type Keys = { deployer: Hex | null; operator: Hex; owner: Hex; treasury: Hex; trading: Hex; writer: Hex };
export type Payees = { market: Address; risk: Address; rogue: Address };

export type DemoConfig = {
  chainId: number;
  live: boolean;
  /** Undefined on local: the demo boots its own anvil. */
  rpcUrl: string | undefined;
  calls: number;
  plan: Plan;
  prices: Prices;
  concurrency: number;
  nodePort: number;
  providerBasePort: number;
  offline: boolean;
  dataDir: string | undefined;
  adminToken: string;
  cosignTimeoutSec: number;
  keys: Keys;
  payees: Payees;
  maxSpend: bigint;
  spend: ReturnType<typeof plannedSpend> & { gateway: bigint };
  /** Live only: the existing deployments file. */
  deployment: { clearingHub: Address; token?: Address } | null;
  /** The gateway act's wallets: always locally; on a live network only with DEMO_GATEWAY=1 (explicit funded keys). */
  gatewayKeys: GatewayKeys | null;
  /** The gateway act's prices and funding, sized for the network. */
  gatewayAmounts: GatewayAmounts;
  /** Live gateway act: where the merchant's webhooks go; null skips the webhook checks (the node refuses private targets). */
  webhookUrl: string | null;
  /** Live gateway act: PUBLIC_CHECKOUT_URL for the node. */
  checkoutUrl: string | null;
  /** CONFIRM_TAG passed to the node, or null for the node's default. */
  confirmTag: "latest" | "safe" | "finalized" | null;
  /** The AI agents act; null unless DEMO_AI=1. */
  ai: AiConfig | null;
};

export class DemoConfigError extends Error {
  constructor(problems: string[]) {
    super(`Refusing to start the demo:\n  - ${problems.join("\n  - ")}`);
    this.name = "DemoConfigError";
  }
}

const LOCAL_ROGUE: Address = getAddress(privateKeyToAccount(ANVIL_KEYS[7]).address);

/**
 * Parses the demo environment and applies the live-network safety guard before anything touches a chain:
 * on 133/177 it needs DEMO_LIVE_NETWORK_CONFIRM=yes, explicit non-dev keys, an existing deployments file,
 * and a planned spend at or under DEMO_MAX_SPEND_USDC (default 1).
 */
export function loadDemoConfig(env: Record<string, string | undefined> = process.env, opts: { deploymentsDir?: string } = {}): DemoConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new DemoConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  const e = parsed.data;
  const chainId = e.DEMO_CHAIN_ID;
  if (!(chainId in networks)) throw new DemoConfigError([`DEMO_CHAIN_ID: ${chainId} is not one of ${Object.keys(networks).join(", ")}`]);
  const live = (LIVE_CHAINS as readonly number[]).includes(chainId);
  const prices = live ? LIVE_PRICES : LOCAL_PRICES;
  const plan = planFor(e.DEMO_CALLS);
  const maxSpend = toAtomic(e.DEMO_MAX_SPEND_USDC, 6);
  const problems: string[] = [];
  const liveGateway = live && e.DEMO_GATEWAY === "1";
  const ai = e.DEMO_AI === "1" ? aiConfig(e, live, prices, chainId, problems, liveGateway) : null;
  const gatewayAmounts = live ? LIVE_GATEWAY_AMOUNTS : LOCAL_GATEWAY_AMOUNTS;
  const gatewayOn = !live || liveGateway;
  const spend = { ...plannedSpend(plan, prices, ai?.buyerCeiling ?? 0n), gateway: gatewayOn ? gatewaySpend(gatewayAmounts) : 0n };
  spend.total += spend.gateway;
  let gatewayKeys: GatewayKeys | null = live ? null : localGatewayKeys();

  let keys: Keys;
  let payees: Payees;
  let deployment: DemoConfig["deployment"] = null;
  if (!live) {
    keys = { deployer: ANVIL_KEYS[0], owner: ANVIL_KEYS[1], treasury: ANVIL_KEYS[2], trading: ANVIL_KEYS[3], writer: ANVIL_KEYS[4], operator: ANVIL_KEYS[9] };
    payees = {
      market: getAddress(privateKeyToAccount(ANVIL_KEYS[5]).address),
      risk: getAddress(privateKeyToAccount(ANVIL_KEYS[6]).address),
      rogue: LOCAL_ROGUE,
    };
  } else {
    if (e.DEMO_LIVE_NETWORK_CONFIRM !== "yes") {
      problems.push(`DEMO_LIVE_NETWORK_CONFIRM: chain ${chainId} is a live HashKey network; set DEMO_LIVE_NETWORK_CONFIRM=yes to spend real tokens`);
    }
    const need = <T>(name: string, v: T | undefined): T => {
      if (v === undefined) problems.push(`${name}: required on chain ${chainId}`);
      return v as T;
    };
    keys = {
      deployer: null,
      operator: need("DEMO_OPERATOR_KEY", e.DEMO_OPERATOR_KEY),
      owner: need("DEMO_OWNER_KEY", e.DEMO_OWNER_KEY),
      treasury: need("DEMO_TREASURY_KEY", e.DEMO_TREASURY_KEY),
      trading: need("DEMO_TRADING_KEY", e.DEMO_TRADING_KEY),
      writer: need("DEMO_WRITER_KEY", e.DEMO_WRITER_KEY),
    };
    payees = {
      market: need("DEMO_MARKET_PAYEE", e.DEMO_MARKET_PAYEE),
      risk: need("DEMO_RISK_PAYEE", e.DEMO_RISK_PAYEE),
      // Never paid: it is the prompt-injection target and must be denied.
      rogue: e.DEMO_ROGUE_PAYEE ?? getAddress("0x000000000000000000000000000000000000dEaD"),
    };
    const dev = new Set<string>(ANVIL_KEYS.map((k) => k.toLowerCase()));
    for (const [name, k] of Object.entries(keys)) {
      if (k && dev.has(k.toLowerCase())) problems.push(`${name} key: is a public anvil dev key; never use it on a live network`);
    }
    if (liveGateway) {
      const k = {} as GatewayKeys;
      for (const [role, name] of Object.entries(GATEWAY_KEY_ENV) as Array<[keyof GatewayKeys, keyof typeof e]>) {
        const v = e[name] as Hex | undefined;
        if (!v) problems.push(`${name}: required for DEMO_GATEWAY=1 on chain ${chainId}`);
        else if (dev.has(v.toLowerCase())) problems.push(`${name}: is a public anvil dev key; never use it on a live network`);
        k[role] = v as Hex;
      }
      const all = [...Object.values(keys), ...Object.values(k)].filter((x): x is Hex => !!x).map((x) => x.toLowerCase());
      if (new Set(all).size !== all.length) problems.push("gateway keys: every demo role needs a wallet of its own (two DEMO_*_KEY values are the same)");
      if (!e.DEMO_PUBLIC_CHECKOUT_URL) problems.push(`DEMO_PUBLIC_CHECKOUT_URL: required for DEMO_GATEWAY=1 on chain ${chainId} (a public https origin)`);
      if (e.DEMO_WEBHOOK_URL && !e.DEMO_WEBHOOK_URL.startsWith("https://")) problems.push("DEMO_WEBHOOK_URL: must be https on a live network");
      gatewayKeys = k;
    }
    if (!e.DEMO_ADMIN_TOKEN) problems.push("DEMO_ADMIN_TOKEN: required on a live network (the local default is public)");
    const dir = opts.deploymentsDir ?? join(REPO_ROOT, "contracts", "deployments");
    const file = join(dir, `${chainId}.json`);
    if (!existsSync(file)) problems.push(`${file}: missing; deploy ClearingHub first (docs/DEPLOY.md), the demo never deploys to a live network`);
    else {
      const d = z.object({ clearingHub: addr, token: addr.optional(), chainId: z.number() }).safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!d.success || d.data.chainId !== chainId) problems.push(`${file}: not a deployments file for chain ${chainId}`);
      else deployment = { clearingHub: d.data.clearingHub, token: d.data.token };
    }
    if (ai?.merchantPayout) {
      const taken = Object.values(keys)
        .filter((k): k is Hex => !!k && /^0x[0-9a-fA-F]{64}$/.test(k))
        .map((k) => privateKeyToAccount(k).address.toLowerCase());
      if (taken.includes(ai.merchantPayout.toLowerCase())) problems.push("DEMO_MERCHANT_PAYOUT: must be a wallet of its own, not one of the demo's operator, owner or agent keys");
    }
    if (spend.total > maxSpend) {
      problems.push(
        `planned spend ${formatAmount(spend.total)} USDC exceeds DEMO_MAX_SPEND_USDC ${formatAmount(maxSpend)}; lower DEMO_CALLS or raise the cap deliberately`,
      );
    }
  }
  if (e.DEMO_CONCURRENCY < 1) problems.push("DEMO_CONCURRENCY: must be at least 1");
  if (problems.length) throw new DemoConfigError(problems);

  return {
    chainId,
    live,
    rpcUrl: e.DEMO_RPC_URL ?? (live ? networks[chainId]!.chain.rpcUrls.default.http[0] : undefined),
    calls: plannedCalls(plan),
    plan,
    prices,
    concurrency: e.DEMO_CONCURRENCY,
    nodePort: e.DEMO_NODE_PORT,
    providerBasePort: e.DEMO_PROVIDER_BASE_PORT,
    offline: e.DEMO_OFFLINE === "1",
    dataDir: e.DEMO_DATA_DIR,
    // Local only: the same public dev token the dashboard pre-fills for a local node.
    adminToken: e.DEMO_ADMIN_TOKEN ?? "dev-admin-token",
    cosignTimeoutSec: e.DEMO_HSP_COSIGN_TIMEOUT_SEC,
    keys,
    payees,
    maxSpend,
    spend,
    deployment,
    gatewayKeys,
    gatewayAmounts,
    webhookUrl: live ? (e.DEMO_WEBHOOK_URL ?? null) : null,
    checkoutUrl: live ? (e.DEMO_PUBLIC_CHECKOUT_URL ?? null) : null,
    confirmTag: e.DEMO_CONFIRM_TAG ?? null,
    ai,
  };
}

/** The AI act's settings. Problems name variables, never their values: a model key is never printed. */
function aiConfig(e: z.infer<typeof envSchema>, live: boolean, prices: Prices, chainId: number, problems: string[], liveGateway = false): AiConfig {
  const provider = e.DEMO_AI_PROVIDER;
  const keyVar = AI_KEY_ENV;
  const apiKey = e.DEMO_AI_API_KEY ?? e[keyVar[provider]] ?? null;
  const baseUrl = e.DEMO_AI_BASE_URL ?? null;
  const localModel = !!baseUrl && LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.replace(/^\[|\]$/g, ""));
  if (provider === "openai_compatible" && !baseUrl) problems.push("DEMO_AI_BASE_URL: required when DEMO_AI_PROVIDER is openai_compatible");
  if (!apiKey && !(provider === "openai_compatible" && localModel)) problems.push(`${keyVar[provider]}: required for DEMO_AI=1 with DEMO_AI_PROVIDER=${provider} (or set DEMO_AI_API_KEY)`);
  const model = e.DEMO_AI_MODEL ?? AI_DEFAULT_MODELS[provider];
  if (!model) problems.push(`DEMO_AI_MODEL: required when DEMO_AI_PROVIDER is ${provider}`);
  let merchantPayout: Address | null = null;
  let checkoutUrl: string | null = null;
  if (live && liveGateway) {
    // The gateway act's store sells the skill, as it does locally.
    if (e.DEMO_STORE_PAYOUT_KEY) merchantPayout = getAddress(privateKeyToAccount(e.DEMO_STORE_PAYOUT_KEY).address);
    if (e.DEMO_MERCHANT_PAYOUT && merchantPayout && e.DEMO_MERCHANT_PAYOUT !== merchantPayout) problems.push("DEMO_MERCHANT_PAYOUT: with DEMO_GATEWAY=1 the store (DEMO_STORE_PAYOUT_KEY) sells the skill; leave it unset or use the store's address");
    checkoutUrl = e.DEMO_PUBLIC_CHECKOUT_URL ?? null;
  } else if (live) {
    merchantPayout = e.DEMO_MERCHANT_PAYOUT ?? null;
    if (!merchantPayout) problems.push(`DEMO_MERCHANT_PAYOUT: required for DEMO_AI=1 on chain ${chainId} (the wallet of the business that sells the skill)`);
    checkoutUrl = e.DEMO_PUBLIC_CHECKOUT_URL ?? null;
    if (!checkoutUrl) problems.push(`DEMO_PUBLIC_CHECKOUT_URL: required for DEMO_AI=1 on chain ${chainId} (a public https origin; the gateway is on for the act)`);
  }
  return {
    provider,
    model: model ?? "",
    apiKey,
    keyHint: apiKey && apiKey.length >= 8 ? apiKey.slice(-4) : null,
    baseUrl,
    localModel,
    skillPrice: prices.writer,
    buyerCeiling: 2n * prices.writer,
    merchantPayout,
    checkoutUrl,
  };
}
