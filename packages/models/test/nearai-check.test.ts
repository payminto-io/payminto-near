/**
 * `nearai:check` against a local mock of the gateway: every way it can end, and that each failure says what to do
 * next. Catalogue, attestation report and error bodies are LIVE recordings; the completion and its signature are
 * SYNTHETIC (see nearai-fixtures.ts). The run that ends with exit code 0 needs a real key and is not covered here:
 * no throwaway key can sign as the enclave of the recorded report.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT, runNearAiCheck } from "../scripts/nearai-check.ts";
import { mockProvider, type MockAnswer, type MockProvider, type SeenRequest } from "./mock-provider.ts";
import { LIVE_MODEL, LIVE_NONCE, LIVE_NOW, ecdsaKey, eip191Sign, liveErrors, liveModelList, liveModels, liveReport, signatureBody } from "./nearai-fixtures.ts";

const KEY = "sk-test-SECRET0123456789";
const errors = liveErrors();
const reply = { id: "chatcmpl-synthetic-1", object: "chat.completion", model: LIVE_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } };
const stranger = ecdsaKey(9);

let m: MockProvider;
beforeEach(async () => {
  m = await mockProvider();
});
afterEach(async () => {
  await m.close();
});

type Routes = Partial<Record<"catalog" | "report" | "check" | "models" | "chat" | "signature", MockAnswer>>;

async function run(env: Record<string, string>, routes: Routes = {}) {
  // A fresh gateway for every run: nothing queued for an earlier run answers this one.
  await m.close();
  m = await mockProvider();
  let sent = "";
  const route = (r: SeenRequest): MockAnswer => {
    const path = r.path.split("?")[0]!;
    if (path === "/v1/model/list") return routes.catalog ?? { json: liveModelList() };
    if (path === "/v1/attestation/report") return routes.report ?? { json: liveReport() };
    if (path === "/v1/check_api_key") return routes.check ?? { json: { valid: true, organization_id: "o", workspace_id: "w", api_key_id: "k" } };
    if (path === "/v1/models") return routes.models ?? { json: liveModels() };
    if (path === "/v1/chat/completions") {
      sent = JSON.stringify(r.body);
      return routes.chat ?? { json: reply };
    }
    if (path.startsWith("/v1/signature/")) return routes.signature ?? { json: signatureBody({ kind: "provider_tee", model: LIVE_MODEL, request: sent, response: JSON.stringify(reply), sign: (t) => eip191Sign(t, stranger), signer: stranger.signer }) };
    return { status: 404, text: "not found" };
  };
  m.answer(...Array.from({ length: 12 }, () => route));
  const lines: string[] = [];
  const code = await runNearAiCheck({ env, out: (l) => lines.push(l), fetch: (input, init) => fetch(String(input).replace("https://cloud-api.near.ai", m.url), init), now: () => LIVE_NOW, nonce: () => LIVE_NONCE });
  const text = lines.join("\n");
  // Whatever happens, the key is never printed, and nothing uses an em dash.
  expect(text).not.toContain("SECRET");
  expect(text).not.toMatch(/\u2014/);
  return { code, text, paths: m.requests.map((r) => `${r.method} ${r.path.split("?")[0]}`) };
}

describe("nearai:check", () => {
  it("without a key: checks the catalogue and the attestation, then says how to get a key", async () => {
    const r = await run({});
    expect(r.code).toBe(EXIT.noKey);
    expect(r.paths).toEqual(["GET /v1/model/list", "GET /v1/attestation/report"]);
    expect(m.requests.every((x) => x.headers.authorization === undefined)).toBe(true);
    expect(r.text).toMatch(/key: {6}NEARAI_API_KEY is not set/);
    expect(r.text).toMatch(/z-ai\/glm-5\.3-flash: runs in a NEAR enclave, tools yes, \$0\.0800 in and \$0\.5000 out per million tokens/);
    expect(r.text).toMatch(/result: PARTIALLY VERIFIED/);
    expect(r.text).toMatch(/\[open\] model:0 {5}NVIDIA accepts the GPU evidence\n {9}not verified locally/);
    expect(r.text).toMatch(/What to do next:\n {2}1\. Sign in at https:\/\/cloud\.near\.ai/);
    expect(r.text).toMatch(/export NEARAI_API_KEY=<the key>/);
  });

  it("a rejected key: says to copy it again from cloud.near.ai", async () => {
    const r = await run({ NEARAI_API_KEY: KEY }, { check: { status: 401, json: errors.invalid_key.body } });
    expect(r.code).toBe(EXIT.badKey);
    expect(r.text).toMatch(/key: {6}NEARAI_API_KEY is set \(not shown\)/);
    expect(r.text).toMatch(/FAILED: NEAR AI Cloud rejected the API key \(401\): Invalid or expired API key/);
    expect(r.text).toMatch(/What to do next:\n {2}- The key in NEARAI_API_KEY was not accepted\. Copy it again from API Keys at https:\/\/cloud\.near\.ai/);
    expect(r.paths).not.toContain("POST /v1/chat/completions");

    // A gateway that echoes the key back in its error: still not printed (asserted in run).
    await run({ NEARAI_API_KEY: KEY }, { check: { status: 401, json: { error: { message: `Invalid or expired API key: ${KEY}`, type: "invalid_api_key" } } } });
  });

  it("no credits: says where to add them", async () => {
    const atCheck = await run({ NEARAI_API_KEY: KEY }, { check: { status: 402, json: { error: { message: "Insufficient credits", type: "insufficient_credits" } } } });
    expect(atCheck.code).toBe(EXIT.noCredits);
    expect(atCheck.text).toMatch(/no credits left, or the key's spend limit is reached \(402\)/);
    expect(atCheck.text).toMatch(/What to do next:\n {2}- The key is valid, but the organization has no credits.*\n {2}- Add credits under Credits at https:\/\/cloud\.near\.ai/);

    const atChat = await run({ NEARAI_API_KEY: KEY }, { chat: { status: 402, json: { error: { message: "Insufficient credits", type: "insufficient_credits" } } } });
    expect(atChat.code).toBe(EXIT.noCredits);
  });

  it("a model that is an alias or does not exist: names the canonical id and the models to pick from", async () => {
    const alias = await run({ NEARAI_MODEL: "glm-latest" });
    expect(alias.code).toBe(EXIT.badModel);
    expect(alias.text).toMatch(/FAILED: glm-latest is an alias of z-ai\/glm-5\.3-flash, not a canonical model id/);
    expect(alias.text).toMatch(/Use the canonical id: export NEARAI_MODEL=z-ai\/glm-5\.3-flash/);
    expect(alias.paths).toEqual(["GET /v1/model/list"]);

    const unknown = await run({ NEARAI_MODEL: "acme/nope" });
    expect(unknown.code).toBe(EXIT.badModel);
    expect(unknown.text).toMatch(/FAILED: acme\/nope is not in the catalogue/);
    expect(unknown.text).toMatch(/Models in NEAR's enclaves with tool calling: .*Qwen\/Qwen3\.8-27B/);

    // The gateway's own refusal of a model at completion time is explained the same way.
    const refused = await run({ NEARAI_API_KEY: KEY }, { chat: { status: 400, json: errors.alias_with_no_aliasing.body } });
    expect(refused.code).toBe(EXIT.badModel);
    expect(refused.text).toMatch(/Use a canonical id from: curl https:\/\/cloud-api\.near\.ai\/v1\/models/);
  });

  it("an unreachable service or attestation endpoint: says how to test the connection", async () => {
    const down = await run({}, { catalog: { status: 502, text: "bad gateway" } });
    expect(down.code).toBe(EXIT.attestation);
    expect(down.text).toMatch(/FAILED: NEAR AI Cloud is overloaded or failing \(502\)/);
    expect(down.text).toMatch(/Check that this machine can reach https:\/\/cloud-api\.near\.ai\/v1 \(try: curl/);

    const noReport = await run({ NEARAI_API_KEY: KEY }, { report: { status: 502, text: "bad gateway" } });
    expect(noReport.code).toBe(EXIT.attestation);
    expect(noReport.text).toMatch(/\[FAIL\] attestation The attestation report was fetched\n {9}the attestation report could not be fetched, so nothing is verified/);
    expect(noReport.text).toMatch(/The attestation endpoint did not answer: curl -sS "https:\/\/cloud-api\.near\.ai\/v1\/attestation\/report\?signing_algo=ecdsa&nonce=\$\(openssl rand -hex 32\)"/);
    expect(noReport.text).toMatch(/wait a minute and run this again/);
    // The key is not sent to a gateway that could not be attested.
    expect(m.requests.every((x) => x.headers.authorization === undefined)).toBe(true);
  });

  it("evidence that fails verification: says not to trust the endpoint", async () => {
    const stale = liveReport();
    stale.gateway_attestation.event_log = "[]";
    const r = await run({ NEARAI_API_KEY: KEY }, { report: { json: stale } });
    expect(r.code).toBe(EXIT.attestation);
    expect(r.text).toMatch(/result: FAILED/);
    expect(r.text).toMatch(/\[FAIL\] gateway {5}The runtime event log matches the quote/);
    expect(r.text).toMatch(/Do not treat answers from this endpoint as coming from an attested enclave/);
    expect(r.paths).not.toContain("POST /v1/check_api_key");
  });

  it("an answer whose signature is not the enclave's: prints the hashes and says the answer is unverified", async () => {
    const r = await run({ NEARAI_API_KEY: KEY });
    expect(r.paths).toEqual(["GET /v1/model/list", "GET /v1/attestation/report", "POST /v1/check_api_key", "GET /v1/models", "POST /v1/chat/completions", "GET /v1/signature/chatcmpl-synthetic-1"]);
    expect(r.code).toBe(EXIT.attestation);
    expect(r.text).toMatch(/the key is accepted; the connection lists 6 models/);
    expect(r.text).toMatch(/answer: "ok" \(stop: end, model: z-ai\/glm-5\.3-flash\)/);
    expect(r.text).toMatch(/usage: {2}20 input and 30 output tokens, about \$0\.000017 at list price/);
    expect(r.text).toMatch(/request hash: {2}[0-9a-f]{64}\n {2}response hash: [0-9a-f]{64}\n {2}signed by: {5}0x[0-9a-f]{40} \(model enclave\)/);
    expect(r.text).toMatch(/\[FAIL\] response {4}The signer is the key of an enclave verified before the request/);
    expect(r.text).toMatch(/Treat this answer as unverified/);

    const none = await run({ NEARAI_API_KEY: KEY }, { signature: { status: 404, json: { error: { message: "Signature not found" } } } });
    expect(none.code).toBe(EXIT.attestation);
    expect(none.text).toMatch(/signed by: {5}nobody \(no signature\)/);
  }, 30_000);
});
