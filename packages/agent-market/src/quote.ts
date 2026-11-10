import { randomUUID } from "node:crypto";
import { z } from "zod";
import { formatAmount } from "@payminto/protocol";
import type { MarketClient } from "./client.ts";
import { MARKET_NETWORK, MAX_QUOTE_TIMEOUT_SECONDS, MAX_SMALL_RESPONSE_BYTES, NEAR_MAINNET_USDC, USDC_DECIMALS } from "./constants.ts";
import { MarketError } from "./errors.ts";
import { argument, parseJson, parseWith } from "./http.ts";
import { refuse, type MarketRefusal } from "./refusal.ts";
import { atomicOrZeroSchema, atomicSchema, exactRequirementSchema, paymentChallengeSchema, rpcErrorSchema, type ExactRequirement } from "./schemas.ts";

/** The longest task text sent with a quote request. The market refuses bodies over 256 KiB. */
export const MAX_TASK_CHARS = 100_000;
const MAX_ROW_CHARS = 2_048;
const DAY_SECONDS = 86_400;

/** The A2A `SendMessage` request. A paid call repeats exactly the request that was quoted. */
export type SendMessageRequest = {
  jsonrpc: "2.0";
  id: number;
  method: "SendMessage";
  params: { message: { messageId: string; role: "ROLE_USER"; parts: [{ text: string }] }; configuration: { historyLength: 0 } };
};

/** One way to pay: the validated requirement, and the row exactly as the market sent it, which is what gets signed. */
export type ExactOption = { requirement: ExactRequirement; accepted: Record<string, unknown> };

/** A price the market quoted for one call to one agent. Asking for it is free and creates no job. */
export type Quote = {
  handle: string;
  /** The agent's A2A endpoint on its own market host. */
  endpoint: string;
  request: SendMessageRequest;
  /** Every `exact` row of the 402, in the market's order. */
  options: ExactOption[];
  /** Unix seconds. */
  quotedAt: number;
};

export function sendMessageRequest(task: string, messageId: string = randomUUID()): SendMessageRequest {
  if (typeof task !== "string" || task.trim().length === 0) throw new MarketError("INVALID_ARGUMENT", "the task text is empty");
  if (task.length > MAX_TASK_CHARS) throw new MarketError("INVALID_ARGUMENT", `the task text is longer than ${MAX_TASK_CHARS} characters`);
  return { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId, role: "ROLE_USER", parts: [{ text: task }] }, configuration: { historyLength: 0 } } };
}

/** Reads the `exact` rows of a decoded 402 body. Rows of other schemes are skipped; a malformed `exact` row is an error. */
export function parseChallenge(body: unknown): ExactOption[] {
  const version = body !== null && typeof body === "object" ? (body as { x402Version?: unknown }).x402Version : undefined;
  if (version !== 2) throw new MarketError("UNSUPPORTED_VERSION", `the quote has x402Version ${JSON.stringify(version ?? null)}; only 2 is supported`);
  const challenge = parseWith(paymentChallengeSchema, body, "the quote");
  if (challenge.accepts.length === 0) throw new MarketError("NO_PAYMENT_OPTIONS", "the quote lists no way to pay");
  const options: ExactOption[] = [];
  for (const row of challenge.accepts) {
    if (row === null || typeof row !== "object" || Array.isArray(row) || (row as { scheme?: unknown }).scheme !== "exact") continue;
    if (JSON.stringify(row).length > MAX_ROW_CHARS) throw new MarketError("MALFORMED_RESPONSE", "a payment row of the quote is oversized");
    options.push({ requirement: parseWith(exactRequirementSchema, row, "a payment row of the quote"), accepted: row as Record<string, unknown> });
  }
  if (options.length === 0) throw new MarketError("MALFORMED_RESPONSE", "the quote has no row with the exact scheme");
  return options;
}

export type QuoteOptions = { client: MarketClient; signal?: AbortSignal; messageId?: string };

