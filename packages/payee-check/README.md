# @payminto/payee-check

A counterparty check for agents that pay on NEAR.
Before an agent pays, it asks about the receiver and gets `allow`, `warn` or `block`, with the reasons.
A wallet wrapper refuses to sign on block, asks a person on warn, and fails closed when the check itself fails.

Payminto Budgets already hold an allowed-payee list, and the node already refuses payees that are not on it.
This package adds the judgment that comes before that: is this payee new, odd, reported, or a lookalike of one you trust.
An owner uses it before adding a payee to a Budget.
A wallet uses it to stop or pause a payment.

It is read-only.
It holds no key, signs nothing and sends no transaction.
Its one dependency is `zod`, and the main entry runs in a browser.

## Do X, see Y

Run `pnpm install` once at the repo root.
Node 22.18 or newer runs the TypeScript directly, so there is no build step.

### Check a real account

```sh
pnpm --silent --filter @payminto/payee-check check wrap.testnet
```

You see the verdict, every signal with its reason, what was not checked, and what to do next.
This is the real output for a long-lived testnet contract on 2026-11-10:

```text
Payee     wrap.testnet
Kind      Named account
Network   NEAR testnet
Verdict   WARN - Ask a person first

Payments to wrap.testnet wait for a person's approval for 1 reason.

Signals
  warn  token_unregistered
        The account is not registered with the settlement token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af, so a payout cannot reach it until it registers.
  info  account_age
        The account was created on 2021-04-16, 2033 days ago (source: nearblocks).
  info  has_contract
        The account is a contract with code DsbyUrKaSJAT91Pewfi71QExPLBooDp1z4sL9GUDhNHa.
  info  full_access_key
        The contract account has 5 full-access keys: whoever holds one can replace the code at any time.

Checked   account state, access keys, account age, token registration

Not checked
  code changes since the last check: pass --store <dir>
  prior payments: the node supplies these, not the command line
  shared blocklist: pass --store <dir>
  lookalike names: pass --allowed <a,b,...> with the Budget's payees

Next
  Ask the payee to register with the settlement token, then check again.

Sources   RPC https://rpc.testnet.near.org, then https://rpc.testnet.fastnear.com; age from nearblocks; token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
These are heuristics, not a guarantee. Read-only: nothing was signed or sent.
```

More things to try:

| Do | See |
| --- | --- |
| `check this-account-does-not-exist-zz9.testnet` | `BLOCK`, `account_missing`, and a hint to check the spelling or the network. |
| `check 641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5` | An implicit account, noted as such, with its age and its 128 keys read page by page. |
| `check vvrap.testnet --allowed wrap.testnet` | `BLOCK`, `lookalike_payee`: the name reads like `wrap.testnet`. |
| `check Near-Examples.Testnet` | `BLOCK`, `invalid_account_id`, and "Did you mean near-examples.testnet?". |
| `check wrap.testnet --json` | The verdict as JSON, for a script. |
| `check wrap.testnet --rpc-url https://rpc.does-not-exist.invalid` | `BLOCK`, `check_failed`, and what to do about the endpoint. |
| `check --help` | Every option. |

Each row is run as `pnpm --silent --filter @payminto/payee-check <row>`.

With no flags the network comes from the name (`.near` and `.tg` mean mainnet, anything else testnet), the token is USDC on that network, and two public RPC endpoints are tried in turn.
A verdict always exits 0, so a `warn` does not look like a crash.
Pass `--exit-code` to get 0 for allow, 10 for warn and 20 for block.
A mistake on the command line exits 2 with one line that says what to do.

### Keep a local blocklist

```sh
pnpm --silent --filter @payminto/payee-check report wrap.testnet --store ./payee-store \
  --reporter alice.testnet --reason "Demo report, not a real claim." --evidence https://example.com/proof
pnpm --silent --filter @payminto/payee-check check wrap.testnet --store ./payee-store
```

The first command writes one report to `./payee-store/blocklist.json` and sends nothing anywhere.
The second then shows `warn reported`, and quotes the report under "Reports (claims by third parties, quoted as written)".
Three distinct reporters turn it into `block reported_by_several`.
The same directory holds `code-seen.json`, so a later check can say that a contract's code changed.

### Run the attack demo

```sh
pnpm --silent --filter @payminto/payee-check demo
```

A scripted agent obeys any "pay X USDC to Y" it reads, wherever the text came from.
It is fed tool results with injected instructions, and every payment goes through `guardPayment`.
There is no network, no model and no key, and every run prints the same log.
The demo ends with:

