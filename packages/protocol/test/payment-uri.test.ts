import { describe, expect, it } from "vitest";
import { depositEvmTransaction, depositPaymentUri, type DepositUriOrigin } from "../src/index.ts";

const BASE_USDC: DepositUriOrigin = { chain: "base", chainId: 8453, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" };
const BASE_ETH: DepositUriOrigin = { chain: "base", chainId: 8453, contractAddress: null, decimals: 18, symbol: "ETH" };
const SOL_USDC: DepositUriOrigin = { chain: "sol", chainId: null, contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC" };
const DEPOSIT_EVM = "0x87151c5ac911a4459762ce215649313cd369dc05";
const DEPOSIT_SOL = "mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN";

describe("depositPaymentUri: EIP-681 on EVM chains", () => {
  // EIP-681 (https://eips.ethereum.org/EIPS/eip-681), "Examples": an ERC-20 transfer of 1 atomic unit is
  // `ethereum:0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7/transfer?address=0x8e23ee67d1332ad560396262c48ffbb01f93d052&uint256=1`.
  // The grammar is `schema_prefix target_address [ "@" chain_id ] [ "/" function_name ] [ "?" parameters ]`, so the same
  // request pinned to chain 1 carries `@1` after the token contract.
  it("builds the spec's ERC-20 transfer example, pinned to its chain", () => {
    const o = { chain: "eth", chainId: 1, contractAddress: "0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7", decimals: 18, symbol: "UNI" };
    expect(depositPaymentUri(o, "0x8e23ee67d1332ad560396262c48ffbb01f93d052", "1")).toBe(
      "ethereum:0x89205a3a3b2a69de6dbf7f01ed13b2108b2c43e7@1/transfer?address=0x8e23ee67d1332ad560396262c48ffbb01f93d052&uint256=1",
    );
  });

  it("sends USDC on Base to the deposit address in base units", () => {
    expect(depositPaymentUri(BASE_USDC, DEPOSIT_EVM, "4509585")).toBe(
      "ethereum:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@8453/transfer?address=0x87151c5ac911a4459762ce215649313cd369dc05&uint256=4509585",
    );
  });

  // EIP-681, "Examples": a payment of 2.014 ETH is `ethereum:0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359?value=2.014e18`.
  // `value` is in wei ("the atomic unit"); a plain integer is the same number, which every wallet parses.
  it("builds the spec's native ETH example with the value in wei", () => {
    const o = { chain: "eth", chainId: 1, contractAddress: null, decimals: 18, symbol: "ETH" };
    expect(depositPaymentUri(o, "0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359", "2014000000000000000")).toBe("ethereum:0xfb6916095ca1df60bb79Ce92ce3ea74c37c5d359@1?value=2014000000000000000");
  });

  it("sends native ETH on Base to the deposit address", () => {
    expect(depositPaymentUri(BASE_ETH, DEPOSIT_EVM, "1250000000000000")).toBe("ethereum:0x87151c5ac911a4459762ce215649313cd369dc05@8453?value=1250000000000000");
  });

  it("returns null for anything it cannot state exactly", () => {
    // No chain id: a wallet would send on whatever network it is on.
    expect(depositPaymentUri({ ...BASE_USDC, chainId: null }, DEPOSIT_EVM, "1")).toBeNull();
    expect(depositPaymentUri({ ...BASE_USDC, chainId: 0 }, DEPOSIT_EVM, "1")).toBeNull();
    expect(depositPaymentUri({ ...BASE_USDC, chainId: 1.5 }, DEPOSIT_EVM, "1")).toBeNull();
    // Not hex addresses.
    expect(depositPaymentUri(BASE_USDC, "0x87151c5ac911a4459762ce215649313cd369dc0", "1")).toBeNull();
    expect(depositPaymentUri(BASE_USDC, "shop.near", "1")).toBeNull();
    expect(depositPaymentUri({ ...BASE_USDC, contractAddress: "0xzz3589fcd6edb6e08f4c7c32d4f71b54bda02913" }, DEPOSIT_EVM, "1")).toBeNull();
    expect(depositPaymentUri(BASE_USDC, `${DEPOSIT_EVM}&uint256=1`, "1")).toBeNull();
    // A token row without its contract is missing data, never a native transfer of the same number of wei.
    expect(depositPaymentUri({ ...BASE_USDC, contractAddress: null }, DEPOSIT_EVM, "4509585")).toBeNull();
  });
});

describe("depositPaymentUri: Solana Pay", () => {
  // Solana Pay transfer request spec (https://docs.solanapay.com/spec), "Examples": a request for 0.01 USDC is
  // `solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=0.01&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
  // `amount` is in user units of the token (not base units), with a leading 0 below 1 and no scientific notation.
  it("builds the spec's 0.01 USDC example from base units", () => {
    expect(depositPaymentUri(SOL_USDC, DEPOSIT_SOL, "10000")).toBe("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=0.01&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("writes the amount in decimal units without trailing zeros", () => {
    expect(depositPaymentUri(SOL_USDC, DEPOSIT_SOL, "4509585")).toBe("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=4.509585&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(depositPaymentUri(SOL_USDC, DEPOSIT_SOL, "4500000")).toBe("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=4.5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(depositPaymentUri(SOL_USDC, DEPOSIT_SOL, "12000000")).toBe("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=12&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(depositPaymentUri(SOL_USDC, DEPOSIT_SOL, "1")).toBe("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=0.000001&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  // The same spec's SOL example is `solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=1&label=...`: native SOL
  // has no `spl-token`.
  it("leaves spl-token out for native SOL", () => {
    expect(depositPaymentUri({ chain: "sol", chainId: null, contractAddress: null, decimals: 9, symbol: "SOL" }, DEPOSIT_SOL, "1000000000")).toBe("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=1");
  });

  it("returns null for addresses that are not base58 keys and for a token without its mint", () => {
    expect(depositPaymentUri(SOL_USDC, DEPOSIT_EVM, "1")).toBeNull();
    expect(depositPaymentUri(SOL_USDC, "mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2k0", "1")).toBeNull();
    expect(depositPaymentUri({ ...SOL_USDC, contractAddress: "not-a-mint" }, DEPOSIT_SOL, "1")).toBeNull();
    expect(depositPaymentUri({ ...SOL_USDC, contractAddress: null }, DEPOSIT_SOL, "1")).toBeNull();
  });
});

describe("depositPaymentUri: everything else", () => {
  it("returns null for chains without a payment URI here", () => {
    expect(depositPaymentUri({ chain: "tron", chainId: null, contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, symbol: "USDT" }, "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf", "1000000")).toBeNull();
    expect(depositPaymentUri({ chain: "btc", chainId: null, contractAddress: null, decimals: 8, symbol: "BTC" }, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "1000")).toBeNull();
  });

  it("takes only a positive integer amount in base units", () => {
    for (const bad of ["0", "-1", "1.5", "1e6", "", " 1", "01", "0x10", "abc"]) {
      expect(depositPaymentUri(BASE_USDC, DEPOSIT_EVM, bad), bad).toBeNull();
      expect(depositPaymentUri(SOL_USDC, DEPOSIT_SOL, bad), bad).toBeNull();
    }
  });

  it("takes only whole, non-negative decimals", () => {
    expect(depositPaymentUri({ ...SOL_USDC, decimals: -1 }, DEPOSIT_SOL, "1")).toBeNull();
    expect(depositPaymentUri({ ...SOL_USDC, decimals: 6.5 }, DEPOSIT_SOL, "1")).toBeNull();
    expect(depositPaymentUri({ ...BASE_USDC, decimals: Number.NaN }, DEPOSIT_EVM, "1")).toBeNull();
  });
});

describe("depositEvmTransaction: the transaction a connected wallet sends for the deposit", () => {
  const DEP = "0x87151c5ac911a4459762ce215649313cd369dc05";
  const BASE_USDC = { chain: "base", chainId: 8453, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6, symbol: "USDC" };

  it("an ERC-20 is a transfer(address,uint256) call on the token contract, with no value", () => {
    const tx = depositEvmTransaction(BASE_USDC, DEP, "25025000");
    expect(tx).toEqual({
      chainId: 8453,
      to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      value: "0x0",
      data: "0xa9059cbb00000000000000000000000087151c5ac911a4459762ce215649313cd369dc0500000000000000000000000000000000000000000000000000000000017dd9e8",
    });
  });

  it("native ETH is a plain transfer of the value to the deposit address", () => {
    const tx = depositEvmTransaction({ chain: "base", chainId: 8453, contractAddress: null, decimals: 18, symbol: "ETH" }, DEP, "833900000000000");
    expect(tx).toEqual({ chainId: 8453, to: DEP, value: "0x2f66d79473800", data: "0x" });
  });

  it("is null wherever the payment URI would be: Solana, a token that lost its contract, a bad address or amount", () => {
    expect(depositEvmTransaction({ chain: "sol", chainId: null, contractAddress: null, decimals: 9, symbol: "SOL" }, "So11111111111111111111111111111111111111112", "1")).toBeNull();
    expect(depositEvmTransaction({ ...BASE_USDC, contractAddress: null }, DEP, "25025000")).toBeNull();
    expect(depositEvmTransaction(BASE_USDC, "0x1234", "25025000")).toBeNull();
    expect(depositEvmTransaction(BASE_USDC, DEP, "0")).toBeNull();
    expect(depositEvmTransaction(BASE_USDC, DEP, "1.5")).toBeNull();
    expect(depositEvmTransaction({ ...BASE_USDC, chainId: null }, DEP, "25025000")).toBeNull();
  });
});
