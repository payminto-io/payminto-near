# Sources

Every fact this package relies on, with where it was checked.
All pages and files were read on 2026-11-10.
"Live view" means a read-only RPC `query` against the public endpoint, with no key.

## Shared

- NEP-145 storage management, including the rule that `registration_only=true` refunds the full deposit for an already registered account: https://github.com/near/NEPs/blob/master/neps/nep-0145.md
- NEP-141 fungible tokens: https://github.com/near/NEPs/blob/master/neps/nep-0141.md
- near-cli-rs command syntax (`contract call-function as-transaction ... sign-as ... network-config ... sign-with-keychain send`): https://docs.near.org/tools/cli
- Payminto hub methods and the 1 yoctoNEAR rule on `fund_from_credit`: `contracts-near/src/lib.rs` and `packages/chain/src/actions.ts` in this repository.

## 1. Intents exit with 1Click

- 1Click documentation index: https://docs.near-intents.org/llms.txt
- OpenAPI document for v0 (request and response schemas, status enum, `dry` semantics, `customRecipientMsg` warning): https://1click.chaindefuser.com/docs/v0/openapi.yaml
- End-to-end flow (tokens, quote, send to `depositAddress`, optional `/v0/deposit/submit`, `/v0/status`): https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request.md
- API keys, `X-API-Key` header and the extra 25 bps without one: https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication.md and https://docs.near-intents.org/resources/fees.md
- Quote signature scheme (`json-stable-stringify`, SHA-256, Base58): https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature.md
- Manager public key and the exact signed field selection: `@defuse-protocol/one-click-sdk-typescript` 0.1.26, `dist/index.mjs`, section `src/quote-signature.ts`, https://unpkg.com/@defuse-protocol/one-click-sdk-typescript@0.1.26/dist/index.mjs
- NEAR origin deposit as `ft_transfer` with 1 yoctoNEAR, and `nearSenderAccount` on submit: https://github.com/near/agent-skills/blob/main/skills/near-intents/rules/deposit-near.md
- NEAR Intents has no testnet: design spec `docs/superpowers/specs/2026-11-10-near-clearing-design.md`, Constraints.
- Live checks:
  - `GET https://1click.chaindefuser.com/v0/tokens`, recorded in `test/fixtures/oneclick/tokens.live.json` (trimmed).
  - `POST https://1click.chaindefuser.com/v0/quote` with `dry: true`, recorded in `test/fixtures/oneclick/quote-dry.live.json` and `quote-error-refund.live.json`.
  - `GET https://1click.chaindefuser.com/v0/status?depositAddress=<zeros>`, recorded in `test/fixtures/oneclick/status-not-found.live.json`.
  - Live views on `https://rpc.mainnet.near.org`: `ft_metadata`, `storage_balance_bounds` and `storage_balance_of` on `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`, recorded in `test/fixtures/rpc/`.

## 2. DAO owner with Sputnik DAO v2

- `ProposalKind::FunctionCall`, `ActionCall` (`deny_unknown_fields`, `args: Base64VecU8`, `deposit: NearToken`, `gas: Gas`), `ProposalInput`, `add_proposal` (`ERR_MIN_BOND` unless the deposit equals `proposal_bond`), `act_proposal(id, action, proposal, memo)` (`ERR_WRONG_KIND`) and proposal execution: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao2/src/proposals.rs
- History of `act_proposal` taking the kind, PR #217 "Act proposal with kind" (2025-03-17) and PR #221 "Forbid unused arguments in act_proposal function" (2025-03-23): https://github.com/near-daos/sputnik-dao-contract/commits/main/sputnikdao2/src/proposals.rs
- Policy, roles and `proposal_bond`: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao2/src/policy.rs
- README with `add_proposal` and `act_proposal` examples on `sputnik-v2.testnet`: https://github.com/near-daos/sputnik-dao-contract/blob/main/README.md
- Factory methods `get_dao_list`, `get_daos`, `create`: https://github.com/near-daos/sputnik-dao-contract/blob/main/sputnikdao-factory2/src/lib.rs
- Live views on `https://rpc.testnet.near.org`:
  - `sputnik-v2.testnet` `get_dao_list` (119 DAOs, all `*.sputnik-v2.testnet`).
  - `sputnik-dao.testnet` returns `CodeDoesNotExist`.
  - `get_proposals`, `get_policy` and `version` on a testnet DAO, recorded in `test/fixtures/sputnik/testnet-functioncall-proposal.live.json`.
