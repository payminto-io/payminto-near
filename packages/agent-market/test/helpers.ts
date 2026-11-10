import { readFileSync } from "node:fs";
import { MarketError, type Clock, type FetchLike } from "../src/index.ts";

export type Recorded = { _source: string; _recorded?: string; _note: string; status: number; body: unknown };

/** A fixture file. `*.live.json` is a real public answer of the market; `*.synthetic.json` is written by hand. */
export function fixture(name: string): Recorded {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Recorded;
}

export type Call = { method: string; url: string; headers: Record<string, string>; body: unknown; redirect: RequestInit["redirect"] };
type Answer = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Route = Answer | ((call: Call) => Answer | Promise<Answer>);

/**
 * A fetch that answers from a table keyed by `METHOD url` and records every call. An unknown route fails the test, so
 * no test can reach the network by accident.
 */
export function fakeFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { method: init.method ?? "GET", url, headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined, redirect: init.redirect };
    calls.push(call);
    const route = routes[`${call.method} ${url}`] ?? routes[`${call.method} ${url.split("?")[0]}`];
    if (!route) throw new Error(`no fake route for ${call.method} ${url}`);
    const a = typeof route === "function" ? await route(call) : route;
    return new Response(a.text ?? JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { "content-type": "application/json", ...a.headers } });
  };
  return { fetch, calls };
}

/** A clock that only moves when something sleeps on it. */
export function fakeClock(start = 1_800_000_000_000): Clock & { slept: number[]; advance: (ms: number) => void } {
  let t = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new MarketError("ABORTED", "aborted");
      slept.push(ms);
      t += ms;
      // Give timers and I/O a turn, as a real sleep would; otherwise a polling loop starves everything else.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

export const MARKET = "https://market.near.ai";
export const TOKEN = `aat_${"0123456789abcdef".repeat(2)}`;

export async function failure(p: Promise<unknown> | (() => unknown)): Promise<MarketError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof MarketError) return err;
    throw err;
  }
  throw new Error("expected a MarketError");
}
