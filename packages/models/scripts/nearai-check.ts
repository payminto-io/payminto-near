/**
 * pnpm --filter @payminto/models nearai:check
 *
 * Checks a NEAR AI Cloud setup from end to end and says what to do when a step fails:
 *   1. the public model catalogue (no key): is the model there, does it run in a NEAR enclave;
 *   2. the enclave attestation of the gateway and of the model (no key);
 *   3. the API key (NEARAI_API_KEY);
 *   4. one tiny completion, and the verification of its signature.
 * Steps 1 and 2 run without a key. The key is read from the environment and never printed.
 *
 * Environment: NEARAI_API_KEY (needed for steps 3 and 4), NEARAI_MODEL (default z-ai/glm-5.3-flash),
 * NEARAI_BASE_URL (default https://cloud-api.near.ai/v1).
 *
 * Exit codes: 0 everything ran and the answer's signature checks did not fail; 2 no API key (steps 1 and 2 ran);
 * 3 the key was rejected; 4 no credits; 5 the model id is unknown or an alias; 6 NEAR AI Cloud or its attestation
 * endpoint is unreachable, or attestation failed; 7 the completion failed for another reason; 1 anything unexpected.
 */
import { pathToFileURL } from "node:url";
import { ModelError, textOf, type AttestationCheck, type TurnAttestation } from "../src/model.ts";
import { verifyConnection } from "../src/providers/index.ts";
import { NEARAI_BASE_URL, NEARAI_DEFAULT_MODEL, NEARAI_KEY_ENV, listNearAiCatalog, nearaiModel, type NearAiCatalogModel } from "../src/providers/nearai.ts";
import type { NearAiResponseVerification } from "../src/attestation/nearai.ts";

export const EXIT = { ok: 0, unexpected: 1, noKey: 2, badKey: 3, noCredits: 4, badModel: 5, attestation: 6, completion: 7 } as const;

