/**
 * HashKey Chain reference data for operators and integrators.
 *
 * Every address below was checked live with eth_getCode on 2026-10-29 (mainnet block ~29.44M, testnet ~35.02M).
 * Re-run `pnpm --filter @payminto/protocol verify:hashkey` to re-check them against the live chains.
 * See docs/HASHKEY.md for the evidence and the operational guidance behind each value.
 */
import type { Address } from "viem";

export type HashKeyContracts = {
  /** Uniswap Permit2: signature approvals for tokens without EIP-2612 (for example mainnet USDT). */
  permit2: Address;
  multicall3: Address;
  /** Arachnid deterministic CREATE2 deployer; forge uses it for `new C{salt: s}()`, giving one hub address per salt on every chain. */
  create2Deployer: Address;
  entryPointV06: Address;
  entryPointV07: Address;
  /** Safe v1.4.1 deployment, for ERC-1271 mandate owners. */
  safe: {
    singleton: Address;
    singletonL2: Address;
    proxyFactory: Address;
    compatibilityFallbackHandler: Address;
    multiSendCallOnly: Address;
  };
  /** OP Stack predeploys. */
  eas: Address;
  schemaRegistry: Address;
  gasPriceOracle: Address;
  l1Block: Address;
  /** Note: 0x4200...0006 on HashKey Chain is the OP Stack WETH predeploy, not wrapped HSK. */
  whsk?: Address;
  usdt?: Address;
  ccipRouter: Address;
  /** APRO price feeds (AggregatorV3 interface, 8 decimals). Only feeds verified live are listed. */
  apro: Partial<Record<"usdcUsd" | "usdtUsd" | "btcUsd", Address>>;
};

const shared = {
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  create2Deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  entryPointV06: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  entryPointV07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  safe: {
    singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
    singletonL2: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
    proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    compatibilityFallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  },
  eas: "0x4200000000000000000000000000000000000021",
  schemaRegistry: "0x4200000000000000000000000000000000000020",
  gasPriceOracle: "0x420000000000000000000000000000000000000F",
  l1Block: "0x4200000000000000000000000000000000000015",
} as const;

export const hashkeyContracts: Record<177 | 133, HashKeyContracts> = {
  177: {
    ...shared,
    whsk: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    usdt: "0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029",
    ccipRouter: "0xf2Fd62c083F3BF324e99ce157D1a42d7EbA77f1d",
    apro: {
      usdcUsd: "0x244Ce344df8837c9d938867E2Ffbf0E4B0169B56",
      usdtUsd: "0x823d7f90f7A3498DB6595886b6B5dC95E6B0B7f3",
      btcUsd: "0x204ED500ab56A2E19B051561258E3A45c850360F",
    },
  },
  133: {
    ...shared,
    ccipRouter: "0x1360c71dd2458B6d4A5Ad5946d9011BafA0435d7",
    apro: {},
  },
};

/** Chain behaviour an operator must plan around, measured live. */
export const hashkeyNetworkFacts = {
  177: {
    blockTimeSeconds: 2,
    /** The `safe` head trails `latest` by about this many blocks; `finalized` (L1-finalized) trails by ~822 (~27 min). */
    safeLagBlocks: 12,
    finalizedLagBlocks: 822,
    /** Base fee is held at this floor; priority fee is about 0.001 gwei. */
    baseFeeGwei: 500,
    blockGasLimit: 30_000_000,
    /** eth_getLogs rejects ranges wider than this (inclusive), with JSON-RPC error -32602. */
    maxLogRange: 5_001,
    fallbackRpcUrls: ["https://hashkey.drpc.org", "https://177.rpc.thirdweb.com"],
  },
  133: {
    blockTimeSeconds: 2,
    safeLagBlocks: 300,
    finalizedLagBlocks: 2_070,
    baseFeeGwei: 1,
    blockGasLimit: 30_000_000,
    maxLogRange: 5_001,
    fallbackRpcUrls: ["https://133.rpc.thirdweb.com"],
  },
} as const;

/**
 * Public HashKey Chain links shown by the dashboard (PRODUCT.md section 8), served through GET /v1/info so a link
 * changes in one place. The faucet was measured live on 2026-10-29; bridge and docs are marked "check" in PRODUCT.md.
 */
export const hashkeyLinks: Record<number, { faucet: string | null; bridge: string | null; docs: string | null }> = {
  177: { faucet: null, bridge: "https://bridge.hsk.xyz", docs: "https://docs.hsk.xyz" },
  133: { faucet: "https://faucet.hsk.xyz/faucet", bridge: null, docs: "https://docs.hsk.xyz" },
};

/** OP Stack GasPriceOracle: fee for posting a transaction's data to Ethereum, added on top of L2 execution gas. */
export const gasPriceOracleAbi = [
  { type: "function", name: "getL1Fee", stateMutability: "view", inputs: [{ name: "data", type: "bytes" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "getL1FeeUpperBound",
    stateMutability: "view",
    inputs: [{ name: "unsignedTxSize", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** FiatToken (USDC.e) blacklist check. A blacklisted party makes the whole netting batch revert, so check before settling. */
export const fiatTokenBlacklistAbi = [
  { type: "function", name: "isBlacklisted", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

/** Chainlink AggregatorV3 subset, which APRO feeds implement. */
export const aggregatorV3Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;
