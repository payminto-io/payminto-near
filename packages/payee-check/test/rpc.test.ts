import { describe, expect, it } from "vitest";
import { nearBlocksAgeSource } from "../src/age.ts";
import { NO_CONTRACT_HASH, contractIdOf } from "../src/facts.ts";
import { ReadError } from "../src/http.ts";
import { NEAR_RPC_FALLBACK_URLS, NEAR_RPC_URLS, RpcNearReader, firstAnswering, rpcEndpoints, rpcReader } from "../src/rpc.ts";
import { fakeFetch, fixture, paramsOf, type Call } from "./helpers.ts";

const URL = "https://rpc.example.test";
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const HOLDER = "641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5";
const PLAIN = "near-examples.testnet";
const MISSING = "this-account-does-not-exist-zz9.testnet";

/** A reader whose every request is answered with one recorded fixture. */
function readerOn(name: string) {
  const f = fixture(`rpc/${name}`);
  const { fetch, calls } = fakeFetch(() => ({ status: f.status, body: f.body }));
  return { reader: new RpcNearReader({ url: URL, fetch }), calls, recorded: f };
}

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (e) {
    return e instanceof ReadError ? e.code : `not a ReadError: ${String(e)}`;
  }
  return "resolved";
};

describe("RpcNearReader against recorded testnet answers", () => {
  it("sends only read-only queries at final finality, with no key or signature anywhere", async () => {
    const { reader, calls } = readerOn("view-account-plain");
    await reader.viewAccount(PLAIN);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: URL,
      method: "POST",
      body: { jsonrpc: "2.0", id: "payminto", method: "query", params: { finality: "final", request_type: "view_account", account_id: PLAIN } },
    });
  });

  it("asks the same question the fixtures were recorded with", async () => {
    for (const [name, run] of [
      ["view-account-contract", (r: RpcNearReader) => r.viewAccount(USDC)],
      ["keys-full-access", (r: RpcNearReader) => r.accessKeys(USDC)],
      ["storage-registered", (r: RpcNearReader) => r.storageBalanceOf(USDC, HOLDER)],
    ] as const) {
      const { reader, calls, recorded } = readerOn(name);
      await run(reader);
      expect(paramsOf(calls[0]!), name).toEqual({ finality: "final", ...recorded.query });
    }
  });

  it("viewAccount: reads a contract account and its code hash", async () => {
    const a = await readerOn("view-account-contract").reader.viewAccount(USDC);
    expect(a).toMatchObject({ codeHash: "EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z", locked: "0", globalContractHash: null, globalContractAccountId: null });
    expect(a?.blockHeight).toBeGreaterThan(0);
    expect(contractIdOf(a!)).toBe("EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z");
  });

  it("viewAccount: reads an account with no contract as the all-ones hash", async () => {
    const a = await readerOn("view-account-plain").reader.viewAccount(PLAIN);
    expect(a?.codeHash).toBe(NO_CONTRACT_HASH);
    expect(contractIdOf(a!)).toBeNull();
  });

  it("viewAccount: answers null for an account that does not exist", async () => {
    expect(await readerOn("view-account-missing").reader.viewAccount(MISSING)).toBeNull();
  });

  it("viewAccount: reads global contract fields when a node sends them", async () => {
    const base = fixture("rpc/view-account-plain").body as { result: Record<string, unknown> };
    const { fetch } = fakeFetch(() => ({ status: 200, body: { ...base, result: { ...base.result, global_contract_account_id: "publisher.testnet" } } }));
    const a = await new RpcNearReader({ url: URL, fetch }).viewAccount(PLAIN);
    expect(contractIdOf(a!)).toBe("global-by-account:publisher.testnet");
  });

  it("accessKeys: counts full-access and function-call keys", async () => {
    const full = await readerOn("keys-full-access").reader.accessKeys(USDC);
    expect(full).toEqual({ keys: [{ publicKey: "ed25519:5BYQWayFEanFwatQefKfuAt5YaUAix3tANi5MtVxm3g2", permission: "full_access", receiverId: null }], more: false });

    const mixed = await readerOn("keys-mixed").reader.accessKeys(PLAIN);
    expect(mixed.more).toBe(false);
    expect(mixed.keys.filter((k) => k.permission === "full_access").length).toBeGreaterThan(0);
    expect(mixed.keys.find((k) => k.permission === "function_call")).toMatchObject({ receiverId: "counter.near-examples.testnet" });
  });

  it("accessKeys: answers an empty list for an account that does not exist", async () => {
    expect(await readerOn("keys-missing-account").reader.accessKeys(MISSING)).toEqual({ keys: [], more: false });
  });

  it("accessKeys: pages through an account with more than 100 keys", async () => {
    const answers = { tooMany: fixture("rpc/keys-too-many"), first: fixture("rpc/keys-page-first"), next: fixture("rpc/keys-page-next"), last: fixture("rpc/keys-full-access") };
    const serve = (call: Call) => {
      const p = paramsOf(call);
      if (p.limit === undefined) return answers.tooMany;
      if (p.after_key === undefined) return answers.first;
      return p.after_key === (answers.first.body as { result: { last_key: string } }).result.last_key ? answers.next : answers.last;
    };
    const { fetch, calls } = fakeFetch(serve);
    const list = await new RpcNearReader({ url: URL, fetch, maxKeyPages: 5 }).accessKeys(HOLDER);
    // Refused plain request, then three pages: two keys, two keys, and a last page of one.
    expect(calls.map((c) => [paramsOf(c).limit, typeof paramsOf(c).after_key])).toEqual([
      [undefined, "undefined"],
      [100, "undefined"],
      [100, "string"],
      [100, "string"],
    ]);
    expect(list.more).toBe(false);
    expect(list.keys).toHaveLength(5);
    expect(list.keys.every((k) => k.permission === "full_access")).toBe(true);

    // With a page limit the reader stops and says there is more.
    const capped = await new RpcNearReader({ url: URL, fetch: fakeFetch(serve).fetch, maxKeyPages: 2 }).accessKeys(HOLDER);
    expect(capped).toMatchObject({ more: true });
    expect(capped.keys).toHaveLength(4);
  });

  it("accessKeys: treats gas keys as the kind of permission they carry", async () => {
    const body = { jsonrpc: "2.0", id: "payminto", result: { block_hash: "x", block_height: 1, keys: [
      { public_key: "ed25519:a", access_key: { nonce: 1, permission: { GasKeyFullAccess: { balance: "1", num_nonces: 4 } } } },
      { public_key: "ed25519:b", access_key: { nonce: 1, permission: { GasKeyFunctionCall: { balance: "1", num_nonces: 4, receiver_id: "shop.testnet", method_names: [] } } } },
    ] } };
    const { fetch } = fakeFetch(() => ({ status: 200, body }));
    expect((await new RpcNearReader({ url: URL, fetch }).accessKeys(PLAIN)).keys.map((k) => [k.permission, k.receiverId])).toEqual([
      ["full_access", null],
      ["function_call", "shop.testnet"],
    ]);
  });

  it("accessKeys: fails closed on a permission it does not know", async () => {
    const body = { jsonrpc: "2.0", id: "payminto", result: { keys: [{ public_key: "ed25519:a", access_key: { nonce: 1, permission: { SomethingNew: {} } } }] } };
    const { fetch } = fakeFetch(() => ({ status: 200, body }));
    expect(await codeOf(new RpcNearReader({ url: URL, fetch }).accessKeys(PLAIN))).toBe("invalid_response");
  });

  it("storageBalanceOf: a balance means registered, null means not registered", async () => {
    expect(await readerOn("storage-registered").reader.storageBalanceOf(USDC, HOLDER)).toEqual({ total: "1250000000000000000000", available: "0" });
    expect(await readerOn("storage-unregistered").reader.storageBalanceOf(USDC, PLAIN)).toBeNull();
  });

  it("storageBalanceOf: encodes the argument as base64 JSON", async () => {
    const { reader, calls } = readerOn("storage-unregistered");
    await reader.storageBalanceOf(USDC, PLAIN);
    const p = paramsOf(calls[0]!);
    expect(p).toMatchObject({ request_type: "call_function", account_id: USDC, method_name: "storage_balance_of", finality: "final" });
    expect(JSON.parse(Buffer.from(p.args_base64 as string, "base64").toString("utf8"))).toEqual({ account_id: PLAIN });
  });

  it("storageBalanceOf: says so when the token is not a contract or lacks the method", async () => {
    expect(await codeOf(readerOn("call-no-contract").reader.storageBalanceOf(PLAIN, PLAIN))).toBe("no_contract");
    expect(await codeOf(readerOn("call-no-method").reader.storageBalanceOf(USDC, PLAIN))).toBe("method_missing");
    expect(await codeOf(readerOn("view-account-missing").reader.storageBalanceOf(MISSING, PLAIN))).toBe("no_contract");
  });

  it("understands the structured form of a failed view call too", async () => {
    const structured = (name: string, data: string) => ({ jsonrpc: "2.0", id: "payminto", error: { name: "HANDLER_ERROR", cause: { name, info: {} }, code: -32000, message: "Server error", data } });
    const on = (body: unknown) => new RpcNearReader({ url: URL, fetch: fakeFetch(() => ({ status: 200, body })).fetch });
    expect(await codeOf(on(structured("NO_CONTRACT_CODE", "x")).storageBalanceOf(USDC, PLAIN))).toBe("no_contract");
    expect(await codeOf(on(structured("CONTRACT_EXECUTION_ERROR", "wasm execution failed with error: MethodResolveError(MethodNotFound)")).storageBalanceOf(USDC, PLAIN))).toBe("method_missing");
    expect(await codeOf(on(structured("CONTRACT_EXECUTION_ERROR", "Smart contract panicked: boom")).storageBalanceOf(USDC, PLAIN))).toBe("contract_error");
    expect(await codeOf(on(structured("UNKNOWN_BLOCK", "x")).viewAccount(PLAIN))).toBe("rpc");
  });

  it("turns every transport failure into a typed error, and none into a value", async () => {
    const on = (answer: Parameters<typeof fakeFetch>[0], timeoutMs = 8_000) => new RpcNearReader({ url: URL, fetch: fakeFetch(answer).fetch, timeoutMs });
    expect(await codeOf(on(() => "hang", 30).viewAccount(PLAIN))).toBe("timeout");
    expect(
      await codeOf(
        on(() => {
          throw new Error("ECONNREFUSED");
        }).viewAccount(PLAIN),
      ),
    ).toBe("network");
    expect(await codeOf(on(() => ({ status: 429, body: "slow down" })).viewAccount(PLAIN))).toBe("http");
    expect(await codeOf(on(() => ({ status: 502, body: "<html>bad gateway</html>" })).viewAccount(PLAIN))).toBe("http");
    expect(await codeOf(on(() => ({ status: 200, body: "<html>not json</html>" })).viewAccount(PLAIN))).toBe("invalid_response");
    expect(await codeOf(on(() => ({ status: 200, body: [] })).viewAccount(PLAIN))).toBe("invalid_response");
    expect(await codeOf(on(() => ({ status: 200, body: { jsonrpc: "2.0", id: "payminto" } })).viewAccount(PLAIN))).toBe("invalid_response");
    expect(await codeOf(on(() => ({ status: 200, body: { result: { amount: 5 } } })).viewAccount(PLAIN))).toBe("invalid_response");
    expect(await codeOf(on(() => ({ status: 200, body: { result: { result: [123, 34] } } })).storageBalanceOf(USDC, PLAIN))).toBe("invalid_response");
  });

  it("names its source and says rate limited on HTTP 429", async () => {
    const reader = new RpcNearReader({ url: URL, fetch: fakeFetch(() => ({ status: 429, body: "" })).fetch });
    await expect(reader.viewAccount(PLAIN)).rejects.toMatchObject({ name: "ReadError", source: "near-rpc", message: "near-rpc answered HTTP 429 (rate limited)" });
  });
});

