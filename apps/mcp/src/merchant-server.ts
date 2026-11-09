import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MERCHANT_INSTRUCTIONS, MERCHANT_TOOLS, MerchantDesk, type MerchantToolResult } from "@payminto/sdk";
import { McpConfigError } from "./config.ts";
import { serveMcpHttp, type McpHttp } from "./http.ts";

export const MERCHANT_SERVER_NAME = "payminto-merchant";
export const MERCHANT_SERVER_VERSION = "0.1.0";

export { MerchantDesk };

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

const envSchema = z.object({
  NODE_URL: z.url("must be the Payminto server base URL, e.g. http://localhost:8787"),
  MERCHANT_API_KEY: z
    .string({ error: "is required: a business API key (sk_test_... or sk_live_...) from Developers > API keys" })
    .regex(/^sk_(test|live)_[A-Za-z0-9]{16,}$/, "must be a business API key (sk_test_... or sk_live_...)"),
  /** Optional: the business the key belongs to; the server refuses to start when the key is for another one. */
  MERCHANT_ID: z.string().regex(/^mer_[A-Za-z0-9]+$/, "must be a business id (mer_...)").optional(),
  MCP_HTTP_PORT: z.string().regex(/^\d+$/).default("3335").transform(Number),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
});

export type MerchantMcpConfig = { nodeUrl: string; apiKey: string; merchantId: string | undefined; http: { port: number; host: string } };

/** Parses the environment. Errors name the variable, never its value (MERCHANT_API_KEY is a secret). */
export function loadMerchantConfig(env: Record<string, string | undefined> = process.env): MerchantMcpConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new McpConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`));
  const e = parsed.data;
  return { nodeUrl: e.NODE_URL.replace(/\/+$/, ""), apiKey: e.MERCHANT_API_KEY, merchantId: e.MERCHANT_ID, http: { port: e.MCP_HTTP_PORT, host: e.MCP_HTTP_HOST } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The MCP server

/** MCP result of a merchant tool: the text for the model, and the data as structured content on success. */
function toCallToolResult(r: MerchantToolResult): CallToolResult {
  if (r.isError) return { isError: true, content: [{ type: "text", text: r.text }] };
  return { content: [{ type: "text", text: r.text }], structuredContent: { result: r.data as Record<string, unknown> } };
}

/**
 * Builds the merchant MCP server for one business. One desk can back many server instances (stateless HTTP). The
 * tools themselves live in `@payminto/sdk` (merchant-tools.ts), shared with the node's ops agents.
 */
export function createMerchantMcpServer(desk: MerchantDesk): McpServer {
  const server = new McpServer({ name: MERCHANT_SERVER_NAME, version: MERCHANT_SERVER_VERSION }, { instructions: MERCHANT_INSTRUCTIONS });
  const who = desk.business.name;
  for (const t of MERCHANT_TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description(who), inputSchema: t.inputSchema, annotations: t.annotations }, async (args: Record<string, unknown>) =>
      toCallToolResult(await t.run(desk, args as never)),
    );
  }
  return server;
}

// ---------------------------------------------------------------------------------------------------------------------
// Process entry (`payminto-mcp --merchant`)

/** Streamable HTTP for the merchant server, the same stateless transport and loopback guard as the wallet server. */
export function startMerchantMcpHttp(desk: MerchantDesk, opts: { port: number; host: string }): Promise<McpHttp> {
  return serveMcpHttp(() => createMerchantMcpServer(desk), opts, () => ({ ok: true, server: MERCHANT_SERVER_NAME, merchant_id: desk.business.id }));
}

/**
 * Runs the merchant MCP server (stdio, or Streamable HTTP with `http`) until the process exits. It never resolves,
 * so main.ts does not go on to start the agent wallet server.
 */
export async function runMerchantMcp(mode: "stdio" | "http", log: (msg: string) => void, env: Record<string, string | undefined> = process.env): Promise<never> {
  let config: MerchantMcpConfig;
  try {
    config = loadMerchantConfig(env);
  } catch (err) {
    if (err instanceof McpConfigError) {
      log(`${err.message}\nSee apps/mcp/README.md (Merchant server).`);
      process.exit(2);
    }
    throw err;
  }
  let desk: MerchantDesk;
  try {
    desk = await MerchantDesk.connect(config);
  } catch (err) {
    log(`cannot start the merchant server against ${config.nodeUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let stopHttp: (() => Promise<void>) | null = null;
  if (mode === "http") {
    const h = await startMerchantMcpHttp(desk, config.http);
    stopHttp = h.close;
    log(`merchant server on Streamable HTTP ${h.url} for ${desk.business.name} (${desk.business.id})`);
  } else {
    await createMerchantMcpServer(desk).connect(new StdioServerTransport());
    log(`merchant server on stdio for ${desk.business.name} (${desk.business.id})`);
  }
  const shutdown = async () => {
    await stopHttp?.();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => {
    if (mode === "stdio") void shutdown();
  });
  return new Promise<never>(() => {});
}
