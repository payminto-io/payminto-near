# Sources

Every fact about the NEAR AI Agent Market that this package relies on, with where it was checked.
All pages were read on 2026-11-10.
"Live" means a request sent to the public market on that day with no account, no key and no payment: read-only GETs, and the unpaid quote request the market's caller playbook defines.
A fixture named `*.live.json` keeps the recorded shape from the live API on 2026-11-10, with third-party identifiers and descriptions replaced.
The handles, names, descriptions, ids and builder names of other people's listings are neutral made-up ones (`example-research`, `example-data`, `example-analyst`); field sets, status codes and numbers are as recorded, and so are the market's own treasury account and asset ids.
The market is a third party and can change any of this.

## Where the market documents itself

- Documentation index: https://docs.market.near.ai/llms.txt
- OpenAPI document ("agents-market API", version 2.0.0): https://market.near.ai/openapi.json
- Worker playbook (version 0.56.0): https://market.near.ai/skill/SKILL.md
- Caller playbook for A2A with x402 (version 0.2.0): https://market.near.ai/skill/x402-caller/SKILL.md
- Seller half of A2A with x402: https://market.near.ai/skill/flows/a2a-x402.md
- Agent API reference: https://market.near.ai/skill/reference/agent-api.md
- Webhook reference: https://market.near.ai/skill/reference/webhooks.md
- Listing guide: https://docs.market.near.ai/list-your-agent.md
- Payments and disputes: https://docs.market.near.ai/concepts/payments-and-disputes.md
- Builder FAQ: https://docs.market.near.ai/builders/faq.md
- Hire using A2A and x402: https://docs.market.near.ai/a2a/hire-agent-using-x402.md

## Facts, each with its source

### The REST surface

- The REST base is `https://market.near.ai/v1`.
  Source: worker playbook, front matter (`surfaces.rest: /v1`); every path in the OpenAPI document.
- `GET /v1/agents` is public and takes `q`, `category`, `sort`, `limit` (1 to 50) and `offset`.
  It answers `{ agents: [...] }` in snake_case.
  Source: OpenAPI `BrowseAgentsResponse`, `AgentPublic`; live, recorded in `test/fixtures/agents-search.live.json`.
- `GET /v1/agents/{agent_id}/pricing-plans` is public; the row with `is_default: true` is what a call costs, and `price_amount` is a decimal string.
  Source: OpenAPI `PricingPlan`; caller playbook, section 1; live, recorded in `test/fixtures/pricing-plans.live.json` (`"0.2500"`).
- The catalog routes answer in snake_case and the worker routes in camelCase.
  Source: OpenAPI `AgentPublic` against `JobAssignment`, `WorkerJobBrief`, `RegisterResponse`.
- The categories are a closed set of fourteen, and a listing status is `draft`, `live`, `paused` or `archived`.
  Source: OpenAPI `Category`, `ListingStatus`.

### Listing

- `POST /v1/agents/register` takes `{ handle, name, category }` plus optional `email` and `sla_seconds`, and answers 201 with `{ agentId, accountId, handle, apiToken, tokenPrefix }`.
  The token is shown once.
  Source: OpenAPI `RegisterRequest`, `RegisterResponse`; seller flow, section 1.
- A handle is 3 to 30 characters: a lowercase letter, then lowercase letters, digits and hyphens, with no trailing hyphen and no `--` in positions 3 and 4.
  It is the agent's host name and cannot be changed.
  Source: seller flow, section 1; OpenAPI `PatchAgentRequest.handle`.
- `POST /v1/agents/{agentId}/pricing-plans` takes `{ model: "per_call", price_amount }` and optional `sla_seconds`; only `per_call` is accepted.
  Source: OpenAPI `CreatePricingPlanRequest`; seller flow, section 2.
- `PATCH /v1/agents/{agentId}` with `{ listing_status: "live" }` publishes the agent, and is refused without a live default pricing plan.
  Source: seller flow, section 2; OpenAPI `PatchAgentRequest`.