describe("firstAnswering", () => {
  const plain = fixture("rpc/view-account-plain");
  const down = () => new RpcNearReader({ url: "https://down.example.test", fetch: fakeFetch(() => ({ status: 503, body: "" })).fetch });

  it("falls back to the next endpoint when one is down", async () => {
    const up = fakeFetch(() => plain);
    const reader = firstAnswering([down(), new RpcNearReader({ url: URL, fetch: up.fetch })]);
    expect((await reader.viewAccount(PLAIN))?.codeHash).toBe(NO_CONTRACT_HASH);
    expect(up.calls).toHaveLength(1);
  });

  it("fails with the last error when every endpoint is down", async () => {
    expect(await codeOf(firstAnswering([down(), down()]).viewAccount(PLAIN))).toBe("http");
  });

  it("does not ask a second endpoint about an answer the first one gave", async () => {
    const second = fakeFetch(() => plain);
    const first = new RpcNearReader({ url: URL, fetch: fakeFetch(() => fixture("rpc/call-no-contract")).fetch });
    expect(await codeOf(firstAnswering([first, new RpcNearReader({ url: URL, fetch: second.fetch })]).storageBalanceOf(PLAIN, PLAIN))).toBe("no_contract");
    expect(second.calls).toHaveLength(0);
  });
});

