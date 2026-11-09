# HashKey Chain reference

Everything Payminto Clearing relies on about HashKey Chain, measured live with read-only RPC calls on 2026-10-29.
The same values live in code in `packages/protocol/src/hashkey.ts` and `packages/protocol/src/chains.ts`.
Re-check them at any time with `pnpm --filter @payminto/protocol verify:hashkey`.

## 1. Networks

| | Mainnet | Testnet |
|---|---|---|
| Chain id | 177 | 133 |
| RPC | https://mainnet.hsk.xyz | https://testnet.hsk.xyz |
| Fallback RPCs | https://hashkey.drpc.org, https://177.rpc.thirdweb.com | https://133.rpc.thirdweb.com |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hskchain.net |
| Verify API (Blockscout) | https://hsk.blockscout.com/api/ | https://testnet-explorer.hskchain.net/api/ |
| Faucet | - | https://faucet.hsk.xyz/faucet |
| Native token | HSK, 18 decimals | HSK, 18 decimals |
| Block time | 2 s | 2 s |
| Block gas limit | 30,000,000 | 30,000,000 |

`testnet-explorer.hsk.xyz`, which older docs mention, does not resolve; use `testnet-explorer.hskchain.net`.
Sourcify also verifies contracts on both chains.

## 2. Stack, finality and confirmations

HashKey Chain is an OP Stack L2 with the Ecotone, Fjord and Isthmus upgrades active (`GasPriceOracle.version()` is `1.3.1-beta.1`).

| Head | Mainnet lag behind `latest` | Testnet lag | Meaning |
|---|---|---|---|
| `latest` (unsafe) | 0 | 0 | Sequencer has included it; can still reorg. |
| `safe` | about 12 blocks (24 s) | about 300 blocks | Batch data posted to Ethereum. |
| `finalized` | about 822 blocks (about 27 min) | about 2,070 blocks | Ethereum has finalized the batch. |

Payminto Clearing books a settlement as included at one confirmation and treats it as final once its block is at or below the `safe` head (`CONFIRM_TAG`, default `safe` on 133 and 177).
Operators who need L1 finality can set `CONFIRM_TAG=finalized` instead.
The revocation scan also reads only up to that head.
There is no public mempool (`txpool_content` is not exposed), which makes front-running of `settleBatch` impractical.

## 3. Fees

- Mainnet base fee sits at a 500 gwei floor; the priority fee is about 0.001 gwei.
- Testnet base fee is 1 gwei, so testnet gas costs say nothing about mainnet costs.
- On top of L2 execution, every transaction pays an L1 data fee for posting its data to Ethereum, computed by the GasPriceOracle predeploy `0x420000000000000000000000000000000000000F` (`getL1Fee(bytes)`, `getL1FeeUpperBound(uint256)`).
- Measured: a 64-claim `settleBatch` (22,692 bytes of calldata) paid 0.00118 HSK of L1 fee on 2026-10-29 and 0.00027 HSK at mainnet block 29,439,234 (`docs/GAS.md`), against about 0.95 HSK of L2 execution: well under 0.15% of the total, moving with Ethereum fees.
- There is no operator fee (`operatorFeeScalar()` reverts).
- viem's OP Stack formatters, used by our chain definitions, expose `l1Fee` and `l1GasUsed` on every receipt.

Settlement gas for every batch size is in `docs/GAS.md`.

## 4. Tokens

| Token | Chain | Address | Decimals | EIP-712 domain | Signature approvals |
|---|---|---|---|---|---|
| USDC.e (default) | 177 | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | 6 | name `Bridged USDC`, version `2` | EIP-2612 permit and EIP-3009 |
| USDT | 177 | `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` | 6 | none | none, use Permit2 |
| WHSK | 177 | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | 18 | none | none |
| USDC (Circle) | 133 | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | 6 | name `USD Coin`, version `2` | EIP-2612 permit and EIP-3009; the network default in `chains.ts`, but it has no public faucet |
| Payminto Test USDC | 133 | `0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15` | 6 | name `Payminto Test USDC`, version `1` | EIP-2612 and EIP-3009; open faucet up to 1,000 per call; used when `contracts/deployments/133.json` names it, which it does |

- USDC.e is a FiatToken: it has a blacklist (`isBlacklisted(address)`), and a blacklisted party makes any transfer to or from it revert, so a clearing node must screen every party before settling a batch (Payminto does, see section 9).
- `0x4200000000000000000000000000000000000006` on HashKey Chain is the OP Stack WETH predeploy, not wrapped HSK; WHSK is the address above.
- The USDC.e domain name is `Bridged USDC`, not `USD Coin`; signing with the wrong name produces signatures the token rejects.

