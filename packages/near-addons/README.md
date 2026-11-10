# @payminto/near-addons

Optional NEAR-native add-ons for Payminto.
The core clearing product never imports this package, so it ships and runs with every add-on off.
Each module can be dropped on its own.

Every module only builds transactions or reads public data.
None of them signs a transaction for a network or sends one, and none holds a key for a real account.
Where a real transaction is needed, the README names it as a human step.

Status words used below:

- **Verified live (read-only)** means the module, or the exact request it makes, was run against the public service or chain on 2026-11-10 with no key, and the recorded answer is a test fixture.
- **Unit-tested** means the behavior is covered by tests against fixtures, source-derived vectors or synthetic data, and was never run against a network.
- **Synthetic** fixtures are labeled in the test file and never presented as recorded.

Sources for every fact are in [SOURCES.md](SOURCES.md).

## 1. Intents exit with 1Click

`src/intents/` and the `payminto-exit` CLI.
A net creditor holding USDC on NEAR mainnet swaps it to another asset or chain, for example USDC on Base, through the 1Click Swap API.

What it does:

- `OneClickClient` wraps the four v0 endpoints the exit needs: `GET /v0/tokens`, `POST /v0/quote`, `GET /v0/status` and `POST /v0/deposit/submit`.
  Request and response types follow the OpenAPI document at `https://1click.chaindefuser.com/docs/v0/openapi.yaml`.
- `exitQuoteRequest` asks for `EXACT_INPUT` from a NEAR `nep141:` origin with `depositType: ORIGIN_CHAIN`, delivery with `recipientType: DESTINATION_CHAIN`, and refunds with `refundType: ORIGIN_CHAIN` to the sender.
  It never sends `customRecipientMsg`, which the 1Click docs mark highly experimental and able to lose funds.
- `verifyQuoteSignature` checks that the 1Click manager key signed the quote, with the same field selection and hashing as the official TypeScript SDK 0.1.26.
- `exitPlan` turns a wet quote into the exact NEAR transaction the human signs, and refuses when the signature fails, the quote differs from what was asked, the deadline passed, a memo is required, or the refund account is not the sender.
  The transaction is one `ft_transfer` of `amountIn` to the deposit address with 1 yoctoNEAR attached, preceded by a `storage_deposit` with `registration_only: true` when the deposit address may not be registered at the token.
- `pollStatus` polls `/v0/status` until `SUCCESS`, `REFUNDED` or `FAILED`, or a timeout.
- `ViewRpc` (in `src/rpc.ts`) is the read-only NEAR RPC reader used for the registration check.
  It refuses every RPC method except view queries and block reads, so it cannot broadcast.

CLI:

```sh
pnpm --filter @payminto/near-addons exit tokens --chain near --symbol USDC
pnpm --filter @payminto/near-addons exit quote --to nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near \
  --amount 10000000 --recipient 0xYourBaseAddress --sender your-account.near
pnpm --filter @payminto/near-addons exit quote ... --mainnet --save quote.json
pnpm --filter @payminto/near-addons exit status --deposit <depositAddress> --watch
```

`quote` is dry by default and creates no deposit address.
`--mainnet` asks for a real deposit address, reads the token registration read-only, and prints the transaction for the human, as wallet JSON and as near-cli-rs commands.
The CLI holds no key.

Verified live (read-only), 2026-11-10:

- `GET /v0/tokens`: 216 tokens; native USDC on NEAR is `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` with 6 decimals.
- `POST /v0/quote` with `dry: true`, 10 USDC on NEAR to USDC on Base, through the CLI: the signature verifies against the published manager key, and a changed field fails.
- `GET /v0/status` for an unknown address returns 404 with a message, which the client surfaces as `OneClickError`.
- The live API answers a quote with HTTP 201, not 200, so the client accepts any 2xx.
- A dry quote whose `refundTo` was `payminto-merchant.near`, a named account that does not exist on mainnet (checked with `view_account`), failed with a 400 "Internal server error", while a 64-hex implicit account succeeded.
  Use a real, existing NEAR account as `--sender`.
- `storage_balance_bounds` on mainnet USDC returns `min` = `max` = 0.00125 NEAR, and `storage_balance_of` for an unregistered account returns `null`.

Unit-tested only:

- The wet-quote path, `exitPlan` and the `--mainnet` CLI output use a synthetic wet quote: the live dry quote with a deposit address added, signed by a test key.
  No wet quote was requested live, because it creates a real deposit address.
