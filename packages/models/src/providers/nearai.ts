/**
 * NEAR AI Cloud (https://cloud-api.near.ai/v1): private inference in enclaves behind an OpenAI-compatible gateway.
 * Facts and sources: packages/models/SOURCES.md.
 *
 * The chat wire format is OpenAI Chat Completions, so messages, tools and usage are mapped by the OpenAI adapter's
 * functions. What differs, and why this is its own adapter:
 *   - a key cannot be checked with the model list (GET /v1/models is public and answers 200 for any key), so the key
 *     is checked with POST /v1/check_api_key;
 *   - the request is serialized once and the response is kept as raw bytes, because the enclave signs their hashes;
 *   - around every turn the adapter verifies attestation (src/attestation/nearai.ts): the gateway and model enclave
 *     reports before the request, the response signature after it. The result is `turn.attestation`.
 *
 * No streaming: the neutral ModelClient has none, and a non-streamed completion is also the one a model enclave signs
 * itself (the gateway re-signs streams it rewrites).
 */
import { randomBytes } from "node:crypto";
import { ModelError, type ClientOptions, type ModelClient, type ModelTurn, type Provider } from "../model.ts";
import {
  verifyNearAiAttestation,
  verifyNearAiResponse,
  type GpuVerifier,
  type NearAiAttestationPolicy,
  type NearAiAttestationVerification,
  type NearAiSigningAlgo,
  type QuoteVerifier,
} from "../attestation/nearai.ts";
import { DEFAULT_TIMEOUT_MS, errorDetail, httpError, joinUrl, redact, requestJson, withRetries } from "./http.ts";
import { fromOpenAICompletion, openaiHeaders, toOpenAIMessages, toolsOf, type WireCompletion } from "./openai.ts";

export const NEARAI_LABEL = "NEAR AI Cloud";
export const NEARAI_BASE_URL = "https://cloud-api.near.ai/v1";
/** The environment variable NEAR's own SDK reads, used by `nearai:check` and suggested for the agent CLI. */
export const NEARAI_KEY_ENV = "NEARAI_API_KEY";
/** What to tell someone who has to paste a key. */
export const NEARAI_KEY_HINT = "A NEAR AI Cloud API key (it starts with sk-), created under API Keys at https://cloud.near.ai";
/**
 * Models NEAR runs in its own enclaves that list the `tools` feature (GET /v1/models and /v1/model/list, read on
 * 2026-11-10). The first is the default: the cheapest, and the one NEAR's verification examples use.
 */
export const NEARAI_MODELS = ["z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B", "deepseek-ai/DeepSeek-V4.1-Flash-1017"] as const;
export const NEARAI_DEFAULT_MODEL: string = NEARAI_MODELS[0];
export const NEARAI_DOCS_URL = "https://docs.near.ai/cloud/quickstart";
/** For the connection dialog: what choosing NEAR AI Cloud means, and where the key comes from. */
export const NEARAI_NOTE =
  "Private inference in enclaves (Intel TDX and NVIDIA GPUs). The key starts with sk- and comes from API Keys at cloud.near.ai. Payminto checks the enclave attestation and the signature of each answer and shows what was and was not verified. Models hosted by other companies (OpenAI, Anthropic, Gemini and others) pass through NEAR's gateway but do not run in a NEAR enclave.";

/**
 * Hosts served by the NEAR AI Cloud gateway. A connection to one of them gets this adapter whichever provider id it
 * was saved under: `nearai`, or `openai_compatible` with the base URL typed in.
 */
export const NEARAI_HOSTS: readonly string[] = ["cloud-api.near.ai"];

/** True when `baseUrl` points at the NEAR AI Cloud gateway. */
export function isNearAiBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && NEARAI_HOSTS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * `off` sends nothing extra. `verify` (the default) checks attestation around every turn and reports it on the turn
 * without ever failing the turn. `require` also refuses to send the request when the preflight attestation failed,
 * and fails the turn when the response signature failed.
 */
export type NearAiAttestationMode = "off" | "verify" | "require";

type Common = { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; provider?: Provider };

