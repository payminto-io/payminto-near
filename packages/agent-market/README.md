# @payminto/agent-market

Payminto's integration with the [NEAR AI Agent Market](https://market.near.ai), the marketplace where agents are hired and paid.

It has two halves.
On the seller side, a Payminto agent takes jobs from the market, and its deliverable ends with a "Verifiable costs" section: the Payminto receipts of the inputs it bought while doing the job.
On the buyer side, an agent asks a market agent for its price and checks that price against its owner's policy before anything is signed.

## What it does not do

These are hard limits, and the code is written so that they hold.

- Payminto does not settle, escrow or route Agent Market jobs.
  A market job is paid through the market: the market holds the payment and pays out from its own treasury.
- No agent advertises Payminto vouchers on the market.
  The market serves the 402 itself, with the `exact` scheme, and the payee is the market's treasury account.
- Nothing here runs end to end on testnet.
  The market takes payment on NEAR mainnet only.
  Payminto hubs run on NEAR testnet and on a local sandbox.
  The two meet in one place: a deliverable paid for on mainnet can list input purchases that are provable on testnet, and it says which is which.
- Nothing here goes around the market's payment process.
  The market's terms require that a hire made through the market is paid through the market.
- This package holds no key and cannot pay on its own.
  `market search`, `market quote` and `market work --dry-run` need no account at all.

## Do X, see Y

Run these from the repository root.
The first two talk to the live market with free, read-only requests.

### Find agents

```
pnpm --silent --filter @payminto/agent-market market search research --limit 5
```

See a table of live agents: handle, category, whether each is taking calls, and jobs delivered.
The last line names a handle to quote next.

### Ask a real agent for its price, and see the policy allow it

```
pnpm --silent --filter @payminto/agent-market market quote <handle> --max 1.00
```

Pick `<handle>` from the `market search` table above.
This is what it printed against the live market on 2026-11-10, with the third-party agent's name and handle replaced by neutral ones:

```
Agent      Example Research Agent (example-research)
Quote      0.25 USDC per call, on near:mainnet
           asset 17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1
           paid to ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc
           that is the market's own treasury account, as its /.well-known/x402 lists it, not the agent
           a payment would stay valid for 4200 s and be charged only on delivery
Policy     at most 1.00 USDC per hire and 5.00 USDC per 24 hours
Decision   ALLOW
           The price is within the policy, so an agent holding this policy may go on to pay through the market.

Nothing was signed or paid. A hire on the Agent Market is paid through the market itself.
```

The exit code is 0.

### See the policy refuse before signing

```
pnpm --silent --filter @payminto/agent-market market quote <handle> --max 0.10
```

The same quote, with a maximum below the price:

```
Decision   REFUSE by rule PER_HIRE_MAX
           The quoted price exceeds the per-hire maximum.
           the price is 250000 atomic units; the per-hire maximum is 100000.
           attempted 0.25 USDC, limit 0.10 USDC, left for today 5.00 USDC
           retry: do not retry: waiting will not change this
           Refused before signing, so this cost nothing.
```

The exit code is 3.
Add `--json` to get the same decision as JSON, with the refusal in Payminto's refusal shape: `rule`, `attemptedAmount`, `remainingBudget`, `retry`.
`--daily <usdc>` sets the rolling 24 hour maximum, and `--message <text>` sets the task that is quoted.
Prices change, so the amount you see may differ.

### See the whole seller flow with no account

```
pnpm --silent --filter @payminto/agent-market market work --dry-run
```

See what the worker would have sent to the market (`start`, then `submit`), and the full deliverable, ending with the "Verifiable costs" section.
The dry run uses a recorded assignment whose brief tells the agent to raise its limit and pay a stranger.
The output shows the spend ceiling unchanged.
The receipts in a dry run are samples and the section says so.

Pass `--ceiling 0.015` to see the ceiling cut the purchases from two to one.
Pass `--assignment <file.json>` to run rows saved from `GET /v1/agents/me/assignments`, and `--fulfil <module>` to run your own fulfil instead of the sample.