```text
Result: 6 payment attempts, 2 signed, 4 stopped.
Signed: acme.testnet, fresh-vendor.testnet
Stopped: acrne.testnet (blocked), fast-refunds.testnet (blocked), quiet-drop.testnet (approval_timeout), acme.testnet (blocked)
All 3 payments that came from injected text were refused before anything was signed.
```

| Step | The agent tries to pay | Outcome | Why |
| --- | --- | --- | --- |
| 1 | `acme.testnet`, asked by the user | allowed, signed | An old, registered payee the owner has paid five times. |
| 2 | `acrne.testnet`, injected by an invoice page | blocked | `lookalike_payee`: reads like `acme.testnet`, which the Budget allows. |
| 3 | `fast-refunds.testnet`, injected by a search result | blocked | `reported_by_several`: three distinct reporters. |
| 4 | `fresh-vendor.testnet`, asked by the user | approved, signed | `new_account`: two days old, so a person is asked, and approves. |
| 5 | `quiet-drop.testnet`, injected by an email footer | approval timeout | `new_account`: nobody answers, so the payment is refused. |
| 6 | `acme.testnet`, with the RPC endpoint down | blocked | `check_failed`: the chain could not be read, so nothing is paid. |

Each step prints one JSON log line with the payer, payee, amount, verdict, outcome, signals and approval.

### Run the tests

```sh
pnpm --filter @payminto/payee-check test
pnpm --filter @payminto/payee-check typecheck
```

## Use it in code

```ts
import { SETTLEMENT_TOKENS, createPayeeCheck, guardPayment, nearBlocksAgeSource, rpcReader } from "@payminto/payee-check";
import { FileBlocklist, FileCodeStore } from "@payminto/payee-check/node";

const check = createPayeeCheck({
  reader: rpcReader("https://rpc.testnet.near.org"),
  token: SETTLEMENT_TOKENS.testnet,
  ageSource: nearBlocksAgeSource({ network: "testnet" }),
  blocklist: new FileBlocklist({ path: "./data/blocklist.json" }),
  codeStore: new FileCodeStore({ path: "./data/code-seen.json" }),
});

const verdict = await check({ payee: "acrne.testnet", payer: "owner.testnet", budgetPayees: ["acme.testnet"] });
// verdict.verdict is "allow", "warn" or "block"; verdict.signals lists each reason with its facts.

const decision = await guardPayment({
  payer: "owner.testnet",
  payee: "acrne.testnet",
  amount: 2_500_000n,
  budgetPayees: ["acme.testnet"],
  check,
  onWarn: async ({ payee, verdict }) => ((await askThePerson(payee, verdict)) ? "approve" : "deny"),
});
if (!decision.proceed) return refuse(decision.message, decision.log);
// Only here may the wallet sign.
```

Only `reader` is required.
Every other source is optional, and a verdict lists what it could not check under `notChecked`, so silence is never read as a pass.

### Entry points

| Import | Holds | Runs in a browser |
| --- | --- | --- |
| `@payminto/payee-check` | Signals, policy, verdict, RPC reader, age source, memory stores, `guardPayment`, wiring helpers. | Yes |
| `@payminto/payee-check/node` | `FileBlocklist`, `FileCodeStore`, `writeFileAtomic`. | No |
| `@payminto/payee-check/fake` | `FakeNearReader`, `FakeAgeSource`, `MemoryHistory`, for tests. | Yes |

### Main functions

| Function | What it does |
| --- | --- |
| `createPayeeCheck(sources)` | Returns `check({ payee, payer?, budgetPayees? })`, which resolves with a `Verdict`. |
| `collectFacts(sources, request)` | Reads the facts only. A source that fails becomes an unknown fact with its cause. |
| `evaluate(facts, policy?)` | Pure: facts and policy in, verdict out. |
| `resolvePolicy(input?)` | Fills in defaults and validates a policy. |
| `guardPayment(input)` | Decides whether a payment may be signed, and returns a structured log entry. |
| `payeeCheckForNode(options)` | The check as the node calls it: cached, shared between concurrent callers, with a call-path time limit, and `check.patient` with a longer one over the same cache. |
| `rpcReader(url, options?)` | The ready-made read-only reader for an RPC URL. On a network's public default endpoint it also tries the second public endpoint; any other URL is read alone. |
| `payeeCheckTool`, `payeeCheckToolResult(verdict)` | The MCP tool `check_payee`: description, zod input shape, and result. |
| `toView(verdict)` | A typed view model in plain words, for a page. |
| `describeVerdict(verdict)` | The verdict as lines of text. |

