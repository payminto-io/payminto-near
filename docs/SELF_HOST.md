# Run your own Payminto: a guide for you or your AI coding agent

Payminto is a self-hosted, non-custodial stablecoin payment gateway for businesses and AI agents.
This guide gets your own copy running, end to end, and is written so an AI coding agent (Claude Code, Codex, Cursor) can follow it step by step.
To use it with an agent, clone the repository, open the agent in it, and paste:

> Follow https://github.com/sagarjethi/payminto-clearing/blob/main/docs/SELF_HOST.md to run my own Payminto. Start with Path A.

## Rules for the agent

1. Do the steps in order and run every check; stop and report the exact error if a check fails.
2. Never commit, print or paste a private key, API key or token; keep them in git-ignored files (`.env`, `.env.*.local`).
3. Path A uses only local test money. Path B uses public testnets, where tokens have no value. Never deploy to or configure HashKey Chain mainnet (177) unless the person explicitly asks for it in their own words.
4. Never point a reset, seed or test script at a database you did not create in this guide.
5. Ask the person before anything that needs them: faucets (they have CAPTCHAs), a domain name, DNS, or their own model API key.

## What you get

- A Clearing Node (API, policy engine, SQLite ledger, settlement worker) on http://localhost:8787.
- A dashboard on http://localhost:3000 for the platform owner, businesses and their staff.
- Payments from people (hosted checkout, payment links, deposit addresses, refunds) and from AI agents (x402, budgets called mandates, per-call vouchers netted into one settlement).
- Merchant AI agents that run on the business's own model key (OpenAI, Anthropic, Gemini or any OpenAI-compatible endpoint).
- An MCP server so any agent can pay, and a merchant MCP server so an agent can run the back office.

## Prerequisites

Check each one; install what is missing.

```bash
node --version      # 22.18 or newer (checked by apps/node/scripts/check-runtime.mjs; the code runs TypeScript directly)
pnpm --version      # 9.x (corepack enable; corepack prepare pnpm@9.15.9 --activate)
forge --version     # Foundry 1.5 or newer: curl -L https://foundry.paradigm.xyz | bash && foundryup
git --version
```

Then, from the repository root:

```bash
pnpm install
pnpm typecheck
```

Check: both finish without errors.

## Path A: everything on this machine (no money, no accounts)

### A1. See the whole product run once

```bash
pnpm demo
```

It starts a private chain (anvil), deploys the contracts, starts the node, and runs the full scenario: three paid services, three agents buying through on-chain budgets, two prompt-injection attacks refused, netting into one settlement, an on-chain receipt proof, then the human side (a payment link paid four ways, a gasless refund, a screening refusal, verified webhooks).
Check: it ends with every check passing and exits 0.

### A2. Run your own node and dashboard

Terminal 1, the chain, contracts and node; keep it running for the rest of Path A.
The payout and fee addresses below are public anvil test accounts 5 and 6, local only.

```bash
GATEWAY_PAYOUT_ADDRESS=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc \
PLATFORM_FEE_ADDRESS=0x976EA74026E726554dB657fA54763abd0C3a0aa9 \
PUBLIC_CHECKOUT_URL=http://localhost:3000 \
CORS_ORIGINS=http://localhost:3000 \
scripts/dev-local.sh
```

Terminal 2, the dashboard:

```bash
NEXT_PUBLIC_NODE_URL=http://localhost:8787 NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545 pnpm --filter dashboard dev
```

Checks:

```bash
curl -s http://localhost:8787/healthz                                   # {"ok":true,"chainId":31337,...}
curl -s http://localhost:8787/v1/info | grep -o '"gateway":{"enabled":true'   # prints the match
```

Ports: the chain uses 8545, the node 8787 and the dashboard 3000.
If one is busy, set `RPC_URL=http://127.0.0.1:<port>` and `PORT=<port>` for `dev-local.sh`, add `-- -p <port>` to the dashboard command, and use the same values in `NEXT_PUBLIC_NODE_URL`, `NEXT_PUBLIC_RPC_URL`, `PUBLIC_CHECKOUT_URL` and `CORS_ORIGINS`.
`pnpm demo` also uses 8787 by default, so stop this node before running the demo again.

### A3. First-run setup and a first payment

1. Open http://localhost:3000/setup; the setup code is `dev-admin-token` (the `ADMIN_TOKEN` that `dev-local.sh` sets; the one-time code in the node log also works). Create the platform owner.
2. In Businesses, open the business named Payminto: it was seeded from `GATEWAY_PAYOUT_ADDRESS`, on the Standard plan (0.5 %).
3. Payments > New link: create a 1.00 USDC link and open it.
   Through the API, amounts are base units: 1.00 USDC is `"1000000"`.
4. Pay it.
   - With a browser wallet: add the network `http://127.0.0.1:8545`, chain id 31337, import anvil account 1, and mint it test USDC first (step below).
   - Without a browser wallet, from a terminal, pay to the link's deposit address:

   ```bash
   TOKEN=$(curl -s http://localhost:8787/v1/info | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(j.token.address??j.token)")
   KEY1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # anvil account 1, local only
   ACCT1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
   # The local test USDC has an open mint on chain 31337 only.
   cast send $TOKEN 'mint(address,uint256)' $ACCT1 100000000 --private-key $KEY1 --rpc-url http://127.0.0.1:8545
   SLUG=<the part after /l/ in the link URL>
   DEPOSIT=$(curl -s -X POST -H 'content-type: application/json' -d '{"method":"deposit"}' \
     http://localhost:8787/v1/links/public/$SLUG/payments | node -e "console.log(JSON.parse(require('fs').readFileSync(0)).deposit_address)")
   cast send $TOKEN 'transfer(address,uint256)' $DEPOSIT 1000000 --private-key $KEY1 --rpc-url http://127.0.0.1:8545
   ```

