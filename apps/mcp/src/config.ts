import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { networks } from "@payminto/protocol";

export const DEFAULT_DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "deployments");

const zAddress = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), "must be a 0x address")
  .transform((v) => getAddress(v));

const envSchema = z.object({
  NODE_URL: z.url("must be the clearing node base URL, e.g. http://localhost:8787"),
  CHAIN_ID: z
    .string()
    .regex(/^\d+$/, "must be an integer")
    .default("31337")
    .transform(Number)
    .refine((n) => n in networks, `must be one of ${Object.keys(networks).join(", ")}`),
  RPC_URL: z.url().optional(),
  HUB_ADDRESS: zAddress.optional(),
  DEPLOYMENTS_DIR: z.string().optional(),
  AGENT_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte hex private key")
    .transform((v) => v as Hex),
  MANDATE_ID: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte mandate id")
    .transform((v) => v.toLowerCase() as Hex),
  /** Optional client-side ceiling per call, in atomic units: refuse to sign above it. */
  MAX_PRICE_ATOMIC: z.string().regex(/^\d+$/).optional(),
  /** Expected node operator address; receipts signed by anyone else are rejected. */
  TRUSTED_NODE: zAddress.optional(),
  /** Durable receipt and signed-position store (SQLite). Processes sharing AGENT_KEY must share this file. */
  RECEIPT_STORE_PATH: z.string().min(1).optional(),
  /** Base directory for local state when RECEIPT_STORE_PATH is unset. */
  PAYMINTO_DATA_DIR: z.string().min(1).optional(),
  MCP_HTTP_PORT: z.string().regex(/^\d+$/).default("3334").transform(Number),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
});

export type McpConfig = {
  nodeUrl: string;
  chainId: number;
  rpcUrl: string | undefined;
  /** Undefined means "ask the node" (GET /v1/info). */
  hub: Address | undefined;
  agentKey: Hex;
  mandateId: Hex;
  maxPrice: bigint | undefined;
  trustedNode: Address | undefined;
  /** SQLite file holding this agent's receipts and the highest cumulative it signed per payee. */
  receiptStorePath: string;
  http: { port: number; host: string };
};

export class McpConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid Payminto MCP configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "McpConfigError";
  }
}

function hubFromDeployments(chainId: number, dir: string): Address | undefined {
  const file = join(dir, `${chainId}.json`);
  if (!existsSync(file)) return undefined;
  const parsed = z.object({ clearingHub: zAddress, chainId: z.number() }).safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success || parsed.data.chainId !== chainId) throw new McpConfigError([`${file}: not a deployments file for chain ${chainId}`]);
  return parsed.data.clearingHub;
}

/** Parses the environment once. Errors name the variable, never its value (AGENT_KEY is a secret). */
export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new McpConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  const e = parsed.data;
  const net = networks[e.CHAIN_ID]!;
  return {
    nodeUrl: e.NODE_URL.replace(/\/+$/, ""),
    chainId: e.CHAIN_ID,
    rpcUrl: e.RPC_URL ?? (e.CHAIN_ID === 31337 ? undefined : net.chain.rpcUrls.default.http[0]),
    hub: e.HUB_ADDRESS ?? hubFromDeployments(e.CHAIN_ID, e.DEPLOYMENTS_DIR ?? DEFAULT_DEPLOYMENTS_DIR),
    agentKey: e.AGENT_KEY,
    mandateId: e.MANDATE_ID,
    maxPrice: e.MAX_PRICE_ATOMIC === undefined ? undefined : BigInt(e.MAX_PRICE_ATOMIC),
    trustedNode: e.TRUSTED_NODE,
    receiptStorePath: resolve(
      e.RECEIPT_STORE_PATH ??
        join(e.PAYMINTO_DATA_DIR ?? join(homedir(), ".payminto"), "mcp", `receipts-${e.CHAIN_ID}-${privateKeyToAccount(e.AGENT_KEY).address.toLowerCase()}.db`),
    ),
    http: { port: e.MCP_HTTP_PORT, host: e.MCP_HTTP_HOST },
  };
}
