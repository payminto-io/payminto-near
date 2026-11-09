#!/usr/bin/env node
/**
 * Payminto Clearing MCP server.
 * stdio (default): for Claude Desktop / Claude Code. Logs go to stderr only; stdout carries the protocol.
 * --http: Streamable HTTP at http://127.0.0.1:3334/mcp (MCP_HTTP_PORT / MCP_HTTP_HOST).
 * --merchant: the merchant server for one business (MERCHANT_API_KEY) instead, on stdio or, with --http, port 3335.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadMcpConfig, McpConfigError } from "./config.ts";
import { startMcpHttp } from "./http.ts";
import { runMerchantMcp } from "./merchant-server.ts";
import { createMcpServer } from "./server.ts";
import { AgentWallet } from "./wallet.ts";

const log = (msg: string) => process.stderr.write(`[payminto-mcp] ${msg}\n`);

const mode = process.argv.includes("--http") || process.env.MCP_TRANSPORT === "http" ? "http" : "stdio";

// --merchant: the business back-office server (merchant-server.ts). It runs until the process exits, so the agent
// wallet server below never starts.
if (process.argv.includes("--merchant")) await runMerchantMcp(mode, log);

let config;
try {
  config = loadMcpConfig(process.env);
} catch (err) {
  if (err instanceof McpConfigError) {
    log(`${err.message}\nSee apps/mcp/README.md.`);
    process.exit(2);
  }
  throw err;
}

let wallet: AgentWallet;
try {
  wallet = await AgentWallet.connect({
    nodeUrl: config.nodeUrl,
    chainId: config.chainId,
    hub: config.hub,
    agentKey: config.agentKey,
    mandateId: config.mandateId,
    rpcUrl: config.rpcUrl,
    maxPrice: config.maxPrice,
    trustedNode: config.trustedNode,
    receiptStorePath: config.receiptStorePath,
  });
} catch (err) {
  log(`cannot reach the clearing node at ${config.nodeUrl}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
wallet.agent.on("error", (e) => log(`agent: ${e.message}`));
wallet.agent.on("cosigned", (c) => log(`co-signed HSP payment ${c.hspPaymentId} for batch ${c.batchId}`));
wallet.agent.on("cosignRefused", (c) => log(`REFUSED to co-sign HSP payment ${c.hspPaymentId}: ${c.reason}`));

let stopHttp: (() => Promise<void>) | null = null;
if (mode === "http") {
  const h = await startMcpHttp(wallet, config.http);
  stopHttp = h.close;
  log(`Streamable HTTP on ${h.url} for agent ${wallet.address}, mandate ${wallet.mandateId}`);
} else {
  const server = createMcpServer(wallet);
  await server.connect(new StdioServerTransport());
  log(`stdio ready for agent ${wallet.address}, mandate ${wallet.mandateId}`);
}

const shutdown = async () => {
  wallet.close();
  await stopHttp?.();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("end", () => {
  if (mode === "stdio") void shutdown();
});
