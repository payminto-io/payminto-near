# Testnet runbook: HashKey Chain Testnet and Ethereum Sepolia

Status: written 2026-11-03 for the HashKey Chain Horizon Mumbai demo.
This is how Payminto runs end to end on public testnets, with real AI agents and real on-chain settlement.
Testnet tokens have no value.
Nothing here deploys to a mainnet.

## 1. Which network does what

| Network | Chain id | Token | Why |
|---|---|---|---|
| HashKey Chain Testnet | 133 | Payminto Test USDC (`tUSDC`), deployed by us | Payminto's contracts run on HashKey Chain; Circle's test USDC there has no public faucet |
| Ethereum Sepolia | 11155111 | Circle test USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | The organisers' USDC test network: real Circle FiatToken, EIP-3009, from faucet.circle.com |

Payminto Test USDC is honest about what it is: its name is "Payminto Test USDC", its symbol is `tUSDC`, and anyone may mint up to 1,000 per call.
Its `mint` refuses every chain except HashKey Chain Testnet and local anvil, so it can never pass for a stablecoin on mainnet (`contracts/src/TestnetStablecoin.sol`).
The contracts deploy with CREATE2 and fixed salts, so they have the same addresses on both testnets:

| Contract | Address |
|---|---|
| ClearingHub | `0x53E4B5712fEeD40dd6597F0A50cC14C063186e81` |
| DepositFactory | `0xcBAFd928dF0C40EDccEC7b82bCaee4a6Ae0E094b` |
| PaymentRouter | `0x1e0f2223D61BF9831fa0b009AE741c3F5E898F0e` |
| Payminto Test USDC (133 only) | `0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15` |

The node reads the settlement token's EIP-712 domain from the token contract at startup (ERC-5267 `eip712Domain()` first) and checks it against the token's `DOMAIN_SEPARATOR()`.
It refuses to start when they disagree, when an unknown token has no readable separator, or when the RPC fails during the check, because every signed authorization would then fail on chain.

The deployed bytecode was checked against this repository's build on both chains (masking immutables) on 2026-11-03.
The sources are not verified on the explorers yet: Blockscout on chain 133 rejects forge's standard-JSON upload as too large (HTTP 413) and Sourcify has no record for chain 133.

## 2. Wallets

The demo uses seven fresh testnet-only wallets, kept in `.env.testnet.local` at the repository root.
That file is git-ignored; never commit it and never reuse these keys on a mainnet.

| Role | Variable | Needs |
|---|---|---|
| Operator: deploys, opens mandates, settles, funds the others | `OPERATOR_KEY` | HSK on 133; Sepolia ETH and Circle USDC on Sepolia |
| Budget owner: signs mandates (no transactions) | `BUDGET_OWNER_KEY` | Nothing |
| Buyer agent (Treasury) | `BUYER_AGENT_KEY` | Gas and USDC, sent by the operator |
| Trading agent | `TRADING_AGENT_KEY` | Gas and USDC, sent by the operator |
| Seller agent (Research Writer): onboards with a permit | `SELLER_AGENT_KEY` | USDC, sent by the operator |
| Merchant payout: sells the paid skill | `MERCHANT_ADDRESS` | Nothing; it receives payments |
| Market Data and Risk Scan payee | `SERVICES_PAYEE_ADDRESS` | Nothing; it receives payments |

Only the operator has to be filled from the faucets:
1. HSK for gas: https://faucet.hsk.xyz (HashKey Chain Testnet).
2. Circle test USDC: https://faucet.circle.com, network Ethereum Sepolia.
3. Sepolia ETH for gas, from any Sepolia faucet.

The model key goes in the same file as `OPENAI_API_KEY=...`, the business's own key (`docs/AGENTS.md` section 1).

## 3. Deploy

From `contracts/`, with the operator as deployer.
Both scripts print the plan first; the cast script sends only with `--yes`.

```sh
DEPLOYER_KEY="$OPERATOR_KEY" script/deploy-create2.sh hashkey_testnet --yes
DEPLOYER_KEY="$OPERATOR_KEY" script/deploy-create2.sh sepolia --yes
```

Use the cast script on both testnets; it sends the same CREATE2 transactions as `script/Deploy.s.sol`, with the same salts, addresses and deployments file.
`forge script` fails on both, measured on 2026-11-03 with Foundry 1.5.0:
- On HashKey Chain Testnet it stops with "Chain 133 not supported" after a successful simulation.
- On Sepolia its gas limits from the local simulation were far too low (3.14M for the hub, which used 15.0M gas on chain, about 90 % of the 16.8M per-transaction cap), so all three transactions reverted; cast asks the RPC to estimate and succeeds.
Public RPCs are load-balanced, so the script waits for each contract's code to appear before moving on.

The cast script refuses to overwrite a deployment it cannot account for, keeps contracts that already exist, and needs `CONFIRM_MAINNET=yes` on chain 177.
Both write `contracts/deployments/<chainId>.json`, which the node and the demo read; commit those files after a real deployment.

## 4. Fund the agents

```sh
pnpm --filter @payminto/demo fund:testnet 133                       # plan only
pnpm --filter @payminto/demo fund:testnet 133 --gateway --yes       # gas + tUSDC minted to each agent and gateway payer
pnpm --filter @payminto/demo fund:testnet 11155111 --gateway --yes  # gas + Circle USDC to each agent and gateway payer
```

