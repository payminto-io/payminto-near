#!/usr/bin/env node
/**
 * Payminto Clearing MCP server.
 * stdio (default): for Claude Desktop / Claude Code. Logs go to stderr only; stdout carries the protocol.
 * --http: Streamable HTTP at http://127.0.0.1:3334/mcp (MCP_HTTP_PORT / MCP_HTTP_HOST), behind a bearer token
 *         (MCP_HTTP_TOKEN, or a token generated into a mode 0600 file whose path is logged).
 * --merchant: the merchant server for one business (MERCHANT_API_KEY) instead, on stdio or, with --http, port 3335.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { rpcChainReader } from "./chain.ts";
import { loadMcpConfig, McpConfigError } from "./config.ts";
import { startMcpHttp } from "./http.ts";
import { HttpTokenError, resolveHttpToken } from "./http-token.ts";
import { liveMarket } from "./market.ts";
import { runMerchantMcp } from "./merchant-server.ts";
import { rpcPayeeCheck } from "./payee-guard.ts";
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
    network: config.network,
    hub: config.hub,
    agentKey: config.agentKey,
    budgetId: config.budgetId,
    // Read-only: proofs are checked against the root the hub stores, never against the node's word alone.
    ...(config.rpcUrl ? { chain: rpcChainReader(config.rpcUrl) } : {}),
    maxPrice: config.maxPrice,
    payableHosts: config.payableHosts,
    allowAnyPayee: config.allowAnyPayee,
    trustedNodeKey: config.trustedNodeKey,
    receiptStorePath: config.receiptStorePath,
    // Quotes from the Agent Market, checked against this wallet's limits. Nothing here pays the market.
    ...(config.market
      ? { market: liveMarket({ ...(config.market.rpcUrl ? { rpcUrl: config.market.rpcUrl } : {}), payeeCheck: config.market.payeeCheck ? { indexer: config.market.payeeCheck.indexer, ...(config.market.payeeCheck.indexerKey ? { indexerKey: config.market.payeeCheck.indexerKey } : {}) } : null }) }
      : {}),
    // Read-only as well: the wallet looks at a payee before it signs, and never signs for one the check blocks.
    // PAYEE_CHECK=off (or CHAIN_READER=off) is the operator's explicit opt-out; the library checks payees otherwise.
    ...(config.payeeCheck
      ? { payeeCheck: rpcPayeeCheck({ rpcUrl: config.payeeCheck.rpcUrl, indexer: config.payeeCheck.indexer, codeStorePath: config.payeeCheck.codeStorePath, ...(config.payeeCheck.indexerKey ? { indexerKey: config.payeeCheck.indexerKey } : {}) }) }
      : { signWithoutPayeeCheck: true }),
  });
} catch (err) {
  log(`cannot start the wallet against the clearing node at ${config.nodeUrl}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
wallet.agent.on("error", (e) => log(`agent: ${e.message}`));
log(`agent key from ${config.agentKeySource.kind === "file" ? config.agentKeySource.path : "AGENT_KEY (environment override)"}; chain reader ${config.rpcUrl ?? "off"}`);
log(config.payeeCheck ? `payee check on: reads ${config.rpcUrl}, account ages from ${config.payeeCheck.indexer === "nearblocks" ? "NearBlocks" : "nowhere (no indexer)"}` : "payee check off: this wallet signs for any payee the Budget allows (set CHAIN_READER=rpc and PAYEE_CHECK=on to turn it on)");
log(config.market ? `Agent Market quotes on (quote_market_agent): quotes only, this wallet pays nothing to the market${config.market.payeeCheck ? "; the quoted payee is checked on NEAR mainnet" : ""}` : "Agent Market quotes off (AGENT_MARKET=off)");
log(`pays services the node lists${config.payableHosts.length ? ` and hosts ${config.payableHosts.join(", ")}` : " only (PAYABLE_HOSTS is empty)"}${config.allowAnyPayee ? "; ALLOW_ANY_PAYEE is on" : ""}`);

let stopHttp: (() => Promise<void>) | null = null;
if (mode === "http") {
  let token;
  try {
    token = resolveHttpToken(config.http.token);
  } catch (err) {
    if (!(err instanceof HttpTokenError)) throw err;
    log(`MCP_HTTP_TOKEN_FILE: ${err.message}`);
    wallet.close();
    process.exit(2);
  }
  const h = await startMcpHttp(wallet, { port: config.http.port, host: config.http.host, token: token.token });
  stopHttp = h.close;
  log(`Streamable HTTP on ${h.url} for agent ${wallet.publicKey}, budget ${wallet.budgetId}`);
  // The path, never the token: clients read the file (or the operator set MCP_HTTP_TOKEN).
  log(token.path ? `bearer token ${token.generated ? "generated in" : "read from"} ${token.path} (mode 0600); clients send it as Authorization: Bearer <token>` : "bearer token from MCP_HTTP_TOKEN");
} else {
  const server = createMcpServer(wallet);
  await server.connect(new StdioServerTransport());
  log(`stdio ready for agent ${wallet.publicKey}, budget ${wallet.budgetId}`);
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
