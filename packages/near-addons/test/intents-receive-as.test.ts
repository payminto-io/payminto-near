/**
 * Origin token details, payout destinations off NEAR ("receive as") and the EIP-191 payout proof, at the kit's public
 * seams: the pinned tables against today's recorded /v0/tokens, the quote builder and checks, the proof message and its
 * verification with viem, and the fake 1Click server delivering to an EVM chain it serves receipts for.
 */
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { CHECKOUT_ORIGINS, checkPayInQuote, payInQuoteRequest } from "../src/intents/checkout.ts";
import { OneClickClient } from "../src/intents/client.ts";
import {
  ERC20_TRANSFER_TOPIC,
  EVM_PAYOUT_CHAINS,
  evmPayoutProofMessage,
  PAYOUT_DESTINATIONS,
  payoutDestinationOf,
  verifyEvmPayoutProof,
} from "../src/intents/destination.ts";
import { FAKE_ONECLICK_MANAGER_PUBLIC_KEY, FakeOneClick } from "../src/intents/fake-server.ts";
import { NEAR_MAINNET_USDC_ASSET, type OneClickToken } from "../src/intents/types.ts";
import { fixture } from "./helpers.ts";

const tokens = fixture<{ body: OneClickToken[] }>("oneclick/pay-in/tokens-2026-11-13.live.json").body;
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const BASE_USDC_DEST = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const OP_USDC = "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ";
const NEAR_MERCHANT = "1111111111111111111111111111111111111111111111111111111111111111";
const EVM_MERCHANT = "0x5f2b3c4d5e6f708192a3b4c5d6e7f8091a2b554f";
const REFUND = "0x1111111111111111111111111111111111111111";
// Public test key (anvil's first account). Never funded anywhere this code reaches.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("origin token details", () => {
  it("pins every offered origin's contract address and EVM chain id, as today's live /v0/tokens has them", () => {
    for (const o of CHECKOUT_ORIGINS) {
      const t = tokens.find((x) => x.assetId === o.assetId);
      expect(t, o.assetId).toBeDefined();
      expect(o.contractAddress, o.assetId).toBe(t!.contractAddress ?? null);
    }
    const ids = Object.fromEntries(CHECKOUT_ORIGINS.map((o) => [`${o.symbol}/${o.blockchain}`, [o.contractAddress, o.chainId]]));
    expect(ids).toEqual({
      "USDC/base": ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", 8453],
      "USDC/eth": ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", 1],
      "USDC/arb": ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", 42161],
      "USDC/sol": ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", null],
      "USDC/pol": ["0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", 137],
      "USDT/eth": ["0xdac17f958d2ee523a2206206994597c13d831ec7", 1],
      "ETH/base": [null, 8453],
      "ETH/eth": [null, 1],
    });
  });
});

describe("payout destinations", () => {
  it("are USDC with 6 decimals on NEAR, Base, Arbitrum, Ethereum, Polygon and Optimism, verbatim from today's /v0/tokens", () => {
    expect(PAYOUT_DESTINATIONS.map((d) => d.blockchain)).toEqual(["near", "base", "arb", "eth", "pol", "op"]);
    expect(EVM_PAYOUT_CHAINS).toEqual(["base", "arb", "eth", "pol", "op"]);
    for (const d of PAYOUT_DESTINATIONS) {
      const t = tokens.find((x) => x.assetId === d.assetId);
      expect(t, d.assetId).toBeDefined();
      expect({ symbol: t!.symbol, decimals: t!.decimals, blockchain: t!.blockchain, contract: t!.contractAddress }).toEqual({ symbol: "USDC", decimals: 6, blockchain: d.blockchain, contract: d.contractAddress });
    }
    expect(payoutDestinationOf("near")!.assetId).toBe(NEAR_MAINNET_USDC_ASSET);
    expect(payoutDestinationOf("op")).toMatchObject({ assetId: OP_USDC, chainName: "Optimism", chainId: 10 });
    expect(payoutDestinationOf("base")).toMatchObject({ chainId: 8453, chainName: "Base" });
    expect(payoutDestinationOf("near")!.chainId).toBeNull();
  });

  it("leaves out a chain whose USDC is not 6 decimals (BNB Chain's has 18)", () => {
    const bsc = tokens.find((t) => t.blockchain === "bsc" && t.symbol === "USDC");
    expect(bsc?.decimals).toBe(18);
    expect(payoutDestinationOf("bsc")).toBeUndefined();
  });
});