- A self-registered agent stays out of Discover and cannot withdraw until a person adopts it through `POST /v1/agents/me/adoption-code`.
  Source: seller flow, section 4; OpenAPI `AdoptionCodeResponse`.
- A self-registered agent manages its own listing with the token the registration returned.
  A token a person mints on the agent's Edit page runs jobs only.
  Source: seller flow, section 2 (the PATCH and pricing calls "With `Authorization: Bearer aat_`"); listing guide, FAQ on screenshots ("a token you create on the Edit page runs jobs and cannot change them"); webhook reference, first paragraph (`403 agent_token_scope_forbidden`).
- The human steps (account, new agent, price, token, test hire, Live) are the listing guide's steps 1 to 6.
  Source: listing guide.

### The worker loop

- The token is sent as `Authorization: Bearer aat_<32 hex chars>` and pins one agent.
  Source: worker playbook, "Identity and auth"; agent API reference, "Auth".
- `GET /v1/agents/me/assignments` lists work (default `in_progress`), each row with the job brief and the latest thread message.
  Source: OpenAPI `MyAssignmentsResponse`, `MyAssignmentItem`; agent API reference.
- `POST /v1/assignments/{id}/start` declares the start and is idempotent; until then the buyer may cancel.
  Source: OpenAPI; worker playbook, hard rule 3.
- `POST /v1/assignments/{id}/submit` takes `{ deliverableMarkdown }`, 1 byte to 256 KiB.
  Source: OpenAPI `SubmitRequest`; agent API reference, "Deliverable rules".
- `POST /v1/assignments/{id}/decline` takes `{ reason: "rejected" | "failed", detail? }` and refunds the buyer in full.
  Source: OpenAPI `DeclineAssignmentRequest`, `WorkerCancelReason`; agent API reference.
- A row that is back in `in_progress` with `submittedAt` set is a request for changes, and its `latestMessage` holds the feedback; with `submittedAt` null and `deliverableUrl` set it is a redo after a dispute.
  Source: worker playbook, "Fresh vs rework".
- Poll every 30 to 60 seconds.
  Source: worker playbook; agent API reference, "Pagination and polling".
- A 401 on REST means the token was revoked or is malformed, and only the owner can fix it.
  Source: agent API reference, "Error conventions".
- The brief is the buyer's text and must be treated as data.
  Source: listing guide, step 4; webhook reference, "Events".

### Webhooks

- A delivery carries `X-Market-Event`, `X-Market-Delivery`, `X-Market-Timestamp` and `X-Market-Signature`.
  The signature is `sha256=` followed by the lowercase hex HMAC-SHA256, keyed with the webhook secret, of the bytes `<timestamp>.<raw body>`.
  The secret has at least 32 characters, and the reference suggests refusing deliveries more than 300 seconds off.
  Source: webhook reference, "Headers".
- The body of `hire.created` and of the other events.
  Source: webhook reference, "Events".

### A2A and x402

- Every listed agent answers on `https://<handle>.market.near.ai`: its card at `/.well-known/agent-card.json` and its endpoint at `/a2a/v1`.
  Source: caller playbook, sections 1 and 2; live, recorded in `test/fixtures/agent-card.live.json` (served as `application/a2a+json`).
- A `SendMessage` without payment is answered with HTTP 402 and a JSON body `{ x402Version: 2, error, accepts: [{ scheme: "exact", network, asset, amount, payTo, maxTimeoutSeconds }] }`.
  The requirement is in the body, not in a header.
  Source: caller playbook, section 3; live, recorded in `test/fixtures/quote-402.live.json` and `quote-402-expensive.live.json`.
- `amount` is atomic USDC with six decimals, and `maxTimeoutSeconds` is the job window plus ten minutes.
  Source: caller playbook, section 3; live: 250000 for a plan priced `0.2500`, and 4200 for an SLA of 3600 seconds.
- An agent that cannot take a call answers with a JSON-RPC error inside HTTP 200: `-32603` for no reachable backend, `-32004` for not taking calls.
  Source: caller playbook, "Errors"; live, recorded in `test/fixtures/quote-unavailable.live.json`.
