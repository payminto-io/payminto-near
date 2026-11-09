# Deploying ClearingHub to HashKey Chain

The hub has no owner, no admin keys and no upgrade path, so a deployment is final and safe to share.
It never holds funds.
Deploying costs only gas in HSK.

## 1. Prerequisites

- Foundry 1.5 or newer (`forge --version`).
- A deployer wallet with a little HSK.
- Testnet HSK comes from https://faucet.hsk.xyz/faucet.

Gas planning:

| | Mainnet (177) | Testnet (133) |
|---|---|---|
| Base fee | held at 500 gwei | about 1 gwei |
| Primary RPC | https://mainnet.hsk.xyz | https://testnet.hsk.xyz |
| Fallback RPCs | https://hashkey.drpc.org, https://177.rpc.thirdweb.com | https://133.rpc.thirdweb.com |
| Explorer | https://hsk.blockscout.com | https://testnet-explorer.hskchain.net |
| `eth_getLogs` range | at most 5,001 blocks | at most 5,001 blocks |

At 500 gwei, deploying the hub (about 2.0M gas) costs about 1 HSK on mainnet; fund the deployer with a little more than that.
`docs/HASHKEY.md` has the measured chain facts behind these numbers.

Keep the deployer key out of shell history and out of this repo.
The simplest safe option is a Foundry keystore:

```bash
cast wallet import payminto-deployer --interactive
```

## 2. Deterministic address

`script/Deploy.s.sol` deploys with CREATE2 through the canonical deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` (present on 31337, 133, 177 and Sepolia) and the salt `keccak256("payminto.clearing.v1")`.
`foundry.toml` pins `bytecode_hash = "ipfs"` and `cbor_metadata = true`, so the same source and compiler give the same bytecode and therefore the same hub address on every chain.
The same script deploys the gateway's `DepositFactory` with the salt `keccak256("payminto.deposits.v1")` and `PaymentRouter` with `keccak256("payminto.router.v1")`.
A second run keeps any contract that already exists at its address (with the block recorded for it) and deploys only what is missing, so running it again after an upgrade adds the gateway contracts next to a live hub; it refuses to run if a contract has code but the deployments file does not record it.

## 3. Testnet first (chain 133)

```bash
cd contracts
# Foundry 1.5 stops `forge script` on chain 133 with "Chain 133 not supported"; send the same CREATE2 transactions
# with cast instead (same salts, addresses and deployments file; docs/TESTNET.md section 3):
DEPLOYER_KEY=... script/deploy-create2.sh hashkey_testnet --yes
script/verify.sh 133
```

The addresses and deployment blocks are written to `contracts/deployments/133.json`.
`script/verify.sh` verifies ClearingHub, DepositFactory, the DepositForwarder implementation and PaymentRouter on Blockscout and falls back to Sourcify (`--verifier sourcify`) if Blockscout fails or is slow.
On chain 133, measured 2026-11-03, both fail: Blockscout answers HTTP 413 to the standard-JSON upload and Sourcify has no record for the chain, so the testnet contracts are not source-verified yet.
Commit the deployments file: the node, the dashboard and the Docker image read it.

## 4. Mainnet (chain 177) - required for a demo slot

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url hashkey --broadcast --account payminto-deployer
script/verify.sh 177
```

The address and block go to `contracts/deployments/177.json`, which the node and dashboard read automatically.

## 5. Point a Clearing Node at it

Use a fresh operator key that holds only a little HSK for settlement gas, never a deployer or treasury key.
Create `apps/node/.env` from the example; `pnpm --filter @payminto/node start` loads it, exactly like `dev`:

```bash
cp apps/node/.env.example apps/node/.env
# edit apps/node/.env:
#   CHAIN_ID=177
#   RPC_URL=https://mainnet.hsk.xyz
#   OPERATOR_KEY=<fresh key, a little HSK for gas>
#   ADMIN_TOKEN=<openssl rand -hex 32>
#   PUBLIC_URL=https://node.example.com
#   CORS_ORIGINS=https://dashboard.example.com
pnpm --filter @payminto/node start
```

Values exported in the shell take precedence over the file.
On 133, 177 and Sepolia (11155111) the node refuses to start if `OPERATOR_KEY` is one of the ten public anvil/hardhat keys, if `ADMIN_TOKEN` is `dev-admin-token` or shorter than 32 characters, or if it cannot tell where the hub was deployed.
That deploy block comes from `blockNumber` in `contracts/deployments/<CHAIN_ID>.json`, or from `DEPLOY_BLOCK` when you set `HUB_ADDRESS` yourself; the node scans for on-chain revocations from there.
`RPC_FALLBACK_URLS` defaults to the public fallbacks in the table above (set `none` to disable).

The token defaults to mainnet USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a`.
Agents need USDC.e in their own wallets and an allowance for the hub: either a one-time `approve(hub, cap)` (SDK `ensureAllowance`, the agent pays gas) or, with no HSK at all, an EIP-2612 permit from `AgentClient.signPermit` that the owner submits with the mandate and the node opens with `openMandateWithPermit`.
`openMandateWithPermit` is a new function, so the hub bytecode and therefore its CREATE2 address differ from builds before it; redeploy rather than reuse an older hub address.

To run the node and dashboard in Docker instead, see "Self-host with Docker" in [DEVELOPERS.md](DEVELOPERS.md#self-host-with-docker).
For TLS, backups, upgrades and monitoring, see [OPERATIONS.md](OPERATIONS.md).

## 6. A real mainnet smoke test for the submission

1. Fund two agent wallets with 1 USDC.e each and a little HSK.
2. Create one mandate per agent with a 1 USDC.e total cap from the dashboard.
3. Run the demo against mainnet with tiny prices (for example 0.001 USDC.e per call).
4. Settle once and record the `settleBatch` transaction link on https://hsk.blockscout.com for the submission.

Total cost is 2 USDC.e plus well under 1 HSK of gas (two `openMandate` calls and one `settleBatch` at the 500 gwei mainnet base fee).
