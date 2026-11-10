# Sources for the NEAR AI Cloud integration

Everything the NEAR AI Cloud adapter and its attestation check assume, with where each fact comes from.
All pages and endpoints were read on 2026-11-10.
"Live" means the fact was observed on the real service from this repository's worktree, without an API key.
"Docs only" means it comes from NEAR's documentation and could not be exercised, because no API key was available.

## Primary sources

- NEAR AI docs index: https://docs.near.ai/llms.txt
- Quickstart: https://docs.near.ai/cloud/quickstart.md
- Models: https://docs.near.ai/cloud/models.md
- Private inference: https://docs.near.ai/cloud/private-inference.md
- Reasoning models: https://docs.near.ai/cloud/reasoning-models.md
- OpenAI compatibility: https://docs.near.ai/cloud/guides/openai-compatibility.md
- Verification overview: https://docs.near.ai/cloud/verification/index.md
- Gateway attestation: https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
- NEAR model attestations: https://docs.near.ai/cloud/verification/cloud-api/model-attestations.md
- Response signatures: https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
- Quote, nonce and signer bindings: https://docs.near.ai/cloud/verification/reference/quote-nonce-signer.md
- Response signature verification helpers: https://docs.near.ai/cloud/verification/reference/response-signature-verification.md
- Verification policy: https://docs.near.ai/cloud/verification/reference/verification-policy.md
- API reference, introduction and authentication: https://docs.near.ai/api-reference/introduction.md
- API reference, chat completions: https://docs.near.ai/api-reference/chat/create-chat-completion.md
- API reference, model list: https://docs.near.ai/api-reference/chat/list-available-models.md
- API reference, models with pricing: https://docs.near.ai/api-reference/models/list-models-with-pricing.md
- API reference, attestation report: https://docs.near.ai/api-reference/attestation/get-attestation-report.md
- API reference, signature: https://docs.near.ai/api-reference/attestation/get-completion-or-responses-api-signature.md
- API reference, key check: https://docs.near.ai/api-reference/gateway/check-api-key-validity.md
- JavaScript SDK: https://docs.near.ai/cloud/inference-sdk/javascript.md
- Gateway source: https://github.com/nearai/cloud-api (README read)
- NEAR's verifier: https://github.com/nearai/nearai-cloud-verifier (README read, no code copied)
- NEAR's verification example: https://github.com/near-examples/nearai-cloud-verification-example (README read, no code copied)
- Dashboard: https://cloud.near.ai (a sign-in page: Google, GitHub or NEAR)
- Intel SGX Root CA certificate: https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.pem
- Intel TD quoting enclave identity: https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity
- Live endpoints, no key: `GET https://cloud-api.near.ai/v1/models`, `GET /v1/model/list`, `GET /v1/attestation/report`.

## API facts