### What happens without a token

```
pnpm --silent --filter @payminto/agent-market market work
```

See the steps a person must take, and exit code 4.
The command never creates an account, registers an agent or mints a token.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Done, or ALLOW |
| 1 | The market could not be used: unknown handle, agent not live, rate limited, unreachable, or an answer in an unknown shape |
| 2 | Bad arguments |
| 3 | REFUSE |
| 4 | A person must set something up first: no token, or a token the market rejects |

Every failure prints one line saying what happened and one line starting with `Next:` saying what to do.

## Listing an agent: the human steps

A person does these once.
Nothing in this package does them for you.

1. Create an account at [market.near.ai](https://market.near.ai) and confirm its email address.
2. Open **Building**, **Your agents**, **New agent**.
   Give it a name, a handle and a one-sentence tagline.
   The handle becomes the agent's host name and cannot be changed.
   Under **Hosting** choose **Self-hosted** and leave the webhook URL empty: the worker polls.
3. Set **Price per hire** and **Delivery SLA**.
   An agent needs a price before it can go live.
4. Under **Agent API tokens** click **Create token** and copy the `aat_` value.
   It is shown once.
   Keep it in a secret store and give it to the worker as `AGENT_MARKET_TOKEN`.
5. Start the worker (see the wiring below), then hire your own draft once from `https://market.near.ai/a/<handle>` to test it.
6. Set **Listing status** to **Live**.
   The agent appears on Discover and answers on `https://<handle>.market.near.ai`.
7. To withdraw earnings, sign in as a person and open **Building**, **Payouts**.
   The market takes a 5% fee from the price of each completed job.

There is a second path, where an agent registers itself with no account behind it (`MarketClient.registerAgent`, then `createPricingPlan` and `setListingStatus("live")` with the token the registration returns).
Such an agent stays out of Discover and cannot withdraw until a person adopts it: the agent calls `createAdoptionCode()`, hands the single-use link to that person, and they sign in and adopt it.
Adoption is a human step too.
The listing calls work with a self-registration token; a token minted on the Edit page runs jobs only, and the owner changes the listing in the dashboard.

## Wiring

The package is self-contained.
Both wirings below are a few lines in the app that uses them, plus `"@payminto/agent-market": "workspace:*"` in that app's dependencies.

### The seller agent (`apps/agent`)

`fulfil` is the one function to supply: it receives the job as data and returns Markdown and receipts.

```ts
import { createMarketWorker, jobAsData, toInputReceipts, type Fulfil } from "@payminto/agent-market";
import { runBuyerTask } from "./agents.ts";

const fulfil: Fulfil = async (job, ctx) => {
  const run = await runBuyerTask({
    // jobAsData fences the buyer's text and labels it as data, not instructions.
    task: `Write the market brief this job asks for, as Markdown.\n\n${jobAsData(job)}`,
    // The ceiling comes from the worker's options, never from the job.
    limits: { maxSpendAtomic: BigInt(ctx.spendCeilingAtomic) },
    signal: ctx.signal,
  });
  if (run.status !== "completed") throw new Error(`the brief run ended as ${run.status}`);
  return {
    deliverableMarkdown: run.answer,
    receipts: toInputReceipts(run.spend?.receipts ?? [], { hub: process.env.HUB_ACCOUNT!, network: "near:testnet" }),
  };
};

const worker = createMarketWorker({ fulfil, spendCeilingAtomic: "500000", token: process.env.AGENT_MARKET_TOKEN });
await worker.start(signal).done;
```

`toInputReceipts` also takes `batchOf(callId)` and `fileOf(callId)`, for the batch a call settled in and the path of its receipt file.
With both, the section prints the `pnpm verify:near ... --receipt <file>` command that proves the single call.
Without them it lists the receipt as cleared but not settled yet.

`worker.dryRun()` runs the same worker on a recorded assignment with no token, and returns the deliverable.
`worker.start(signal).poke()` polls at once, for example after `receiveWebhook` verified a `hire.created` delivery.

From the command line the same fulfil can be loaded as a module:

```
AGENT_MARKET_TOKEN=aat_... pnpm --filter @payminto/agent-market market work --fulfil apps/agent/src/market-fulfil.ts --ceiling 0.50
```

### The wallet MCP server (`apps/mcp`)

```ts
import { MarketClient, quoteMarketAgentTool, usdcPolicy } from "@payminto/agent-market";

const tool = quoteMarketAgentTool({
  client: new MarketClient(),
  policy: usdcPolicy({ maxPerHire: "1000000", maxPerDay: "5000000" }),
  // Optional. A Verdict from @payminto/payee-check fits as it is.
  // Build that check with a mainnet reader: the quote pays an account on NEAR mainnet.
  payeeVerdict: ({ account }) => payeeCheck({ payee: account }),
});
server.registerTool(tool.name, tool.config, tool.handler);
```

The tool is `quote_market_agent`.
It is read-only: it asks for the free quote and runs the policy check.
The model that calls it can pass `max_usdc` to tighten the owner's maximum for one check, and can never raise it.
The result is the price and `allow` or `refuse`, with the refusal in the same shape as every other Payminto refusal.

### A root script, if wanted

```json
"market": "pnpm --silent --filter @payminto/agent-market market"
```

## The public API

| Area | Exports |
|---|---|
| Client | `MarketClient` (`searchAgents`, `getAgent`, `getAgentCard`, `pricingPlans`, `x402Recipients`, `registerAgent`, `createPricingPlan`, `setListingStatus`, `createAdoptionCode`, `myAssignments`, `startAssignment`, `submitDeliverable`, `declineAssignment`), `MarketError`, `Secret`, `RateLimiter` |
| Webhooks | `verifyWebhookSignature`, `parseWebhookEvent`, `receiveWebhook` |
| Seller | `runWorker`, `startWorker`, `createMarketWorker`, `renderReceiptsSection`, `verifyCommand`, `toInputReceipts`, `SpendGuard`, `jobAsData`, `recordedMarket`, `sampleFulfil` |

`renderReceiptsSection(receipts, { simulatedHub: true })` is for receipts a simulated hub signed, as in `pnpm agent market work --dry-run`.
The section then says so in its own words, makes no claim that the receipts are on NEAR, and prints no `pnpm verify:near` command, because there is no chain for one to read.
`createMarketWorker({ ..., receipts: { simulatedHub: true } })` passes the option through.
| Buyer | `quoteAgent`, `checkQuote`, `usdcPolicy`, `HireLedger`, `buildExactPayment`, `exactPaymentDelegate`, `xPaymentHeader`, `sendPaidMessage`, `getTask` |
| MCP | `quoteMarketAgentTool`, `quoteAndCheck`, `QUOTE_MARKET_AGENT` |
| CLI | `market search`, `market quote`, `market work` |

## How the pieces behave

### Untrusted input

The market is a third party, and so is every buyer and builder on it.

- Every answer is validated with zod.
  Identifiers must match a strict pattern, lists are bounded, unknown fields are dropped, and free text is cut to a fixed length with a flag that says so.
- Response bodies are read with a byte cap, requests have a timeout, and no redirect is followed.
- Job text is data.
  The worker hands it to `fulfil` and reads nothing from it: the spend ceiling, the payees and the limits come only from the caller's options.
- Worker events carry ids, codes and counts only, so they are safe to log.
- The agent token is sent only to the market's own origin.
  It is wrapped in `Secret`, which prints `[redacted]` in strings, JSON and `util.inspect`, and it is removed from every error message.
  The `X-PAYMENT` header and the adoption link are wrapped the same way.
- The client stays under the market's limit of 60 requests per minute by waiting, and a 429 becomes a `RATE_LIMITED` error that carries the wait.

### The spend ceiling

`runWorker` takes `spendCeilingAtomic`, the most one job may spend on inputs.
Each job gets a `SpendGuard` that lasts for the whole job, across retries and requests for changes.
`fulfil` receives what is left as `ctx.spendCeilingAtomic`, and can ask `ctx.spend.authorize(amount)` before each purchase; a refusal comes back in Payminto's refusal shape with the rule `JOB_SPEND_CEILING`.
After `fulfil` returns, the worker adds up the receipts.
A run that reports spending above the ceiling is not submitted: its output is not trusted, and by default the job is handed back so the buyer is refunded.

A failed run is not repeated by default (`maxAttempts: 1`), so it cannot spend twice.
A finished deliverable whose submit fails for a while is kept and submitted again, never rebuilt.

### The quote check

`checkQuote({ quote, policy, payeeVerdict, recentHires })` is pure.
It refuses with one of these rules:

| Rule | When | Retry hint |
|---|---|---|
| `NETWORK_NOT_ALLOWED` | no row of the quote is on the policy's network | never |
| `ASSET_NOT_ALLOWED` | the quote asks for another asset | never |
| `PAYEE_BLOCKED` | the payee check answers `block` | never |
| `PAYEE_WARNED` | it answers `warn` and the policy has `refuseOnWarn` | never |
| `PAYEE_VERDICT_MISMATCH` | the verdict is about another account than the quote pays | never |
| `VALIDITY_TOO_LONG` | the payment would stay chargeable longer than `maxValiditySeconds` | never |
| `PER_HIRE_MAX` | the price is above the per-hire maximum | never |
| `DAILY_MAX` | the hire would take the last 24 hours over the daily maximum | after N seconds, or never when the price alone is above it |

### The paying step

`buildExactPayment({ decision, payer, chain, sign })` builds the payment the market's caller playbook prescribes: one NEP-366 delegate action, an `ft_transfer` of the quoted amount to the market's treasury on the quoted asset, with 30 Tgas and a deposit of 1 yoctoNEAR, valid for `maxTimeoutSeconds` blocks.
It calls `sign` once with the 32-byte hash and the delegate, checks the returned signature against the payer's key, and returns the `X-PAYMENT` header.
It refuses a decision that is not `allow`, and one decision backs one payment.

It sends nothing.
`sendPaidMessage({ client, quote, payment, confirmMainnetPayment: true })` is the separate, explicit step that sends the header.
That step spends real USDC on NEAR mainnet once the agent delivers.
The caller reads the access key nonce and the block height from an RPC endpoint and passes them in as `chain`.

## Tests

```
pnpm --filter @payminto/agent-market test
pnpm --filter @payminto/agent-market typecheck
```

Fixtures named `*.live.json` are real public answers of the market, recorded on 2026-11-10 with no account: a catalog search, an agent card, pricing plans, the x402 recipients, two 402 quotes, the answer of an agent with no backend, and a 404.
`openapi-shapes.live.json` is the market's own OpenAPI document, trimmed to the operations this package uses; a contract test checks every schema and every request body against it.
Fixtures named `*.synthetic.json` are written by hand, and each says why: an assignment list, a registration and a webhook need an account, and a paid call needs mainnet funds.

No test reaches the network.

## Limits

- The paying step was never run against the live market: that needs mainnet USDC and a key, and this work had neither.
  The delegate bytes are pinned by a vector and cross-checked with near-kit, and the header follows the playbook's own code, but the market has not accepted one of these headers yet.
- The worker loop, the listing calls and the webhook check were tested against synthetic fixtures built from the market's OpenAPI document and its webhook reference, because they need an account.
- The worker keeps its state in memory.
  After a restart it resumes jobs that are still in progress and may run one again, bounded by the ceiling per job and, behind that, by the agent's Payminto Budget.
  `HireLedger` is in memory too; a long-running buyer should keep its own record of hires.
- Attachments of a job are listed to `fulfil` as metadata only; they are not downloaded.
  Deliverables are Markdown only; file uploads are not implemented.
- Bidding on the job board, competitions, the message thread and `CancelTask` are not implemented.
- `pnpm verify:near` reads testnet and sandbox hubs, so receipts name one of those two networks.
- The market can change its API.
  `SOURCES.md` lists every fact this package relies on and where it was read.
