import type { Context } from "hono";
import { streamSSE as honoStreamSSE } from "hono/streaming";

/**
 * Hono's `streamSSE` with `Cache-Control: no-cache, no-transform`.
 * Hono sends `no-cache` only, which lets a proxy in front of the node compress the stream and hold events back until
 * the connection closes: the dashboard's Next.js server gzips proxied responses, so live updates never reached the
 * browser. `no-transform` tells every proxy to pass the stream through as it is.
 */
export function streamSSE(c: Context, ...rest: Parameters<typeof honoStreamSSE> extends [Context, ...infer R] ? R : never): Response {
  const res = honoStreamSSE(c, ...rest);
  // Hono merges the context's headers into the handler's response afterwards, so the context header must change too,
  // and a new Response carries the value for any path that does not merge.
  c.header("Cache-Control", "no-cache, no-transform");
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-cache, no-transform");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
