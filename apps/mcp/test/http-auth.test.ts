/**
 * The bearer token of the MCP HTTP transport. A stand-in MCP server with one tool that "spends" shows what a local
 * process without the token can and cannot do; the token file is created in a temp directory.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/config.ts";
import { serveMcpHttp } from "../src/http.ts";
import { bearerMatches, HttpTokenError, httpTokenSource, resolveHttpToken } from "../src/http-token.ts";
import { loadMerchantConfig } from "../src/merchant-server.ts";

const TOKEN = "t".repeat(40);
const dir = mkdtempSync(join(tmpdir(), "payminto-mcp-http-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("L3: MCP over HTTP needs a bearer token", () => {
  it("refuses requests without the token and serves the tools with it", async () => {
    let spent = 0;
    const create = () => {
      const server = new McpServer({ name: "stand-in", version: "1" });
      server.registerTool("spend", { description: "moves money", inputSchema: {} }, () => {
        spent++;
        return { content: [{ type: "text", text: "spent" }] };
      });
      return server;
    };
    const h = await serveMcpHttp(create, { port: 0, host: "127.0.0.1", token: TOKEN }, () => ({ ok: true, budgetId: "b" }));
    try {
      const rpc = (method: string, params?: unknown) => ({ method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
      const none = await fetch(h.url, rpc("tools/list"));
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
      const spendCall = rpc("tools/call", { name: "spend", arguments: {} });
      // Any local process can reach the port. Without the token it cannot make the server act.
      expect((await fetch(h.url, spendCall)).status).toBe(401);
      for (const bad of ["Bearer wrong", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN.slice(1)}`]) {
        expect((await fetch(h.url, { ...spendCall, headers: { ...spendCall.headers, authorization: bad } })).status, bad.slice(0, 12)).toBe(401);
      }
      expect(spent).toBe(0);

      const c = new Client({ name: "http-test", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(new URL(h.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual(["spend"]);
      await c.callTool({ name: "spend", arguments: {} });
      await c.close();
      expect(spent).toBe(1);

      // Health says only "up" to a caller without the token.
      const health = new URL("/healthz", h.url);
      expect(await (await fetch(health)).json()).toEqual({ ok: true });
      expect(await (await fetch(health, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).toEqual({ ok: true, budgetId: "b" });
    } finally {
      await h.close();
    }
    await expect(serveMcpHttp(create, { port: 0, host: "127.0.0.1", token: "short" }, () => ({ ok: true }))).rejects.toThrow(/at least 32 characters/);
  });

  it("compares tokens as a whole", () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    for (const bad of [undefined, "", "Bearer ", `bearer ${TOKEN}`, `Bearer ${TOKEN} `, `Bearer  ${TOKEN}`, `Bearer ${TOKEN.slice(0, -1)}`]) expect(bearerMatches(bad, TOKEN)).toBe(false);
  });

  it("generates a token into a mode 0600 file when none is configured, and reuses it", () => {
    const path = join(dir, "state", "mcp", "http-token");
    const src = httpTokenSource({ PAYMINTO_DATA_DIR: join(dir, "state") });
    expect(src).toEqual({ kind: "file", path });
    const first = resolveHttpToken(src);
    expect(first).toMatchObject({ generated: true, path });
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state", "mcp")).mode & 0o077).toBe(0);
    expect(readFileSync(path, "utf8").trim()).toBe(first.token);
    expect(resolveHttpToken(src)).toEqual({ token: first.token, generated: false, path });
    // A token others can read is refused, and the error never carries it.
    chmodSync(path, 0o644);
    try {
      resolveHttpToken(src);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpTokenError);
      expect((err as Error).message).toMatch(/readable by other users .*chmod 600/);
      expect((err as Error).message).not.toContain(first.token);
    }
    expect(resolveHttpToken(httpTokenSource({ MCP_HTTP_TOKEN: TOKEN }))).toEqual({ token: TOKEN, generated: false, path: null });
  });

  it("takes the token from the environment for both servers, and refuses a weak one", () => {
    const base = { NODE_URL: "http://localhost:8787", AGENT_KEY: "ab".repeat(32), BUDGET_ID: "cd".repeat(32), PAYMINTO_DATA_DIR: dir };
    expect(loadMcpConfig(base).http).toEqual({ port: 3334, host: "127.0.0.1", token: { kind: "file", path: join(dir, "mcp", "http-token") } });
    expect(loadMcpConfig({ ...base, MCP_HTTP_TOKEN: TOKEN }).http.token).toEqual({ kind: "env", token: TOKEN });
    expect(loadMcpConfig({ ...base, MCP_HTTP_TOKEN_FILE: join(dir, "elsewhere") }).http.token).toEqual({ kind: "file", path: join(dir, "elsewhere") });
    try {
      loadMcpConfig({ ...base, MCP_HTTP_TOKEN: "hunter2" });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toMatch(/MCP_HTTP_TOKEN: must be 32 to 256 characters/);
      expect((err as Error).message).not.toContain("hunter2");
    }
    const merchant = loadMerchantConfig({ NODE_URL: "http://localhost:8787", MERCHANT_API_KEY: `sk_test_${"b".repeat(52)}`, PAYMINTO_DATA_DIR: dir });
    expect(merchant.http.token).toEqual({ kind: "file", path: join(dir, "mcp", "merchant-http-token") });
  });
});
