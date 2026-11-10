/**
 * Re-records the fixtures in this directory from public NEAR testnet endpoints. Read-only: it sends view queries and
 * GET requests, and nothing else. Run it from the package directory with `node test/fixtures/record.ts`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RPC = "https://rpc.testnet.near.org";
const INDEXER = "https://api-testnet.nearblocks.io";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const HOLDER = "641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5";
const PLAIN = "near-examples.testnet";
const MISSING = "this-account-does-not-exist-zz9.testnet";
const recorded = new Date().toISOString().slice(0, 10);
const args = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64");

function save(dir: string, name: string, fixture: Record<string, unknown>): void {
  mkdirSync(join(here, dir), { recursive: true });
  writeFileSync(join(here, dir, `${name}.json`), `${JSON.stringify({ recorded, ...fixture }, null, 2)}\n`);
  console.log(`${dir}/${name}.json`);
}

const queries: Record<string, Record<string, string | number>> = {
  "view-account-contract": { request_type: "view_account", account_id: USDC },
  "view-account-plain": { request_type: "view_account", account_id: PLAIN },
  "view-account-missing": { request_type: "view_account", account_id: MISSING },
  "keys-full-access": { request_type: "view_access_key_list", account_id: USDC },
  "keys-mixed": { request_type: "view_access_key_list", account_id: PLAIN },
  "keys-missing-account": { request_type: "view_access_key_list", account_id: MISSING },
  // HOLDER has more than 100 keys: the plain request is refused, and a paged one answers. Two keys a page keeps the files small.
  "keys-too-many": { request_type: "view_access_key_list", account_id: HOLDER },
  "keys-page-first": { request_type: "view_access_key_list", account_id: HOLDER, limit: 2 },
  "storage-registered": { request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", args_base64: args({ account_id: HOLDER }) },
  "storage-unregistered": { request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", args_base64: args({ account_id: PLAIN }) },
  "call-no-contract": { request_type: "call_function", account_id: PLAIN, method_name: "storage_balance_of", args_base64: args({ account_id: PLAIN }) },
  "call-no-method": { request_type: "call_function", account_id: USDC, method_name: "no_such_method", args_base64: args({}) },
};

type KeyList = { result?: { keys?: Array<{ access_key: { permission: unknown } }>; last_key?: string } };

// A list that grows while it is walked: the second key page can only be asked for once the first has answered.
const pending = Object.entries(queries);
for (const [name, query] of pending) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "payminto", method: "query", params: { finality: "final", ...query } }),
  });
  const body = (await res.json()) as KeyList;
  let note: string | undefined;
  if (name === "keys-mixed") {
    // Function-call permissions are cut down to the two fields that say what the key may call.
    for (const k of body.result?.keys ?? []) {
      const p = k.access_key.permission as { FunctionCall?: { receiver_id: string; method_names: string[] } } | string;
      if (typeof p === "object" && p.FunctionCall) k.access_key.permission = { FunctionCall: { receiver_id: p.FunctionCall.receiver_id, method_names: p.FunctionCall.method_names } };
    }
    note = "Function-call permissions are trimmed to receiver_id and method_names. Everything else is as answered.";
  }
  save("rpc", name, { url: RPC, query, status: res.status, ...(note ? { note } : {}), body });
  if (name === "keys-page-first" && body.result?.last_key) pending.push(["keys-page-next", { ...query, after_key: body.result.last_key }]);
}

const accounts: Record<string, string> = { "account-known": PLAIN, "account-no-record": "testnet", "account-not-indexed": MISSING };
for (const [name, account] of Object.entries(accounts)) {
  const url = `${INDEXER}/v3/accounts/${account}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  save("indexer", name, { url, status: res.status, body: await res.json() });
}
