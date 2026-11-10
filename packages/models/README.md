# @payminto/models

The neutral model layer of Payminto.
The agent runtime (`apps/agent`) and the node's merchant agents (`apps/node`) build every model client here, so a business can bring a key for any supported provider.
An agent loop only sees `ModelClient.turn()`; each provider is an adapter in `src/providers/`.

Providers: Anthropic, OpenAI, Google Gemini, Replicate, any OpenAI-compatible endpoint, and NEAR AI Cloud with enclave attestation.

## NEAR AI Cloud

[NEAR AI Cloud](https://cloud.near.ai) runs models inside enclaves (Intel TDX, NVIDIA confidential GPUs) behind an OpenAI-compatible gateway at `https://cloud-api.near.ai/v1`.
Payminto talks to it with its own adapter, which does two things a generic OpenAI client does not.
It checks the key properly: the gateway's model list is public and answers 200 for any key, so the key is checked with the gateway's key check instead.
It verifies attestation: before each request it checks the enclave reports of the gateway and of the model, and after each answer it checks the answer's signature.
The result travels on the turn as `turn.attestation`.

Sources for every fact in this section are in [SOURCES.md](./SOURCES.md).

### Get a key

1. Sign in at https://cloud.near.ai (Google, GitHub or a NEAR account).
2. Add credits under Credits.
   If the hackathon hands out a NEAR AI Cloud coupon or a ready-made builder key, use that instead.
   No primary source for such a key was found while writing this, so ask the organizers.
3. Create a key under API Keys.
   It starts with `sk-`.
4. Keep it out of the repository: export it in your shell, or paste it into the dashboard, which seals it with the node's server key.

### Check the setup

```bash
export NEARAI_API_KEY=sk-...
pnpm --filter @payminto/models nearai:check
```

The command checks the public model catalogue, the enclave attestation of the gateway and the model, the key, and one tiny completion with its signature.
The first two steps need no key, so it is worth running before you have one.
It never prints the key.
Every failure ends with a "What to do next" list.

| Exit code | Meaning |
| - | - |
| 0 | Everything ran and the answer's signature checks did not fail |
| 2 | No `NEARAI_API_KEY`; the catalogue and attestation steps ran |
| 3 | The key was rejected |
| 4 | No credits, or the key's spend limit is reached |
| 5 | The model id is unknown or an alias |
| 6 | NEAR AI Cloud or its attestation endpoint is unreachable, or attestation failed |
| 7 | The completion failed for another reason |

`NEARAI_MODEL` picks another model (default `z-ai/glm-5.3-flash`).
`NEARAI_BASE_URL` points the check somewhere else.

### Select the provider

The provider id is `nearai`, shown as "NEAR AI Cloud".

In the dashboard (Settings, AI models, Add connection):

- Provider: "NEAR AI Cloud".
  The endpoint is fixed and the model is prefilled with `z-ai/glm-5.3-flash`.
- API key: the `sk-` key.

A wrong key is caught on save: the connection is stored as "Key rejected" with the message "NEAR AI Cloud rejected the API key (401): Invalid or expired API key", and no agent can run on it until the key is replaced.

For the agent CLI:

```bash
export PAYMINTO_AGENT_PROVIDER=nearai
export NEARAI_API_KEY=sk-...
export PAYMINTO_AGENT_MODEL=z-ai/glm-5.3-flash   # optional, this is the default
```

In code:

```ts
import { createModelClient, NEARAI_DEFAULT_MODEL } from "@payminto/models";

const client = createModelClient({ provider: "nearai", apiKey, model: NEARAI_DEFAULT_MODEL });
const turn = await client.turn({ system, tools, messages, maxTokens: 1024 });
turn.attestation?.status; // "verified" | "partially_verified" | "failed"
turn.attestation?.summary; // one or two plain sentences
```

NEAR AI Cloud is also recognised by its base URL.
A connection of the provider `openai_compatible` whose base URL is `https://cloud-api.near.ai/v1` gets the same adapter, the same key check and the same attestation.

### Pick a model

Use a canonical model id.
With attestation on, the adapter sends `x-no-aliasing: true`, so an alias such as `glm-latest` is refused by the gateway: the model id is part of the text the enclave signs.

Only models that NEAR runs in its own enclaves can be attested as a model.
On 2026-11-10 those with tool calling were `z-ai/glm-5.3-flash`, `Qwen/Qwen3.8-27B`, `Qwen/Qwen3.6-35B-A3B-FP8` and `deepseek-ai/DeepSeek-V4.1-Flash-1017`.
Models of other vendors (OpenAI, Anthropic, Gemini and others) pass through NEAR's gateway but run outside any enclave; for them the attestation result is `failed` with the reason "no NEAR model report".
`listNearAiCatalog()` returns the current catalogue with hosting, tool support and prices, without a key.

`z-ai/glm-5.3-flash` thinks before it answers and the thinking counts as output tokens, so give it room: a `maxTokens` of a few hundred at least.

### What the attestation check does

Before a request, without sending the key:

1. It generates a random nonce and fetches the attestation report for the gateway and the model.
2. For each report it parses the Intel TDX quote and verifies, in this process, the quote signature, the quoting enclave's signature and the certificate chain up to Intel's root certificate, which is pinned in the code.
3. It reads the measurements from the quote itself and checks that the quote was made for this nonce, that it binds the key the enclave signs answers with, that the measured configuration is the one the report shows, that the runtime event log matches, and that debug mode is off.

After the answer:

4. It hashes the exact bytes it sent and the exact bytes it received.
5. It fetches the signature for the completion and checks that the signed text is those two hashes (with the model id, for a model enclave), and that the signature is valid.
6. It checks that the signer is the key of an enclave verified in steps 1 to 3, before the request.

### What a result means

`turn.attestation` is a `NearAiResponseVerification`: `status`, `summary`, the list of `checks`, the request and response hashes, who signed (`signatureKind`, `signer`) and what the answer is tied to (`boundTo`).
Each check has a `status` (`pass`, `fail`, `not_verified`) and a `trust` (`local` for cryptography done in this process, `remote` for a service's verdict, `none` for a check that did not run).

| Status | Meaning |
| - | - |
| `verified` | Every check passed, which the defaults cannot reach (see below) |
| `partially_verified` | No check failed, and some did not run in this process; the summary names them |
| `failed` | A check failed or evidence was unavailable: treat the answer as unverified |

`boundTo` is `model_enclave` when a model enclave signed the answer (`provider_tee`), `gateway_enclave` when only the gateway signed it, and `null` when the result failed.

A `partially_verified` answer with `boundTo: "model_enclave"` proves this much: the bytes of the request and of the answer were signed by a key that an Intel TDX enclave, running the configuration shown in the report, presented as its own a few minutes earlier, in a quote signed by a platform that Intel certified.

It does not prove the following.
These checks are listed as `not_verified` in every default result:

- That the platform's firmware and TDX module are up to date and that no certificate was revoked (the Intel TCB status).
  That needs signed collateral from Intel and a full DCAP verifier; pass one as `quoteVerifier`.
- That NVIDIA accepts the GPU evidence.
  That is the verdict of NVIDIA's remote attestation service; pass a `gpuVerifier`.
- That the measured software is software you trust.
  The check reports the hash of the configuration; nobody has compared it with an audited build unless you pass `policy.acceptedComposeHashes`.

And it never proves these, whatever the status:

- That the answer is correct, safe or honest.
- That the same serving instance produced the report and the answer: instances of one model share a signing key.
- That nobody saw the prompt on the way: the TLS connection is not tied to the enclave by this check, and end-to-end encryption to the enclave is not used.
- Anything about a model that does not run in a NEAR enclave.

### Modes

`createModelClient(spec, { attestation })`:

- `verify` (default): checks around every turn and reports on the turn; never fails a turn because of attestation.
- `require`: refuses to send the request, key included, when the preflight failed, and discards an answer whose signature fails.
  A `partially_verified` result passes.
- `off`: no attestation requests.

The preflight is reused for five minutes per client.
An attestation costs one extra request per five minutes (about 330 KB) and one small request per turn.

### Functions

- `verifyNearAiAttestation(input)`: checks the body of `GET /v1/attestation/report`; pure, no network.
- `verifyNearAiResponse(input)`: checks a signature against the exact request and response bytes and a preflight result; pure, no network.
- `checkNearAiAttestation(options)`: fetches a report with a fresh nonce and verifies it; needs no key and never throws.
- `fetchNearAiAttestation`, `fetchNearAiSignature`: the two requests on their own.
- `nearaiModel(options)`: the adapter; `client.attest()` returns the current preflight.
- `listNearAiCatalog()`, `listNearAiModels()`, `verifyNearAiKey()`.
- `summarizeAttestation(turn.attestation)`: the few fields worth storing with a run step.
- `parseTdxQuote`, `verifyTdxQuoteLocally`: the quote parser and the offline signature-chain check.

### Tests and fixtures

`test/fixtures/nearai/*.live.json` are recordings of the public endpoints, trimmed as each file's `_fixture` header says.
No API key was available, so completions and signatures in the tests are synthetic: made with throwaway keys in the documented shapes, and labelled so in `test/nearai-fixtures.ts`.
The run that ends in a verified signature from a real model enclave has to be done once by a person with a key: `nearai:check`.
