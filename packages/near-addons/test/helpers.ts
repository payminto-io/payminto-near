import { readFileSync } from "node:fs";
import type { FetchLike } from "../src/intents/client.ts";

export const fixture = <T = Record<string, unknown>>(path: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8")) as T;

export type Route = {
  method: "GET" | "POST";
  /** Matched against the full URL with `startsWith`. */
  url: string;
  /** For JSON-RPC routes: the `call_function` method name or `view_access_key` / `block`. */
  rpc?: string;
  status: number;
  body: unknown;
};

export type Call = { method: string; url: string; body: unknown };

/**
 * A fetch that serves only fixtures and records every call. Anything it has no fixture for fails the test, and any
 * JSON-RPC method that could submit a transaction throws, so a test proves the code never tried to send.
 */
export function fakeFetch(routes: Route[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    const rpcMethod = body && typeof body.jsonrpc === "string" ? String(body.method) : undefined;
    if (rpcMethod && /send_tx|broadcast_tx/.test(rpcMethod)) throw new Error(`test refused a transaction submit: ${rpcMethod}`);
    const params = (body?.params ?? {}) as Record<string, unknown>;
    const rpcKey = rpcMethod === "query" ? String(params.method_name ?? params.request_type) : rpcMethod;
    const route = routes.find((r) => r.method === method && url.startsWith(r.url) && (r.rpc === undefined || r.rpc === rpcKey));
    if (!route) throw new Error(`no fixture for ${method} ${url} ${rpcKey ?? ""}`);
    return { status: route.status, text: async () => JSON.stringify(route.body) };
  };
  return { fetch, calls };
}

/** A JSON-RPC `call_function` result wrapping a JSON value, as nearcore returns it. */
export const rpcView = (value: unknown, height = 1) => ({
  jsonrpc: "2.0",
  id: "payminto",
  result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: height, block_hash: "11111111111111111111111111111111" },
});