export type NearAiAdapterOptions = ClientOptions & {
  apiKey: string;
  /** A canonical model id, for example z-ai/glm-5.3-flash. With attestation on, an alias is refused by the gateway. */
  model: string;
  baseUrl?: string;
  /** The provider id the client reports (the id the connection was saved under). */
  provider?: Provider;
  /** How long a verified preflight is reused, in milliseconds (default 5 minutes). */
  attestationTtlMs?: number;
  policy?: NearAiAttestationPolicy;
  /** Full DCAP verification of each quote (TCB status); without it that check is reported as not verified. */
  quoteVerifier?: QuoteVerifier;
  /** NVIDIA's verdict on the GPU evidence; without it that check is reported as not verified. */
  gpuVerifier?: GpuVerifier;
  /** How often the signature is asked for while it is not recorded yet (default 4), and the first wait (default 300 ms, doubling). */
  signatureAttempts?: number;
  signatureDelayMs?: number;
  /** The clock (tests pin it). */
  now?: () => Date;
  /** The source of attestation nonces (tests replay a recording); 32 random bytes as hex otherwise. */
  nonce?: () => string;
};

export type NearAiModelClient = ModelClient & {
  /** The preflight attestation of the gateway and of this client's model: fetched and verified now, or reused while fresh. */
  attest(opts?: { signal?: AbortSignal; refresh?: boolean }): Promise<NearAiAttestationVerification>;
};

const DEFAULT_PROVIDER: Provider = "nearai";
const ATTESTATION_TIMEOUT_MS = 30_000;

// ------------------------------------------------------------------ errors

/** NEAR AI Cloud's error bodies are `{ error: { message, type, param, code } }` (recorded in test/fixtures/nearai). */
export function nearaiErrorOf(provider: Provider, apiKey: string) {
  return (status: number, body: unknown, headers: Headers): ModelError => {
    const detail = errorDetail(body);
    const type = (body as { error?: { type?: unknown } } | null)?.error?.type;
    if (status === 401 || status === 403) {
      const what = type === "missing_auth_header" ? "no API key was sent" : detail || "the key was not accepted";
      return httpError(provider, status, `${what}. Create or copy a key under API Keys at https://cloud.near.ai (it starts with sk-)`, { headers, apiKey, label: NEARAI_LABEL });
    }
    // 402: the organization is out of credits or the key hit its spend limit. Waiting does not fix it.
    if (status === 402) {
      const text = `${NEARAI_LABEL} refused the request: no credits left, or the key's spend limit is reached (402)${detail ? `: ${redact(detail, apiKey)}` : ""}. Add credits under Credits at https://cloud.near.ai`;
      return new ModelError("rate_limit", text, { status, provider, retryable: false });
    }
    // 429 is either a rate limit or an overloaded backend; the body says which.
    if (status === 429 && type === "service_overloaded") return httpError(provider, status, detail, { headers, apiKey, kind: "overloaded", label: NEARAI_LABEL });
    return httpError(provider, status, detail, { headers, apiKey, label: NEARAI_LABEL });
  };
}

function request(o: Common, r: { path: string; method?: "GET" | "POST"; query?: Record<string, string>; headers?: Record<string, string>; auth: boolean; bodyText?: string; onRawResponse?: (b: Uint8Array) => void; timeoutMs?: number }): Promise<unknown> {
  const provider = o.provider ?? DEFAULT_PROVIDER;
  const url = new URL(joinUrl(o.baseUrl ?? NEARAI_BASE_URL, r.path));
  for (const [k, v] of Object.entries(r.query ?? {})) url.searchParams.set(k, v);
  return requestJson({
    provider,
    label: NEARAI_LABEL,
    apiKey: o.apiKey,
    url: url.toString(),
    method: r.method,
    headers: { ...(r.auth ? openaiHeaders(o.apiKey) : {}), ...r.headers },
    bodyText: r.bodyText,
    onRawResponse: r.onRawResponse,
    fetch: o.fetch ?? fetch,
    timeoutMs: r.timeoutMs ?? o.timeoutMs ?? 30_000,
    signal: o.signal,
    onError: nearaiErrorOf(provider, o.apiKey),
  });
}

// ------------------------------------------------------------------ key, models

/**
 * Checks the key itself (POST /v1/check_api_key): rejects with kind `auth` for a wrong key and with a non-retryable
 * `rate_limit` when the organization has no credits. Resolves `false` when the endpoint does not exist (a proxy in
 * front of the gateway), so the caller can fall back to a one-token completion.
 */
export async function verifyNearAiKey(o: Common): Promise<boolean> {
  try {
    const body = (await request(o, { path: "check_api_key", method: "POST", auth: true })) as { valid?: unknown };
    if (body.valid === false) throw httpError(o.provider ?? DEFAULT_PROVIDER, 401, "the key is not valid. Create or copy a key under API Keys at https://cloud.near.ai (it starts with sk-)", { apiKey: o.apiKey, label: NEARAI_LABEL });
    return true;
  } catch (err) {
    if (err instanceof ModelError && (err.status === 404 || err.status === 405)) return false;
    throw err;
  }
}