describe("a pay-in quote to an EVM destination", () => {
  const base = { origin: BASE_USDC, amount: 5_000_000n, refundTo: REFUND, slippageBps: 10, deadline: "2026-11-13T15:49:42.000Z", dry: true };

  it("asks for that chain's USDC, delivered to the business's address on that chain", () => {
    const asked = payInQuoteRequest({ ...base, recipient: EVM_MERCHANT, destination: "base" });
    expect(asked).toMatchObject({ destinationAsset: BASE_USDC_DEST, recipient: EVM_MERCHANT, recipientType: "DESTINATION_CHAIN", swapType: "EXACT_OUTPUT" });
    expect(payInQuoteRequest({ ...base, recipient: EVM_MERCHANT, destination: payoutDestinationOf("op")! }).destinationAsset).toBe(OP_USDC);
    // NEAR stays the default.
    expect(payInQuoteRequest({ ...base, recipient: NEAR_MERCHANT }).destinationAsset).toBe(NEAR_MAINNET_USDC_ASSET);
  });

  it("refuses a recipient of the wrong kind for the destination, and a destination that is not offered", () => {
    expect(() => payInQuoteRequest({ ...base, recipient: "shop.near", destination: "base" })).toThrow(/Base address/);
    expect(() => payInQuoteRequest({ ...base, recipient: "0x0000000000000000000000000000000000000000", destination: "base" })).toThrow(/Base address/);
    expect(() => payInQuoteRequest({ ...base, recipient: EVM_MERCHANT.toUpperCase().replace("0X", "0x"), destination: "near" })).toThrow(/NEAR account/);
    expect(() => payInQuoteRequest({ ...base, recipient: EVM_MERCHANT, destination: "bsc" })).toThrow(/not a payout destination/);
  });
});

describe("the EIP-191 payout proof", () => {
  const account = privateKeyToAccount(TEST_KEY);
  const address = account.address.toLowerCase();
  const scope = { merchantId: "mer_shopaaaaaaaaaaaaaaaaaaaaaa", address, timestamp: 1_763_000_000, chainId: 8453, hub: "hub.test.near" };

  it("is exactly the agreed message", () => {
    expect(evmPayoutProofMessage({ ...scope, address: account.address })).toBe(`Payminto intents payout mer_shopaaaaaaaaaaaaaaaaaaaaaa ${address} 1763000000 network eip155:8453 hub hub.test.near`);
  });

  it("verifies a personal_sign of it by the address, and nothing else", async () => {
    const signature = await account.signMessage({ message: evmPayoutProofMessage(scope) });
    expect(await verifyEvmPayoutProof({ ...scope, signature })).toBe(true);
    // Checksummed or lowercased, the address is the same one.
    expect(await verifyEvmPayoutProof({ ...scope, address: account.address, signature })).toBe(true);
    expect(await verifyEvmPayoutProof({ ...scope, address: REFUND, signature })).toBe(false);
    expect(await verifyEvmPayoutProof({ ...scope, chainId: 42161, signature })).toBe(false);
    expect(await verifyEvmPayoutProof({ ...scope, merchantId: "mer_otheraaaaaaaaaaaaaaaaaaaaa", signature })).toBe(false);
    expect(await verifyEvmPayoutProof({ ...scope, timestamp: scope.timestamp + 1, signature })).toBe(false);
    expect(await verifyEvmPayoutProof({ ...scope, hub: "hub.other.near", signature })).toBe(false);
    expect(await verifyEvmPayoutProof({ ...scope, signature: "0x1234" })).toBe(false);
    expect(await verifyEvmPayoutProof({ ...scope, signature: "not hex" })).toBe(false);
  });
});