- Live view on `https://rpc.mainnet.near.org`: `sputnik-dao.near` `get_dao_list` answers with `*.sputnik-dao.near` DAOs.

## 3. Named agent sub-accounts

- Sub-account rules (only the parent creates its sub-accounts; the parent has no control afterwards): https://docs.near.org/protocol/accounts-contracts/account-id
- Access keys: function-call keys call one receiver, optional method list, cannot attach NEAR; an `AddKey` allowance of `0` is a zero budget and an omitted one is unlimited: https://docs.near.org/protocol/access-keys
- Wallet action shapes `CreateAccount`, `Transfer`, `AddKey` (`"FullAccess"` or `{ receiverId, allowance, methodNames }`) and `DeleteKey`: https://github.com/near/wallet-selector/blob/main/packages/core/src/lib/wallet/transactions.types.ts
- Storage staking and the cost of a new account: https://docs.near.org/protocol/storage/storage-staking
- What agents call on the hub: `contracts-near/src/lib.rs` (`settle_own`, `payout`, `fund_from_credit` with `assert_one_yocto`) and the design spec, "Signatures and proofs" and "Calls made by the team".
- Live view on `https://rpc.testnet.near.org`: `view_access_key_list` for `near-examples.testnet`, one function-call key recorded in `test/fixtures/rpc/testnet-function-call-key.live.json`.

## 4. Gasless actions with NEP-366

- NEP-366 specification (DelegateAction fields, relayer flow, validation rules and errors): https://github.com/near/NEPs/blob/master/neps/nep-0366.md
- nearcore `DelegateAction`, `SignedDelegateAction`, `Action::Delegate = 8`, `Action::DelegateV2 = 14` and the `DELEGATE_ACTION_HEX` test vector: https://github.com/near/nearcore/blob/master/core/primitives/src/action/delegate.rs
- nearcore `Action` enum indices and `FunctionCallAction { method_name, args, gas, deposit }`: https://github.com/near/nearcore/blob/master/core/primitives/src/action/mod.rs
- nearcore NEP-461 tags (`MIN_ON_CHAIN_DISCRIMINANT = 1 << 30`, `NEP_366_META_TRANSACTIONS = 366`) and `get_nep461_hash`: https://github.com/near/nearcore/blob/master/core/primitives/src/signable_message.rs
- Meta transactions overview: https://docs.near.org/protocol/transactions/meta-tx
- Relayer tutorial, including the `{ "signedDelegate": base64(borsh(SignedDelegate)) }` request and gating: https://docs.near.org/web3-apps/tutorials/meta-transactions
- near-api-js meta transaction guide in the NEAR agent skills: https://github.com/near/agent-skills/blob/main/skills/near-api-js/references/meta_transactions.md
- Cross-check implementation: near-kit 0.20.2 (`DELEGATE_ACTION_PREFIX`, `serializeDelegateAction`, `decodeSignedDelegateAction`), already used by `@payminto/chain`.
- Live reads on `https://rpc.testnet.near.org`: `view_access_key` and `block` through `delegateParams`.

## 5. Omni Bridge