| Fact | Value | Source |
| - | - | - |
| Base URL | `https://cloud-api.near.ai/v1` | Quickstart, OpenAI compatibility, API introduction; live |
| Wire format | OpenAI Chat Completions, `POST /v1/chat/completions` | OpenAI compatibility, API reference |
| Auth | `Authorization: Bearer <key>`; API keys start with `sk-` | API introduction |
| Missing key | `401 {"error":{"message":"Missing authorization header","type":"missing_auth_header"}}` | live |
| Wrong key | `401 {"error":{"message":"Invalid or expired API key","type":"invalid_api_key"}}` | live, with a made-up key |
| No credits | `402` on chat completions and on the key check | API reference; docs only |
| Rate limit or overload | `429`, `error.type` is `rate_limit_exceeded` or `service_overloaded` | API reference; docs only |
| Token limit parameter | `max_tokens` | API reference |
| Usage | `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` | API reference, Quickstart |
| Tool calling | Supported on chat completions; per model, the `tools` entry of `supported_features` | OpenAI compatibility; live model list |
| Streaming | Supported (Server-Sent Events) | OpenAI compatibility |
| Model list | `GET /v1/models`, public | live |
| Model list and keys | `GET /v1/models` answers 200 with the full list for a key that does not exist | live, with a made-up key |
| Key check | `POST /v1/check_api_key`: 200 `{valid, organization_id, workspace_id, api_key_id}`, 401, 402, 429 | API reference; the 401 is live |
| Catalogue with pricing | `GET /v1/model/list`, public; prices are `amount / 10^scale` US dollars per token | API reference; live |
| Aliases | Sending `x-no-aliasing: true` makes an alias fail with a 400 that names the canonical id | Model attestations; live |
| Key environment variable | `NEARAI_API_KEY` (the name NEAR's own SDK reads) | JavaScript SDK |

## Models and pricing (live, 2026-11-10)

`GET /v1/model/list` returned 64 models.
Twelve have `providerType` `vllm`: they run in NEAR's own enclaves and are the ones `provider=near` attestation covers.
Six of those list the `tools` feature.

| Model id | Input, USD per million tokens | Output, USD per million tokens | Context |
| - | - | - | - |
| `z-ai/glm-5.3-flash` (default) | 0.08 | 0.50 | 1,048,576 |
| `Qwen/Qwen3.8-27B` | 0.04 | 1.35 | 262,144 |
| `Qwen/Qwen3.6-35B-A3B-FP8` | 0.17 | 1.10 | 262,144 |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 0.30 | 1.20 | 1,048,576 |

The other entries are models in a third party's enclave (`providerType` `chutes` or `tinfoil`) and models that run outside any enclave at their vendor (`external`: OpenAI, Anthropic, Gemini and others).
For an `external` model, `GET /v1/attestation/report?model=...&provider=near` answers `503 Provider error: No provider found that supports attestation reports for model: ...` (live).
Prices change; `listNearAiCatalog()` reads the current ones.
`z-ai/glm-5.3-flash` reasons by default with a budget of 8192 thinking tokens, billed as completion tokens (Reasoning models).

## Attestation flow, as NEAR documents it

1. The client generates a nonce: 32 random bytes as 64 hex characters.
2. `GET /v1/attestation/report?model=<canonical id>&provider=near&include_tls_fingerprint=false&signing_algo=ecdsa&nonce=<nonce>` with `x-no-aliasing: true`.
   No API key is needed, so the gateway can be verified before it sees the key.
   The response has `gateway_attestation` and, for a model NEAR hosts, `model_attestations[]`.
3. For the gateway report and for every model report, verify the Intel TDX quote, read report data and measurements from the verified quote, and check the bindings (next section).
4. Send the completion with the canonical model id and `x-no-aliasing: true`, keeping the exact request bytes and the raw response bytes.
5. `GET /v1/signature/<completion id>?signing_algo=ecdsa` with the API key.
   The body is `{text, signature, signing_address, signing_algo, signature_kind}`.
   A `404` means not recorded yet; a 2xx with `error_code` and `message` means unavailable.
6. Check that `text` is `<model>:<sha256 of request>:<sha256 of response>` for `signature_kind` `provider_tee`, or `<sha256 of request>:<sha256 of response>` for `gateway`.
7. Check the signature: for `ecdsa` recover the Ethereum EIP-191 signer and compare it with `signing_address`; for `ed25519` verify with `signing_address` as the public key.
8. Require the signer and algorithm to match exactly one model report verified in step 3 (`provider_tee`) or the gateway report (`gateway`).
   A report fetched after the completion cannot replace the preflight.

Sources: Gateway attestation, NEAR model attestations, Response signatures, Quote, nonce and signer bindings.

## Bindings inside a NEAR report

- Report data is 64 bytes: the first 32 are the signing identity, zero-padded on the right (a 20-byte Ethereum address for `ecdsa`, a 32-byte key for `ed25519`), the last 32 are the client nonce.
  With a TLS fingerprint requested, the first 32 bytes are `SHA-256(identity || fingerprint)` instead.
- MRCONFIGID is 48 bytes: `01`, then `SHA-256` of the raw `info.tcb_info.app_compose` string, then 15 zero bytes.
- RTMR3 is the replay of the `imr` 3 events of `event_log`: each digest is `SHA-384(event_type as 4 little-endian bytes || ":" || event || ":" || payload)`, and RTMR3 extends once per event from 48 zero bytes.
- Bit 0 of `TD_ATTRIBUTES` is the debug flag and must be off.
- `nvidia_payload` is a JSON string whose `nonce` must equal the client nonce; NVIDIA's verdict comes from `POST https://nras.attestation.nvidia.com/v3/attest/gpu`.

Source: Quote, nonce and signer bindings.
All five were reproduced on the live report of 2026-11-10 for the gateway and for `z-ai/glm-5.3-flash`.

## TDX quote layout

Used by `src/attestation/tdx-quote.ts`.
The layout is Intel's version 4 quote format.
It was written from prior knowledge of that format: Intel's specification was not re-read for this work.
It is confirmed by the two live quotes instead: the fields parsed at these offsets equal the copies in `info.tcb_info` and `report_data`, the quote signature and the QE report signature verify, and the certificate chain ends at Intel's root.
A wrong offset would break at least one of those.

- Header, 48 bytes: version (u16, 4), attestation key type (u16, 2 is ECDSA P-256), TEE type (u32, 0x81 is TDX), 4 reserved bytes, QE vendor id (16 bytes), user data (20 bytes).
- TD report, 584 bytes: TEE TCB SVN 16, MRSEAM 48, MRSIGNERSEAM 48, SEAM attributes 8, TD attributes 8, XFAM 8, MRTD 48, MRCONFIGID 48, MROWNER 48, MROWNERCONFIG 48, RTMR0 to RTMR3 48 each, report data 64.
- Signature data length (u32), then: quote signature 64 (r, s), attestation public key 64 (x, y), certification data type (u16, 6) and size (u32).
- Certification data type 6: QE report 384, QE report signature 64, QE authentication data (u16 length, bytes), nested certification data type (u16, 5) and size (u32), PCK certificate chain in PEM.
- QE report: MRSIGNER at offset 128 (32 bytes), ISV product id at 256 (u16), ISV SVN at 258 (u16), report data at 320 (64 bytes); its first 32 bytes are `SHA-256(attestation key || QE authentication data)`.

Pinned values:

- Intel SGX Root CA, SHA-256 fingerprint `44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3`, valid until 2049-12-31, from Intel's certificate site.
- TD quoting enclave MRSIGNER `dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5` and product id 2, from Intel's signed QE identity (`id` `TD_QE`).

## What is verified where

Checked in this process, with `node:crypto` and `@noble/curves`:

- The quote signature over the header and TD report, by the attestation key in the quote.
- That the QE report commits to that attestation key, and the QE report signature by the PCK certificate key.
- The PCK certificate chain up to the pinned Intel SGX Root CA, and its validity dates.
- That the quoting enclave is Intel's TD quoting enclave, by signer and product id.
- Debug mode off, the nonce binding, the signer binding, MRCONFIGID against `app_compose`, the RTMR3 replay.
- The nonce of the GPU evidence.
- The response signature: signed text against the exact bytes, EIP-191 recovery or Ed25519 verification, signer against the preflight reports, preflight age.

Not checked in this process, and reported as `not_verified`:

- The Intel TCB status of the platform and TDX module, the QE's TCB level, and certificate revocation.
  They need signed collateral from Intel's PCS or a PCCS.
  NEAR's docs use `@phala/dcap-qvl` for this; it is not a dependency here (eight direct dependencies, its own HTTP client) and can be plugged in through the `quoteVerifier` option.
- NVIDIA's verdict on the GPU evidence, which comes from NVIDIA's remote attestation service (`gpuVerifier` option).
- Whether the measured software is acceptable: no measurement allowlist or image provenance (Sigstore) check exists unless `policy.acceptedComposeHashes` is given.
- The TLS endpoint binding: it needs the peer certificate of the same connection, which `fetch` does not expose.

## Not confirmed

- The exact body of a `402` and of a `429`: the adapter relies on the status code, and on `error.type` only to tell overload from rate limit.
- The live behaviour of `GET /v1/signature/{id}` with a valid key, and which `signature_kind` a non-streamed completion gets.
  The docs say the gateway signs when it changes bytes (streams, aliases, the Responses API), which implies `provider_tee` for a non-streamed completion sent with the canonical id; both kinds are handled.
- A "NEAR Builders" key for the hackathon: no primary source was found.
  A web search surfaced Notion pages about coupon codes for NEAR AI Cloud credits at earlier NEAR hackathons; they were not opened or verified.
  Whatever is handed out is expected to end up as an `sk-` key from cloud.near.ai, which is an assumption.

## Why not NEAR's JavaScript SDK

`@nearai/inference-sdk` verifies attestation and signatures itself, but it requires Node.js 24.22.1 or later (this workspace supports 22.18), brings its own HTTP client (the node passes a guarded `fetch` into every model call) and has its own client shape.
The adapter here follows the same documented flow on the workspace's `ModelClient` seam.