describe("rpcReader", () => {
  const plain = fixture("rpc/view-account-plain");
  /** Answers 429 on the hosts named, and the recorded account everywhere else. */
  const net = (limited: string[]) => {
    const asked: string[] = [];
    const fetch = fakeFetch((call) => {
      const host = new globalThis.URL(call.url).host;
      asked.push(host);
      return limited.includes(host) ? { status: 429, body: "" } : plain;
    }).fetch;
    return { asked, fetch };
  };

  it("on a network's public default endpoint it tries the second public endpoint when the first is rate limited", async () => {
    for (const network of ["testnet", "mainnet"] as const) {
      const first = new globalThis.URL(NEAR_RPC_URLS[network]).host;
      const n = net([first]);
      expect((await rpcReader(NEAR_RPC_URLS[network], { fetch: n.fetch }).viewAccount(PLAIN))?.codeHash).toBe(NO_CONTRACT_HASH);
      expect(n.asked).toEqual([first, new globalThis.URL(NEAR_RPC_FALLBACK_URLS[network]).host]);
      // A trailing slash is the same endpoint.
      expect(rpcEndpoints(`${NEAR_RPC_URLS[network]}/`)).toEqual([`${NEAR_RPC_URLS[network]}/`, NEAR_RPC_FALLBACK_URLS[network]]);
    }
  });

  it("reads an endpoint of your own alone, and never falls over to a public one", async () => {
    const n = net(["rpc.example.test"]);
    expect(await codeOf(rpcReader("https://rpc.example.test", { fetch: n.fetch }).viewAccount(PLAIN))).toBe("http");
    expect(n.asked).toEqual(["rpc.example.test"]);
    expect(rpcEndpoints("http://127.0.0.1:3030")).toEqual(["http://127.0.0.1:3030"]);
    // The fallback endpoint given as your own is read alone too: it is the default that has a partner.
    expect(rpcEndpoints(NEAR_RPC_FALLBACK_URLS.testnet)).toEqual([NEAR_RPC_FALLBACK_URLS.testnet]);
  });
});