/** GET /v1/models: every model id the gateway serves, sorted. The list is public; it says nothing about the key. */
export async function listNearAiModels(o: Common): Promise<string[] | null> {
  const body = (await request(o, { path: "models", auth: true })) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(body.data)) return null;
  return body.data.flatMap((m) => (typeof m.id === "string" ? [m.id] : [])).sort();
}

export type NearAiCatalogModel = {
  id: string;
  name: string;
  /** `near_tee`: NEAR's own enclaves (attestable here). `third_party_tee`: another provider's enclave. `external`: no enclave. */
  hosting: "near_tee" | "third_party_tee" | "external";
  /** True when GET /v1/attestation/report can return a NEAR model report for it. */
  attestable: boolean;
  tools: boolean;
  contextLength: number | null;
  /** US dollars per million tokens. */
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  aliases: string[];
};

/** GET /v1/model/list (public, no key): the catalogue with pricing and which models run in NEAR's enclaves. */
export async function listNearAiCatalog(o: Omit<Common, "apiKey"> & { apiKey?: string } = {}): Promise<NearAiCatalogModel[]> {
  const body = (await request({ ...o, apiKey: o.apiKey ?? "" }, { path: "model/list", query: { limit: "1000" }, auth: false })) as { models?: unknown };
  if (!Array.isArray(body.models)) return [];
  const usdPerMTok = (p: unknown): number => {
    const d = p as { amount?: unknown; scale?: unknown } | null;
    return typeof d?.amount === "number" && typeof d.scale === "number" ? Number(((d.amount * 1_000_000) / 10 ** d.scale).toFixed(6)) : 0;
  };
  return body.models.flatMap((raw): NearAiCatalogModel[] => {
    const m = raw as { modelId?: unknown; inputCostPerToken?: unknown; outputCostPerToken?: unknown; metadata?: Record<string, unknown> };
    if (typeof m.modelId !== "string") return [];
    const meta = m.metadata ?? {};
    const type = typeof meta.providerType === "string" ? meta.providerType : "external";
    const features = Array.isArray(meta.supportedFeatures) ? meta.supportedFeatures : [];
    return [
      {
        id: m.modelId,
        name: typeof meta.modelDisplayName === "string" ? meta.modelDisplayName : m.modelId,
        hosting: type === "vllm" ? "near_tee" : type === "external" ? "external" : "third_party_tee",
        attestable: type === "vllm" && meta.attestationSupported === true,
        tools: features.includes("tools"),
        contextLength: typeof meta.contextLength === "number" ? meta.contextLength : null,
        inputUsdPerMTok: usdPerMTok(m.inputCostPerToken),
        outputUsdPerMTok: usdPerMTok(m.outputCostPerToken),
        aliases: Array.isArray(meta.aliases) ? meta.aliases.filter((a): a is string => typeof a === "string") : [],
      },
    ];
  });
}

// ------------------------------------------------------------------ attestation requests

export type FetchedNearAiAttestation = {
  /** The nonce this client generated for the request. */
  nonce: string;
  model: string | null;
  /** The parsed response body. */
  report: unknown;
  /** Set when the model report could not be had and `report` is the gateway-only report. */
  modelEvidenceError: string | null;
  fetchedAt: string;
};

/**
 * GET /v1/attestation/report with a fresh client nonce: the gateway report, plus NEAR's model reports when `model` is
 * given. No API key is sent unless `sendKey` is set (the endpoint needs none, so the gateway can be verified before
 * it sees the key). When the gateway has no model report for the model (an external model, an alias), the
 * gateway-only report is fetched instead and `modelEvidenceError` says why.
 */