## 5. Shared infrastructure (same address on 177 and 133)

| Contract | Address | How Payminto Clearing uses it |
|---|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Signature approvals for tokens without EIP-2612 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batched balance, allowance and blacklist reads |
| CREATE2 deployer (Arachnid) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | Deterministic ClearingHub address across chains |
| EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | Smart-account agents |
| EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | Smart-account agents |
| Safe 1.4.1 singleton | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | Mandate owners via ERC-1271 |
| Safe 1.4.1 L2 singleton | `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` | Mandate owners via ERC-1271 |
| Safe proxy factory | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | Creating a treasury Safe |
| Safe fallback handler | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | ERC-1271 signature checks on Safes |
| Safe MultiSendCallOnly | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` | Batched Safe transactions |
| EAS | `0x4200000000000000000000000000000000000021` | Attestations (predeploy) |
| EAS SchemaRegistry | `0x4200000000000000000000000000000000000020` | Attestation schemas (predeploy) |
| GasPriceOracle | `0x420000000000000000000000000000000000000F` | L1 data fee |
| L1Block | `0x4200000000000000000000000000000000000015` | L1 origin data |

Chain-specific:

| Contract | Mainnet (177) | Testnet (133) |
|---|---|---|
| Chainlink CCIP router | `0xf2Fd62c083F3BF324e99ce157D1a42d7EbA77f1d` | `0x1360c71dd2458B6d4A5Ad5946d9011BafA0435d7` |
| APRO USDC/USD (8 dp) | `0x244Ce344df8837c9d938867E2Ffbf0E4B0169B56` | - |
| APRO USDT/USD (8 dp) | `0x823d7f90f7A3498DB6595886b6B5dC95E6B0B7f3` | - |
| APRO BTC/USD (8 dp) | `0x204ED500ab56A2E19B051561258E3A45c850360F` | - |

Not verified, so deliberately not in code: an APRO HSK/USD feed (the published address has only 38 hex characters) and the HashKey KYC SBT address.

## 6. RPC limits

- `eth_getLogs` accepts at most 5,001 blocks per request (inclusive) and answers wider ranges with JSON-RPC error `-32602 block range too large`.
- Forty rapid sequential calls produced no rate limiting, and JSON-RPC batching works.
- Production nodes should still configure a fallback RPC and retry with jittered exponential backoff (Payminto does both, see section 9).

## 7. HSP (HashKey Settlement Protocol)

- Status on 2026-10-29: the `project-hsp` GitHub organisation has no public repositories, `@hsp/core` and `@hsp/sdk` are not on npm, and the HashKey documentation repository last changed on 2026-06-22.
- Payminto Clearing implements HSP wire v1 (`packages/protocol/src/hsp.ts`): EIP-712 domain `HSP` version `1`, the `eip712-eoa.v1` signer profile, address recipients, the capability-set hash and the decimal-string wire form.
- Every net transfer of a batch becomes an HSP mandate whose `settlementBinding` is the batch id, co-signed by the paying agent.
- In `local` mode the node is the HSP adapter and verifier; in `coordinator` mode it registers each payment with the HSP Coordinator once credentials are issued.
- In `coordinator` mode the node reads the Coordinator's `GET /chains` at startup, resolves this chain by id (registry name and `verifyingContract`; `HSP_CHAIN_NAME` is only a fallback), refuses to start when a pinned `HSP_VERIFYING_CONTRACT` differs, and sends the capabilities it hashed into each mandate (`HSP_REQUIRED_CAPABILITIES`) instead of an empty list.

## 8. Deploying

Deployment and verification steps are in `docs/DEPLOY.md`.

## 9. What Payminto Clearing implements on top of these facts

| HashKey Chain behaviour | What the node and contracts do | Code | Tests |
|---|---|---|---|
| `safe` head trails `latest` (section 2) | Batches go `submitted` -> `included` (one confirmation) -> `confirmed` once the block is at or below `CONFIRM_TAG`; ledger, positions, EAS and HSP move only at `confirmed`, exactly once. A finality tracker runs every 2 s and at startup. | `apps/node/src/settlement.ts` (`trackFinality`, `#markIncluded`, `#finalize`), `apps/node/src/chain.ts` (`headOf`), `apps/node/migrations/003_finality_fees_attestations.sql` | `apps/node/test/hashkey.test.ts` (finality) |
| Unsafe blocks can reorg | A settlement whose receipt disappears goes back to `submitted` and its stored signed transaction is rebroadcast with the same nonce; the batch fails and returns its calls only when the hub has no record of it and its nonce now belongs to another transaction. | `apps/node/src/settlement.ts` (`#handleMissing`) | `apps/node/test/hashkey.test.ts` (both reorg cases) |
| Revocations on chain | The revocation scan reads up to the finality head in windows of at most 5,001 blocks. | `apps/node/src/mandates.ts` (`scanRevocations`) | `apps/node/test/ops.test.ts` |
| USDC.e permit, domain `Bridged USDC` v2 (section 4) | `ClearingHub.openMandateWithPermit` opens the mandate and calls `permit` in a try/catch (front-run safe: proceeds only if the allowance already covers the value). `AgentClient.signPermit` takes the domain from `chains.ts` and refuses unless it matches the token's `DOMAIN_SEPARATOR()`. `POST /v1/mandates` accepts `permit`. The agent needs zero HSK and zero transactions. | `contracts/src/ClearingHub.sol`, `packages/protocol/src/permit.ts`, `packages/sdk/src/agent.ts`, `apps/node/src/mandates.ts` | `contracts/test/ClearingHubPermit.t.sol`, `packages/sdk/test/sdk.test.ts`, `apps/node/test/hashkey.test.ts`, fork suite, `pnpm demo` (Research Writer) |
| USDC.e blacklist (section 4) | Before simulating a batch, every agent and payee is checked with `isBlacklisted` in one Multicall3 call; affected claims are dropped with a `funds.warning` and a clear reason. Tokens without the function have no blacklist. | `apps/node/src/chain.ts` (`blacklisted`, `supportsBlacklist`), `apps/node/src/settlement.ts` (`#screenBlacklist`), `contracts/src/MockFiatToken.sol` | `apps/node/test/hashkey.test.ts`, fork suite (real FiatToken) |
| L1 data fee (section 3) | Every operator transaction is preflighted against gas x maxFeePerGas plus the L1 fee (viem op-stack `estimateL1Fee` on the GasPriceOracle); the fee each settlement paid (`l1Fee` from the OP Stack receipt) is stored per batch and served as `l1Fee`. | `apps/node/src/chain.ts` (`send`, `#preflight`, `l1FeeOf`), `apps/node/scripts/measure-gas.ts` | `apps/node/test/rpc.test.ts`, `apps/node/test/hashkey.test.ts`, fork suite |
| RPC limits (section 6) | JSON-RPC retries with exponential backoff and jitter on network errors, timeouts, 429 and 5xx (`RPC_RETRIES`), over `RPC_URL` plus fallbacks; deterministic errors such as the 5,001-block limit are not retried. Settlements not included after `TX_BUMP_AFTER_BLOCKS` blocks are replaced with the same nonce and fees raised 12.5 %. | `apps/node/src/chain.ts` (`retryingTransport`, `send`, `bumpFees`) | `apps/node/test/rpc.test.ts`, `apps/node/test/hashkey.test.ts` (replacement) |
| HSP Coordinator chain registry (section 7) | Resolves the chain and `verifyingContract` from `GET /chains` by chain id, refuses to start on a pin mismatch, sends the real `requiredCapabilities`. | `apps/node/src/hsp/coordinator.ts`, `apps/node/src/server.ts` | `apps/node/test/hsp.test.ts`, `apps/node/test/hashkey.test.ts` |
| EAS predeploy (section 5) | With `EAS_ATTEST=true` each confirmed batch is attested (schema `bytes32 batchId,bytes32 receiptsRoot,uint256 gross,uint256 net,uint256 transfers`, registered on first use, attester the operator, recipient the hub); the local HSP adapter verifies it on chain and adds `attests:payminto-batch-settled:v1` to the satisfied capabilities; the batch API links it. | `apps/node/src/eas.ts`, `apps/node/src/hsp/local.ts` | fork suite |
| Safe 1.4.1, CREATE2 deployer, Multicall3 (section 5) | Safe-owned mandates work through ERC-1271; the hub deploys at one CREATE2 address per bytecode. | `contracts/script/Deploy.s.sol` | fork suite |

The fork suite (`pnpm test:fork`, `apps/node/test/fork/hashkey-testnet.test.ts`) runs `anvil --fork-url https://testnet.hsk.xyz` and, against real testnet state, deploys the hub through the CREATE2 deployer and checks the address, mints the real testnet USDC through its master minter, opens a mandate with a real EIP-2612 permit, opens a mandate owned by a Safe 1.4.1 created by the on-chain SafeProxyFactory, pays calls through the SDK, settles with blacklist screening and the L1 fee preflight, confirms at the safe head, attests on EAS and gets an HSP `ACCEPT`.
Every transaction goes to the local fork; the node runs with `RPC_FALLBACK_URLS=none` and per-run keys.
anvil does not add `l1Fee` to forked receipts, so the stored `l1Fee` is null on the fork and set on the real chains.