The script sends one transaction at a time from the operator, each confirmed before the next, and skips a wallet that already holds its share, so a rerun sends only what is missing.
`--gateway` adds the gateway act's payers: a person paying by wallet signature, a person paying by transfer (the only one given gas), an x402 agent, an MCP mandate agent and a flagged wallet, 0.045 each.
The store, Northwind's payout and the platform fee wallet only receive or sign, so they get nothing.

## 5. Run the live demo

The live mode of `apps/demo` refuses to start unless every key is explicit, none is a public dev key, every role has a wallet of its own, and the planned spend is under `DEMO_MAX_SPEND_USDC` (`apps/demo/README.md`, Live networks).
It runs three acts:
1. Clearing: three agents buy from paid services through on-chain mandates, two attacks are refused at both layers, the node nets every obligation into one `settleBatch`, and a receipt is proved on chain.
2. Gateway (`DEMO_GATEWAY=1`): a business is onboarded with a fee plan, one payment link is paid by a person's wallet signature, a person's plain transfer, an x402 agent and an MCP mandate agent, then a gasless refund, a screening refusal and the reconciliation report.
3. AI agents (`DEMO_AI=1`): the business's own model key, an ops agent, a paid skill agent, and a buyer AI agent that buys the skill through its mandate.

```sh
set -a; . ./.env.testnet.local; set +a
DEMO_CHAIN_ID=11155111 DEMO_LIVE_NETWORK_CONFIRM=yes DEMO_CALLS=60 DEMO_MAX_SPEND_USDC=0.5 DEMO_CONFIRM_TAG=latest \
  DEMO_GATEWAY=1 DEMO_PUBLIC_CHECKOUT_URL=https://pay.example.com \
  DEMO_OPERATOR_KEY=$OPERATOR_KEY DEMO_OWNER_KEY=$BUDGET_OWNER_KEY DEMO_TREASURY_KEY=$BUYER_AGENT_KEY \
  DEMO_TRADING_KEY=$TRADING_AGENT_KEY DEMO_WRITER_KEY=$SELLER_AGENT_KEY \
  DEMO_MARKET_PAYEE=$MARKET_PAYEE_ADDRESS DEMO_RISK_PAYEE=$SERVICES_PAYEE_ADDRESS \
  DEMO_STORE_PAYOUT_KEY=$MERCHANT_KEY DEMO_PLATFORM_FEES_KEY=$PLATFORM_FEES_KEY DEMO_NORTHWIND_PAYOUT_KEY=$NORTHWIND_PAYOUT_KEY \
  DEMO_HUMAN_PAYER_KEY=$HUMAN_PAYER_KEY DEMO_DEPOSIT_PAYER_KEY=$DEPOSIT_PAYER_KEY DEMO_X402_AGENT_KEY=$X402_AGENT_KEY \
  DEMO_MANDATE_AGENT_KEY=$MANDATE_AGENT_KEY DEMO_FLAGGED_KEY=$FLAGGED_KEY \
  DEMO_ADMIN_TOKEN=$(openssl rand -hex 32) pnpm demo
```

Add `DEMO_AI=1` (with `OPENAI_API_KEY` in the environment) for the AI act; with `DEMO_GATEWAY=1` the store sells the AI skill, so `DEMO_MERCHANT_PAYOUT` is not needed.
Use `DEMO_CHAIN_ID=133` for the same run on HashKey Chain Testnet, and `pnpm demo:stage` instead of `pnpm demo` to advance step by step for a recording.

Settings to know:
- `DEMO_CONFIRM_TAG=latest` makes the node confirm credits, refunds and batches at the latest head, so a recording does not wait out the safe head (about 10 minutes on 133, one to two epochs on Sepolia).
  It is a testnet demo setting and the run says so in its plan and summary; without it the node keeps its default, the safe head, and the demo waits for every batch to confirm and reconcile before it proves receipts.
- `DEMO_PUBLIC_CHECKOUT_URL` must be a public https origin because the node runs the gateway; checkout links point there.
- Webhooks: on a public chain the node refuses webhook targets on private addresses, so the act's local receiver cannot be used.
  Set `DEMO_WEBHOOK_URL` to a public https receiver to check deliveries; without it the webhook checks are skipped and the summary says so.
  The local run (`pnpm demo`) verifies every delivery's signature.
- The AI act uses `gpt-5-mini` by default (`DEMO_AI_MODEL` changes it) and the key from `OPENAI_API_KEY`; see `apps/demo/README.md`, AI agents act.

Every on-chain transaction is printed with its explorer link: https://testnet-explorer.hskchain.net on 133 and https://sepolia.etherscan.io on Sepolia.

## 6. What is real and what is not

- Real: contracts on both testnets, Circle USDC on Sepolia, mandates and settlement batches on chain, receipt proofs checked by the hub, AI agents calling a real model with the business's own key.
- Test only: Payminto Test USDC on 133 has no value; HSP runs against the local stand-in until HashKey allowlists the node's IP (`docs/GATEWAY.md` section 17).
- Not done: no mainnet deployment.