export async function fetchNearAiAttestation(o: Omit<Common, "apiKey"> & { apiKey?: string; sendKey?: boolean; model?: string | null; nonce?: string; signingAlgo?: NearAiSigningAlgo; maxRetries?: number } = {}): Promise<FetchedNearAiAttestation> {
  const nonce = (o.nonce ?? randomBytes(32).toString("hex")).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new ModelError("bad_request", "the attestation nonce must be 32 bytes as 64 hex characters", { provider: o.provider ?? DEFAULT_PROVIDER });
  const model = o.model?.trim() || null;
  const common: Common = { ...o, apiKey: o.apiKey ?? "" };
  const auth = !!o.sendKey && !!o.apiKey;
  const base = { include_tls_fingerprint: "false", signing_algo: o.signingAlgo ?? "ecdsa", nonce };
  const once = (withModel: boolean) =>
    request(common, { path: "attestation/report", query: withModel ? { model: model!, provider: "near", ...base } : base, headers: withModel ? { "x-no-aliasing": "true" } : {}, auth, timeoutMs: o.timeoutMs ?? ATTESTATION_TIMEOUT_MS });
  // Anonymous requests share a small concurrency limit (429 with Retry-After), so one retry is the default.
  const retries = o.maxRetries ?? 1;
  const done = (report: unknown, modelEvidenceError: string | null): FetchedNearAiAttestation => ({ nonce, model, report, modelEvidenceError, fetchedAt: new Date().toISOString() });
  if (!model) return done(await withRetries(retries, o.signal, () => once(false)), null);
  // 400 (an alias, an unknown model) and 503 "No provider found that supports attestation reports" are about the
  // model, not the gateway: they are not retried, and the gateway's own report is still worth having.
  let modelProblem: ModelError | null = null;
  const withModel = await withRetries(retries, o.signal, async () => {
    try {
      return await once(true);
    } catch (err) {
      if (!(err instanceof ModelError) || !(err.status === 400 || err.status === 404 || err.status === 503)) throw err;
      modelProblem = err;
      return null;
    }
  });
  if (withModel !== null) return done(withModel, null);
  // The gateway's own words, without this adapter's reading of the status ("overloaded" would mislead here).
  const why = (modelProblem as ModelError | null)?.message.replace(/^.*?\(\d{3}\): /, "") ?? "no model report";
  return done(await withRetries(retries, o.signal, () => once(false)), why);
}

export type CheckNearAiAttestationOptions = Parameters<typeof fetchNearAiAttestation>[0] & { policy?: NearAiAttestationPolicy; quoteVerifier?: QuoteVerifier; gpuVerifier?: GpuVerifier; now?: Date };

/** A failed attestation result for evidence that could not be fetched at all. */
function unavailableAttestation(model: string | null, nonce: string, now: Date, why: string): NearAiAttestationVerification {
  const detail = `the attestation report could not be fetched, so nothing is verified (${why})`;
  return {
    kind: "nearai_attestation",
    status: "failed",
    summary: `Attestation failed (${detail}).`,
    checks: [{ id: "report_fetched", scope: "attestation", title: "The attestation report was fetched", status: "fail", trust: "local", detail }],
    model,
    nonce,
    verifiedAt: now.toISOString(),
    gateway: null,
    models: [],
    notVerifiedLocally: [],
  };
}

/**
 * Fetches the attestation report with a fresh nonce and verifies it. Never throws: a report that cannot be fetched is
 * a `failed` result whose only check, `report_fetched`, says why.
 */
export async function checkNearAiAttestation(o: CheckNearAiAttestationOptions = {}): Promise<NearAiAttestationVerification> {
  return (await preflight(o)).result;
}

