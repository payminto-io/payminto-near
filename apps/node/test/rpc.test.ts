import { describe, expect, it } from "vitest";
import { createPublicClient, custom, HttpRequestError, InvalidParamsRpcError, RpcRequestError } from "viem";
import { localAnvil } from "@payminto/protocol";
import { backoffDelay, bumpFees, isTransientRpcError, retryingTransport } from "../src/chain.ts";

function flaky(failures: Array<() => Error>, result: unknown = "0x85") {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    transport: custom({
      async request() {
        const f = failures[calls++];
        if (f) throw f();
        return result;
      },
    }),
  };
}

const http429 = () => new HttpRequestError({ url: "https://testnet.hsk.xyz", status: 429, details: "Too Many Requests" });
const http503 = () => new HttpRequestError({ url: "https://testnet.hsk.xyz", status: 503 });
const network = () => new HttpRequestError({ url: "https://testnet.hsk.xyz", details: "fetch failed" });
const rangeTooLarge = () =>
  new InvalidParamsRpcError(new RpcRequestError({ url: "https://testnet.hsk.xyz", body: {}, error: { code: -32602, message: "block range too large" } }));

describe("RPC retries", () => {
  it("retries 429, 5xx and network errors with growing, jittered delays, then succeeds", async () => {
    const delays: number[] = [];
    const f = flaky([http429, http503, network]);
    const client = createPublicClient({
      chain: localAnvil,
      transport: retryingTransport(f.transport, { retries: 4, random: () => 0.5, sleep: async (ms) => void delays.push(ms) }),
    });
    expect(await client.getChainId()).toBe(0x85);
    expect(f.calls).toBe(4);
    expect(delays).toEqual([187.5, 375, 750]); // 250 * 2^n, half fixed plus half jitter at random() = 0.5
  });

  it("does not retry deterministic errors such as the 5,001-block eth_getLogs limit", async () => {
    const f = flaky([rangeTooLarge]);
    const client = createPublicClient({ chain: localAnvil, transport: retryingTransport(f.transport, { retries: 4, sleep: async () => {} }) });
    await expect(client.getChainId()).rejects.toThrow(/block range too large|Invalid parameters/);
    expect(f.calls).toBe(1);
  });

  it("gives up after the configured retries", async () => {
    const f = flaky([http429, http429, http429]);
    const client = createPublicClient({ chain: localAnvil, transport: retryingTransport(f.transport, { retries: 2, sleep: async () => {} }) });
    await expect(client.getChainId()).rejects.toThrow();
    expect(f.calls).toBe(3);
  });

  it("classifies transient errors", () => {
    expect(isTransientRpcError(http429())).toBe(true);
    expect(isTransientRpcError(new HttpRequestError({ url: "x", status: 400 }))).toBe(false);
    expect(isTransientRpcError(rangeTooLarge())).toBe(false);
    expect(isTransientRpcError(new Error("execution reverted"))).toBe(false);
  });

  it("treats a provider's internal error (-32603) as transient, unless it reports a revert", () => {
    const internal = (message: string) => new RpcRequestError({ body: {}, url: "x", error: { code: -32603, message } });
    expect(isTransientRpcError(internal("We are not able to process your request at this time."))).toBe(true);
    expect(isTransientRpcError(internal("execution reverted: faucet limit"))).toBe(false);
  });

  it("caps the backoff and keeps the jitter inside [d/2, d]", () => {
    for (let n = 0; n < 12; n++) {
      const lo = backoffDelay(n, { random: () => 0 });
      const hi = backoffDelay(n, { random: () => 0.999999 });
      expect(hi).toBeLessThanOrEqual(8_000);
      expect(lo).toBeGreaterThanOrEqual(Math.min(8_000, 250 * 2 ** n) / 2);
    }
  });
});

describe("fee bump", () => {
  it("raises both fees by 12.5 %, rounding up, and always by at least 1 wei", () => {
    expect(bumpFees({ maxFeePerGas: 500_000_000_000n, maxPriorityFeePerGas: 1_000_000n })).toEqual({
      maxFeePerGas: 562_500_000_000n,
      maxPriorityFeePerGas: 1_125_000n,
    });
    expect(bumpFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n })).toEqual({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    expect(bumpFees({ maxFeePerGas: 9n, maxPriorityFeePerGas: 7n })).toEqual({ maxFeePerGas: 11n, maxPriorityFeePerGas: 8n });
  });
});

describe("L1 data fee", () => {
  it("reads l1Fee from a HashKey Chain receipt through viem's OP Stack formatters, and null elsewhere", async () => {
    const { hashkeyMainnet } = await import("@payminto/protocol");
    const { ChainClient } = await import("../src/chain.ts");
    const raw = {
      blockHash: `0x${"11".repeat(32)}`,
      blockNumber: "0x10",
      contractAddress: null,
      cumulativeGasUsed: "0x5208",
      effectiveGasPrice: "0x746a528800",
      from: `0x${"22".repeat(20)}`,
      gasUsed: "0x5208",
      logs: [],
      logsBloom: `0x${"00".repeat(256)}`,
      status: "0x1",
      to: `0x${"33".repeat(20)}`,
      transactionHash: `0x${"44".repeat(32)}`,
      transactionIndex: "0x1",
      type: "0x2",
      l1Fee: "0x10c5c8a4e38",
      l1GasUsed: "0x640",
      l1GasPrice: "0x3b9aca00",
      l1FeeScalar: null,
    };
    const formatted = hashkeyMainnet.formatters!.transactionReceipt!.format(raw as never) as never;
    expect(ChainClient.l1FeeOf(formatted)).toBe(0x10c5c8a4e38n);
    expect(ChainClient.l1FeeOf({ ...(raw as object), l1Fee: undefined } as never)).toBeNull();
  });
});
