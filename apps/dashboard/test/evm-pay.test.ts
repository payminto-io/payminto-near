import { afterEach, describe, expect, it } from "vitest";
import { checkEvmTransaction, evmWalletErrorMessage, payWithEvmWallet, setEvmProvider } from "@/lib/evm-wallet";

const TX = { chainId: 8453, to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", value: "0x0", data: "0xa9059cbb" };
const FROM = "0xab12cd34ef56ab12cd34ef56ab12cd34ef56abcd";
const HASH = `0x${"ab".repeat(32)}`;

function wallet(chain: string, over: Record<string, (params?: unknown[]) => unknown> = {}) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const answers: Record<string, (params?: unknown[]) => unknown> = { eth_requestAccounts: () => [FROM], eth_chainId: () => chain, wallet_switchEthereumChain: () => null, eth_call: () => `0x${(30_000_000n).toString(16)}`, eth_getBalance: () => "0xde0b6b3a7640000", eth_sendTransaction: () => HASH, ...over };
  setEvmProvider({
    async request({ method, params }) {
      calls.push({ method, params });
      return answers[method]!(params);
    },
  });
  return calls;
}

afterEach(() => setEvmProvider(null));

describe("paying the deposit from a browser wallet", () => {
  it("asks for the account, then sends the exact transaction on the right chain, and answers the hash", async () => {
    const calls = wallet("0x2105");
    await expect(payWithEvmWallet(TX)).resolves.toEqual({ from: FROM, hash: HASH });
    expect(calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "eth_chainId", "eth_sendTransaction"]);
    expect(calls[2]!.params).toEqual([{ from: FROM, to: TX.to, value: "0x0", data: "0xa9059cbb" }]);
  });

  it("checks the balance first when told what is paid, and never opens the wallet for a payment it cannot cover", async () => {
    const calls = wallet("0x2105", { eth_call: () => "0x0" });
    const need = { token: TX.to, amount: 1_501_657n, decimals: 6, symbol: "USDC", chainName: "Base" };
    await expect(payWithEvmWallet(TX, "Base", need)).rejects.toMatchObject({ message: "Your wallet 0xab12...abcd holds 0 USDC on Base, and this payment needs 1.501657 USDC. Pick an account that holds it in your wallet, or add USDC on Base, then try again." });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
    expect(calls.find((c) => c.method === "eth_call")!.params).toEqual([{ to: TX.to, data: `0x70a08231${FROM.slice(2).padStart(64, "0")}` }, "latest"]);
  });

  it("sends when the balance covers it, and checks ETH for a native payment", async () => {
    const enough = wallet("0x2105");
    await payWithEvmWallet(TX, "Base", { token: TX.to, amount: 1_501_657n, decimals: 6, symbol: "USDC", chainName: "Base" });
    expect(enough.map((c) => c.method)).toContain("eth_sendTransaction");
    const poor = wallet("0x2105", { eth_getBalance: () => "0x1" });
    await expect(payWithEvmWallet({ ...TX, value: "0x2f66d79473800", data: "0x" }, "Base", { token: null, amount: 833900000000000n, decimals: 18, symbol: "ETH", chainName: "Base" })).rejects.toMatchObject({ message: expect.stringContaining("holds 0.000000000000000001 ETH on Base") });
    expect(poor.map((c) => c.method)).not.toContain("eth_sendTransaction");
  });

  it("switches the wallet to the payment's chain first when it is on another one", async () => {
    const calls = wallet("0x1");
    await payWithEvmWallet(TX);
    expect(calls.map((c) => c.method)).toEqual(["eth_requestAccounts", "eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction"]);
    expect(calls[2]!.params).toEqual([{ chainId: "0x2105" }]);
  });

  it("never sends when the wallet stays on another chain", async () => {
    const calls = wallet("0x1", { wallet_switchEthereumChain: () => Promise.reject(Object.assign(new Error("Unrecognized chain"), { code: 4902 })) });
    await expect(payWithEvmWallet(TX, "Base")).rejects.toMatchObject({ message: "Your wallet does not have Base yet. Add the Base network in your wallet, then try again." });
    expect(calls.map((c) => c.method)).not.toContain("eth_sendTransaction");
  });

  it("refuses an answer that is not a transaction hash", async () => {
    wallet("0x2105", { eth_sendTransaction: () => "nope" });
    await expect(payWithEvmWallet(TX)).rejects.toMatchObject({ message: "The wallet answered without a transaction hash." });
  });

  it("a declined payment says no money moved", () => {
    expect(evmWalletErrorMessage(Object.assign(new Error("User rejected"), { code: 4001 }), "pay")).toBe("You declined the payment in your wallet. No money moved.");
    expect(evmWalletErrorMessage(Object.assign(new Error("User rejected"), { code: 4001 }))).toBe("You declined the request in your wallet. Nothing was signed.");
  });
});

describe("following the transaction the wallet answered", () => {
  it("is mined, reverted, pending, or unknown to the chain", async () => {
    wallet("0x2105", { eth_getTransactionReceipt: () => ({ status: "0x1" }) });
    expect(await checkEvmTransaction(HASH)).toBe("mined");
    wallet("0x2105", { eth_getTransactionReceipt: () => ({ status: "0x0" }) });
    expect(await checkEvmTransaction(HASH)).toBe("reverted");
    wallet("0x2105", { eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => ({ hash: HASH }) });
    expect(await checkEvmTransaction(HASH)).toBe("pending");
    wallet("0x2105", { eth_getTransactionReceipt: () => null, eth_getTransactionByHash: () => null });
    expect(await checkEvmTransaction(HASH)).toBe("unknown");
  });
});