async function preflight(o: CheckNearAiAttestationOptions): Promise<{ result: NearAiAttestationVerification; fetchError: ModelError | null }> {
  const nonce = (o.nonce ?? randomBytes(32).toString("hex")).toLowerCase();
  let fetched: FetchedNearAiAttestation;
  try {
    fetched = await fetchNearAiAttestation({ ...o, nonce });
  } catch (err) {
    const e = err instanceof ModelError ? err : new ModelError("unknown", err instanceof Error ? err.message : String(err), { provider: o.provider ?? DEFAULT_PROVIDER, cause: err });
    return { result: unavailableAttestation(o.model?.trim() || null, nonce, o.now ?? new Date(), e.message), fetchError: e };
  }
  const result = await verifyNearAiAttestation({ report: fetched.report, nonce, model: fetched.model, modelEvidenceError: fetched.modelEvidenceError, now: o.now, policy: o.policy, quoteVerifier: o.quoteVerifier, gpuVerifier: o.gpuVerifier });
  return { result, fetchError: null };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * GET /v1/signature/{id}: the signature over a completion's request and response hashes. Needs the API key. A 404
 * means "not recorded yet" and is retried a few times; anything else ends the attempt. Never throws: no signature is
 * `{ signature: null, error }`.
 */
export async function fetchNearAiSignature(o: Common & { chatId: string; signingAlgo?: NearAiSigningAlgo; attempts?: number; delayMs?: number }): Promise<{ signature: unknown; error: string | null }> {
  const attempts = Math.max(1, o.attempts ?? 4);
  let wait = o.delayMs ?? 300;
  let last = "no signature was recorded for this completion (404)";
  for (let i = 0; i < attempts; i++) {
    try {
      const signature = await request(o, { path: `signature/${encodeURIComponent(o.chatId)}`, query: { signing_algo: o.signingAlgo ?? "ecdsa" }, auth: true, timeoutMs: o.timeoutMs ?? ATTESTATION_TIMEOUT_MS });
      return { signature, error: null };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      if (!(err instanceof ModelError) || err.status !== 404 || i === attempts - 1) break;
      try {
        await sleep(wait, o.signal);
      } catch {
        break;
      }
      wait *= 2;
    }
  }
  return { signature: null, error: last };
}

// ------------------------------------------------------------------ chat

export function nearaiModel(o: NearAiAdapterOptions): NearAiModelClient {
  const provider = o.provider ?? DEFAULT_PROVIDER;
  const mode: NearAiAttestationMode = o.attestation ?? "verify";
  const now = o.now ?? (() => new Date());
  const ttl = o.attestationTtlMs ?? 5 * 60_000;
  const common: Common = { apiKey: o.apiKey, baseUrl: o.baseUrl, fetch: o.fetch, provider };
  let cached: { result: NearAiAttestationVerification; at: number } | null = null;

  async function attestation(signal: AbortSignal | undefined, refresh: boolean): Promise<{ result: NearAiAttestationVerification; fetchError: ModelError | null }> {
    if (!refresh && cached && now().getTime() - cached.at < ttl) return { result: cached.result, fetchError: null };
    // No key on this request: the gateway is verified before it sees the key.
    const out = await preflight({ ...common, signal, model: o.model, nonce: o.nonce?.(), policy: o.policy, quoteVerifier: o.quoteVerifier, gpuVerifier: o.gpuVerifier, now: now(), maxRetries: Math.max(1, o.maxRetries ?? 0) });
    // A report that could not be fetched is not kept: the next turn asks again. Evidence, good or bad, is kept.
    cached = out.fetchError ? null : { result: out.result, at: now().getTime() };
    return out;
  }

  return {
    provider,
    model: o.model,
    async attest(opts) {
      return (await attestation(opts?.signal, opts?.refresh ?? false)).result;
    },
    async turn(req, opts): Promise<ModelTurn> {
      let pre: NearAiAttestationVerification | null = null;
      if (mode !== "off") {
        const out = await attestation(opts?.signal, false);
        pre = out.result;
        if (mode === "require" && pre.status === "failed") {
          // An unreachable attestation endpoint keeps its own kind (so it is retried); bad evidence is final.
          if (out.fetchError) throw out.fetchError;
          throw new ModelError("bad_request", `${NEARAI_LABEL} attestation failed, so the request was not sent: ${pre.summary}`, { provider, retryable: false });
        }
      }
      // Serialized once: these exact bytes are what the enclave hashes and signs.
      const bodyText = JSON.stringify({
        model: o.model,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: toolsOf(req.tools) } : {}),
        max_tokens: req.maxTokens,
      });
      let raw: Uint8Array = new Uint8Array();
      let sentAt = now();
      const body = (await withRetries(o.maxRetries ?? 0, opts?.signal, () => {
        sentAt = now();
        return request(
          { ...common, signal: opts?.signal },
          {
            path: "chat/completions",
            auth: true,
            bodyText,
            // With attestation on, an alias must fail instead of being rewritten: the model id is part of the signed text.
            headers: mode === "off" ? {} : { "x-no-aliasing": "true" },
            onRawResponse: (b) => {
              raw = b;
            },
            timeoutMs: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          },
        );
      })) as WireCompletion & { id?: unknown };
      const turn = fromOpenAICompletion(body, o.model, provider);
      if (mode === "off" || !pre) return turn;

      const chatId = typeof body.id === "string" && body.id ? body.id : null;
      const sig = chatId
        ? await fetchNearAiSignature({ ...common, signal: opts?.signal, chatId, attempts: o.signatureAttempts, delayMs: o.signatureDelayMs })
        : { signature: null, error: "the completion has no id to fetch a signature for" };
      const verification = verifyNearAiResponse({ requestBody: bodyText, responseBody: raw, model: o.model, signature: sig.signature, signatureError: sig.error, attestation: pre, chatId, requestSentAt: sentAt });
      if (mode === "require" && verification.status === "failed") {
        throw new ModelError("unknown", `${NEARAI_LABEL} answered, but the answer could not be verified and was discarded: ${verification.summary}`, { provider, retryable: false });
      }
      return { ...turn, attestation: verification };
    },
  };
}