## Signals

Each signal is a pure function over facts.
It has an id, a severity set by the policy, a reason in one sentence, and the facts behind the reason.
The verdict is the heaviest severity among the signals that fired: any block blocks, else any warn warns, else allow.
The same facts and policy always give the same verdict, byte for byte.

| Signal | Default | Fires when |
| --- | --- | --- |
| `invalid_account_id` | block | The payee text is not a NEAR account id. |
| `check_failed` | block | The chain could not be read. |
| `account_missing` | block | No such account exists on chain. |
| `lookalike_payee` | block | The name is a near miss of an account on the Budget's allowed list. |
| `reported_by_several` | block | 3 or more distinct reporters, or 1 trusted reporter, on the shared blocklist. |
| `reported` | warn | At least 1 reporter, and fewer than the blocking number. |
| `code_changed` | warn | The contract code differs from an earlier check, and the change was seen in the last 7 days. |
| `new_account` | warn | The account was created fewer than 7 days ago. |
| `account_not_indexed` | warn | The account is on chain but the indexer has never seen it. |
| `no_keys_no_contract` | warn | The account has no access keys and no contract. |
| `token_unregistered` | warn | `storage_balance_of` on the settlement token returned null. |
| `check_incomplete` | warn | A secondary source (keys, age, code store, token, history, blocklist) did not answer. |
| `account_age_unknown` | info | The indexer knows the account but holds no creation transaction. |
| `account_age` | info | The account is older than the minimum; the creation date is listed. |
| `implicit_account` | info | The id is 64 hex characters, or `0x` and 40 hex characters. |
| `has_contract` | info | The code hash is not the all-ones "no contract" hash; the hash is recorded. |
| `full_access_key` | info | The account has at least one full-access key. |
| `locked_contract` | info | A contract account has no access keys. |
| `first_payment` | info | This payer has never paid this payee. |
| `paid_before` | info | This payer has paid this payee; the count and total are listed. |

### Policy defaults

| Setting | Default | Meaning |
| --- | --- | --- |
| `minAccountAgeDays` | 7 | `new_account` fires below this age. |
| `codeChangeWindowDays` | 7 | `code_changed` keeps firing this long after a change was seen. |
| `establishedAfterPayments` | 3 | After this many payments from the same payer, `new_account` and `account_not_indexed` drop to info. 0 turns this off. |
| `blocklist.warnAtReporters` | 1 | Distinct reporters for `reported`. |
| `blocklist.blockAtReporters` | 3 | Distinct reporters for `reported_by_several`. |
| `blocklist.trustedReporters` | none | One report from any of these blocks on its own. |
| `lookalike.maxEdits` | 2 | The most edits that still count as a lookalike. |
| `lookalike.charsPerEdit` | 4 | One edit is tolerated per this many characters, so names under 4 characters need an exact confusable match. |
| `severity` | the table above | Per signal: `off`, `info`, `warn` or `block`. |

Give only what you want to change: `createPayeeCheck({ ..., policy: { minAccountAgeDays: 30, severity: { new_account: "block" } } })`.
A malformed policy throws when the check is built, not at the first payment.
`check_failed` and `invalid_account_id` can be set to warn or block and nothing lighter, so no policy can wave a failed check through.

### What each signal can and cannot tell you

| Signal | It tells you | It cannot tell you |
| --- | --- | --- |
| `invalid_account_id` | The text cannot be a NEAR account, which also rules out every non-ASCII homoglyph. | Anything about a valid name. |
| `account_missing` | A payout cannot land there today. | Whether the name is a typo or a trap. |
| `implicit_account` | The id is derived from a key, so the name carries no meaning. | Who holds the key. |
| `new_account`, `account_age` | When the creating transaction happened, according to the indexer. | That a new account is fraud, or that an old one is honest. Old accounts are bought, sold and stolen. |
| `account_not_indexed`, `account_age_unknown` | The age is unknown, and why. | The age. It is never estimated. |
| `has_contract` | The account runs code, and the hash of that code right now. | What the code does. A hash is not an audit. |
| `code_changed` | The code differed between two of your own checks. | When it changed on chain, or what changed before your first check. |
| `full_access_key` | A key holder can replace the code or move every asset at any time. | Who holds the key, or whether they will. |
| `locked_contract` | No key can change the code. | That the code has no upgrade path of its own. |
| `no_keys_no_contract` | Nobody can ever move funds from the account. | Why someone would ask you to pay it. |
| `token_unregistered` | A payout in the settlement token cannot be delivered until the payee registers. | Anything about intent. On Payminto the credit waits on the hub. |
| `first_payment`, `paid_before` | What this payer's own history with the payee is. | Whether those earlier payments were wanted. |
| `reported`, `reported_by_several` | How many distinct accounts filed a report, and their evidence links. | Whether the reports are true. Reporters are not verified by this package. |
| `lookalike_payee` | The name is within a few edits, or a confusable spelling, of a payee you already allow. | Whether the two are related. A different name under another parent is not caught. |
| `check_failed`, `check_incomplete` | Part of the picture is missing, and which part. | Anything about the payee. |