- `/v0/deposit/submit` and every non-404 status response are synthetic, shaped from the OpenAPI document.
- The tests fail if any code path calls a JSON-RPC method that submits a transaction.

Human step, NEAR mainnet, real funds:

1. Hold USDC on NEAR mainnet in your own account.
   The Payminto hub on testnet pays out Circle testnet USDC, which 1Click cannot swap; mainnet funds never reach a testnet Budget and testnet payouts never reach 1Click.
2. Run `quote ... --mainnet --save quote.json` and read the printed amounts and deadline.
3. Sign and send the printed transaction from your own wallet: `storage_deposit` if printed, then `ft_transfer` to the deposit address.
4. Optionally run `submit --deposit <address> --tx <hash> --sender <you>`, then `status --deposit <address> --watch` until `SUCCESS` or `REFUNDED`.

Risks: the deposit address and price come from 1Click, a third party; the signature check proves origin, not fairness.
The docs say an unauthenticated quote pays an extra 25 bps; live quotes on 2026-11-10 showed 1 bp on stablecoin routes and 20 bps on others.
Set `ONECLICK_API_KEY` to a partner JWT if you have one, and read the fee from each quote.

### 1b. Any-chain checkout: paying into NEAR

`src/intents/checkout.ts` is the other direction, used by the node's any-chain checkout (docs/DEVELOPERS.md, "Any-chain checkout"): a buyer pays from another chain and the merchant receives exactly the invoice amount of native USDC on NEAR in its own account.

- `payInQuoteRequest` asks for `EXACT_OUTPUT` of `nep141:17208628...a1` (native USDC on NEAR, 6 decimals), `depositType` and `refundType` `ORIGIN_CHAIN`, `recipientType: DESTINATION_CHAIN`.
- `CHECKOUT_ORIGINS` are USDC on Base, Ethereum, Arbitrum, Solana and Polygon, USDT on Ethereum, and ETH on Base and Ethereum, with asset ids and decimals from the live token list.
  Not Bitcoin (the quote signature check fails on Bitcoin quotes today), Tron or BNB (high minimums), and no memo chain.
- `isOriginAddress` checks a refund or deposit address per chain: EVM addresses (not the zero address) and Solana base58 keys (not the system program), the forms the live API accepted and refused.
- `checkPayInQuote` returns the refusals that keep a deposit address from being shown: a signature that is not 1Click's, an echoed request that differs from what was asked, `minAmountOut` other than the invoice amount, a recipient other than the merchant's account, a missing or malformed deposit address, a memo, a deadline in the past.
- `mapStatus` turns a 1Click status into a checkout state; `feeLines` computes the deposit screen's numbers from the signed quote; `quoteErrorReason` turns 1Click's refusals into plain words.
- `src/intents/fake-server.ts` (export `@payminto/near-addons/intents/fake-server`) is a fake 1Click server for tests and `pnpm local`.
  It answers the recorded live requests with the same status codes, keys and messages (a contract test checks this), signs with a public test key that can never pass as 1Click's, and simulates the swap from deposits reported on its `/_fake/` control routes.
  Its `deliver` hook lets `pnpm local` deliver real mock USDC on the local chain.

Verified live (read-only), 2026-11-10: the dry quotes in `test/fixtures/oneclick/pay-in/` (5 USDC delivered to a NEAR account, paid with USDC on Base, Ethereum and Solana and ETH on Base) verify against the published manager key and pass `checkPayInQuote`; the recorded refusals (Tron minimum, Bitcoin bridge minimum, invalid refund address, missing named recipient, past deadline) are the fake server's contract.
Unit-tested only: every wet quote, status and deposit flow; no wet quote was ever requested live.

`quote-in` shows live dry quotes for the demo.
It is always dry: it refuses `--mainnet` and creates no deposit address.

```sh
pnpm --filter @payminto/near-addons intents quote-in --from base:USDC --usdc 5 --merchant <existing mainnet account>
pnpm --filter @payminto/near-addons intents quote-in --from all --usdc 5 --merchant <existing mainnet account>
```

It prints what the buyer sends, what the merchant receives, the swap cost, the price buffer, the refund and delivery fees, the time estimate, whether the signature is 1Click's and whether the checks passed, then the exact request and response.
`--refund-to` sets the refund address (default a placeholder of the right format, which a dry quote needs), and `--slippage` the basis points (default 10 for stablecoins, 100 for ETH).
Use a NEAR mainnet account that exists: 1Click answers a named account that does not with a 400 "Internal server error".

