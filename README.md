# Payminto

**A clearing layer for AI agent payments on NEAR.**

An owner gives an AI agent a Budget on a NEAR contract: a spending cap, the payees it may pay, an expiry and escrowed USDC.
The agent pays per HTTP call with a signed voucher, so a call clears in milliseconds with no transaction.
Payminto nets what owners owe each other and settles only the difference on NEAR, in one transaction for many calls.
Every single call can still be proven against a Merkle root stored on chain.

The same gateway takes payments from people: a merchant shares a payment link, and the buyer pays from a NEAR wallet or from any chain through NEAR Intents, while the merchant receives USDC in its own NEAR account.

Built for the NEAR HACKATHON (1 to 14 November 2026).
Tracks: agents, swarms, security, real world, business.

<p align="center"><img src="docs/img/payment-flow.svg" alt="How one paid call works: the owner opens a Budget with USDC escrow on the NEAR hub; each call is paid off chain with a signed voucher that the clearing node checks; many calls settle in one netted transaction, and anyone can prove a single call against the Merkle root." width="900"></p>

## Quick start

You need [Node.js](https://nodejs.org) 22.18 or newer and [pnpm](https://pnpm.io) 9 (`npm install -g pnpm@9`), on macOS or Linux (on Windows, use WSL).
Nothing here touches testnet or mainnet, moves real money, or needs an account, a wallet or a key.

```bash
git clone https://github.com/payminto-io/payminto-near.git
```

```bash
cd payminto-near && ./scripts/setup.sh
```

The setup script checks Node.js and pnpm, installs the dependencies from the lockfile, and prints what to run next.

```bash
pnpm local
```

`pnpm local` runs the whole product on this machine:

- a local NEAR node (near-sandbox), with the committed hub contract deployed and locked;
- the clearing node, the dashboard and a gas relayer;
- local test accounts in place of a wallet.

The first start downloads the near-sandbox binary once (about 30 MB) and takes about 2 minutes.
When it prints `Ready`, open the dashboard at http://localhost:3210 and sign in with a login from `apps/local/data/logins.txt`.
The terminal prints a guide of eleven steps: fund a Budget, make agent calls from the agent page, approve a new payee, settle, prove a call, pay a checkout link, pay a link from another chain (simulated), pay out and revoke.
Press Ctrl-C to stop everything.

## More to try

| Command | What you see |
|---|---|
| `pnpm demo` | In about 5 seconds: four owners, 189 paid calls, nine refusals that each name their rule, one netted batch, and a seller settling on its own after the node stops, then `25 of 25 checks passed` |
| `pnpm demo --chain sandbox` | The same story as real transactions on a local NEAR node, in about 2 minutes: `26 of 26 checks passed` |
| `pnpm swarm` | In about 5 seconds: 20 buyer and 5 seller agents on their own sub-accounts in sealed-bid rounds, 299 calls settled in 1 transaction and 5 transfers, then `17 of 17 checks passed` |
| `pnpm local --check` | The browser guide run as a script, every result checked on chain, in about 3 minutes: `24 of 24 checks passed` |
| `pnpm --silent --filter @payminto/payee-check demo` | An agent fed injected "pay X" instructions: all 3 injected payments are refused before anything is signed |
| `pnpm --filter dashboard dev:mock` | The dashboard at http://localhost:3000 with sample data, no node and no chain, including the any-chain checkout (simulated) |
| `pnpm --filter @payminto/near-addons intents quote-in --from base:USDC --usdc 5 --merchant <existing mainnet account>` | A free dry quote from the live NEAR Intents 1Click API: what a buyer on Base sends so the merchant receives exactly 5 USDC, with each fee; it reads the network and signs nothing |

Each command, with its expected output and the measured numbers, is in [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md).

## How it works

<p align="center"><img src="docs/img/architecture.svg" alt="Architecture: the dashboard talks to the clearing node and, through the owner's wallet, to the hub contract. An AI agent pays a seller API per call; the seller checks each voucher with the clearing node, which settles netted batches and payouts on the locked hub. A seller can settle on its own if the node is gone, and a gas relayer pays for an owner's revoke." width="900"></p>

1. **Budget.**
   The owner opens a Budget on the hub contract from their NEAR wallet and escrows USDC with `ft_transfer_call`.
2. **Pay per call.**
   A seller answers with HTTP 402 (x402 v2).
   The agent signs an ed25519 voucher for that exact call and retries; no transaction is sent.
3. **Checked three times.**
   The agent's wallet checks the Budget before it signs.
   The clearing node checks the signature, the payee, the caps and the escrow left.
   The hub checks them again at settlement.
   Every refusal names its rule, the amount, and when a retry can work.
4. **Payee check.**
   A lookalike or missing account is blocked before anything is signed.
   A payee with warnings waits until the owner approves it in the dashboard; the model has no tool that approves.
5. **Netting.**
   One `settle_batch` moves only each owner's net position.
   The contract verifies every voucher signature itself and recomputes the net amounts.
6. **Proof and exit.**
   Each batch stores a Merkle root, so anyone can prove one call with `pnpm verify:near`.
   If the node disappears, a seller collects from escrow with `settle_own` and the node's signed acceptance.

Every refusal, with the test that proves it, is in [docs/REFUSALS.md](docs/REFUSALS.md).

## Pay from any chain

<p align="center"><img src="docs/img/any-chain-checkout.svg" alt="Any-chain checkout: the buyer picks a token and chain; the node asks NEAR Intents for a signed quote that delivers exactly the invoice, checks it and shows a deposit address; the buyer sends from their own wallet; NEAR Intents delivers USDC to the merchant's own NEAR account; the node reads that transfer on NEAR before marking the payment paid." width="900"></p>

A buyer opens the merchant's payment link and chooses "NEAR wallet" or "Any chain".
With "Any chain" they pick USDC on Base, Ethereum, Arbitrum, Solana or Polygon, USDT on Ethereum, or ETH on Base or Ethereum, give a refund address, and get a deposit address with a QR code, the exact amount, a countdown and every fee from the signed quote.
The quote asks for the exact invoice as output, so the merchant always receives the full amount and the buyer sees the swap cost before sending.
The node marks the payment paid only after it reads the USDC transfer to the merchant's account on NEAR itself, then sends a signed webhook.
A deposit that is too small comes back to the refund address, and the checkout says so in plain words.
A merchant turns it on in Settings with one NEAR account, proven by a signed message; a two-line script adds a pay button to any website.

<p align="center"><img src="apps/dashboard/docs/screenshots/anychain-choose-1280-light.png" alt="The checkout's Any chain tab: one list of tokens and chains with estimated amounts." width="560"> <img src="apps/dashboard/docs/screenshots/anychain-deposit-375-light.png" alt="The deposit screen on a phone: send exactly this amount on Base, the QR code, the countdown, the steps and the fees." width="220"></p>

`pnpm local` runs this against a simulated 1Click server that delivers real tokens on the local chain, and `pnpm local --check` pays one link and has one deposit returned.
`pnpm local --intents live --intents-payout <account>` runs it against the real 1Click API and NEAR mainnet; [docs/LIVE_RUN.md](docs/LIVE_RUN.md) is the checklist for one real payment.

## Why NEAR

- **`ed25519_verify` in the contract**: the hub checks up to 100 voucher signatures in one `settle_batch`.
- **Function-call keys**: the node's key can call only `settle_batch` and `payout`.
- **Named accounts**: a company, a person or a Sputnik DAO owns a Budget the same way, and each swarm agent is its own sub-account.
- **A locked hub**: the deploy script deletes every key on the hub account, so nobody can change its code.
- **NEP-141 `ft_transfer_call`**: a deposit is accepted or returned in full.
- **NEP-366 meta transactions**: a relayer pays the gas, so an owner who holds only USDC can still revoke an agent.
- **NEAR Intents**: a buyer on another chain pays, and USDC arrives in the merchant's NEAR account, with no bridge or exchange account on either side.

## What the operator can and cannot do

| The operator can | The operator cannot |
|---|---|
| Refuse calls, stop settling, or go offline | Move escrow or credit to itself |
| Choose which accepted vouchers go into a batch | Settle a voucher the agent did not sign |
| Keep accepting calls for 24 hours after a revoke | Pay a payee the Budget does not allow, or exceed its cap |
| Trigger a payout | Redirect a payout, or change the hub's code |

The trust model and known limits are in [docs/SECURITY.md](docs/SECURITY.md).

## Status

| Where | State |
|---|---|
| Simulated hub (in memory) | `pnpm demo`, `pnpm swarm`, and 2,314 TypeScript tests in 15 packages pass |
| Local NEAR node (near-sandbox 2.14.0) | `pnpm local`, `pnpm local --check`, and the sandbox demo and swarm pass, with every on-chain step a real transaction against the locked hub |
| NEAR testnet | Not deployed yet; the deploy script supports it and has a dry run ([docs/WALKTHROUGH.md](docs/WALKTHROUGH.md#deploy-your-own-hub-on-testnet)) |
| NEAR mainnet | The hub and the clearing node do not run on mainnet. The any-chain rail alone has a live mode (`pnpm local --intents live`) on the real 1Click API, built and tested against recorded answers; no real payment has run on it yet ([docs/LIVE_RUN.md](docs/LIVE_RUN.md)) |

The hub contract has had an internal audit and an independent pre-audit, each finding fixed or documented with a test ([docs/audit](docs/audit)); it has not had an external audit.
What each track covers, and what still needs a person, is in [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md#which-track-each-feature-answers).

## Repository

| Path | What it is |
|---|---|
| [contracts-near/](contracts-near/) | The hub contract in Rust (near-sdk 5.30.1) |
| [apps/node/](apps/node/) | The clearing node: policy engine, payee check, settlement, payouts, merchant gateway |
| [apps/dashboard/](apps/dashboard/) | The owner and merchant dashboard (Next.js) |
| [apps/local/](apps/local/) | `pnpm local`: the whole product on a local NEAR node |
| [apps/demo/](apps/demo/), [apps/swarm/](apps/swarm/) | `pnpm demo`, `pnpm verify:near` and `pnpm swarm` |
| [apps/mcp/](apps/mcp/), [apps/agent/](apps/agent/) | An MCP wallet for AI agents and an agent runtime |
| [apps/relayer/](apps/relayer/) | The gas relayer for an owner's revoke |
| [packages/](packages/) | The protocol, NEAR chain client, SDK, payee check, model providers (NEAR AI Cloud), Agent Market quotes and NEAR add-ons, including the NEAR Intents pay-in |
| [docs/](docs/) | [Walkthrough](docs/WALKTHROUGH.md), [architecture](docs/ARCHITECTURE.md), [security](docs/SECURITY.md), [audits](docs/audit), [agents](docs/AGENTS.md), [developers](docs/DEVELOPERS.md), [self-hosting](docs/SELF_HOST.md), [operations](docs/OPERATIONS.md), [live run](docs/LIVE_RUN.md) |

Run all checks with `pnpm typecheck`, `pnpm test`, and `cargo test` in `contracts-near/`.

## Hackathon disclosure

Payminto existed before this hackathon as a payment gateway on EVM testnets, entered in a HashKey event.
The tag `pre-hackathon` is a snapshot of that version, and everything after it is the NEAR work to be judged; the tag `hackathon-submission` marks the submitted commit.

```bash
git diff --stat pre-hackathon hackathon-submission
```

The NEAR work removed the Solidity contracts and every EVM rail, and added everything described on this page.
The design and its decisions are in [docs/superpowers/specs/2026-11-10-near-clearing-design.md](docs/superpowers/specs/2026-11-10-near-clearing-design.md) and [docs/superpowers/specs/2026-11-10-hub-v2-and-any-chain-checkout-design.md](docs/superpowers/specs/2026-11-10-hub-v2-and-any-chain-checkout-design.md).

<details>
<summary>Libraries, templates and AI assistance (hackathon rule Q-005)</summary>

| Kind | What |
|---|---|
| Contract | Rust 1.99.1, near-sdk 5.30.1, cargo-near 0.23.0; near-contract-standards 5.30.1 for the mock token used in sandbox tests only; ed25519-dalek, serde, tokio and the near-sandbox crate in tests |
| NEAR client | near-kit 0.20.2, near-sandbox 2.14.0, borsh 2.0.0, `@noble/curves` and `@noble/hashes` 2.4.0, `@hot-labs/near-connect` 0.12.0 for wallets in the dashboard |
| Server | Node.js with built-in type stripping and `node:sqlite`, Hono 4 with `@hono/node-server`, zod 4 |
| Agents | `@modelcontextprotocol/sdk` 1.32, `@anthropic-ai/sdk` for the default model provider; the other providers are called over HTTP |
| Dashboard | Next.js 16.4.5, React 19.2.4, Tailwind CSS 4, Radix UI, TanStack Query, Recharts, lucide-react, qrcode.react 4.2.0 |
| Tests and build | Vitest 5 and TypeScript 7 (the dashboard uses Vitest 4 and TypeScript 5.9.3), pnpm 9 |
| Standards | x402 v2 headers with Payminto's own `payminto-voucher` scheme; NEP-141, NEP-145, NEP-366 and NEP-413; Sputnik DAO v2 proposals; the Model Context Protocol |
| Services read at run time | A NEAR RPC endpoint; the NearBlocks API for account age in the payee check; the NEAR AI Agent Market API; NEAR AI Cloud; the NEAR Intents 1Click API for any-chain payments (dry quotes only, unless an operator turns on live mode) |
| Template code | The 20 files in `apps/dashboard/components/ui` are shadcn/ui component sources |
| Recorded fixtures | Public answers of NEAR RPC, NearBlocks, the Agent Market, NEAR AI Cloud and the 1Click API, recorded for tests and labeled in each package |
| AI-generated code | The code, the tests and the documentation were written with AI coding assistance (Claude Code), directed by the author, who is responsible for what is submitted |

</details>

## License

MIT, see [LICENSE](LICENSE).