export type CheckOptions = {
  env?: Record<string, string | undefined>;
  /** Where lines go (default: stdout). */
  out?: (line: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
};

const KEY_HELP = [
  `  1. Sign in at https://cloud.near.ai (Google, GitHub or a NEAR account).`,
  `  2. Add credits under Credits. If your hackathon hands out a NEAR AI Cloud coupon or a ready-made builder key, use that instead.`,
  `  3. Create a key under API Keys. It starts with sk-.`,
  `  4. export ${NEARAI_KEY_ENV}=<the key>   (do not paste it into a file that is committed)`,
  `  5. Run this command again.`,
];

function mark(c: AttestationCheck): string {
  return c.status === "pass" ? "[pass]" : c.status === "fail" ? "[FAIL]" : "[open]";
}

function printAttestation(out: (l: string) => void, a: TurnAttestation): void {
  out(`  result: ${a.status.toUpperCase().replace("_", " ")}`);
  out(`  ${a.summary}`);
  for (const c of a.checks) out(`  ${mark(c)} ${c.scope.padEnd(11)} ${c.title}${c.status === "pass" ? "" : `\n         ${c.detail}`}`);
  out(`  [pass] checked in this process, [open] not verified here, [FAIL] failed`);
}

const usd = (n: number) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;

/** Runs the check and resolves with the exit code. Never prints the key. */
export async function runNearAiCheck(o: CheckOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  const out = o.out ?? ((l: string) => console.log(l));
  const apiKey = env[NEARAI_KEY_ENV]?.trim() ?? "";
  const baseUrl = (env.NEARAI_BASE_URL?.trim() || NEARAI_BASE_URL).replace(/\/+$/, "");
  const model = env.NEARAI_MODEL?.trim() || NEARAI_DEFAULT_MODEL;
  const say = (text: string) => out(apiKey && apiKey.length >= 4 ? text.split(apiKey).join("[key]") : text);
  const next = (...lines: string[]) => {
    say("  What to do next:");
    for (const l of lines) say(l.startsWith("  ") ? l : `  - ${l}`);
  };

  say("NEAR AI Cloud check");
  say(`  endpoint: ${baseUrl}`);
  say(`  model:    ${model}`);
  say(`  key:      ${apiKey ? `${NEARAI_KEY_ENV} is set (not shown)` : `${NEARAI_KEY_ENV} is not set`}`);

  // ---------------------------------------------------------------- 1. catalogue (public)
  say("");
  say("1. Model catalogue (public, no key)");
  let entry: NearAiCatalogModel | undefined;
  try {
    const catalog = await listNearAiCatalog({ baseUrl, fetch: o.fetch });
    const tee = catalog.filter((m) => m.hosting === "near_tee");
    say(`  ${catalog.length} models, ${tee.length} of them in NEAR's own enclaves, ${tee.filter((m) => m.tools).length} of those with tool calling`);
    entry = catalog.find((m) => m.id === model);
    if (!entry) {
      const canonical = catalog.find((m) => m.aliases.includes(model));
      say(`  FAILED: ${model} is ${canonical ? `an alias of ${canonical.id}, not a canonical model id` : "not in the catalogue"}`);
      const suggestions = tee.filter((m) => m.tools).map((m) => `${m.id} (${usd(m.inputUsdPerMTok)} in, ${usd(m.outputUsdPerMTok)} out per million tokens)`);
      next(
        canonical ? `Use the canonical id: export NEARAI_MODEL=${canonical.id}. An alias is refused when attestation is on, because the model id is part of what the enclave signs.` : `Pick a model id from the catalogue: export NEARAI_MODEL=<id>.`,
        `Models in NEAR's enclaves with tool calling: ${suggestions.join("; ") || "none listed"}.`,
        `The full list: curl ${baseUrl}/models`,
      );
      return EXIT.badModel;
    }
    say(`  ${entry.id}: ${entry.hosting === "near_tee" ? "runs in a NEAR enclave" : entry.hosting === "third_party_tee" ? "runs in another provider's enclave (not attestable here)" : "runs outside any enclave, at the model's own vendor"}, tools ${entry.tools ? "yes" : "no"}, ${usd(entry.inputUsdPerMTok)} in and ${usd(entry.outputUsdPerMTok)} out per million tokens`);
    if (entry.hosting !== "near_tee") say(`  NOTE: only the gateway can be attested for this model. For an answer signed by a model enclave pick one of: ${tee.filter((m) => m.tools).map((m) => m.id).join(", ")}.`);
  } catch (err) {
    say(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    next(
      `Check that this machine can reach ${baseUrl} (try: curl -sS ${baseUrl}/models | head -c 200).`,
      env.NEARAI_BASE_URL ? `NEARAI_BASE_URL is set to ${baseUrl}; unset it to use ${NEARAI_BASE_URL}.` : `Behind a proxy or firewall, allow HTTPS to cloud-api.near.ai.`,
      `If the service itself is down, try again in a few minutes.`,
    );
    return EXIT.attestation;
  }

  // ---------------------------------------------------------------- 2. attestation (public)
  const client = nearaiModel({ apiKey, model, baseUrl, fetch: o.fetch, attestation: "verify", maxRetries: 2, now: o.now, nonce: o.nonce, policy: { requireModelEvidence: entry.hosting === "near_tee" } });
  say("");
  say("2. Enclave attestation of the gateway and the model (public, no key)");
  const preflight = await client.attest();
  printAttestation(say, preflight);
  const unreachable = preflight.checks.some((c) => c.id === "report_fetched");
  if (unreachable) {
    next(
      `The attestation endpoint did not answer: curl -sS "${baseUrl}/attestation/report?signing_algo=ecdsa&nonce=$(openssl rand -hex 32)" | head -c 200`,
      `Requests without a key share a small concurrency limit; wait a minute and run this again.`,
      `Until it answers, Payminto still runs the model but reports every answer as unverified (or refuses to send, in "require" mode).`,
    );
    return EXIT.attestation;
  }
  if (preflight.status === "failed") {
    next(
      `Do not treat answers from this endpoint as coming from an attested enclave: a check above failed.`,
      `Run the command again: evidence is fetched fresh each time. If it keeps failing, compare with NEAR's own page at https://cloud.near.ai/verify and report the failing check to NEAR.`,
      env.NEARAI_BASE_URL ? `NEARAI_BASE_URL is set to ${baseUrl}; make sure it is the real gateway.` : `Make sure nothing between this machine and cloud-api.near.ai rewrites responses (a caching proxy would replay an old report).`,
    );
    return EXIT.attestation;
  }

  // ---------------------------------------------------------------- 3. key
  say("");
  say("3. API key");
  if (!apiKey) {
    say(`  ${NEARAI_KEY_ENV} is not set, so the key check and the test completion were skipped. Steps 1 and 2 above need no key.`);
    next(...KEY_HELP);
    return EXIT.noKey;
  }
  // The same check the dashboard runs when a NEAR AI Cloud connection is saved.
  const verified = await verifyConnection({ provider: "nearai", apiKey, baseUrl, model }, { fetch: o.fetch });
  if (!verified.ok) {
    say(`  FAILED: ${verified.error.message}`);
    return explain(verified.error, next, baseUrl);
  }
  say(`  the key is accepted${verified.models ? `; the connection lists ${verified.models.length} models` : ""}`);

  // ---------------------------------------------------------------- 4. completion
  say("");
  say("4. One tiny completion, then its signature");
  let turn;
  try {
    turn = await client.turn({ system: "You are a connection test. Follow the instruction exactly.", tools: [], messages: [{ role: "user", parts: [{ type: "text", text: "Reply with the word ok." }] }], maxTokens: 512 });
  } catch (err) {
    const e = err instanceof ModelError ? err : new ModelError("unknown", err instanceof Error ? err.message : String(err));
    say(`  FAILED: ${e.message}`);
    return explain(e, next, baseUrl);
  }
  const cost = (turn.usage.inputTokens * entry.inputUsdPerMTok + turn.usage.outputTokens * entry.outputUsdPerMTok) / 1_000_000;
  say(`  answer: ${JSON.stringify(textOf(turn).slice(0, 200))} (stop: ${turn.stop}, model: ${turn.model})`);
  say(`  usage:  ${turn.usage.inputTokens} input and ${turn.usage.outputTokens} output tokens, about ${usd(cost)} at list price`);
  const a = turn.attestation as NearAiResponseVerification | undefined;
  if (!a) {
    say("  FAILED: the turn carries no attestation result");
    return EXIT.unexpected;
  }
  say(`  request hash:  ${a.requestHash}`);
  say(`  response hash: ${a.responseHash}`);
  say(`  signed by:     ${a.signer ? `${a.signer.address} (${a.signatureKind === "provider_tee" ? "model enclave" : a.signatureKind === "gateway" ? "gateway enclave" : "unknown kind"})` : "nobody (no signature)"}`);
  printAttestation(say, a);
  for (const l of a.limits) say(`  limit: ${l}`);
  if (a.status === "failed") {
    next(
      `Treat this answer as unverified. Run the command again: a signature that was not recorded yet can appear a moment later.`,
      `If the failing check is signed_text or signature_valid, something changed the bytes between the enclave and this machine: check proxies, then report it to NEAR.`,
      `If the failing check is signer_attested, the answer was signed by a key that was not in the report fetched in step 2 (the deployment may have rotated): run again.`,
    );
    return EXIT.attestation;
  }
  say("");
  const open = a.status === "verified" ? "Every check passed." : "Read the [open] lines above: they are what this check did not verify.";
  say(a.boundTo === "model_enclave" ? `OK: the connection works, and this answer is signed by the key of a model enclave whose attestation was checked. ${open}` : `OK: the connection works. This answer is signed by the key of the gateway enclave, not of a model enclave. ${open}`);
  return EXIT.ok;
}

function explain(e: ModelError, next: (...lines: string[]) => void, baseUrl: string): number {
  if (e.kind === "auth") {
    next(
      `The key in ${NEARAI_KEY_ENV} was not accepted. Copy it again from API Keys at https://cloud.near.ai: the whole value, starting with sk-, with no quotes or spaces.`,
      `A revoked or expired key has to be replaced: create a new one under API Keys.`,
      `A key from another service (OpenAI, OpenRouter) does not work here.`,
    );
    return EXIT.badKey;
  }
  if (e.status === 402) {
    next(`The key is valid, but the organization has no credits or the key reached its spend limit.`, `Add credits under Credits at https://cloud.near.ai, or raise the key's spend limit under API Keys, then run this again.`);
    return EXIT.noCredits;
  }
  if (e.kind === "bad_request" && /model|alias/i.test(e.message)) {
    next(`The gateway refused the model id. Use a canonical id from: curl ${baseUrl}/models`, `export NEARAI_MODEL=<id>, then run this again.`);
    return EXIT.badModel;
  }
  if (e.kind === "network" || e.kind === "timeout" || e.kind === "overloaded") {
    next(`NEAR AI Cloud could not be reached or is busy. Check the network, then run this again in a minute.`);
    return EXIT.attestation;
  }
  if (e.kind === "rate_limit") {
    next(`The key is rate limited${e.retryAfterMs ? `; wait ${Math.ceil(e.retryAfterMs / 1000)} s` : ""} and run this again.`);
    return EXIT.completion;
  }
  next(`Read the message above; if it does not say what is wrong, run this again and report the message to NEAR support with the X-Request-Id of the request.`);
  return EXIT.completion;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNearAiCheck().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      // Never the key: only the message of an unexpected error.
      console.error(`nearai:check failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = EXIT.unexpected;
    },
  );
}