/**
 * Asks an agent what one call costs: an A2A `SendMessage` without payment, which the market answers with HTTP 402 and
 * the price. It is free, needs no account and no key, opens no job, and sends no credential.
 *
 * Throws a MarketError when there is no price to act on: AGENT_UNAVAILABLE when the agent cannot take a call now,
 * NOT_FOUND for an unknown handle, MALFORMED_RESPONSE for a quote that does not have the documented shape.
 */
export async function quoteAgent(handle: string, task: string, o: QuoteOptions): Promise<Quote> {
  const endpoint = o.client.a2aEndpoint(handle);
  const request = sendMessageRequest(task, o.messageId);
  const res = await o.client.http.send({ url: endpoint, method: "POST", json: request, timeoutMs: o.client.timeoutMs, maxBytes: MAX_SMALL_RESPONSE_BYTES, ...(o.signal ? { signal: o.signal } : {}) });
  const what = `the quote of ${handle}`;
  if (res.status === 402) return { handle, endpoint, request, options: parseChallenge(parseJson(res.text, what, 402)), quotedAt: Math.floor(o.client.http.clock.now() / 1000) };
  if (res.status === 404) {
    throw new MarketError("NOT_FOUND", `no published agent has the handle ${handle}`, { status: 404, nextStep: `Check the spelling of ${handle}, or run \`market search <query>\` to find live agents.` });
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new MarketError("RATE_LIMITED", `${what} was rate limited`, { status: 429, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(Math.ceil(retryAfter), 3_600) : 60 });
  }
  if (res.status === 200) {
    const rpc = rpcErrorSchema.safeParse(parseJson(res.text, what, 200));
    if (!rpc.success) throw new MarketError("UNEXPECTED_RESPONSE", `${what} came back without a price and without an error`, { status: 200 });
    const { code, message } = rpc.data.error;
    if (code === -32603) {
      throw new MarketError("AGENT_UNAVAILABLE", `${handle} has no reachable backend right now`, { rpcCode: code, nextStep: `The agent ${handle} is listed but not answering. Try again in a few minutes, or pick another agent with \`market search <query>\`.` });
    }
    if (code === -32004) {
      throw new MarketError("AGENT_UNAVAILABLE", `${handle} is not taking calls (paused, suspended or without a live price)`, { rpcCode: code, nextStep: `The agent ${handle} is not live for calls. Pick another agent with \`market search <query>\`.` });
    }
    throw new MarketError("RPC_ERROR", `${what} was refused with JSON-RPC ${code}: ${message.replace(/[^\x20-\x7e]+/g, " ").slice(0, 200)}`, { rpcCode: code });
  }
  throw new MarketError(res.status >= 500 ? "SERVER" : "HTTP", `${what} answered HTTP ${res.status}`, { status: res.status });
}

// ------------------------------------------------------------------------------------------------- policy

const policySchema = z.strictObject({
  /** The most one hire may cost, in atomic units of `asset`. */
  maxPerHire: atomicOrZeroSchema,
  /** The most all hires together may cost in any 24 hours, in atomic units of `asset`. */
  maxPerDay: atomicOrZeroSchema,
  /** The one token contract the owner allows hires to be paid in. */
  asset: z.string().min(1).max(128),
  /** The one network the owner allows hires to be paid on, for example `near:mainnet`. */
  network: z.string().min(1).max(64),
  /** Refuse a payment that would stay valid (chargeable on delivery) for longer than this. */
  maxValiditySeconds: z.number().int().min(1).max(MAX_QUOTE_TIMEOUT_SECONDS).optional(),
  /** Refuse when the payee check answers `warn`. Default: allow, and carry the warning. */
  refuseOnWarn: z.boolean().optional(),
});
export type HirePolicy = z.infer<typeof policySchema>;

/** A policy for the market as it is today: USDC on NEAR mainnet. Amounts are atomic units (six decimals). */
export const usdcPolicy = (o: { maxPerHire: string; maxPerDay: string } & Pick<HirePolicy, "maxValiditySeconds" | "refuseOnWarn">): HirePolicy => ({ asset: NEAR_MAINNET_USDC, network: MARKET_NETWORK, ...o });