describe("nearBlocksAgeSource against recorded testnet answers", () => {
  const sourceOn = (name: string, account?: string) => {
    const f = fixture(`indexer/${name}`);
    const { fetch, calls } = fakeFetch(() => f);
    return { source: nearBlocksAgeSource({ network: "testnet", fetch }), calls, recorded: f, account };
  };

  it("reads the creation time of an indexed account from nanoseconds", async () => {
    const { source, calls, recorded } = sourceOn("account-known");
    expect(await source.createdAt(PLAIN)).toEqual({ status: "known", createdAtMs: 1664639408926, txHash: "4jM2fCA16gw1sjwP5Bdboj5e17QXpKfruxLLiNNYbpyx" });
    expect(calls).toEqual([{ url: recorded.url, method: "GET", body: null }]);
    expect(source.name).toBe("nearblocks");
  });

  it("says no_record for an account from genesis, and never makes up a date", async () => {
    expect(await sourceOn("account-no-record").source.createdAt("testnet")).toEqual({ status: "no_record" });
  });

  it("says not_indexed for an account the indexer has never seen", async () => {
    expect(await sourceOn("account-not-indexed").source.createdAt(MISSING)).toEqual({ status: "not_indexed" });
  });

  it("uses the mainnet host for mainnet and sends an API key only when given one", async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    const fetch = async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.authorization });
      return { status: 200, text: async () => '{"data":null}' };
    };
    await nearBlocksAgeSource({ network: "mainnet", fetch }).createdAt("acme.near");
    await nearBlocksAgeSource({ baseUrl: "https://indexer.example.test/", fetch, apiKey: "k" }).createdAt("acme.near");
    expect(seen).toEqual([
      { url: "https://api.nearblocks.io/v3/accounts/acme.near", auth: undefined },
      { url: "https://indexer.example.test/v3/accounts/acme.near", auth: "Bearer k" },
    ]);
  });

  it("fails with a typed error instead of an answer when the indexer misbehaves", async () => {
    const on = (answer: Parameters<typeof fakeFetch>[0], timeoutMs = 8_000) => nearBlocksAgeSource({ fetch: fakeFetch(answer).fetch, timeoutMs }).createdAt(PLAIN);
    const retired = { data: null, errors: [{ message: "API v1 was retired" }] };
    expect(await codeOf(on(() => ({ status: 410, body: retired })))).toBe("http");
    expect(await codeOf(on(() => ({ status: 429, body: "" })))).toBe("http");
    expect(await codeOf(on(() => "hang", 30))).toBe("timeout");
    expect(await codeOf(on(() => ({ status: 200, body: { account: [] } })))).toBe("invalid_response");
    expect(await codeOf(on(() => ({ status: 200, body: { data: { account_id: PLAIN, created: { block_timestamp: "soon" } } } })))).toBe("invalid_response");
    // An answer about some other account is not an answer.
    expect(await codeOf(on(() => fixture("indexer/account-no-record")))).toBe("invalid_response");
  });
});