- Omni Bridge overview, how it works and implementation (a transfer with zero fee may never be signed or finalized): https://docs.near.org/chain-abstraction/omnibridge/overview, https://docs.near.org/chain-abstraction/omnibridge/how-it-works and https://docs.near.org/chain-abstraction/omnibridge/implementation
- Contract ids, EVM bridge addresses and the indexer API base URLs: https://github.com/Near-One/omni-bridge/blob/main/README.md
- `ft_on_transfer`, `init_transfer` (no route check, storage charged to the signer, `fee < amount`), signing (`FailedToGetTokenAddress`) and `get_token_address`: https://github.com/Near-One/omni-bridge/blob/main/near/omni-bridge/src/lib.rs
- Storage methods `storage_deposit`, `required_balance_for_account` and `required_balance_for_init_transfer`: https://github.com/Near-One/omni-bridge/blob/main/near/omni-bridge/src/storage.rs
- `InitTransferMsg`, `ChainKind` and the `OmniAddress` prefixes: https://github.com/Near-One/omni-bridge/blob/main/near/omni-types/src/lib.rs
- The NEAR-side transfer as the official SDK builds it (`ft_transfer_call`, `memo: null`, `msg` JSON, 300 Tgas, 1 yoctoNEAR): https://github.com/Near-One/bridge-sdk-js/blob/main/packages/near/src/builder.ts and https://github.com/Near-One/bridge-sdk-js/blob/main/packages/near/src/types.ts
- Indexer API schema (`/api/v3/transfer-fee`, `/api/v4/transfers/transfer`, `/api/v4/transfers/transfer/status`, `TransferStatusV4`): https://near-one.github.io/bridge-indexer-rs/omni-indexer-endpoint/openapi.json
- Live views on `https://rpc.mainnet.near.org` and `https://rpc.testnet.near.org`: `get_token_address`, `required_balance_for_account`, `required_balance_for_init_transfer` and `get_mpc_account`, recorded in `test/fixtures/omni/bridge-views.live.json`.
- Live GETs on `https://mainnet.api.bridge.nearone.org`: two fee quotes, one transfer and its status, recorded in `test/fixtures/omni/`.

## 6. Chain Signatures

- Contract ids `v1.signer` and `v1.signer-prod.testnet`: https://docs.near.org/chain-abstraction/chain-signatures/implementation and https://github.com/near/mpc/blob/main/crates/contract/README.md
- `sign` request shape (`payload_v2` with `Ecdsa` hex, `path`, `domain_id`), the 1 yoctoNEAR deposit, the gas requirement and the response fields: https://github.com/near/mpc/blob/main/crates/contract/README.md, `crates/contract/src/api/sign.rs`, `crates/near-mpc-crypto-types/src/sign.rs` and `crates/near-mpc-crypto-types/src/primitives.rs`
- The payload must be a valid scalar (`k256::Scalar::from_repr`, so below the curve order n): `crates/contract/src/api/sign.rs` in https://github.com/near/mpc
- Tweak derivation (prefix, `<predecessor>,<path>`, SHA3-256) and its snapshot test: https://github.com/near/mpc/blob/main/crates/near-mpc-crypto-types/src/kdf.rs and its `snapshots/` folder
- Derived key = root + tweak * G: https://github.com/near/mpc/blob/main/crates/contract/src/crypto_shared/kdf.rs
- Root key text form `secp256k1:` + base58 of 64 bytes: `crates/near-mpc-crypto-types/src/crypto.rs` in https://github.com/near/mpc
- JavaScript reference for derivation, the EVM address and the 300 Tgas `sign` call: https://github.com/NearDeFi/chainsig.js (`src/utils/cryptography.ts`, `src/chain-adapters/EVM/EVM.ts`, `src/contracts/ChainSignatureContract.ts`)
- EIP-1559 transaction encoding: https://eips.ethereum.org/EIPS/eip-1559, RLP: https://ethereum.org/developers/docs/data-structures-and-encoding/rlp, EIP-55 checksums: https://eips.ethereum.org/EIPS/eip-55
- Cross-check implementation: viem 2.57.10 (`serializeTransaction`, `encodeFunctionData`, `publicKeyToAddress`, `recoverTransactionAddress`), already in this workspace.
- USDC on Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`: https://developers.circle.com/stablecoins/usdc-contract-addresses
- Base Sepolia chain id 84532: https://docs.base.org/base-chain/quickstart/connecting-to-base
- Live views: `version`, `public_key` and `derived_public_key` on `v1.signer-prod.testnet` and `v1.signer`, recorded in `test/fixtures/chainsig/mpc-keys.live.json`.
