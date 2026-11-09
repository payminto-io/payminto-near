# Payminto: developer guide

The full reference that used to be the README; the short overview is the [README](../README.md).

**Get paid in stablecoins by people and AI agents, on your own server.**

Payminto is a payment system you run yourself: you share one payment link, and anyone who opens it can pay you.
A person gets a simple checkout page and pays from their wallet; an AI agent that opens the same link pays automatically.
Every payment goes straight to your own wallet on HashKey Chain, with fees split off in the same transaction, so nobody holds your money, not even us.
If you run AI agents, you can give each one a spending budget with hard limits, and its many small charges are bundled into a few transfers that can each be checked later.
Run it for one business, or host many businesses on one server and earn a platform fee from each.

## Quickstart

### With your AI coding agent

Clone the repository, open Claude Code (or any coding agent) in it, and paste:

> Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A.

[docs/SELF_HOST.md](SELF_HOST.md) takes it from install to your own node, dashboard, first payment, AI agents and MCP servers, with a check after every step, then to your own server on a public testnet.

### With Docker (no real money)

```bash
git clone <this repo> payminto && cd payminto
docker compose --profile local up --build
```

Open http://localhost:3000/setup, enter the setup code `dev-admin-token`, and create the platform owner account.
This runs on a private local test network with test money only; [Self-host with Docker](#self-host-with-docker) covers HashKey Chain and [docs/TESTNET.md](TESTNET.md) the public testnets.

### Without Docker (the guided demo)

Requirements: Node 22.18+, pnpm 9 (`corepack enable`), and Foundry 1.5+ (`anvil` and `forge` on PATH).

```bash
pnpm install
pnpm demo:stage                         # terminal 1: a local test network, your Payminto server and sample businesses
pnpm --filter dashboard dev -p 3000     # terminal 2: the dashboard, with the NEXT_PUBLIC_* values terminal 1 prints
```

Open http://localhost:3000/login and sign in with the email and password that `pnpm demo:stage` prints.
`pnpm demo` runs the whole story once in the terminal (about 500 agent charges, two blocked attacks, a settlement and four ways of paying a link) and exits.

## For developers

Payminto has two halves inside one server: payment links and checkout (internally "Gateway", [docs/GATEWAY.md](GATEWAY.md)) and agent budgets with bundled settlement (internally "Clearing", [docs/SPEC.md](SPEC.md)).
The words customers see are defined in [docs/PRODUCT.md](PRODUCT.md); the rest of this file uses the technical names.

Built for the HashKey Chain Horizon Hackathon (Mumbai edition), track: Agent Payments & A2A Settlement.

### Why it exists

Paying every agent call on chain does not work: a stablecoin transfer costs about 34,000 gas, which rivals the price of a 0.002 USDC API call.
x402 moves single payments, AP2 proves consent, ERC-8004 proves identity, but nothing owns the middle layer that budgets, meters, nets and proves agent spend, and nothing offers it self-hosted.
Payminto Clearing is that layer.

### How it works

1. **Mandate.** An owner (a person, a treasury, or a Safe) signs an EIP-712 mandate: total cap, per-call cap, daily cap, rate limit, payee allowlist, expiry.
2. **Vouchers.** The agent calls a paid endpoint, gets HTTP 402 (x402 v2), and retries with a signed cumulative voucher. No gas, one signature.
3. **Policy, three times.** The agent SDK refuses to sign anything outside the mandate, the node refuses to accept it, and the contract enforces the hard limits again at settlement.
4. **Netting.** `ClearingHub.settleBatch` verifies every signature and cap on chain, nets all obligations between all agents and providers, and moves only net amounts, wallet to wallet.
5. **HSP.** Each net transfer is described as an HSP-compatible mandate whose `settlementBinding` is the batch id, signed by our own adapter; merchant payments can also be paid through HashKey's HSP Agentic Payment server (see Payment gateway), which goes live once HashKey allowlists the server's IP.
6. **Proof.** The Merkle root of every call receipt is stored per batch, so anyone can prove any single call with `verifyReceipt`.

Built for HashKey Chain specifically ([docs/HASHKEY.md](HASHKEY.md)):
- **Finality.** A settlement is `included` at one confirmation and `confirmed`, booked and HSP-verified only once its block is at or below the `safe` head; a reorged-out settlement is rebroadcast, never double-booked.
- **Gasless agents.** An agent signs an EIP-2612 permit for USDC.e ("Bridged USDC", version 2) and the node opens its mandate with `openMandateWithPermit`: the agent holds no HSK and sends no transaction.
- **USDC.e blacklist.** Every party is screened with `isBlacklisted` through Multicall3 before a batch is sent, so one blacklisted wallet cannot revert a whole netting batch.
- **Fees and RPC.** The OP Stack L1 data fee is priced into the operator preflight and stored per batch; RPC calls retry with jittered backoff, and stuck settlements are replaced with the same nonce and 12.5 % higher fees.
- **Ecosystem contracts.** Safe 1.4.1 owners (ERC-1271), Multicall3, the CREATE2 deployer, the GasPriceOracle and EAS attestations per batch (`EAS_ATTEST=true`), all proven on a testnet fork by `pnpm test:fork`.

Measured: one batch cleared 640 calls for 1.91M gas, versus 22.04M gas for one transfer per call, 11.6x less ([docs/GAS.md](GAS.md)).

## Repository

| Path | What |
|---|---|
| [`contracts/`](../contracts) | `ClearingHub.sol` (Foundry): mandates, vouchers, multilateral netting, receipt roots. No owner, no upgrade keys, never holds funds. |
| [`packages/protocol/`](../packages/protocol) | Shared TypeScript: ABI, EIP-712 types, Merkle trees, policy hashing, HSP wire v1, x402 headers. Tested for parity against the deployed contract. |
| [`packages/models/`](../packages/models) | `@payminto/models`: one neutral `ModelClient` over Anthropic, OpenAI, Google Gemini and any OpenAI-compatible endpoint, the provider catalogue, and connection checks. Used by the agent runtime and the node's merchant agents. |
| [`packages/sdk/`](../packages/sdk) | `@payminto/sdk`: `OwnerClient`, `AgentClient` (x402 fetch, pre-sign policy guard, HSP co-signing), `paywall()` for providers, `GatewayClient`, `constructEvent` and `payExact` for the gateway. |
| [`apps/node/`](../apps/node) | The self-hosted Clearing Node: API, policy engine, SQLite ledger, settlement worker, HSP adapter, live events. |
| [`apps/dashboard/`](../apps/dashboard) | The dashboard and hosted checkout: payments, links, refunds, customers, budgets, settlements, platform pages, accounts and search. |
| [`apps/mcp/`](../apps/mcp) | MCP server that gives any MCP-capable agent a budget-bound wallet, including `pay_link` for gateway links. |
| [`apps/demo/`](../apps/demo) | Three paid services, two agents, scripted attacks, the gateway act, and the one-command demo. |
| [`apps/agent/`](../apps/agent) | `payminto-agent`: real Claude agents on the MCP servers: a buyer that spends through a mandate, a seller skill behind the paywall, and an ops agent for the back office. |
| [`docs/`](.) | Spec, architecture and threat model, gas, deploy guide, strategy, pitch and submission. |

## Demo and tests (local, no real money)

Requirements: Node 22.18+ (`nvm install` reads `.nvmrc`), pnpm 9 (`corepack enable`), Foundry 1.5+ (`anvil` and `forge` on PATH).
The code runs TypeScript directly with Node's built-in type stripping, so there is no build step.

```bash
git clone <this repo> payminto-clearing && cd payminto-clearing
pnpm install
pnpm demo
```

`pnpm demo` starts a private anvil chain, deploys the contracts with `forge`, starts the node and three paid services, runs about 500 agent calls including two blocked attacks, settles them, prints the result with an on-chain proof check, runs the payment gateway act described below, and exits.
It uses only public anvil dev keys on chain 31337, so no real money is involved.

To watch it in the dashboard, use the staged run, which keeps the node up and walks through the story one Enter at a time:

```bash
pnpm demo:stage                                                         # terminal 1
NEXT_PUBLIC_NODE_URL=http://localhost:8787 pnpm --filter dashboard dev  # terminal 2
```

Open http://localhost:3000/login and sign in with the platform owner email and password that `demo:stage` prints (they are also saved in the run directory).
If port 8787 is busy, `demo:stage` prints the port it picked; use that in `NEXT_PUBLIC_NODE_URL`.

Tests:

```bash
pnpm contracts:test
pnpm test
pnpm typecheck
pnpm test:fork   # optional: anvil --fork-url https://testnet.hsk.xyz with the real testnet USDC, a real Safe and EAS
```

CI runs the same commands plus the dashboard build, `pnpm demo` on a clean checkout, and the Docker stack ([.github/workflows/ci.yml](../.github/workflows/ci.yml)); the fork suite runs as a non-blocking job because it depends on the public testnet RPC.

## Agents

The scripted agents above follow a fixed order; `apps/agent` runs real Claude agents on the same MCP servers ([apps/agent/README.md](../apps/agent/README.md)).

- **Buyer:** `pnpm agent run "<task>"` takes a task in plain words, finds paid services on the node, buys only what the task needs through its mandate, and answers with a spend report (each receipt, total spent, budget left, refusals with their rule).
  `pnpm agent serve` offers the same over HTTP (`POST /v1/runs`).
- **Seller:** `pnpm agent serve-skill market-brief` sells the "HashKey market brief" per call behind `paywall()`; it is listed in the node directory, buys its own inputs with its own mandate, and writes the brief with Claude.
- **Ops:** `pnpm agent ops "what did we earn today"` answers back-office questions from the merchant MCP server; refunds go through the approval rule.

The owner's policy is enforced below the model: a per-task spend ceiling checked against the wallet, a directory check so an address planted in paid content is never paid, and the mandate in the wallet, the node and the hub.
The agents need `ANTHROPIC_API_KEY` (model `claude-opus-5-5` by default, `PAYMINTO_AGENT_MODEL` to change it) and fail with a clear message without it; their tests use a scripted model and run without a key.
`pnpm demo:stage` prints the exact commands to run the buyer and ops agents against the staged node.

## Payment gateway

The same node is also a self-hosted, non-custodial payment gateway ([docs/GATEWAY.md](GATEWAY.md)).
The operator runs any number of merchants, each with its own payout wallet, fee plan, payment methods, links, webhooks and API keys.

**One link for people and agents.**
A merchant shares one link, `https://<checkout>/l/<slug>`.
A browser gets a hosted checkout page, where a person pays with a wallet signature or by sending the token to a deposit address.
Anything else (an agent, curl, an x402 client) gets HTTP 402 with a `PAYMENT-REQUIRED` header that lists x402 `exact` (EIP-3009) and `payminto-voucher` for agents with a mandate.
Fees are split on chain in the same transaction that pays the merchant, by contracts that cannot send money anywhere else, so the node never holds a payer's or merchant's funds.

**Payment methods.**
Every method pays the payment's own fee-splitting deposit address, so fees, webhooks, refunds and reports work the same whichever one a payer picks.

| Method | Who pays | How |
|---|---|---|
| `wallet` | A person with a browser wallet | Signs one EIP-3009 authorization; the node sends it, so the payer pays no gas. |
| `deposit` | A person paying from any wallet or exchange | Sends the token to the payment's one-time address. |
| `x402` | An agent with a plain wallet | Standard x402 `exact`; `payExact` in the SDK. |
| `voucher` | An agent with a Payminto mandate | Signed vouchers checked against the owner's policy, settled in the next clearing batch. |
| `hsp` | A person or an agent through HashKey's HSP | Signs the EIP-712 data HSP prepares; HSP's gateway sends the transfer into the payment's address. Off until a business turns it on, and only when the server is set up for HSP ([docs/GATEWAY.md](GATEWAY.md) section 16). `payHsp` in the SDK. |

Quickstart: `pnpm demo` ends with the gateway act.
The operator creates the merchant "Northwind Data" with a 0.5 % + 0.01 USDC fee plan and a deposit fee the customer pays, the merchant creates a link with an API key and registers a webhook receiver, and four payers pay the same link: a person with a wallet, a person by plain transfer, a plain x402 agent with `payExact`, and an MCP agent with two vouchers.
It then issues a gasless refund, shows a screening refusal, and checks that every balance moved exactly by the fee breakdowns and that every webhook signature verified.
To try the API by hand, keep a node running with `pnpm demo:stage`, sign in to the dashboard, and create an API key under Developers, API keys for the business you want.
The admin token is only a setup code and an emergency recovery key after setup (`ADMIN_TOKEN_BREAK_GLASS=true`), so the commands below use an API key.

Create a payment with that key:

```bash
NODE=http://localhost:8787
KEY=sk_test_...   # from Developers, API keys

curl -s -X POST $NODE/v1/payments -H "Authorization: Bearer $KEY" -H "Idempotency-Key: order-1001" \
  -H "content-type: application/json" -d '{"amount":"2000000","reference":"order-1001","method":"wallet"}'
```

The answer carries `checkout_url` and the fee breakdown (`amount`, `surcharge`, `amount_due`, `platform_fee`, `method_fee`, `fee_total`, `net_amount`), all in base units (6 decimals).
Links work the same way: `POST /v1/links` with `{"title":"Market dataset","amount":"2000000"}` returns the `url` to share.

Pay a link as an agent: the first request answers 402, and the decoded header lists what the link accepts.

```bash
curl -si $NODE/v1/pay/l/<slug> | grep -i '^payment-required:' | cut -d' ' -f2 | tr -d '\r' | base64 -d | jq '.accepts[] | {scheme, payTo, amount}'
```

An agent then retries with a signed `PAYMENT-SIGNATURE` header, which the SDK builds:

```ts
import { AgentClient, payExact, payHsp } from "@payminto/sdk";

// A plain x402 agent: signs one EIP-3009 TransferWithAuthorization to the payment's fee-splitting forwarder.
const { settlement } = await payExact(`${NODE}/v1/pay/l/${slug}`, { account, maxAmount: 2_000_000n });
console.log(settlement.paymentId, settlement.status, settlement.txHash);

// An agent with a mandate: one voucher to the merchant and one to the platform fee, both checked against the policy.
const res = await agentClient.fetch(`${NODE}/v1/pay/l/${slug}`);

// A plain wallet through HashKey's HSP: prepare, sign HSP's EIP-712 data, submit, wait until paid.
const hsp = await payHsp(`${NODE}/v1/pay/l/${slug}`, { account, maxAmount: 2_000_000n });
console.log(hsp.paymentId, hsp.status, hsp.hspStatus, hsp.attributionVerified);
```

Over MCP, `list_paid_services` reads the node's service directory (`GET /v1/directory`) and `pay_link` pays a link with vouchers only, never `exact` or `hsp`, because only the voucher path is checked against the owner's policy.

Verify webhooks on the raw body before trusting them:

```ts
import { constructEvent, WebhookSignatureError } from "@payminto/sdk";

app.post("/payminto/webhooks", async (c) => {
  try {
    const event = await constructEvent(await c.req.text(), c.req.header("Payminto-Signature"), process.env.PAYMINTO_WEBHOOK_SECRET!);
    if (event.type === "payment.paid") await fulfil(event.data.object.id);
    return c.body(null, 204);
  } catch (err) {
    if (err instanceof WebhookSignatureError) return c.text("bad signature", 400);
    throw err;
  }
});
```

`constructEvent` checks `t=<unix>,v1=<HMAC-SHA256>` against the `whsec_` secret shown when the endpoint was created, rejects timestamps more than 300 s off, and only then parses the body.
`GatewayClient` covers the rest of the API: payments, links, refunds, webhooks and screening with a merchant key, and merchants, fee plans, the platform and API keys with the admin token.

## Self-host with Docker

The node and dashboard ship as Docker images (Node 22 slim, non-root, SQLite on a named volume, health checks).
A local stack with its own anvil chain needs no keys and no money:

```bash
docker compose --profile local up --build
```

This starts anvil, deploys `ClearingHub` and a mock USDC once (`forge script`), then the node on http://localhost:8787 and the dashboard on http://localhost:3000; finish first-run setup at `/setup` with the setup code `dev-admin-token` (the `ADMIN_TOKEN`).
Chain state and the node database survive restarts; `docker compose --profile local down -v` wipes both.

For HashKey Chain, copy `.env.docker.example` to `.env`, set `CHAIN_ID`, a fresh `OPERATOR_KEY` and a random 32+ character `ADMIN_TOKEN`, then run `docker compose up -d --build`.
On chains 133, 177 and 11155111 the node refuses to start with a public anvil/hardhat key, the dev admin token, or no deploy block.
Ports bind to 127.0.0.1; put a TLS reverse proxy in front as described in [docs/OPERATIONS.md](OPERATIONS.md), which also covers backups, upgrades, monitoring and key handling.

## Networks

| | HashKey Chain Testnet (133) | Ethereum Sepolia (11155111) | HashKey Chain mainnet (177) |
|---|---|---|---|
| ClearingHub | `0x53E4B5712fEeD40dd6597F0A50cC14C063186e81` | `0x53E4B5712fEeD40dd6597F0A50cC14C063186e81` | not deployed yet |
| DepositFactory | `0xcBAFd928dF0C40EDccEC7b82bCaee4a6Ae0E094b` | `0xcBAFd928dF0C40EDccEC7b82bCaee4a6Ae0E094b` | not deployed yet |
| PaymentRouter | `0x1e0f2223D61BF9831fa0b009AE741c3F5E898F0e` | `0x1e0f2223D61BF9831fa0b009AE741c3F5E898F0e` | not deployed yet |
| Settlement token | Payminto Test USDC `0x35D0055cd3a9E674B0b14cCDAc030BF19c8DDb15` (open faucet, no value) | Circle test USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | USDC.e `0x054ed45810DbBAb8B27668922D110669c9D88D0a` |
| Explorer | https://testnet-explorer.hskchain.net | https://sepolia.etherscan.io | https://hsk.blockscout.com |

The contracts deploy with CREATE2, so they have the same addresses on every chain; they have no owner and never hold funds, so any operator can use them.
Circle's test USDC on HashKey Chain Testnet has no public faucet, which is why the testnet uses Payminto Test USDC; Sepolia is the organisers' USDC test network.

Deployment steps are in [docs/DEPLOY.md](DEPLOY.md); running a node in production is in [docs/OPERATIONS.md](OPERATIONS.md).

## Status and honesty notes

- The official HSP SDK repository and the hackathon Coordinator were not reachable when we built this, so the node implements HSP wire v1 behind one interface, with a built-in adapter and verifier, and a Coordinator client ready for credentials that resolves the chain and verifying contract from the Coordinator's `GET /chains`.
- HSP payment method, live vs local: HashKey's HSP Agentic Payment server (`https://mcp-qa.hashkeymerchant.com/`) only answers servers whose public IP is on its allowlist, and ours is not on it yet (it answers HTTP 403).
  Until it is, a server with `HSP_MCP_URL` set shows "Waiting for HSP access" and refuses HSP payments cleanly, and nothing else is affected.
  Locally and in the tests, the same flow runs end to end against a stand-in that speaks the same eight tools and really sends the transfer on anvil (`apps/node/test/support/hsp-standin.ts`); no test calls HashKey.
- Per-call and daily caps are enforced by the agent and the node; total cap, allowlist and expiry are additionally enforced on chain. The mandate's `policyHash` commits to the off-chain rules.
- See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for the trust model and known limitations.

## License

MIT