5. Checks, for a 1.00 USDC link on the Standard plan:
   - Within a few seconds the payment shows Paid on the Payments page, with platform fee 0.005 and net 0.995 USDC.
   - Payments > Download report gives a CSV whose TOTAL row shows paid 1.000000, fee 0.005000 and net 0.995000.

### A4. Turn on the business's AI agents

1. Settings > AI models > Add connection: provider, the person's own API key, a model, an optional monthly token limit.
   Ask the person for the key; never invent one.
2. AI agents > Create agent > Back office; ask it "What did we earn today?".
3. Check: the run page shows model turns, tool calls (`get_overview`, `list_payments`) and an answer from real data.
4. Optional: create a Paid skill agent and buy it from another agent (`apps/agent/README.md`).

### A5. Let any agent pay or run the back office through MCP

Merchant back office, for an ops agent:
1. In the dashboard, Developers > API keys > Create; the key is shown once, so put it in a git-ignored file such as `.env.local`.
2. Start the server; `--silent` keeps pnpm's banner off stdout, which a stdio MCP client reads:

```bash
NODE_URL=http://localhost:8787 MERCHANT_API_KEY=<the key> pnpm --silent mcp -- --merchant
```

Check: an MCP client lists `get_overview`, `list_payments`, `get_payment`, `create_link`, `request_refund`, `get_reconciliation` and `list_blocked`.

Wallet, for a buyer agent: it needs an agent key and a budget (mandate) the owner signed for it.
Create one in the dashboard under Agents > Budgets > New budget (the platform owner first turns on "Agent budgets" for the business), or use the Trading Agent key and mandate id that `pnpm demo:stage` prints for its own local stack.
Then `NODE_URL=... AGENT_KEY=... MANDATE_ID=... pnpm --silent mcp`; `apps/mcp/README.md` lists every variable.

In Claude Desktop or Claude Code configs, run `node apps/mcp/src/main.ts` (with `--merchant` for the back office) as `apps/mcp/README.md` shows, not `pnpm mcp`.

## Path B: your own server on a public testnet

Path B is a real deployment: a server with a domain name and TLS, on HashKey Chain Testnet (133) or Ethereum Sepolia (11155111).
On public chains the node refuses dev keys, dev tokens, private webhook targets and non-https checkout links, so links you send customers always work.

### B1. Contracts: reuse ours or deploy your own

The contracts have no owner and never hold funds, so every operator can share one deployment.
They are already live, at the same addresses on both testnets, recorded in `contracts/deployments/133.json` and `contracts/deployments/11155111.json` (`docs/TESTNET.md`).
To deploy your own instead, follow `docs/TESTNET.md` section 3.

### B2. Keys and funds

1. Create a fresh operator wallet that holds only gas: `cast wallet new`. Put its key in `.env` (git-ignored).
2. Ask the person to fill it from a faucet: HSK at https://faucet.hsk.xyz for 133, or Sepolia ETH for Sepolia.
3. The merchant payout and platform fee wallets must be different from the operator wallet; the node refuses otherwise.
4. Test money for paying: on 133, Payminto Test USDC has an open faucet (`mint`, up to 1,000 per call); on Sepolia, Circle test USDC at https://faucet.circle.com.

### B3. Configure and start

```bash
cp .env.docker.example .env
```

Fill in `.env`:

| Variable | Value |
|---|---|
| `CHAIN_ID` | `133` or `11155111` |
| `RPC_URL` | `https://testnet.hsk.xyz` or `https://ethereum-sepolia-rpc.publicnode.com` |
| `OPERATOR_KEY` | the fresh operator key |
| `ADMIN_TOKEN` | `openssl rand -hex 32` |
| `PUBLIC_URL`, `NEXT_PUBLIC_NODE_URL` | `https://node.<your domain>` |
| `CORS_ORIGINS`, `PUBLIC_CHECKOUT_URL` | `https://pay.<your domain>` |
| `GATEWAY_PAYOUT_ADDRESS`, `PLATFORM_FEE_ADDRESS` | the business payout and the platform fee wallet |
| `AGENTS_ENABLED`, `AGENT_SECRETS_KEY` | `true` and `openssl rand -base64 32`, to turn on merchant AI agents |

Then:

```bash
docker compose up -d --build
```

Put Caddy or nginx in front for TLS as `docs/OPERATIONS.md` describes (it has a ready Caddyfile, backups, upgrades and monitoring).
For a quick trial without a server, a tunnel such as `cloudflared tunnel --url http://localhost:3000` gives a public https origin for the dashboard; give the node its own tunnel too.

Checks:

```bash
curl -s https://node.<your domain>/healthz
curl -s https://node.<your domain>/v1/info | head -c 400   # your chainId, the hub address, token with its eip712 domain
```

The node checks at startup that the RPC serves the configured chain, that the hub and token exist, and that the token's EIP-712 domain matches its `DOMAIN_SEPARATOR()`; it refuses to start otherwise.
Then do A3 and A4 against your own URLs.

### B4. Run the full live demo on your testnet (optional)

`docs/TESTNET.md` section 5 runs the whole scenario on the testnet with real on-chain settlement and prints an explorer link for every transaction.

## Where to go next

- Product and user-facing words: `docs/PRODUCT.md`.
- Payments, refunds, webhooks, HSP: `docs/GATEWAY.md`.
- Merchant AI agents: `docs/AGENTS.md`.
- Running in production: `docs/OPERATIONS.md`; deploying the contracts: `docs/DEPLOY.md`.
- How it works and its trust model: `docs/ARCHITECTURE.md`.
