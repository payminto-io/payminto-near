import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { isAccountId, isPublicKey, keypairFromSeed, networks, type AccountId, type Id32, type Network, type PublicKey } from "@payminto/protocol";
import { AgentKeyFileError, defaultAgentKeyPath, readAgentKeyFile } from "@payminto/sdk";
import { httpTokenSchema, httpTokenSource, type HttpTokenSource } from "./http-token.ts";

const zAccount = z.string().refine((v) => isAccountId(v), "must be a NEAR account id").transform((v) => v as AccountId);

/** A URL host: a DNS name or IPv4 address, or a bracketed IPv6 address, with an optional port. */
const HOST = /^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;

const envSchema = z.object({
  NODE_URL: z.url("must be the clearing node base URL, e.g. http://localhost:8787"),
  /** Mainnet is deliberately not an option: this server has no mainnet mode. */
  NETWORK: z.enum(["near:testnet", "near:sandbox"]).default("near:testnet"),
  HUB_ACCOUNT: zAccount.optional(),
  /** Override: the seed in the environment. Prefer AGENT_KEY_FILE, which keeps the key out of every environment. */
  AGENT_KEY: z.string().regex(/^[0-9a-f]{64}$/, "must be a 32-byte ed25519 seed as 64 lowercase hex characters").optional(),
  /** The file `payminto-agent keygen` wrote (mode 0600). Defaults to $PAYMINTO_DATA_DIR/agent/agent-key.json. */
  AGENT_KEY_FILE: z.string().min(1).optional(),
  BUDGET_ID: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a 32-byte Budget id as 64 lowercase hex characters")
    .transform((v) => v as Id32),
  /**
   * Highest price per call in atomic units: the wallet refuses to sign above it. Unset, the maximum is the Budget's
   * per-call cap, which applies in any case (the lower of the two wins).
   */
  MAX_PRICE_ATOMIC: z.string().regex(/^\d+$/).optional(),
  /**
   * Hosts the wallet may call and pay besides the services its node lists: a comma-separated list of `host` or
   * `host:port`, as they appear in a URL. Unset, the wallet calls only what its node's directory lists.
   */
  PAYABLE_HOSTS: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean))
    .refine((hosts) => hosts.every((h) => HOST.test(h)), "must be a comma-separated list of host or host:port, without scheme or path"),
  /** Set to 1 to pay under a Budget whose payee list is empty (any payee). Unset, the wallet refuses such a Budget. */
  ALLOW_ANY_PAYEE: z.enum(["0", "1"]).default("0"),
  /** Expected node receipt key; receipts signed by anyone else are rejected. */
  TRUSTED_NODE_KEY: z.string().refine((v) => isPublicKey(v), "must be an ed25519:<base58> public key").transform((v) => v as PublicKey).optional(),
  /** Read-only NEAR RPC for proofs and on-chain Budget state. Defaults to the network's public RPC. */
  NEAR_RPC_URL: z.url("must be an http(s) NEAR RPC URL").optional(),
  /** `off` proves receipts with the node's word only (no chain reads). */
  CHAIN_READER: z.enum(["rpc", "off"]).default("rpc"),
  /**
   * The payee check the wallet runs before it signs: on (the default while there is a chain reader) or off. It reads
   * accounts through NEAR_RPC_URL, holds no key and sends nothing.
   */
  PAYEE_CHECK: z.enum(["on", "off"]).optional(),
  /** Where account ages come from: nearblocks (default on near:testnet) or off (default on near:sandbox). */
  PAYEE_CHECK_INDEXER: z.enum(["nearblocks", "off"]).optional(),
  /** Optional NearBlocks API key. The keyless tier is rate limited. */
  PAYEE_CHECK_INDEXER_KEY: z.string().min(8).max(200).optional(),
  /** `quote_market_agent`: quotes from the NEAR AI Agent Market, checked against this wallet's limits. on (default) or off. */
  AGENT_MARKET: z.enum(["on", "off"]).default("on"),
  /** Read-only NEAR mainnet RPC for the payee check of a market quote. Defaults to the public mainnet endpoints. */
  AGENT_MARKET_RPC_URL: z.url("must be an http(s) NEAR mainnet RPC URL").optional(),
  /** Durable receipt and signed-position store (SQLite). Processes sharing one agent key must share this file. */
  RECEIPT_STORE_PATH: z.string().min(1).optional(),
  /** Base directory for local state (the key file and the receipt store). */
  PAYMINTO_DATA_DIR: z.string().min(1).optional(),
  MCP_HTTP_PORT: z.string().regex(/^\d+$/).default("3334").transform(Number),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  /** The bearer token HTTP clients must send. Unset, one is generated into MCP_HTTP_TOKEN_FILE. */
  MCP_HTTP_TOKEN: httpTokenSchema.optional(),
  /** Where a generated token is kept (mode 0600). Defaults to $PAYMINTO_DATA_DIR/mcp/http-token. */
  MCP_HTTP_TOKEN_FILE: z.string().min(1).optional(),
});

