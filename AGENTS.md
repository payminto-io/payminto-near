# Payminto: instructions for coding agents

Read by Codex, Cursor, Claude Code and other coding agents that open this repository.
Everything below runs on a clean Linux or macOS machine with no account, wallet or key, and CI runs the same commands on `ubuntu-24.04` on every push.

## Set up and prove it works

You need Node.js 22.18 or newer and pnpm 9 (`corepack enable pnpm` or `npm install -g pnpm@9`).

```bash
./scripts/setup.sh
```

```bash
pnpm typecheck && pnpm test
```

```bash
pnpm local --check
```

`./scripts/setup.sh` checks Node.js and pnpm and installs the workspace from the lockfile.
`pnpm test` runs every package's tests (about 2,600 TypeScript tests in 15 packages).
`pnpm local --check` starts the whole product on a local NEAR node (near-sandbox, downloaded once, about 30 MB), runs a scripted pass through it and prints `24 of 24 checks passed`; it exits non-zero on any failure.
It takes about 4 minutes and needs no network access beyond the first download and the package registry.

## Run it for a person

```bash
pnpm local
```

When it prints `Ready`, the dashboard is at http://localhost:3210 and the logins are in `apps/local/data/logins.txt` (a platform owner, a business admin and a business API key).
The terminal prints an eleven-step guide.
It runs Test mode: a local NEAR node and a simulated 1Click server, no real money.

## Create a payment link

With the stack running, use the business API key from `apps/local/data/logins.txt`.
Amounts are USDC base units (6 decimals), so `1500000` is 1.50 USDC.

```bash
curl -s -X POST http://127.0.0.1:4210/v1/links -H "Authorization: Bearer $PAYMINTO_KEY" -H "content-type: application/json" -d '{"title":"Bag of coffee beans","amount":"1500000"}'
```

The answer's `url` is the payment link; opening it shows the one-screen checkout.
In the dashboard the same is Payment links, then "New link".
The TypeScript SDK (`packages/sdk`, `GatewayClient`) wraps the same API.
The whole API is in [docs/DEVELOPERS.md](docs/DEVELOPERS.md).

## Pay as an AI agent

The MCP server in `apps/mcp` gives an agent the tools `invoice_pay_options`, `invoice_deposit` and `invoice_status` to pay any invoice from another chain from its own wallet, and Budget tools to pay per call.
Setup and every tool call are in [docs/AGENTS.md](docs/AGENTS.md).

## Rules for changes

- Run `pnpm typecheck`, `pnpm test` and `pnpm local --check` before you call a change done.
- Never point tests or scripts at a database that is in use: `pnpm local` deletes only its own `apps/local/data` and refuses while a live payment is unfinished.
- Never commit keys, `.env` files or `apps/local/data`.
- Live mode (`pnpm local --intents live --intents-payout <account>`) moves real money on NEAR mainnet; only a person runs it ([docs/LIVE_RUN.md](docs/LIVE_RUN.md)).
