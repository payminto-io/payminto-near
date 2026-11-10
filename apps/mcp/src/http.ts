import { serve } from "@hono/node-server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { bearerMatches } from "./http-token.ts";
import { createMcpServer } from "./server.ts";
import type { AgentWallet } from "./wallet.ts";

export type McpHttp = { url: string; port: number; close(): Promise<void> };

/** `token` is the bearer token every request to /mcp must carry (see http-token.ts). */
export type McpHttpOptions = { port: number; host: string; token: string };

/**
 * Streamable HTTP transport at POST /mcp, stateless: each request gets a fresh MCP server bound to the one shared
 * wallet, so positions and receipts are shared across requests.
 * Binds to loopback by default with DNS-rebinding protection, and requires a bearer token, because the wallet can spend.
 */
export async function startMcpHttp(wallet: AgentWallet, opts: McpHttpOptions): Promise<McpHttp> {
  return serveMcpHttp(() => createMcpServer(wallet), opts, () => ({ ok: true, agent: wallet.publicKey, budgetId: wallet.budgetId }));
}

/**
 * Serves any MCP server factory over stateless Streamable HTTP at POST /mcp, with GET /healthz.
 *
 * Every /mcp request must carry `Authorization: Bearer <token>`: loopback is shared by every process on the machine,
 * so without it any local program could drive a server that can spend or act for a business. Loopback hosts also get
 * DNS-rebinding protection, so a page on another origin cannot reach the server through the browser.
 * /healthz says only that the server is up unless the request is authenticated.
 */
export async function serveMcpHttp(create: () => McpServer, opts: McpHttpOptions, health: () => Record<string, unknown>): Promise<McpHttp> {
  if (opts.token.length < 32) throw new Error("the MCP HTTP transport needs a bearer token of at least 32 characters");
  const app = new Hono();
  app.get("/healthz", (c) => c.json(bearerMatches(c.req.header("authorization"), opts.token) ? health() : { ok: true }));
  const loopback = opts.host === "127.0.0.1" || opts.host === "localhost" || opts.host === "::1";
  let port = opts.port;
  const allowed = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  app.all("/mcp", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null }, 405);
    }
    // DNS-rebinding guard: a browser page on another origin must not drive this server.
    if (loopback && !allowed().includes(c.req.header("host") ?? "")) {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Forbidden host" }, id: null }, 403);
    }
    if (!bearerMatches(c.req.header("authorization"), opts.token)) {
      return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: send Authorization: Bearer <token>" }, id: null }, 401, { "www-authenticate": 'Bearer realm="payminto-mcp"' });
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(loopback
        ? { enableDnsRebindingProtection: true, allowedHosts: allowed() }
        : {}),
    });
    const server = create();
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  const srv = await new Promise<Server>((resolve) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, () => resolve(s as Server));
  });
  port = (srv.address() as AddressInfo).port;
  const host = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  return {
    url: `http://${host}:${port}/mcp`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        srv.close(() => resolve());
        srv.closeAllConnections?.();
      }),
  };
}