## 2. DAO owner with Sputnik DAO v2

`src/dao/sputnik.ts`.
A Sputnik DAO owns a Budget: members vote it into existence, fund it, move earned credit into it, and revoke it.
The hub makes the predecessor of `open_budget` the owner, so when the DAO executes the call the DAO is the owner, with no change to the hub.

What it does:

- `functionCallKind` turns a `WalletTx` from `@payminto/chain` `actions.ts` into a `FunctionCall` proposal kind: one receiver, actions in order, args as base64 JSON, deposit and gas as decimal strings.
  It refuses more than 250 Tgas of inner gas, because the approving vote runs the proposal inside its own 300 Tgas `act_proposal`.
- `addProposalTx` wraps a proposal in `add_proposal` with the DAO's `proposal_bond` attached exactly, since the DAO panics with `ERR_MIN_BOND` on any other amount.
  `readProposalBond` reads the bond read-only from `get_policy`.
- `voteTx` builds `act_proposal` with `id`, `action` and the proposal `kind`.
  Current Sputnik code (PR #217, March 2025) requires the kind and refuses a vote whose kind differs from the stored one, so a member votes on exactly what they read; older DAO code ignores the extra field.
- Payminto proposals, each using the `actions.ts` builder for the inner call:
  - `openBudgetProposal`: `open_budget` on the hub with the storage deposit paid from the DAO's NEAR, and the Budget id the hub will return written into the description.
    The terms' owner must be the DAO.
  - `depositProposal`: `ft_transfer_call` of the DAO's tokens to the hub with a `budget` msg and 1 yoctoNEAR.
    The hub accepts it only from the Budget owner and raises escrow, never cap.
  - `revokeProposal` and `reclaimProposal`: no deposit.
  - `fundFromCreditProposal`: `fund_from_credit` with exactly 1 yoctoNEAR, which the DAO attaches from its own balance when the proposal runs.
- `decodeKind` and `auditBudgetProposal` decode a proposal read from chain and check receiver, method, deposit and the deposit target, so a member can verify before voting.

Opening a Budget is two proposals, as for any owner: `open_budget` and then the deposit, because the deposit goes to the token contract and a Sputnik `FunctionCall` proposal has one receiver.
The task brief described `open_budget` as going through `ft_transfer_call`; the hub does not work that way, since `open_budget` is a payable call on the hub and only the deposit is an `ft_transfer_call`.

Verified live (read-only), 2026-11-10:

- On testnet the Sputnik v2 factory is `sputnik-v2.testnet` and DAOs are named `<name>.sputnik-v2.testnet`.
  `sputnik-dao.testnet` has no contract code (`CodeDoesNotExist`), so a `*.sputnik-dao.testnet` DAO cannot be created through it; mainnet uses `sputnik-dao.near`.
- A live testnet `FunctionCall` proposal from `get_proposals` has exactly our keys, base64 args, and decimal-string deposit and gas.
  It is recorded in `test/fixtures/sputnik/` as a shape reference.
- `get_policy` on that DAO returns `proposal_bond` as a yoctoNEAR string (1 NEAR there), and `version` returns `"2.0.0"`.

Unit-tested only: every builder, the vote shape, the gas cap and the audit.
No proposal was added and no vote was cast.

Human steps, testnet:

1. Create a DAO through `sputnik-v2.testnet` (for example in a Sputnik UI) with the members as council, and fund it with NEAR for the bond, storage and gas, and with testnet USDC registered at the token.
2. A member sends the `add_proposal` transaction from `openBudgetProposal`, attaching the bond.
3. Council members each send `voteTx(dao, id, kind)`; the vote that reaches the threshold runs `open_budget`.
4. Repeat for `depositProposal`.
   Later, `revokeProposal`, `reclaimProposal` and `fundFromCreditProposal` work the same way.

Risks: a DAO's policy decides who may propose and vote on `call` proposals; check `get_policy` before relying on it.
A failed inner call leaves the proposal `Failed`, and a member can retry it with the `Finalize` action.

## 3. Named agent sub-accounts

`src/subaccounts/index.ts`.
`agent-1.acme.testnet` gives an agent a readable identity for the dashboard and, for a selling agent, a payee account that receives payouts.

What an agent actually calls on chain decides its key:

| Role | Calls on chain | Agent key on the sub-account |
|---|---|---|
| Buyer | Nothing. It pays with off-chain vouchers signed by the bare ed25519 key named in the Budget terms, and cannot revoke on chain. | None |
| Seller (payee) | `settle_own`, the escape hatch if the node dies, and `payout`, which anyone may call. | One function-call key: receiver the hub, methods `settle_own` and `payout`, a finite gas allowance (0.25 NEAR by default) |

What it does:

- `agentAccountId(label, owner)` builds `<label>.<owner>` and refuses nested labels, implicit owners and ids over 64 characters, because only a parent can create its direct sub-accounts.
- `createAgentAccountTx` builds the one transaction the owner signs: `CreateAccount`, `Transfer` of the initial balance, the owner's own public key as the only full-access key, and for a seller the agent's function-call key.
  Actions use the `@near-wallet-selector/core` shape (`CreateAccount`, `Transfer`, `AddKey` with `"FullAccess"` or `{ receiverId, allowance, methodNames }`).
- `registerAgentAtTokenTx` registers the sub-account at the settlement token (NEP-145), paid by the owner, so `payout` can deliver to it.
- `rotateAgentKeyTx` and `revokeAgentKeyTx` replace or remove the agent key, signed by the owner's key on the sub-account.
- `auditAgentKey` checks a key read with `view_access_key` against the role: no full access, receiver the hub, no method outside the role, a finite allowance.

Security model:

- The agent never holds a full-access key, and a buyer agent holds no access key at all: its only power is signing vouchers within its Budget, and the node and hub enforce the Budget.
- Function-call keys cannot attach a deposit, so a seller key cannot call `fund_from_credit` (1 yoctoNEAR), cannot call `ft_transfer` on the token (1 yoctoNEAR), cannot transfer NEAR, and cannot add keys.
  Earned credit and paid-out tokens therefore stay out of the agent's reach; only the owner's full-access key can move them.
- `settle_own` costs no deposit while the Budget's prepaid `settle_own` entries last; after that it needs a deposit, so a seller key can no longer use it and the owner key must.
- A leaked seller key can at worst spend its gas allowance on `settle_own` and `payout`, which only move value toward the rightful payees.
- An `AddKey` with allowance `0` is a zero gas budget, not unlimited, so the helper refuses it; an omitted allowance would be unlimited, so the helper always sets one.
- The sub-account is a separate account: the owner controls it only through the full-access key it adds at creation.
  The owner should keep that key offline and use a different key from the agent's.
- The voucher key named in a Budget's `agent_pk` is not an access key and is never added to any account.

Verified live (read-only), 2026-11-10: the `view_access_key_list` permission shape (`{"FunctionCall":{"allowance","method_names","receiver_id"}}`), recorded in `test/fixtures/rpc/testnet-function-call-key.live.json` and used by the audit tests.

Unit-tested only: every builder and the audit.
No account was created.

Human step, testnet: the owner signs `createAgentAccountTx` from the owner account (only the parent can create the sub-account), then, for a seller, `registerAgentAtTokenTx`.

## 4. Gasless actions with NEP-366 meta transactions

`src/gasless/`.
An owner with no NEAR for gas signs a delegate action off-chain, and a relayer wraps it in its own transaction and pays the gas.
The hub sees the owner as the predecessor, so `revoke_budget` works unchanged.

What it does:

- `revokeBudgetDelegate`, `reclaimDelegate` and `payoutDelegate` build a `DelegateAction` from the `actions.ts` builders.
  All three calls carry no deposit.
- `encodeDelegateAction`, `delegateSigningPayload` and `delegateHash` produce the Borsh encoding and the NEP-461 hash the owner's key signs: sha256 of the u32 tag 2^30 + 366 (1073742190) followed by the DelegateAction Borsh.
- `signDelegate` signs with a 32-byte ed25519 seed held in Node, for tests and server-side owners; browser wallets sign delegates themselves.
  `verifySignedDelegate` checks the signature as the runtime does.
- `encodeSignedDelegate`, `decodeSignedDelegate` and `relayRequestBody` produce and parse the `SignedDelegateAction` Borsh, and the `{ "signedDelegate": "<base64>" }` body of the relayer in the NEAR docs tutorial.
  `encodeDelegateTxAction` gives `Action::Delegate` (enum index 8), the one action of the relayer's outer transaction, whose receiver is the owner.
- `delegateParams` reads the key's nonce and the final block height read-only and returns `nonce + 1` and a 120-block validity window.
- `checkRelayPolicy` is what a relayer runs before paying: a valid signature, the receiver is our hub, only `revoke_budget`, `reclaim` and `payout` by default, zero deposit, a gas cap, not expired, and not valid too far ahead.

Only version 1 (`Action::Delegate`) is built.
nearcore also has `Action::DelegateV2` (index 14, NEP-611 gas keys) with a different tag; it is not used here.

Verified live (read-only), 2026-11-10: `delegateParams` against `https://rpc.testnet.near.org` read a real key's nonce through `view_access_key` and the final height through `block`, and returned `null` for a key the account does not have.

Unit-tested only, with vectors:

- The encoder reproduces nearcore's hard-coded `DELEGATE_ACTION_HEX` test vector byte for byte, and decodes it back.
- near-kit 0.20.2, an independent implementation, decodes our `SignedDelegateAction` to the same fields and builds the same signing payload from them; both use the tag 1073742190.
- A `revoke_budget` delegate is pinned field by field: lengths, enum index, 30 Tgas as u64, zero deposit as u128, nonce, height and key.
- Tampering with any field breaks the signature, and the relayer policy refuses other receivers, other methods, deposits, expired and far-future delegates, bad signatures and non-call actions.

No delegate was relayed, and this package contains no relayer that signs or sends.

Human steps, testnet:

1. Run a relayer: a funded testnet account and a small server as in the NEAR docs tutorial, with `checkRelayPolicy` gating `/relay` to the hub.
2. The owner signs `revokeBudgetDelegate(...)` with their key (`signDelegate` or a wallet's delegate signing) and posts `relayRequestBody(...)` to the relayer.
3. The relayer sends one transaction to the owner's account with the `Delegate` action.

The owner's account must exist and its key must be a full-access key or a function-call key for the hub that allows `revoke_budget`.
Per NEP-366, a delegate signed by a function-call key may hold only one `FunctionCall` action, to that key's receiver, with a method the key allows.
The NEAR docs disagree on who pays an inner deposit, so the policy sponsors zero-deposit calls only.

## 5. Omni Bridge

`src/bridge/omni.ts`.
A thin, honest helper: route checks, fee and status reads, and the NEAR-side transaction for a transfer out of NEAR.

What is real today, checked with read-only views on 2026-11-10:

- The NEAR-side bridge is `omni.bridge.near` on mainnet and `omni.n-bridge.testnet` on testnet, both live, both using Chain Signatures (`get_mpc_account` returns `v1.signer` and `v1.signer-prod.testnet`).
- **Native Circle USDC on NEAR has no Omni Bridge route.** `get_token_address` for `17208628...36133a1` returns `null` for Base and every other destination checked.
  Ethereum USDC arrives on NEAR as a separate bridged token, `a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near`, which maps back to Ethereum only.
- On testnet, Circle testnet USDC (the hub's settlement token) has no route either.
- So Omni Bridge cannot fund a Budget directly: a bridged token is not the hub's settlement token, and the hub accepts only its own token.
  Funding a Budget from another chain needs a swap into the settlement token, for example through 1Click (module 1) on mainnet.
  Paying hub payouts out to another chain is also a 1Click job, not an Omni one.
- The bridge's `init_transfer` does not check the route, and signing later panics with `FailedToGetTokenAddress`, so a transfer of an unroutable token can be accepted and then never complete.

What it does:

- `tokenRoute` reads `get_token_address` read-only; `planOutbound` refuses any token without a route before it builds anything.
- `OmniApi` reads the indexer API with GETs only: `transferFee` (`/api/v3/transfer-fee`), `transferStatus` (`/api/v4/transfers/transfer/status`) and `transfer` (`/api/v4/transfers/transfer`).
  The fee endpoint quotes even an unroutable transfer, so a fee is never treated as proof of a route.
- `planOutbound` takes the fee from the indexer, reads the signer's bridge storage balance and the bridge's storage requirements, and returns a `storage_deposit` on the bridge when needed and the `ft_transfer_call` with `{ recipient, fee, native_token_fee, msg }`, 300 Tgas and 1 yoctoNEAR, as the official bridge SDK builds it.
- `omniAddress` formats `<chain>:<address>` with the contract's chain prefixes.

Verified live (read-only): `planOutbound` against mainnet refused native USDC to Base, and for `wrap.near` to Base returned the route `base:0x02eea354d135d1a912967c2d2a6147deb01ef92e` and a quoted native fee; `transferStatus` returned `["Settled"]` for a known transfer.
The recorded views and API answers are in `test/fixtures/omni/`.

Unit-tested only: the exact transactions, the storage arithmetic and both fee modes.
Not built: the other-chain side of a transfer into NEAR (an EVM or Solana transaction on that chain's bridge contract) and finalization; both belong to the user's wallet or a relayer on that chain.
Nothing was bridged.

Human step: none for Payminto today, because no Payminto token has a route.
For a token that has one, sign the planned `storage_deposit` (if any) and then `ft_transfer_call` from your own wallet, and read `transferStatus` until `Settled`.

## 6. Chain Signatures payout

`src/chainsig/`.
A NEAR account controls an EVM address through the MPC signer, and pays a merchant in USDC on an EVM chain from it.
This works outside the hub: it signs for an EVM address the NEAR account controls and never touches escrow, so funding that address with USDC on the EVM chain is a separate step.

What it does:

- `MPC_SIGNER` holds the contract ids, `v1.signer` on mainnet and `v1.signer-prod.testnet` on testnet, and their secp256k1 root keys as the contracts return them.
- `deriveTweak` and `deriveSecp256k1Key` derive the key the network signs with for a predecessor and path: tweak = SHA3-256 of `near-mpc-recovery v0.1.0 epsilon derivation:<predecessor>,<path>` read big-endian, and key = root + tweak * G.
  The EVM address is the last 20 bytes of keccak256(X || Y), with the EIP-55 checksum.
- `readDerivedKey` reads the contract's own `derived_public_key` view, read-only, for a cross-check.
- `signRequestTx` builds `sign` with `{ request: { payload_v2: { Ecdsa: <hex> }, path, domain_id: 0 } }`, 1 yoctoNEAR and 300 Tgas, and refuses a payload at or above the curve order, which the contract would reject.
  The deposit cannot come from a function-call key, so a full-access key or a wallet confirmation must sign it.
- `evmPayoutRequest` builds an EIP-1559 ERC-20 `transfer` from the derived address, its signing hash, and the `sign` call for that hash.
- `parseMpcSignature`, `verifyMpcSignature` and `assembleEvmPayout` read the `Secp256k1` response (`big_r.affine_point`, `s.scalar`, `recovery_id`, with or without the `scheme` tag), check that it recovers to the derived key, and produce the raw signed transaction.

Verified live (read-only), 2026-11-10:

- Both contracts answer `version` with `"3.18.0"` and `public_key` with the root keys in `MPC_SIGNER`.
- `derived_public_key` for (`alice.testnet`, `ethereum-1`) and (`merchant.payminto.testnet`, `payminto-payout-1`) on testnet, and (`alice.near`, `ethereum-1`) on mainnet, equals our local derivation exactly.
  The views are recorded in `test/fixtures/chainsig/mpc-keys.live.json`.

Unit-tested only, with vectors:

- All 16 tweaks of near/mpc's `derive_tweak__has_not_changed` snapshot.
- The EVM address, ERC-20 calldata, unsigned EIP-1559 bytes and signing hash equal viem's output for the same inputs, and RLP follows the spec examples.
- An end-to-end payout with a **simulated** MPC signer, a local root secret whose derived secret is root + tweak: the assembled transaction recovers, through viem, to the derived address, and a signature for another path or account is refused.
- The live `sign` response was not observed; its shape comes from the contract source (`SignatureResponse` with `#[serde(tag = "scheme")]`).

Nothing was signed by the MPC network and nothing was broadcast.

Human steps, testnet:

1. Pick the NEAR account and path, and print the derived address with `deriveSecp256k1Key(MPC_SIGNER.testnet.rootKey, account, path)`.
2. Fund that address on Base Sepolia with Base Sepolia ETH for gas and USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`).
3. Build `evmPayoutRequest` with the address's current nonce and fees, and send `signTx` from the NEAR account's own wallet.
4. Pass the returned signature to `assembleEvmPayout`, and broadcast the raw transaction on Base Sepolia.

Risks: the MPC response format can change with contract upgrades, so `assembleEvmPayout` always verifies recovery before returning bytes.
Anyone who can make the NEAR account call `sign` for that path controls the EVM address, so the account's full-access key is the security boundary.