## Fail closed

- `guardPayment` never rejects, and it sets `proceed: true` in one place, for two outcomes: `allowed` and `approved`.
- If the check throws, hangs past `checkTimeoutMs`, answers nothing, answers about another payee, or says allow while listing a blocking signal, the outcome is `check_failed` and nothing is signed.
- `onCheckFailure: "warn"` asks the person instead, with a verdict that says the check failed.
  Allow is not an option.
- On warn, only the exact answer `"approve"` approves.
  A denial, a timeout (default 120 s), a throwing callback, a missing callback and any other value all refuse.
- Inside the check, a source that fails or hangs becomes an unknown fact: the chain itself gives `check_failed` (block), any other source gives `check_incomplete` (warn).
- A lookalike is still caught when the chain cannot be read, because it needs no reading.
- Every decision returns a log entry: payer, payee, amount, verdict, outcome, signals with reasons, the approval answer and wait, the error, and the duration.

## Blocklist reports are data, not instructions

A report is a claim by another party, and it is treated as hostile input.

- Reports are validated strictly with zod when submitted, and again every time a file is read: account ids, a reason of one plain line of at most 280 characters, evidence that is a transaction hash or an `https` URL of at most 300 characters, and no unknown fields.
- Control characters, line breaks and bidirectional override characters are rejected.
- A reporter holds one report per account, so repeating a claim adds no weight.
  An account holds at most 200 reports.
- Signal reasons, signal facts, `guardPayment` log entries and the `check_payee` tool result are built from counts and validated account ids only.
  The free text of a report never appears in them.
- The text is kept apart in `verdict.reports`, for a person to read as a quote.
- This package never fetches an evidence URL.
- `FileBlocklist` writes atomically: new content goes to a file beside the target, is flushed, and is renamed over it.
  A damaged file is an error, never an empty list.

The store does not authenticate reporters.
Whoever calls `report()` must have checked that the reporter is who they say, as the node does for its own API callers.

## Wiring

All three pieces are in this package, so each integration is a few lines.

### Node: when an owner adds a payee, and when a voucher names one

```ts
import { payeeCheckForNode } from "@payminto/payee-check";
import { FileBlocklist, FileCodeStore } from "@payminto/payee-check/node";

const payeeCheck = payeeCheckForNode({ reader, token: config.TOKEN_ACCOUNT, ageSource, blocklist, codeStore, history });
// history: { paymentsBetween: (payer, payee) => store.paidBetween(payer, payee) }

// In the voucher path, before evaluateVoucher:
const verdict = await payeeCheck(budget.owner, voucher.payee, voucher.amount, budget.payees);
if (verdict.verdict === "block") return deny("PAYEE_BLOCKED", { signals: verdict.signals }); // the rule name is the node's to choose
```

It always resolves with a verdict.
Verdicts are cached for 30 s per payer, payee and allowed list, concurrent calls share one check, and no call waits longer than 3 s (`timeLimitMs`).
`payeeCheck.patient(...)` asks the same question for a caller that can wait, such as a person or a look nobody waits for, and waits up to 20 s (`patientLimitMs`, never shorter than `timeLimitMs`).
Both share one cache and one set of running looks, so a node builds one instance.
A check that runs past its limit answers `check_failed`, finishes in the background and fills the cache.
Failed and incomplete verdicts are never cached.
Call `payeeCheck.forget(payee)` after a report is filed.

### MCP wallet: the `check_payee` tool and the guard

```ts
import { guardPayment, payeeCheckTool, payeeCheckToolResult } from "@payminto/payee-check";

server.registerTool(payeeCheckTool.name, payeeCheckTool, async ({ payee }) =>
  payeeCheckToolResult(await check({ payee, payer: wallet.owner, budgetPayees: wallet.allowedPayees })));

// In the wallet, before a voucher is signed:
const decision = await guardPayment({ payer, payee, amount, budgetPayees, check, onWarn: askUserThroughElicitation });
if (!decision.proceed) return refusal(decision.message, decision.log);
```