/**
 * What a separate payee check says about the account a quote pays. This package only consumes it.
 * A `Verdict` from `@payminto/payee-check` fits as it is: its `verdict`, `payee` and `signals` are read, the rest is
 * ignored.
 */
export type PayeeVerdict = {
  verdict: "allow" | "warn" | "block";
  /** The account the verdict is about. When given, it must be the account the quote pays. */
  payee?: string;
  /** A short machine code or sentence from the checker. Cut and cleaned before it is shown. */
  reason?: string;
  /** The signals that fired, heaviest first. Without a `reason`, the first one explains the verdict. */
  signals?: ReadonlyArray<{ id: string; severity?: string; reason?: string }>;
};
const verdictSchema = z.object({
  verdict: z.enum(["allow", "warn", "block"]),
  payee: z.string().max(128).optional(),
  reason: z.string().max(2_000).optional(),
  signals: z
    .array(z.object({ id: z.string().max(64), severity: z.string().max(16).optional(), reason: z.string().max(2_000).optional() }))
    .max(64)
    .optional(),
});

/** A hire that was paid: the amount in atomic units and when, in Unix seconds. */
export type HireRecord = { amount: string; at: number };
const hireSchema = z.object({ amount: atomicSchema, at: z.number().int().min(0) });

export type QuoteDecision =
  | {
      decision: "allow";
      handle: string;
      /** The row to pay, chosen by the policy's network and asset. */
      option: ExactOption;
      /** What would be left of the rolling 24h maximum after this hire, in atomic units. */
      remainingAfter: string;
      /** Things the owner should see even though the hire is allowed, for example a payee warning. */
      warnings: string[];
    }
  | { decision: "refuse"; handle: string; refusal: MarketRefusal };

export type CheckQuoteInput = {
  quote: Quote;
  policy: HirePolicy;
  payeeVerdict?: PayeeVerdict;
  /** Hires already paid. Only those of the last 24 hours count. */
  recentHires?: readonly HireRecord[];
  /** Unix seconds. Defaults to the system clock. */
  now?: number;
};

/** Text from another checker or party, reduced to one printable line. */
const clean = (s: string) => s.replace(/[^\x21-\x7e]+/g, " ").trim().slice(0, 160);

/**
 * Decides whether a quote may be paid, before anything is signed. Pure: no network, no clock unless `now` is left out.
 *
 * It refuses with a machine-readable reason when the quote names another network or asset than the policy, when the
 * payee check blocks the payee, when the price is above the per-hire maximum, or when the hire would take the last 24
 * hours over the daily maximum. The quote's own text never reaches the decision: only its validated numbers and ids do.
 */
