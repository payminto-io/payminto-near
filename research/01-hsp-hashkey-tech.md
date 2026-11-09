# 01 - HSP and HashKey Chain: builder-grade technical brief

Research date: 2026-10-24.
Target: HashKey Chain Horizon Hackathon, India/Mumbai edition, track "Agent Payments & A2A Settlement".
Every fact below carries a source.
Facts marked "(verified live)" were checked by me against the chain or an API on 2026-10-24.
Facts marked "(third-party)" come from other hackathon teams' public repos, not from HashKey, and should be treated as secondary evidence.

---

## 0. Read this first: status as of 2026-10-24

The official HSP developer guide says the SDK repo link, Coordinator URL, API key and faucet are handed out by the organizer "once the sandbox has been deployed, typically a few days later".
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 4 and 12), mirrored at https://hashfans.io/hsp and https://hashfans.io/docs?id=HSP.

The SDK repo named everywhere, `github.com/project-hsp/hsp`, is not public today.
`git clone https://github.com/project-hsp/hsp` returns "Repository not found", and the `project-hsp` GitHub org exists but reports `public_repos: 0` (verified live via `gh api users/project-hsp`).

The previous edition's sandbox Coordinator, `https://hsp-hackathon.hashkeymerchant.com`, no longer resolves in DNS (verified live: `getaddrinfo ENOTFOUND`).
That host was used by Japan-edition teams in June and July 2026 (third-party: https://github.com/tang-vu/tessera/blob/main/README.md, https://github.com/xDzaky/shieldpay-hsp/blob/main/MASTER_URLS.md).

An India-edition team in the same track reported the same thing on 2026-10-23: the HSP SDK and its EIP-712 type definitions are not published and the sandbox Coordinator was not online (third-party: https://github.com/swiftbotlab/hsk-meter/blob/main/README.md, section "HSP: what follows the published spec, and what is still draft").

Action item: ask the organizers on the DoraHacks page or in HashKey Chain Discord (https://discord.com/invite/V7kypNm9cS) / Telegram (https://t.me/HashKeyChainHSK) for `<REPO_URL>`, `<COORDINATOR_URL>`, `<API_KEY>`, `<FAUCET_URL>`, `<FACILITATOR_URL>` and the pinned adapter address for this edition.
Until then, build against the documented wire format (section 2.6 below) so the swap to the official SDK is mechanical.

I could not read the DoraHacks page itself: https://dorahacks.io/hackathon/hskchainindia/detail returns HTTP 405 behind an AWS WAF human-verification challenge, which I did not attempt to bypass.
So track rules, dates and judging text in this brief do not come from DoraHacks; they come from the task description.

---

## 1. What HSP is

### 1.1 Name and purpose

HSP stands for HashKey Settlement Protocol.
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (section 1).

The guide defines it as a verifiable settlement layer for stablecoin payments where every payment carries cryptographic evidence that anyone can re-check, instead of trusting a processor's "paid" flag.
Source: same file, section 1.

HSP is zero-custody: the payer's own wallet broadcasts the on-chain transfer and no HSP service ever holds funds.
Source: same file, sections 1 and 11.

HSP is pre-1.0 and the wire format may change between releases.
Source: same file, last line.

### 1.2 The three moves

1. Intent: the payer signs a Mandate, an EIP-712 message saying pay this amount of this token to this recipient on this chain, meeting these requirements.
2. Settlement: the payer's own wallet broadcasts the on-chain transfer.
3. Verification: a verifier independently checks the Receipt against the Mandate and a pinned trust policy; "ACCEPT means ship".

Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (section 1).

### 1.3 Wire objects

| Object | Signed by | Meaning |
|---|---|---|
| Mandate | payer | I intend to pay X to Y and I require capabilities Z |
| Receipt | adapter | I observed the settlement that satisfies this mandate |
| Attestation | issuer | I vouch that the subject is KYC'd / not sanctioned / ... |

Source: same file, section 1.

The single acceptance rule: a verifier ACCEPTs iff `requiredCapabilities ⊆ satisfiedCapabilities`.
Source: same file, section 1.

Capabilities are typed strings `verb:object:version`, with verbs `proves:` (structural proof, e.g. `proves:settlement-verified`) and `attests:` (issuer vouches, e.g. `attests:kyc`, `attests:sanctions`).
A public payment requires the empty set; a compliant payment requires `attests:kyc` plus `attests:sanctions`.
Source: same file, section 5.

### 1.4 Architecture: on-chain vs off-chain

On-chain:
- The settlement itself is a plain ERC-20 `transfer` from the payer wallet (scenario "evm-transfer"), or an EIP-3009 authorization settled by an x402 facilitator (scenario "x402").
- The guide requires "wallet-settling": `Transfer.from` must equal the mandate signer.
- The EIP-712 domain carries a `verifyingContract` per chain, served by the Coordinator at `GET /chains` (third-party: https://github.com/tang-vu/tessera/blob/main/agent/src/hsp/hsp-client.ts, https://github.com/thisyearnofear/diversify/blob/main/packages/shared/src/services/hsp/hsp-settlement.service.ts).
- The official repo reportedly contains a `contracts/` folder (third-party listing: https://github.com/xDzaky/shieldpay-hsp/blob/main/MASTER_URLS.md, item 1.12); I could not inspect it because the repo is not public.

Off-chain:
- Coordinator: the hosted hub and "the only service you talk to over the network".
  It registers mandates, observes on-chain settlement, runs the verifier, stores the (mandate, receipt, attestations) triple, and serves status, a web Explorer and a developer portal.
  It signs observations with an adapter key and cannot move funds.
- Adapter: signs Receipts after observing settlement; relying parties pin the adapter address out of band.
- Issuer: signs Attestations (KYC, sanctions); reached via `HSP_ISSUER_URL`.
- x402 Facilitator: settles EIP-3009 authorizations on-chain for the x402 scenarios (payer pays no gas) and bridges them to an HSP receipt; reached via `HSP_FACILITATOR_URL`.
- Verifier: a pure function of (mandate, receipt, attestations, policy) that you can run locally.

Source for all of the above unless noted: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 3, 5, 6, 11).

### 1.5 Actors

| Actor | Role in HSP |
|---|---|
| Payer (human wallet or AI agent) | signs Mandate, broadcasts transfer from own wallet |
| Merchant / recipient / relying party | pins adapter address, runs `HSPVerifier.verify`, ships on ACCEPT |
| Coordinator | registers, observes, verifies, stores, serves Explorer |
| Adapter operator | signs Receipts; custom adapters can be registered via `@hsp/devkit` |
| Issuer | signs KYC / sanctions Attestations |
| Facilitator | x402 settlement of EIP-3009 authorizations |

Source: same file, sections 3, 6, 7, 11.

### 1.6 Relation to x402, AP2 and agent payments

x402: HSP supports "real Coinbase x402 v2" as a payment path (scenarios 2 and 4), via `hsp.payX402(...)`, and the SDK ships `x402Gate` / `fetchWithX402` helpers to charge for or pay HTTP resources.
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 2 and 6).

AP2: HashKey's own marketing describes HSP as extending Google's Agent Payments Protocol (AP2), HTTP-native, supporting A2A payments and sub-cent micropayments, with licensed-institution verification nodes and on-chain AML.
Source: https://techflowpost.com/en-US/article/31203 (HashKey-authored promotional article, published 2026-04-20).
The developer guide itself does not mention AP2.

HashKey Merchant (the productized merchant checkout, production host `https://hsp.hashkey.com`) explicitly models its Cart Mandate and Payment Mandate on AP2 Verifiable Digital Credentials and uses x402 v2 as the payment method identifier.
Source: https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/README.md and https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/api-reference.md.
See section 2.8.

Agents: HSP ships `@hsp/mcp` (MCP server) and `skills/hsp-pay` (agent skill) specifically for AI agents, see section 5.1.

---

## 2. The HSP SDK

### 2.1 Language, packages, versions, license

Language: TypeScript (Node 20+ or Docker).
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (section 4).

Packages in the monorepo (layered stack):

| Package | Purpose |
|---|---|
| `skills/hsp-pay` | AI skill: teaches an agent how and when to pay (quote, approve, pay) |
| `@hsp/mcp` | MCP server: `hsp_quote`, `hsp_pay`, `hsp_status`, `hsp_verify` |
| `@hsp/sdk` | one-call `pay()` plus independent `verify()`; "most developers start here" |
| `@hsp/devkit` | build and conformance-test your own adapter |
| `@hsp/core` | protocol primitives: types, capabilities, verifier, signer, chains |

Source: same file, section 3.

Versions: not published.
The guide says the SDK "is distributed as a repository for the hackathon (not yet on npm)".
Source: same file, section 4.
A third party confirms `@hsp/core` 404s on npm (third-party: https://github.com/thisyearnofear/diversify/blob/main/docs/archive/strategy-2026-07.md, "Why HSP is safe to depend on").

License: Apache-2.0 according to two teams that read the repo while it was public (third-party: header of https://github.com/tang-vu/tessera/blob/main/agent/src/hsp/hsp-wire.ts and https://github.com/tang-vu/tessera/blob/main/agent/src/hsp/hsp-client.ts).
I could not confirm the LICENSE file directly.

### 2.2 Install

```sh
git clone <REPO_URL> && cd hsp
# everything runs in Docker (no node needed on your host) - see the repo README,
# or use your own Node 20+ toolchain:
npm install
```

Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (section 4).
`<REPO_URL>` was `https://github.com/project-hsp/hsp` in previous editions (third-party: tessera README, shieldpay MASTER_URLS.md) and is currently not public (verified live).

### 2.3 Core API surface (from the official guide)

```ts
import { HSPClient, HSPVerifier } from '@hsp/sdk';
import { resolveChain } from '@hsp/core/chains/index';

resolveChain(name: 'hashkey-testnet' | string): Chain   // pinned stablecoin per chain

new HSPClient({
  coordinatorUrl: string,
  apiKey: string,
  signer:
    | { kind: 'privateKey', privateKey: `0x${string}` }
    | { kind: 'viemAccount', account }
    | { kind: 'eip1193', provider, address },
  chain,
  issuerUrl?: string,                                   // for compliant payments
});

hsp.pay({ to, amount: bigint, profile?: { compliance: ['kyc','sanctions'] } })
  -> handle { paymentId /* = mandateHash */, txHash, status, awaitSettled(): Promise<{ status: 'SETTLED' | ... }> }

hsp.payX402({ merchant, facilitatorUrl, amount: bigint, profile? })

x402Gate(...) / fetchWithX402(...)                      // signatures documented only in repo docs/guide.md

new HSPVerifier({ chain, adapterAddress, compliance?: { trustedIssuers, policyRequiredCaps } })
verifier.verify(mandate, receipt, attestations)
  -> { ok: boolean, outcomeClass: 'ACCEPT' | 'RETRYABLE' | 'POLICY' | 'PERMANENT', ... }
```

Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 4, 5, 6, 10).
Exact TypeScript signatures beyond what the guide shows are not available because the repo is not public.
`x402Gate` and `fetchWithX402` signatures are only in the repo's `docs/guide.md`, which I could not read.

Payment status values seen in the wild: `PROPOSED`, `ATTEMPTED`, `SETTLED`, `FAILED`, `DISPUTED`, `EXPIRED` (third-party: https://github.com/thisyearnofear/diversify/blob/main/packages/shared/src/services/hsp/hsp-settlement.service.ts line 126; tessera treats `SETTLED`, `FAILED`, `DISPUTED`, `EXPIRED` as terminal).

### 2.4 Coordinator REST endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/payments` | register a signed mandate (+ attestations) |
| POST | `/payments/:id/observe` | ask the Coordinator to observe your settlement tx |
| GET | `/payments/:id` | payment status + the stored triple |
| GET | `/payments/:id/explain` | label-resolved decision trace |
| GET | `/requirements?chain=` | the deployment's requirement advertisement |
| GET | `/chains` | chain registry + the adapter address to pin |
| GET | `/stats` | public aggregate dashboard |
| GET | `/docs`, `/explorer` | developer portal + decision-trace UI |

Write endpoints need `Authorization: Bearer <API_KEY>`.
`observe` answers `202` while the tx is still confirming; the SDK retries.
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 9 and 10).

Additional endpoints that existed on the previous sandbox: `/register` (self-service API key), `/faucet/`, `/issuers`, `/adapter-operators`, `/verify`, `/verifier/` (hosted verifier, POST).
Source (third-party): https://github.com/xDzaky/shieldpay-hsp/blob/main/MASTER_URLS.md section 1.14, and https://github.com/tang-vu/tessera/blob/main/.env.example line 22.

Request and response shapes used successfully against the previous Coordinator (third-party, tessera settled real USDC.e on mainnet 177 through it):
- `POST /payments` body: `{ "chain": "<registry name>", "mandate": { "body": {...}, "signerProof": "0x...", "requiredCapabilities": [] }, "attestations": [] }` returns `{ paymentId, status, existing? }`.
- `POST /payments/:id/observe` body: `{ "txHash": "0x..." }`.
- `GET /chains` returns an array of `{ name, chainId, stablecoin: { address, symbol, decimals }, confirmations, verifyingContract, adapterAddress, adapterOperatorUrl? }`.
- If `adapterOperatorUrl` is set, observation goes to `POST {adapterOperatorUrl}/observe/evm-transfer` with `{ coordinatorUrl, paymentId, txHash }`.
Source: https://github.com/tang-vu/tessera/blob/main/agent/src/hsp/hsp-client.ts.

Chain registry names: `hashkey-testnet` is official (guide section 4).
The mainnet name is not documented officially; third parties used `hashkey` (https://github.com/thisyearnofear/diversify/blob/main/packages/shared/src/services/hsp/hsp-settlement.service.ts line 63) and tessera resolved it by `chainId` from `/chains`, which is the safer approach.

### 2.5 Minimal end-to-end example (official guide)

Payer side:

```ts
import { HSPClient } from '@hsp/sdk';
import { resolveChain } from '@hsp/core/chains/index';

const chain = resolveChain('hashkey-testnet');               // pinned testnet USDC

const hsp = new HSPClient({
  coordinatorUrl: process.env.HSP_COORDINATOR_URL!,          // <COORDINATOR_URL>
  apiKey:         process.env.HSP_API_KEY!,                  // <API_KEY>
  signer:         { kind: 'privateKey', privateKey: process.env.HSP_PRIVATE_KEY as `0x${string}` },
  chain,
});

// USDC has 6 decimals: 1 USDC = 1_000_000 base units
const handle = await hsp.pay({ to: '0xRecipientAddress', amount: 1_000_000n });
console.log(handle.paymentId, handle.txHash, handle.status); // mandateHash, on-chain tx, status
const final = await handle.awaitSettled();                   // polls to SETTLED
console.log(final.status);                                   // "SETTLED"
```

`pay()` builds the mandate, signs it, registers it with the Coordinator, broadcasts the ERC-20 transfer from your own wallet, asks the Coordinator to observe it, and returns a handle.

Merchant side (independent verification, do not trust the Coordinator):

```ts
import { HSPVerifier } from '@hsp/sdk';

const verifier = new HSPVerifier({
  chain,
  adapterAddress: '0x<pinned-adapter-address>',   // pin once from GET <COORDINATOR_URL>/chains
  // compliance: { trustedIssuers: [...], policyRequiredCaps: [...] },
});

const decision = await verifier.verify(mandate, receipt, attestations);
if (decision.ok && decision.outcomeClass === 'ACCEPT') {
  shipTheGoods();   // ACCEPT means ship
}
```

Compliant and x402 variants:

```ts
await hsp.pay({ to: '0xRecipient', amount: 1_000_000n, profile: { compliance: ['kyc', 'sanctions'] } });

await hsp.payX402({
  merchant:       '0xMerchant',
  facilitatorUrl: process.env.HSP_FACILITATOR_URL!,
  amount:         1_000_000n,
});
```

For `payX402` you sign both an HSP mandate and an EIP-3009 authorization; the facilitator settles on-chain (payer pays no gas).
Source for all code in 2.5: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 4 and 6), em dashes in comments replaced.

### 2.6 Wire format v1 (for building without the SDK)

Two independent teams re-implemented the payer-side hashing from the then-public repo (`packages/core/spec/typehashes.md`, `derivations.ts`, `profiles/signer/eip712-eoa.ts`) and pinned it with tests; tessera then settled real mainnet USDC.e through the official Coordinator with it.
Source (third-party): https://github.com/thisyearnofear/diversify/blob/main/packages/shared/src/services/hsp/eip712.ts, its test https://github.com/thisyearnofear/diversify/blob/main/packages/shared/src/services/hsp/__tests__/eip712.test.ts, and https://github.com/tang-vu/tessera/blob/main/agent/src/hsp/hsp-wire.ts.

EIP-712 domain: `{ name: "HSP", version: "1", chainId, verifyingContract }`, where `verifyingContract` comes from `GET /chains`.

`MANDATE_TYPEHASH` preimage (quoted by the diversify test as verbatim from the spec):

```
Mandate(bytes32 nonce,Signer signer,bytes32 grantRef,bytes32 requirementRef,Recipient recipient,address token,uint256 amount,uint256 chainId,uint64 deadline,bytes32 settlementBinding,bytes32 requiredCapabilitiesHash)Recipient(uint8 kind,bytes payload)Signer(bytes32 profileId,bytes payload)
```

Field rules:
- `signer = { profileId: keccak256("eip712-eoa.v1"), payload: abi.encode(address) }`.
- `recipient = { kind: 0 /* ADDRESS */, payload: abi.encode(address) }` (kind 1 = COMMITMENT).
- `grantRef`, `requirementRef`, `settlementBinding` default to 32 zero bytes.
- `requiredCapabilitiesHash`: lowercase, dedupe, sort, then `keccak256(abi.encode(bytes32[]))`; empty set is 32 zero bytes.
- `paymentId = mandateHash = hashTypedData(...)`.
- `signerProof` is a 65-byte secp256k1 signature over the mandateHash digest (what `eth_signTypedData_v4` produces).
- JSON wire form sends `amount`, `chainId`, `deadline` as decimal strings / numbers.

This is third-party reconstruction, so re-pin it against the official `@hsp/core` the moment the repo link is shared.

### 2.7 Auth and keys

- `HSP_API_KEY`: per-team write key, sent as `Authorization: Bearer`, server-side only.
- Payer key: EOA private key (demo only), viem account, or EIP-1193 wallet; the signing account must also be the settling account.
- Pinned adapter address: obtained once from `GET /chains` and stored out of band.
- `HSP_ISSUER_URL` for compliant payments, `HSP_FACILITATOR_URL` for x402.

Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (sections 4, 5, 6, 11, 12).

### 2.8 HashKey Merchant (the production HSP-branded checkout)

This is a separate, live, merchant-facing product with public docs and SDKs, and its production host is literally `hsp.hashkey.com`.
It is a hosted gateway (the gateway broadcasts the transaction), not the zero-custody wallet-settling HSP SDK flow, so treat it as a complementary "officially recommended product" rather than a replacement for HSP.

| Item | Value | Source |
|---|---|---|
| QA (testnet) base URL | `https://merchant-qa.hashkeymerchant.com` | https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/api-reference.md |
| Staging (mainnet tokens) | `https://merchant-stg.hashkeymerchant.com` | same |
| Production (mainnet tokens) | `https://hsp.hashkey.com` | same |
| Checkout URL shape | `https://pay.hashkey.com/flow/<flow_id>` | same |
| Endpoints | `POST /api/v1/merchant/orders`, `POST /api/v1/merchant/orders/reusable`, `GET /api/v1/merchant/payments`, `GET /api/v1/merchant/payments/reusable` | same |
| Request auth | HMAC-SHA256 headers `X-App-Key`, `X-Signature`, `X-Timestamp`, `X-Nonce`; message `METHOD\nPATH\nQUERY\nbodyHash\ntimestamp\nnonce`; ±300 s skew; nonce unique per 5 min | https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/authentication.md |
| Order auth | `merchant_authorization` = ES256K JWT, `aud: "HashkeyMerchant"`, claim `cart_hash` = SHA-256 of canonical JSON of cart contents | same |
| Payment method | `supported_methods: "https://www.x402.org/"`, `x402Version: 2` | api-reference.md |
| On-chain protocol | `eip3009` (USDC) or `permit2` (USDT) | https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/onboarding.md |
| Statuses | `payment-included`, `payment-safe`, `payment-finalized`, `payment-failed` | https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/webhook.md |
| Webhook signature | `X-Signature: t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(app_secret, t + "." + raw_body)`; 2xx within 10 s; 6 retries (1m, 5m, 15m, 1h, 6h, 24h) | webhook.md |
| Rate limit | error `10007` / HTTP 429 "Rate limited"; numeric limits not documented | https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/appendix.md |
| Chains | mainnet: Ethereum, HashKey Chain, Base, Arbitrum, BSC; testnet: Sepolia, HashKey testnet, Base Sepolia, Arbitrum Sepolia, BSC testnet (v2.3.0, 2026-10-16) | appendix.md changelog |
| SDKs | Node `hashkeymerchant-nodejs-sdk` 0.1.0, Python `hashkeymerchant-python-sdk` 0.1.0, Go `github.com/hashkey-merchant/merchant-sdks/golang`; Apache-2.0; install from Git | https://github.com/hashkey-merchant/sdks/blob/main/readme.md |
| Node SDK API | `new HashKeyMerchantClient({ baseURL, appKey, appSecret, merchantPrivateKey, merchantID, merchantName })`, `createOrder`, `createReusableOrder`, `queryPayment`, `queryReusablePayments`, `PaymentMethods.mainnet.hashkeyUSDC(payTo)`, `verifyAndParseWebhook` | https://github.com/hashkey-merchant/sdks/tree/main/nodejs/src |

Onboarding is manual: generate a secp256k1 key pair, send organization name, email, language, `service_rate`, PEM public key and supported chain/token rows to HashKey operations, accept the email invite, then create an app in the console to get `app_key` / `app_secret`.
Source: https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/onboarding.md.
The docs do not say whom to email; ask the organizers.

---

## 3. Registration, API keys, merchant onboarding

HSP SDK / Coordinator (this hackathon):
- Per the official guide, the organizer gives each team a write `<API_KEY>`, plus Coordinator URL, chain name, faucet, optional facilitator URL and the adapter address to pin.
  Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (section 12).
- On the previous sandbox the key was self-service: `POST https://hsp-hackathon.hashkeymerchant.com/register` with body `{"name":"you"}`, free, no external account (third-party: https://github.com/tang-vu/tessera/blob/main/.env.example line 22, https://github.com/xDzaky/shieldpay-hsp/blob/main/MASTER_URLS.md line 110).
  That host is down now (verified live), so the exact procedure for the India edition is unknown.
- One team reported that Coordinator usage was "blocked on Coordinator KYC (submitted, pending)" and called KYC slow to obtain (third-party: https://github.com/thisyearnofear/diversify/blob/main/docs/archive/strategy-2026-07.md, section "HSP Settlement & FX Protection Insight").
  Other teams on the same sandbox self-registered without KYC, so this may have applied only to their mainnet use; ask the organizers early.
- Custom adapters must be registered with the organizer by submitting `(adapterId, instanceKey, signing address, reorgPolicy)` after passing the `@hsp/devkit` conformance suite.
  Source: official guide section 7.

HashKey Merchant: manual onboarding via HashKey operations, see 2.8.

---

## 4. HashKey Chain

### 4.1 Networks

| | Mainnet | Testnet |
|---|---|---|
| Chain ID | 177 (`0xb1`, verified live) | 133 (`0x85`, verified live) |
| Public RPC | `https://mainnet.hsk.xyz` | `https://testnet.hsk.xyz` |
| Explorer | `https://hashkey.blockscout.com` (301-redirects to `https://hsk.blockscout.com`, verified live) | `https://testnet-explorer.hsk.xyz` |
| Native token | HSK (gas) | HSK (test) |
| Faucet | n/a | `https://faucet.hsk.xyz/faucet` |
| CAIP-2 | `eip155:177` | `eip155:133` |
| viem chain | `hashkey` | `hashkeyTestnet` |

Sources: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/network-info/index.mdx, https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/Tools/Faucet/index.mdx, viem chain names from https://github.com/HashkeyHSK/agentkit/blob/main/typescript/agentkit/src/network/network.ts.

Alternative testnet faucet route: bridge Sepolia WETH (`0x7b79995e5f793a07bc00c21412e50ecae098e7f9`) via `https://hashkey-testnet-51efbf722023210f.testnets.rollbridge.app/`.
Source: Faucet doc above.
Previous HSP sandboxes also ran their own faucet for gas plus test USDC at `<COORDINATOR_URL>/faucet`, rate-limited per address and IP (official guide section 4; rate-limit detail third-party from shieldpay MASTER_URLS.md).

Mainnet bridges: Superbridge `https://bridge.hashkeychain.net`, Orbiter Finance.
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/Tools/Bridges/index.mdx.

### 4.2 Gas and OP Stack specifics

- HashKey Chain is an OP Stack L2 on Ethereum; nodes run `op-geth` and `op-node`, mainnet bootnodes on `hashkey-mainnet-bootnodes.altlayer.network`.
  Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/RPC-Node-Provider/index.mdx.
- Fees = L2 execution fee + L1 security (data) fee.
  Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/Fee/index.mdx.
- Measured on 2026-10-24 (verified live): base fee 500 gwei, block gas limit 30,000,000, block time 2 s (600 blocks in 1,200 s around block 29,220,600).
- A third party measured 246,503 gas at 500 gwei = 0.123 HSK (about $0.011) for an EIP-3009 settlement on mainnet (third-party: hsk-meter README).
- Network upgrade: Granite, Holocene, Isthmus and Jovian activated on mainnet 2026-07-29 06:30 to 06:40 UTC (testnet 2026-07-09).
  Isthmus brings Pectra features including EIP-7702 (EOA set-code), EIP-2537, EIP-2935, and EIP-7623 (higher calldata cost); Jovian adds a configurable minimum base fee.
  Source: https://docs.hskchain.net/docs/Notices/Jovian-Upgrade.
- Flashblocks (about 200 ms partial blocks) are testnet only: `wss://testnet-flashblocks.hsk.xyz/ws`.
  Source: https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Flashblocks.
- Standard OP predeploys apply (L2CrossDomainMessenger `0x4200...0007`, GasPriceOracle `0x4200...000F`, L2StandardBridge `0x4200...0010`, L1Block `0x4200...0015`, EAS `0x4200000000000000000000000000000000000021`).
  Source: https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Contract-Addresses.
- L1 (Ethereum) mainnet: SystemConfigProxy `0x43F8DeFe3E9286D152E91BB16a248808E7247198`, OptimismPortalProxy `0xe7Aa79B59CAc06F9706D896a047fEb9d3BDA8bD3`, L1StandardBridgeProxy `0x2171E6d3B7964fA9654Ce41dA8a8fFAff2Cc70be`.
  Source: same page.

### 4.3 Token addresses

Mainnet (official list: https://docs.hskchain.net/docs/Build-on-HashKey-Chain/Token-Contracts; metadata verified live via `https://hsk.blockscout.com/api/v2/tokens/<addr>` and `/api/v2/smart-contracts/<addr>`):

| Token | Address | Decimals | Contract | Gasless support |
|---|---|---|---|---|
| USDC.e ("Bridged USDC") | `0x054ed45810DbBAb8B27668922D110669c9D88D0a` | 6 | `FiatTokenProxy` -> `FiatTokenV2_2` impl `0x82f67Bdea6CbCC6BD34526073300e619225b22DE` | EIP-3009 (`transferWithAuthorization`, `receiveWithAuthorization`) and EIP-2612 `permit`; domain name `Bridged USDC`, version `2` (verified live) |
| USDT | `0xf1b50ed67a9e2cc94ad3c477779e2d4cbfff9029` | 6 | `OptimismMintableERC20` | none; `nonces` and `DOMAIN_SEPARATOR` revert (verified live); use Permit2 |
| WHSK | `0xB210D2120d57b758EE163cFfb43e73728c471Cf1` | 18 | `WHSK` | none |
| WETH | `0xefd4bC9afD210517803f293ABABd701CaeeCdfd0` | 18 | `OptimismMintableERC20` | none |
| WBTC | `0x6119ca49a79f5825c8b345f8d7ac36b272565b14` | 8 | `OptimismMintableERC20` | none |
| LINK | `0x71052BAe71C25C78E37fD12E5ff1101A71d9018F` | 18 | `LinkToken` | n/a (CCIP fee token) |
| HSK on Ethereum L1 | `0xE7C6BF469e97eEB0bFB74C8dbFF5BD47D4C1C98a` | 18 | ERC-20 | n/a |

Note: USDC.e had only 58 holders and USDT 5,164 holders on 2026-10-24 (verified live), so most real liquidity is USDT, while gasless agent flows need USDC.e.
Note: Blockscout search shows many "Mock USDC" / "USD Coin" impostor tokens on mainnet; always hardcode the address above.

Testnet (no official HashKey Chain token page lists testnet tokens; the addresses below come from the HashKey Merchant docs: https://github.com/hashkey-merchant/hashkey-merchant.github.io/blob/main/docs/en/onboarding.md):

| Token | Address | Decimals | Gasless support |
|---|---|---|---|
| USDC | `0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6` | 6 | EIP-3009 (`authorizationState` responds) and `permit` (`nonces` responds); name `USD Coin`, version `2` (verified live) |
| USDT | `0x372325443233fEbaC1F6998aC750276468c83CC6` | 6 | Permit2 per Merchant docs (not verified) |
| WHSK | `0x2896e619Fa7c831A7E52b87EffF4d671bEc6B262` | 18 | from Chainlink CCIP testnet fee-token list |

The testnet USDC `0x8FE3...53c6` is also the one previous HSP sandboxes pinned for `hashkey-testnet` (third-party: SentryPay docs/DEPLOYMENT.md, shieldpay evidence.ts).

### 4.4 Canonical infra contracts (verified live via `eth_getCode`, both chains unless noted)

| Contract | Address | Mainnet | Testnet |
|---|---|---|---|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | yes | yes |
| ERC-4337 EntryPoint v0.7 | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` | yes | yes |
| ERC-4337 EntryPoint v0.6 | `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789` | yes | yes |
| ERC-4337 EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` | no | no |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | yes | yes |
| Deterministic CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | yes | yes |
| CreateX | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` | yes | no |
| Safe 1.4.1 singleton | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | yes | yes |

No official bundler or paymaster service for HashKey Chain is documented anywhere I looked (docs.hskchain.net, HashkeyHSK GitHub, hashfans.io).

### 4.5 Chainlink CCIP

| | Mainnet | Testnet |
|---|---|---|
| Chain selector | `7613811247471741961` | `4356164186791070119` |
| Router | `0xf2Fd62c083F3BF324e99ce157D1a42d7EbA77f1d` | `0x1360c71dd2458B6d4A5Ad5946d9011BafA0435d7` |
| RMN | `0x59F168858472c5ECC217588678F6c378951Bd524` | `0x9BbBb1Df7D813c9749d99D3CC3D8087b06A83984` |
| Token admin registry | `0x4b238f757f842280FeA88A1c2B4186b71eF8BC5E` | `0x732cC8266993dDfc5a91035EBe7afF301Be4e8c3` |
| Registry module owner | `0x04c5046A1f4E3fFf094c26dFCAA75eF293932f18` | `0xa9Fd6072c80fC9EbBA6322F4ffEc872408914DF3` |
| Token pool factory | `0x48bc5Ab224B818300041956f0da2e675bf676D27` | `0xd0fe9b0f49127D514cc37808592C24111DBf3004` |
| Fee tokens | LINK `0x71052BAe71C25C78E37fD12E5ff1101A71d9018F`, WHSK `0xB210D2120d57b758EE163cFfb43e73728c471Cf1`, native HSK | LINK `0x8418c4d7e8e17ab90232DC72150730E6c4b84F57`, WHSK `0x2896e619Fa7c831A7E52b87EffF4d671bEc6B262`, native HSK |

Sources: https://docs.chain.link/ccip/directory/mainnet/chain/ethereum-mainnet-hashkey-1 and https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia-hashkey-1 (full addresses extracted from the page's explorer links on 2026-10-24).
Some older community notes list different testnet registry-module-owner and token-pool-factory addresses; prefer the Chainlink directory.

Chainlink Data Streams verifier proxy: mainnet `0x3278e7a582B94d82487d4B99b31A511CbAe2Cd54`, testnet `0xE02A72Be64DA496797821f1c4BB500851C286C6c`.
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/Tools/Oracle/index.mdx.

### 4.6 Contract verification (Foundry / Hardhat)

The official docs only show deploy config, not verification config.
Source: https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Developer-QuickStart/index.mdx.

Facts I verified:
- Mainnet explorer is Blockscout (backend `v12.0.3`, `https://hsk.blockscout.com/api/v2/config/backend-version`), with a working Etherscan-compatible `/api` endpoint (HTTP 200 on `https://hsk.blockscout.com/api?module=block&action=eth_block_number`).
- Sourcify supports both chain 177 ("HashKey") and 133 ("HSKChain Testnet") (`https://sourcify.dev/server/chains`).
- A track team verified its mainnet contract on Blockscout and Sourcify with exact match (third-party: hsk-meter README).

Recommended Foundry config (standard Blockscout verifier pattern, not from HashKey docs):

```toml
[rpc_endpoints]
hashkey = "https://mainnet.hsk.xyz"
hashkey_testnet = "https://testnet.hsk.xyz"
```

```sh
forge verify-contract <ADDR> src/X.sol:X --chain 177 \
  --verifier blockscout --verifier-url https://hsk.blockscout.com/api/
# fallback:
forge verify-contract <ADDR> src/X.sol:X --chain 177 --verifier sourcify
```

Recommended Hardhat config (hardhat-verify `customChains`, no real API key needed for Blockscout):

```ts
etherscan: {
  apiKey: { hashkey: "empty", hashkeyTestnet: "empty" },
  customChains: [
    { network: "hashkey", chainId: 177,
      urls: { apiURL: "https://hsk.blockscout.com/api", browserURL: "https://hsk.blockscout.com" } },
    { network: "hashkeyTestnet", chainId: 133,
      urls: { apiURL: "https://testnet-explorer.hsk.xyz/api", browserURL: "https://testnet-explorer.hsk.xyz" } },
  ],
},
```

The testnet explorer API URL is unverified: `testnet-explorer.hsk.xyz` did not resolve in DNS from my environment on 2026-10-24; use Sourcify for testnet if it fails.

### 4.7 EIP-3009 / permit summary for gasless agent payments

- Mainnet USDC.e supports EIP-3009 and EIP-2612; it is the only mainnet stablecoin usable for x402 `exact`-style gasless settlement (verified live).
- Mainnet USDT supports neither; gasless USDT needs Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`, deployed) which still needs a one-time on-chain `approve` to Permit2, or EIP-7702 (live since 2026-07-29).
- HashKey Merchant itself uses `eip3009` for USDC and `permit2` for USDT on HashKey Chain (onboarding.md table).
- Use `receiveWithAuthorization` rather than `transferWithAuthorization` when a contract settles, to avoid signature front-running (third-party design note: hsk-meter README "x402 v2 profile").

---

## 5. Officially recommended products and frameworks (extra points)

From HashKey's own surfaces (hashfans.io, docs.hskchain.net, HashkeyHSK GitHub, hashkey-merchant GitHub):

| Product | What it gives you | Source |
|---|---|---|
| HSP `@hsp/sdk` | pay + independent verify; the track requirement | HSP guide section 3 |
| HSP `@hsp/mcp` | MCP tools `hsp_quote`, `hsp_pay` (explicit confirmation, server-side SpendGuard: per-tx cap, daily cap, optional recipient allowlist), `hsp_status`, `hsp_verify`; config via `.mcp.json.example` | HSP guide section 8 |
| HSP `skills/hsp-pay` | agent skill enforcing quote, user approval, pay | HSP guide section 8 |
| HSP `@hsp/devkit` | adapter template plus conformance runner; register adapter with organizer | HSP guide section 7 |
| HashKey Merchant + SDKs | AP2-style Cart Mandate checkout over x402 v2, webhooks | section 2.8 |
| `@hashkeychain/agentkit` 0.6.3 (npm, Apache-2.0) | HashKey fork of Coinbase AgentKit with `hashkey-mainnet` / `hashkey-testnet` networks and a WHSK action provider; last published 2025-04-17 | https://github.com/HashkeyHSK/agentkit, `npm view @hashkeychain/agentkit` |
| HashKey Chain KYC SBT | on-chain KYC levels (NONE..ULTIMATE) and `isHuman`, `getKycInfo`; contract address not given in docs | https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/Build-on-HashKey-Chain/Tools/KYC/index.mdx |
| Safe | official deployments `https://safe.hsk.xyz/welcome?chain=HSK`, tx service `https://safe-transaction-hashkey.safe.global`, testnet `https://testnet-safe.hsk.xyz/welcome?chain=HSKT` | Tools/Safe doc |
| APRO oracle (push) | mainnet USDC/USD `0x244Ce344df8837c9d938867E2Ffbf0E4B0169B56`, USDT/USD `0x823d7f90f7A3498DB6595886b6B5dC95E6B0B7f3`, HSK/USD `0x86CE42c1b714149Dc3A7b169EF67b5F78A224b` (as printed, 40 hex chars, check before use), BTC/USD `0x204ED500ab56A2E19B051561258E3A45c850360F` | Tools/Oracle doc |
| SUPRA pull oracle | mainnet pull `0x16f70cAD28dd621b0072B5A8a8c392970E87C3dD`, storage `0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57` | Tools/Oracle doc |
| Chainlink Data Streams and CCIP | see 4.5 | Tools/Oracle doc, Chainlink directory |
| EAS predeploy | `0x4200000000000000000000000000000000000021` | Contract-Addresses page |
| Subgraph (The Graph) | network id `hashkeychain` | Tools/Subgraph doc |
| Wallets | OKX Wallet (featured), MetaMask, TokenPocket, imToken | Tools/Wallet doc |
| DEX | HSKSwap `https://app.hskswap.com` (hashfans top nav) | hashfans.io bundle nav |

Caution on the APRO HSK/USD address: the docs print `0x86CE42c1b714149Dc3A7b169EF67b5F78A224b`, which is only 38 hex characters after `0x`, so it is a typo in the docs; do not use it without confirming on Blockscout.

No official HashKey bundler, paymaster, or HashKey-specific MCP server beyond `@hsp/mcp` was found.

Related HSP resource on hashfans: a PDF "Payment Deck CaaS" at `https://hashfans.io/assets/Hashkey_Payment_Deck_CaaS_EN.pdf` (linked from the HSP guide page; not downloaded).

---

## 6. Gotchas

1. HSP SDK repo is private / not yet shared, and the old sandbox host is dead (see section 0); everything depends on the organizer handing out the India-edition sandbox.
2. HSP is pre-1.0 and the wire format may change; pin the EIP-712 typehash with a unit test and re-check it when the repo appears.
3. Wallet-settling rule: the mandate signer must be the `Transfer.from`; an agent paying from a smart account or relayer will not satisfy the default `evm-transfer` adapter.
4. Fetch `verifyingContract`, stablecoin and adapter address from `GET /chains`, but pin the adapter out of band for verification ("pin, do not fetch-and-trust").
5. `observe` returns 202 until confirmations are reached; poll with backoff.
6. Faucet and Coordinator are rate-limited (official faucet doc: "may have request limits"; sandbox faucet "rate-limited per address and IP" per third-party notes); claim funds early.
7. HashKey Merchant rate limits are signalled by error `10007` / HTTP 429 with no published numbers.
8. Public RPC `https://mainnet.hsk.xyz` returns 403 on plain GET (POST JSON-RPC works, verified live); a third party reports 403 on some write or estimate calls and suggests `https://hashkeychain-mainnet.alt.technology` (third-party: https://github.com/Ardian3D/guardfi-ai/blob/main/docs/ENVIRONMENT.md), but that host did not answer from my environment.
9. `hashkey.blockscout.com` now 301-redirects to `hsk.blockscout.com`; some HTTP clients and Blockscout API callers do not follow redirects.
10. Testnet explorer `testnet-explorer.hsk.xyz` did not resolve in DNS on 2026-10-24 from my environment.
11. Base fee is pinned at 500 gwei, so a USDC.e EIP-3009 settlement costs about 0.12 HSK; sub-cent micropayments per request are not economical on-chain without batching.
12. USDT on HashKey has no permit or EIP-3009; plan gasless flows around USDC.e or Permit2.
13. Mainnet USDC.e EIP-712 domain name is `Bridged USDC` (not `USD Coin`), version `2`; testnet USDC name is `USD Coin`, version `2`; hardcoding the wrong name breaks EIP-3009 signatures.
14. Many fake USDC/USDT tokens exist on mainnet; hardcode the canonical addresses.
15. The HSP `@hsp/mcp` tool list differs between the official guide (4 tools: quote/pay/status/verify) and a third-party snapshot of the repo README (10 key-less tools such as `hsp_build_mandate`, `hsp_prepare_payment`, `hsp_submit_payment`); the repo was evolving, confirm against the released version.
16. One team reported Coordinator KYC as a blocker for live HSP settlement; raise it with organizers on day one.
17. No public x402 facilitator for `eip155:177` was found; if the organizer does not provide `<FACILITATOR_URL>`, you must run your own facilitator (as hsk-meter did with its own settlement contract).
18. CCIP addresses in community notes differ from the Chainlink directory for testnet registry module owner and token pool factory; use the directory.

---

## 7. Implication for Payminto (one paragraph)

The safest integration is a thin `HspSettlement` port with two adapters: the official `@hsp/sdk` once the organizer shares it, and a self-contained wire-v1 client (section 2.6) that already matches what the previous Coordinator accepted.
Settle in USDC.e on mainnet 177 for gasless agent flows, verify locally with a pinned adapter, and expose the agent side through `@hsp/mcp` (or an equivalent MCP tool with a SpendGuard) plus HashKey Merchant checkout for human payers, which covers the "officially recommended products" criterion.

---

## Sources

Official HashKey / HSP:
- HSP developer guide (source of truth): https://github.com/HashkeyHSK/documentation/blob/main/contents/docs/HSP/index.mdx (repo HEAD 64ac108, 2026-06-22)
- HSP guide rendered: https://hashfans.io/hsp and https://hashfans.io/docs?id=HSP (hashfans bundle `/assets/index-DWcnC3Q8.js` fetched 2026-10-24)
- HashKey Chain docs: https://docs.hskchain.net/ (Token-Contracts, Contract-Addresses, Notices/Jovian-Upgrade, Flashblocks) and source repo https://github.com/HashkeyHSK/documentation
- HashKey AgentKit: https://github.com/HashkeyHSK/agentkit
- HashKey Merchant docs: https://github.com/hashkey-merchant/hashkey-merchant.github.io (HEAD 2026-10-16), site https://hashkey-merchant.github.io/
- HashKey Merchant SDKs: https://github.com/hashkey-merchant/sdks
- HashKey HSP marketing (AP2 claim): https://techflowpost.com/en-US/article/31203

Chainlink:
- https://docs.chain.link/ccip/directory/mainnet/chain/ethereum-mainnet-hashkey-1
- https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia-hashkey-1

Live checks (2026-10-24):
- JSON-RPC `https://mainnet.hsk.xyz`, `https://testnet.hsk.xyz` (`eth_chainId`, `eth_call`, `eth_getCode`, `eth_getBlockByNumber`, `eth_gasPrice`)
- Blockscout API `https://hsk.blockscout.com/api/v2/tokens/...`, `/api/v2/smart-contracts/...`
- Sourcify `https://sourcify.dev/server/chains`
- GitHub `gh api users/project-hsp` (0 public repos)

Third-party (secondary evidence from hackathon teams):
- https://github.com/swiftbotlab/hsk-meter (India edition, same track, 2026-10-23)
- https://github.com/tang-vu/tessera (settled real HSP payments on 177 and 133)
- https://github.com/thisyearnofear/diversify (wire-v1 EIP-712 reimplementation)
- https://github.com/xDzaky/shieldpay-hsp (sandbox URL inventory)
- https://github.com/Ardian3D/guardfi-ai (RPC 403 note)