export type McpConfig = {
  nodeUrl: string;
  network: Network;
  /** Undefined means "ask the node" (GET /v1/info). */
  hub: AccountId | undefined;
  agentKey: Uint8Array;
  /** Where the key came from, for the startup log. Never the key itself. */
  agentKeySource: { kind: "file"; path: string } | { kind: "env" };
  budgetId: Id32;
  maxPrice: bigint | undefined;
  /** Hosts the wallet may call besides its node's directory. */
  payableHosts: string[];
  /** The operator accepted a Budget with an empty payee list. */
  allowAnyPayee: boolean;
  trustedNodeKey: PublicKey | undefined;
  /** The NEAR RPC the read-only chain reader uses, or null when CHAIN_READER=off. */
  rpcUrl: string | null;
  /** SQLite file holding this agent's receipts and the highest cumulative it signed per payee. */
  receiptStorePath: string;
  /**
   * The wallet's own payee check, or null when it is off. It reads NEAR through `rpcUrl` and remembers the code each
   * payee ran in `codeStorePath`, next to the receipts.
   */
  payeeCheck: { rpcUrl: string; indexer: "nearblocks" | "off"; indexerKey: string | null; codeStorePath: string } | null;
  /** The Agent Market quote tool, or null when AGENT_MARKET=off. `rpcUrl` is the mainnet RPC of its payee check. */
  market: { rpcUrl: string | null; payeeCheck: { indexer: "nearblocks" | "off"; indexerKey: string | null } | null } | null;
  http: { port: number; host: string; token: HttpTokenSource };
};

export class McpConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid Payminto MCP configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "McpConfigError";
  }
}

/**
 * Parses the environment once. The agent key comes from AGENT_KEY_FILE (default `~/.payminto/agent/agent-key.json`,
 * written by `payminto-agent keygen`), or from AGENT_KEY as an override. Errors name the variable, never a key value.
 */
export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new McpConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  const e = parsed.data;
  let agentKey: Uint8Array;
  let agentKeySource: McpConfig["agentKeySource"];
  if (e.AGENT_KEY) {
    agentKey = Uint8Array.from(Buffer.from(e.AGENT_KEY, "hex"));
    agentKeySource = { kind: "env" };
  } else {
    const path = resolve(e.AGENT_KEY_FILE ?? defaultAgentKeyPath({ PAYMINTO_DATA_DIR: e.PAYMINTO_DATA_DIR }));
    if (!e.AGENT_KEY_FILE && !existsSync(path)) {
      throw new McpConfigError([`AGENT_KEY_FILE: no agent key at ${path}; run \`payminto-agent keygen\` (or set AGENT_KEY_FILE, or AGENT_KEY as an override)`]);
    }
    try {
      agentKey = readAgentKeyFile(path).secretKey;
    } catch (err) {
      throw new McpConfigError([`AGENT_KEY_FILE: ${err instanceof AgentKeyFileError ? err.message : "cannot read the key file"}`]);
    }
    agentKeySource = { kind: "file", path };
  }
  const fileId = keypairFromSeed(agentKey).publicKey.slice("ed25519:".length);
  const rpcUrl = e.CHAIN_READER === "off" ? null : (e.NEAR_RPC_URL ?? networks[e.NETWORK]?.rpcUrl ?? null);
  const receiptStorePath = resolve(e.RECEIPT_STORE_PATH ?? join(e.PAYMINTO_DATA_DIR ?? join(homedir(), ".payminto"), "mcp", `receipts-${e.NETWORK.replace(":", "-")}-${fileId}.db`));
  if (e.PAYEE_CHECK === "on" && rpcUrl === null) throw new McpConfigError(["PAYEE_CHECK: on needs a chain reader to read accounts with; set CHAIN_READER=rpc (and NEAR_RPC_URL), or PAYEE_CHECK=off"]);
  if (e.PAYEE_CHECK_INDEXER === "nearblocks" && e.NETWORK !== "near:testnet") throw new McpConfigError([`PAYEE_CHECK_INDEXER: nearblocks has no index of ${e.NETWORK}; use off (the default there)`]);
  const payeeCheck =
    e.PAYEE_CHECK === "off" || rpcUrl === null
      ? null
      : {
          rpcUrl,
          indexer: e.PAYEE_CHECK_INDEXER ?? (e.NETWORK === "near:testnet" ? ("nearblocks" as const) : ("off" as const)),
          indexerKey: e.PAYEE_CHECK_INDEXER_KEY ?? null,
          codeStorePath: join(dirname(receiptStorePath), `payee-code-${e.NETWORK.replace(":", "-")}-${fileId}.json`),
        };
  return {
    nodeUrl: e.NODE_URL.replace(/\/+$/, ""),
    network: e.NETWORK,
    hub: e.HUB_ACCOUNT,
    agentKey,
    agentKeySource,
    budgetId: e.BUDGET_ID,
    maxPrice: e.MAX_PRICE_ATOMIC === undefined ? undefined : BigInt(e.MAX_PRICE_ATOMIC),
    payableHosts: e.PAYABLE_HOSTS,
    allowAnyPayee: e.ALLOW_ANY_PAYEE === "1",
    trustedNodeKey: e.TRUSTED_NODE_KEY,
    rpcUrl,
    receiptStorePath,
    payeeCheck,
    // The market's payee is a mainnet account, which NearBlocks indexes, whatever network the Budget is on.
    market: e.AGENT_MARKET === "off" ? null : { rpcUrl: e.AGENT_MARKET_RPC_URL ?? null, payeeCheck: payeeCheck ? { indexer: e.PAYEE_CHECK_INDEXER === "off" ? "off" : "nearblocks", indexerKey: e.PAYEE_CHECK_INDEXER_KEY ?? null } : null },
    http: { port: e.MCP_HTTP_PORT, host: e.MCP_HTTP_HOST, token: httpTokenSource(e) },
  };
}