describe("the fake 1Click server delivering off NEAR", () => {
  const rpc = async (fake: FakeOneClick, chain: string, method: string, params: unknown[] = []) => {
    const r = await fake.handle("POST", `/_fake/rpc/${chain}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    return { status: r.status, body: JSON.parse(r.body) as { result?: any; error?: { code: number; message: string } } };
  };

  it("quotes USDC on Base to an address, delivers it there as a simulated ERC-20 transfer and serves its receipt over JSON-RPC", async () => {
    const delivered: string[] = [];
    const fake = new FakeOneClick({ stepMs: 0, refundAfterMs: 0, deliver: async (d) => (delivered.push(d.recipient), { txHash: "NearTx" }) });
    const client = new OneClickClient({ baseUrl: "http://fake.local", fetch: fake.fetch });
    const asked = payInQuoteRequest({ origin: BASE_USDC, amount: 5_000_000n, recipient: EVM_MERCHANT, refundTo: REFUND, slippageBps: 10, deadline: new Date(Date.now() + 1_800_000), dry: false, destination: "base" });
    const q = await client.quote(asked);
    expect(checkPayInQuote(asked, q, { recipient: EVM_MERCHANT, managerPublicKey: FAKE_ONECLICK_MANAGER_PUBLIC_KEY })).toEqual([]);
    await fake.deposit(q.quote.depositAddress!, BigInt(q.quote.amountIn));
    await fake.idle();
    const s = await client.status(q.quote.depositAddress!);
    expect(s.status).toBe("SUCCESS");
    // The NEAR deliver hook (the local stack's ft_transfer) is never asked to deliver to another chain.
    expect(delivered).toEqual([]);
    const hash = s.swapDetails.destinationChainTxHashes[0]!.hash;
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);

    expect((await rpc(fake, "base", "eth_chainId")).body.result).toBe("0x2105");
    const receipt = (await rpc(fake, "base", "eth_getTransactionReceipt", [hash])).body.result;
    expect(receipt).toMatchObject({ transactionHash: hash, status: "0x1" });
    expect(receipt.logs).toEqual([
      {
        address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        topics: [ERC20_TRANSFER_TOPIC, expect.stringMatching(/^0x0{24}[0-9a-f]{40}$/), `0x${"0".repeat(24)}${EVM_MERCHANT.slice(2)}`],
        data: `0x${(5_000_000n).toString(16).padStart(64, "0")}`,
        transactionHash: hash,
        blockNumber: receipt.blockNumber,
        logIndex: "0x0",
        removed: false,
      },
    ]);
    const head = BigInt((await rpc(fake, "base", "eth_blockNumber")).body.result);
    expect(head).toBeGreaterThanOrEqual(BigInt(receipt.blockNumber));
    // Another chain does not know the transaction; an unknown method is a JSON-RPC error.
    expect((await rpc(fake, "arb", "eth_getTransactionReceipt", [hash])).body.result).toBeNull();
    expect((await rpc(fake, "base", "eth_sendRawTransaction", ["0x00"])).body.error?.code).toBe(-32601);
    expect((await rpc(fake, "bsc", "eth_chainId")).status).toBe(404);
  });

  it("refuses a NEAR account as the recipient of an EVM destination, as the live API does", async () => {
    const fake = new FakeOneClick({ stepMs: 0 });
    const asked = { ...payInQuoteRequest({ origin: BASE_USDC, amount: 5_000_000n, recipient: EVM_MERCHANT, refundTo: REFUND, slippageBps: 10, deadline: new Date(Date.now() + 1_800_000), dry: true, destination: "op" }), recipient: "shop.near" };
    const r = await fake.handle("POST", "/v0/quote", JSON.stringify(asked));
    expect(r.status).toBe(400);
  });
});