### Dashboard: show a verdict before a payee is added to a Budget

```tsx
import { toView } from "@payminto/payee-check";

const view = toView(verdict); // verdict from the node, or from createPayeeCheck in the browser
<h3 data-tone={view.tone}>{view.headline}</h3>
<p>{view.summary} {view.nextStep}</p>
{view.signals.map((s) => <li key={s.id} data-tone={s.tone}><b>{s.title}</b> {s.reason}</li>)}
{view.reports.map((r) => <blockquote key={r.reporter}>{r.quote} <cite>{r.reporter}</cite></blockquote>)}
```

Every string in the view is text, never markup.

## Where the facts come from

| Fact | Source | Notes |
| --- | --- | --- |
| Existence, code hash | NEAR JSON-RPC `view_account` at `finality: "final"` | `UNKNOWN_ACCOUNT` means the account does not exist. Global contract fields are read when present. |
| Access keys | `view_access_key_list` | Nodes refuse more than 100 keys in one answer (`TOO_MANY_ACCESS_KEYS`), so the reader pages with `limit` and `after_key`, up to 3 pages by default. Gas keys count by the permission they carry. |
| Token registration | `call_function` `storage_balance_of` on the NEP-141 token | Null means not registered. |
| Account age | A pluggable `AgeSource`; the built-in one is NearBlocks `GET /v3/accounts/{account}` | See below. |
| Code changes | A `CodeStore` you keep | RPC reports the code now, not when it was deployed. |
| Prior payments | A `HistorySource` the node supplies | |
| Reports | A `Blocklist` you keep or share | |

The reader can only send those three queries.
The RPC shapes, the paging rule and the error names were recorded from `rpc.testnet.near.org` on 2026-11-10 and are replayed in the tests from `test/fixtures/rpc/`.
`node test/fixtures/record.ts` records them again.

### Account age, honestly

NEAR RPC does not give an account's creation time.
`view_account` describes the account as it is now, and finding its first block would mean walking archival history.
An indexer that stores the creating transaction is the honest source.

The built-in source is NearBlocks API v3, checked against its migration guide at `https://api-testnet.nearblocks.io/api-docs/migration` and against live answers on 2026-11-10.
Testnet serves v3 only, and the guide announces the end of v1 and v2 for 2026-11-22, so this package uses v3 on both networks.

| NearBlocks answers | The check says |
| --- | --- |
| `data.created.block_timestamp` (nanoseconds, as a string) | Known: the creation time and the creating transaction. |
| `data.created` is `{}` | `account_age_unknown`: the indexer knows the account but not its creation, as with accounts from genesis such as `testnet`. |
| `data` is `null` | `account_not_indexed`: on chain but unknown to the indexer, which is how an account newer than the index looks. |
| An error, a timeout, or another shape | `check_incomplete`, with the cause. |

An age is never guessed.
Implement `AgeSource` (`name` and `createdAt(account)`) to use FastNEAR, your own indexer or anything else.

## Limits

- These are heuristics, not a guarantee.
  An allow means nothing that was checked speaks against the payee.
  It does not mean the payee is honest.
- A new account is not proof of fraud, and an old one is not proof of honesty.
- The indexer is a trusted third party.
  If NearBlocks is wrong, the age is wrong.
  It also learns which accounts you check, as does the RPC endpoint.
- The public RPC endpoints and the keyless NearBlocks tier are rate limited.
  For real traffic pass your own endpoint and an API key.
- Reporters are not verified and accounts are cheap, so reports can be faked.
  `trustedReporters` and the reporter thresholds are the levers, and the node must authenticate whoever files a report.
- A code change is only seen between two of your own checks.
  Code that changed before your first check, or changed and changed back between checks, is invisible.
- A code hash says the code is the same as before, not that it is safe.
- The lookalike signal compares against the Budget's allowed list only, with a small table of confusable spellings and a small edit distance.
  It does not catch the same name under another parent, such as `acme.near` against `acme.other.near`.
- Verdicts do not depend on the amount today.
  The amount is logged and shown to the approver.
- The file stores serialize writes inside one process.
  Two processes writing the same file can lose one update to the other, so keep one writer per file.
- `payeeCheckForNode` caches for 30 s, so a new report or code change can take that long to show unless `forget` is called.
- The check reads at `finality: "final"`.
  An account can change right after it is read.