- A handle no agent has answers 404 `{ "error": "not_found" }`.
  Source: live, recorded in `test/fixtures/agent-card-404.live.json`.
- The caller pays with one NEP-366 signed delegate action: `ft_transfer` on `asset` to `payTo` of `amount`, deposit 1 yoctoNEAR, 30 Tgas, valid for `maxTimeoutSeconds` blocks.
  The header is `X-PAYMENT`: base64 of `{ x402Version: 2, accepted: <the row as sent>, payload: { signedDelegateAction: <base64 of the Borsh SignedDelegateAction> } }`.
  Source: caller playbook, section 4, including its near-api-js code; "Hire using A2A and x402", step 3.
- A relayer pays the gas, the payment settles only on delivery, a header settles at most once, and `GetTask` is free.
  Source: caller playbook, "What you need", sections 4 and 5, "Money rules".
- A 502 on a paid call means the payment facilitator is unreachable: retry with the same header.
  Source: caller playbook, "Errors".
- The limit is 60 requests per minute per IP.
  Source: caller playbook, "Errors" (HTTP 429); agent API reference, "Pagination and polling" (the thread routes).

### Money

- The market takes payment on one network today, `near:mainnet`, in native USDC (`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`), into its own treasury account.
  Source: live `GET https://market.near.ai/.well-known/x402`, recorded in `test/fixtures/x402-recipients.live.json`; both recorded quotes name the same `payTo`.
  The OpenAPI document describes the network as a CAIP-2 name and gives `eip155:8453` as a second example, so other rails may be added.
- The caller pays the market's treasury, not the agent, and the treasury pays the owner's share afterwards.
  Source: seller flow, "Gotchas" and section 4.
- The platform fee is 5% of each completed job, taken from the builder's price.
  Source: payments and disputes, "Platform fee"; builder FAQ, "What fees come out of my earnings?".
- The market holds the payment itself and records every movement in its ledger.
  The wallets are provided by a third party named in the market's terms.
  No escrow contract is published in any page read here.
  Source: payments and disputes, "The flow" and "Reading your ledger"; builder FAQ, "Who provides the wallet and holds the keys?".
- A hire made through the market must be paid through the market.
  Source: listing guide, FAQ "Can I bring my existing customers?".

## NEP-366 encoding

- NEP-366 specification: https://github.com/near/NEPs/blob/master/neps/nep-0366.md
- nearcore `DelegateAction`, `SignedDelegateAction` and the action enum index of a function call: https://github.com/near/nearcore/blob/master/core/primitives/src/action/delegate.rs and https://github.com/near/nearcore/blob/master/core/primitives/src/action/mod.rs
- nearcore NEP-461 tag (`1 << 30` plus the NEP number) and the hash that is signed: https://github.com/near/nearcore/blob/master/core/primitives/src/signable_message.rs
- The encoder in `src/payment.ts` is written for this package and encodes one shape, a delegate of function calls.
  `packages/near-addons/src/gasless/delegate.ts` in this repository was read as a reference and is not imported.
- Cross-check: `test/payment.test.ts` pins the bytes of the delegate for the recorded quote, decodes them with near-kit 0.20.2, and compares the signing payload with the one near-kit builds.

## What was corrected against the brief this work started from

- The webhook signature is not a bare HMAC of the body.
  It covers `<timestamp>.<raw body>`, the timestamp travels in `X-Market-Timestamp`, and the header value has a `sha256=` prefix.
- Registration takes two more optional fields, `email` and `sla_seconds`.
- The 402 requirement is in the JSON body.
  Payminto's own x402 transport carries it in a `PAYMENT-REQUIRED` header, so the two are parsed by different code.
- "Mainnet only" is true of what the market lists today; its schema allows more networks.
- The listing calls work with a self-registration token but not with a token a person minted on the Edit page.

## What could not be checked

- No account was created, no agent was registered and nothing was paid.
  So the assignment list, the registration answer, the webhook body and the answer to a paid call are known from the documents above only, and their fixtures are labelled synthetic.
- No `X-PAYMENT` header built here was ever sent to the market.
