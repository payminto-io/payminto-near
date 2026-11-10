import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountView, Fact, PayeeFacts } from "../src/facts.ts";
import { NO_CONTRACT_HASH } from "../src/facts.ts";
import type { FetchLike } from "../src/http.ts";

const here = dirname(fileURLToPath(import.meta.url));

export const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
export const DAY = 86_400_000;
export const CODE_A = "EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z";
export const CODE_B = "DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa";

export const known = <T>(value: T): Fact<T> => ({ state: "known", value });
export const unknown = (reason = "source down"): Fact<never> => ({ state: "unknown", reason });
export const NOT_CHECKED: Fact<never> = { state: "not_checked" };

export const view = (over: Partial<AccountView> = {}): AccountView => ({
  amount: "1",
  locked: "0",
  codeHash: NO_CONTRACT_HASH,
  storageUsage: 182,
  globalContractHash: null,
  globalContractAccountId: null,
  blockHeight: 1,
  blockHash: "x",
  ...over,
});

/** Facts for an ordinary, long-lived, registered personal account that nothing speaks against. */
export const facts = (over: Partial<PayeeFacts> = {}): PayeeFacts => ({
  payee: "acme.testnet",
  kind: "named",
  payer: "owner.testnet",
  nowMs: NOW,
  account: known(view()),
  keys: known({ fullAccess: 1, functionCall: 0, more: false }),
  age: known({ status: "known", createdAtMs: NOW - 400 * DAY, txHash: null, source: "test-indexer" }),
  code: known({ contractId: null, firstSeenAtMs: NOW - 10 * DAY, changedAtMs: null, previousContractId: null }),
  token: known({ token: "usdc.testnet", registered: true }),
  history: known({ count: 5, totalPaid: "12500000", lastAtMs: NOW - DAY }),
  reports: known([]),
  budgetPayees: ["acme.testnet"],
  ...over,
});

export type Fixture = { url: string; status: number; query?: Record<string, unknown>; body: unknown };

export const fixture = (path: string): Fixture => JSON.parse(readFileSync(join(here, "fixtures", `${path}.json`), "utf8")) as Fixture;

export type Call = { url: string; method: string; body: Record<string, unknown> | null };

/**
 * A `fetch` that answers from a function and records what it was asked. Return a fixture, or throw to simulate a
 * dropped connection, or return "hang" to never answer.
 */
export function fakeFetch(answer: (call: Call) => { status: number; body: unknown } | "hang"): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null };
    calls.push(call);
    const a = answer(call);
    if (a === "hang") return new Promise(() => {});
    return { status: a.status, text: async () => (typeof a.body === "string" ? a.body : JSON.stringify(a.body)) };
  };
  return { fetch, calls };
}

/** The `params` of a recorded JSON-RPC call. */
export const paramsOf = (call: Call): Record<string, unknown> => (call.body?.params ?? {}) as Record<string, unknown>;
