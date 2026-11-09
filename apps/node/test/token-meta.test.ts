import { describe, expect, it } from "vitest";
import { ContractFunctionRevertedError, getAddress, hashDomain, HttpRequestError, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { networks } from "@payminto/protocol";
import { ChainClient } from "../src/chain.ts";

// ChainClient.tokenMeta must sign with the token's real EIP-712 domain or refuse to start: never guess.
const TYPES = { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } as const;
const separatorOf = (name: string, version: string, chainId: number, token: Address): Hex =>
  hashDomain({ domain: { name, version, chainId: BigInt(chainId), verifyingContract: token }, types: TYPES });
const absent = () => new ContractFunctionRevertedError({ abi: [], functionName: "x" });
const down = () => new HttpRequestError({ url: "https://rpc.example", status: 503 });

type Answers = Partial<Record<"symbol" | "decimals" | "name" | "version" | "DOMAIN_SEPARATOR" | "eip712Domain", unknown | (() => Error)>>;

function clientWith(chainId: number, token: Address, answers: Answers): ChainClient {
  const c = new ChainClient({ chainId, rpcUrl: "http://127.0.0.1:1", hub: getAddress("0x" + "11".repeat(20)), token, operatorKey: generatePrivateKey(), rpcRetries: 0 });
  Object.assign(c.public, {
    readContract: async ({ functionName }: { functionName: keyof Answers }) => {
      const a = answers[functionName];
      if (a === undefined) throw absent();
      if (typeof a === "function") throw (a as () => Error)();
      return a;
    },
  });
  return c;
}

describe("ChainClient.tokenMeta", () => {
  it("uses the known chains.ts domain when the token's separator matches it (Circle USDC on Sepolia)", async () => {
    const t = networks[11155111]!.token.address;
    const c = clientWith(11155111, t, { symbol: "USDC", decimals: 6, name: "USDC", version: "2", DOMAIN_SEPARATOR: separatorOf("USDC", "2", 11155111, t) });
    expect(await c.tokenMeta()).toEqual({ symbol: "USDC", decimals: 6, eip712: { name: "USDC", version: "2" } });
  });

  it("uses the token's own ERC-5267 domain for a deployment's test token (Payminto Test USDC on 133)", async () => {
    const t = getAddress("0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15");
    const sep = separatorOf("Payminto Test USDC", "1", 133, t);
    const c = clientWith(133, t, { symbol: "tUSDC", decimals: 6, name: "Payminto Test USDC", DOMAIN_SEPARATOR: sep, eip712Domain: ["0x0f", "Payminto Test USDC", "1", 133n, t, "0x" + "00".repeat(32), []] });
    expect((await c.tokenMeta()).eip712).toEqual({ name: "Payminto Test USDC", version: "1" });
  });

  it("rethrows an RPC outage instead of skipping the check", async () => {
    const t = getAddress("0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15");
    const c = clientWith(133, t, { symbol: "tUSDC", decimals: 6, name: "Payminto Test USDC", DOMAIN_SEPARATOR: down });
    await expect(c.tokenMeta()).rejects.toBeInstanceOf(HttpRequestError);
  });

  it("refuses an unknown token without DOMAIN_SEPARATOR, rather than falling back to the network's domain", async () => {
    const t = getAddress("0x" + "22".repeat(20));
    const c = clientWith(133, t, { symbol: "X", decimals: 6, name: "X" });
    await expect(c.tokenMeta()).rejects.toThrow(/cannot be verified/);
  });

  it("refuses a token whose separator matches no candidate", async () => {
    const t = getAddress("0x" + "33".repeat(20));
    const c = clientWith(133, t, { symbol: "X", decimals: 6, name: "X", version: "2", DOMAIN_SEPARATOR: separatorOf("Other", "9", 133, t) });
    await expect(c.tokenMeta()).rejects.toThrow(/matches none/);
  });
});
