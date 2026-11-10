/**
 * Requests the way curl sends them: a POST or DELETE with no body carries no Content-Length. They must reach their
 * route (`curl -X POST /v1/settlements` is in the docs), and the body limit must still hold for a body sent in chunks.
 * The requests are written to a raw socket, so no HTTP client adds or changes a header.
 */
import { connect } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../src/logger.ts";
import { startNode, type ClearingNode } from "../src/server.ts";
import { OWNER_A, openBudget, startFakeChain, tempDir, testConfig, testKey } from "./helpers.ts";

const ADMIN = "test-admin-token-123";
const tmp = tempDir("payminto-no-body-");
let node: ClearingNode;
let budgetId = "";

/** Sends one request as raw text and returns the status and the JSON body. */
function raw(head: string, body = ""): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const socket = connect(node.port, "127.0.0.1", () => socket.write(`${head}\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${ADMIN}\r\nConnection: close\r\n\r\n${body}`));
    let text = "";
    socket.on("data", (d) => (text += d.toString("utf8")));
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
      const payload = text.slice(text.indexOf("\r\n\r\n") + 4);
      const start = payload.indexOf("{");
      resolve({ status, json: start >= 0 ? JSON.parse(payload.slice(start, payload.lastIndexOf("}") + 1)) : null });
    });
  });
}

beforeAll(async () => {
  const chain = startFakeChain();
  node = await startNode(testConfig({ dbPath: tmp.dbPath, adminToken: ADMIN }), { chain, logger: silentLogger, port: 0, workers: false });
  budgetId = (await openBudget(chain, node.url, ADMIN, OWNER_A, testKey(1))).id;
});

afterAll(async () => {
  await node?.stop();
  tmp.cleanup();
});

describe("a request without a body and without Content-Length", () => {
  it("POST reaches its route", async () => {
    const r = await raw("POST /v1/settlements HTTP/1.1");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ skipped: "nothing to settle" });
  });

  it("DELETE reaches its route, and a route that does not exist is a 404, not a 500", async () => {
    const gone = await raw(`DELETE /v1/budgets/${budgetId}/payee-approvals/seller.testnet HTTP/1.1`);
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBe("NOT_FOUND");
    const none = await raw("DELETE /v1/no-such-route HTTP/1.1");
    expect(none.status).toBe(404);
  });

  it("a body sent in chunks is read, and still held to the 512 KiB limit", async () => {
    const chunked = (payload: string) => `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`;
    const small = await raw(`POST /v1/budgets/${budgetId}/payee-approvals HTTP/1.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked`, chunked(JSON.stringify({ payee: "seller.testnet", decision: "deny" })));
    expect(small.status).toBe(200);
    expect(small.json.approval).toMatchObject({ payee: "seller.testnet", decision: "deny" });
    const big = await raw("POST /v1/payees/reports HTTP/1.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked", chunked(JSON.stringify({ account: "a.testnet", reason: "x".repeat(600 * 1024), evidence: "https://example.com/a" })));
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("an oversized body is read to its end before the 413, so the answer is never lost to a connection reset", async () => {
    // A server that closes a connection on bytes it has not read makes the kernel answer with a reset, and the client
    // then gets ECONNRESET or EPIPE in place of the 413. Eight senders at a time make that race easy to lose.
    const payload = JSON.stringify({ account: "a.testnet", reason: "x".repeat(2 * 1024 * 1024), evidence: "https://example.com/a" });
    const chunked = () => raw("POST /v1/payees/reports HTTP/1.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked", `${Buffer.byteLength(payload).toString(16)}\r\n${payload}\r\n0\r\n\r\n`);
    const sized = () => raw(`POST /v1/payees/reports HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}`, payload);
    for (let round = 0; round < 5; round++) {
      const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? chunked() : sized())));
      expect(answers.map((a) => a.status)).toEqual(Array.from({ length: 8 }, () => 413));
      expect(answers.every((a) => a.json.error.code === "PAYLOAD_TOO_LARGE")).toBe(true);
    }
  });
});