export function checkQuote(input: CheckQuoteInput): QuoteDecision {
  const policy = argument(policySchema, input.policy, "policy");
  const verdict = input.payeeVerdict === undefined ? undefined : argument(verdictSchema, input.payeeVerdict, "payee verdict");
  const hires = argument(z.array(hireSchema).max(100_000), input.recentHires ?? [], "recent hires");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const { quote } = input;
  if (quote.options.length === 0) throw new MarketError("INVALID_ARGUMENT", "the quote has no payment option");

  const maxPerHire = BigInt(policy.maxPerHire);
  const maxPerDay = BigInt(policy.maxPerDay);
  const inWindow = hires.filter((h) => h.at > now - DAY_SECONDS && h.at <= now).sort((a, b) => a.at - b.at);
  const spent = inWindow.reduce((sum, h) => sum + BigInt(h.amount), 0n);
  const remaining = spent >= maxPerDay ? 0n : maxPerDay - spent;
  const no = (rule: Parameters<typeof refuse>[0], amount: string, message: string, extra: { limit?: bigint; retryAfterSeconds?: number } = {}): QuoteDecision => ({
    decision: "refuse",
    handle: quote.handle,
    refusal: refuse(rule, { message, attemptedAmount: BigInt(amount), remaining, ...extra }),
  });

  const onNetwork = quote.options.filter((o) => o.requirement.network === policy.network);
  if (onNetwork.length === 0) {
    const offered = [...new Set(quote.options.map((o) => o.requirement.network))].join(", ");
    return no("NETWORK_NOT_ALLOWED", quote.options[0]!.requirement.amount, `the quote can be paid on ${offered}; the policy allows ${policy.network}`);
  }
  const option = onNetwork.find((o) => o.requirement.asset === policy.asset);
  if (!option) return no("ASSET_NOT_ALLOWED", onNetwork[0]!.requirement.amount, `the quote asks for asset ${onNetwork[0]!.requirement.asset}; the policy allows ${policy.asset}`);

  const r = option.requirement;
  const amount = BigInt(r.amount);
  const warnings: string[] = [];
  if (verdict) {
    if (verdict.payee !== undefined && verdict.payee !== r.payTo) return no("PAYEE_VERDICT_MISMATCH", r.amount, `the payee verdict is about ${clean(verdict.payee)}; the quote pays ${r.payTo}`);
    const signal = verdict.signals?.[0];
    const said = verdict.reason ?? (signal ? `${signal.id}${signal.reason ? ` (${signal.reason})` : ""}` : "");
    const why = said ? `: ${clean(said)}` : "";
    if (verdict.verdict === "block") return no("PAYEE_BLOCKED", r.amount, `the payee check blocked ${r.payTo}${why}`);
    if (verdict.verdict === "warn") {
      if (policy.refuseOnWarn) return no("PAYEE_WARNED", r.amount, `the payee check warned about ${r.payTo}${why}`);
      warnings.push(`the payee check warned about ${r.payTo}${why}`);
    }
  }
  if (policy.maxValiditySeconds !== undefined && r.maxTimeoutSeconds > policy.maxValiditySeconds) {
    return no("VALIDITY_TOO_LONG", r.amount, `the payment would stay valid for ${r.maxTimeoutSeconds} s; the policy allows ${policy.maxValiditySeconds} s`);
  }
  if (amount > maxPerHire) return no("PER_HIRE_MAX", r.amount, `the price is ${r.amount} atomic units; the per-hire maximum is ${maxPerHire}`, { limit: maxPerHire });
  if (spent + amount > maxPerDay) {
    // The same hire fits once enough earlier hires have left the 24 hour window. If it never fits, do not retry.
    let rolling = spent;
    let retryAfterSeconds: number | undefined;
    if (amount <= maxPerDay) {
      for (const h of inWindow) {
        rolling -= BigInt(h.amount);
        if (rolling + amount <= maxPerDay) {
          retryAfterSeconds = h.at + DAY_SECONDS - now;
          break;
        }
      }
    }
    return no("DAILY_MAX", r.amount, `${spent} atomic units were spent on hires in the last 24 hours and this hire costs ${r.amount}; the daily maximum is ${maxPerDay}`, {
      limit: maxPerDay,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  return { decision: "allow", handle: quote.handle, option, remainingAfter: (maxPerDay - spent - amount).toString(), warnings };
}

/**
 * Remembers paid hires for the rolling 24h maximum. In memory only: a process that restarts forgets, so a long-running
 * buyer should keep its own durable record and pass it to `checkQuote` as `recentHires`.
 */
export class HireLedger {
  #hires: HireRecord[] = [];

  /** Call this once a paid request was sent, whether or not the agent has delivered yet. */
  record(amount: string, at: number = Math.floor(Date.now() / 1000)): void {
    this.#hires.push(hireSchema.parse({ amount, at }));
  }

  recent(now: number = Math.floor(Date.now() / 1000)): HireRecord[] {
    this.#hires = this.#hires.filter((h) => h.at > now - DAY_SECONDS);
    return [...this.#hires];
  }
}

/** A price in atomic units as a person reads it: `250000` is `0.25 USDC`. */
export const usdc = (atomic: string | bigint): string => `${formatAmount(atomic, USDC_DECIMALS)} USDC`;

/** An amount of `asset` for display. Only USDC on NEAR mainnet has known decimals here; anything else stays atomic. */
export const money = (atomic: string | bigint, asset: string): string => (asset === NEAR_MAINNET_USDC ? usdc(atomic) : `${atomic} atomic units of ${asset}`);
