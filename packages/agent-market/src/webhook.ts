import { createHmac, timingSafeEqual } from "node:crypto";
import { MIN_WEBHOOK_SECRET_CHARS, WEBHOOK_TOLERANCE_SECONDS } from "./constants.ts";
import { MarketError, Secret } from "./errors.ts";
import { webhookEventSchema, type WebhookEvent } from "./schemas.ts";

export const HEADER_SIGNATURE = "x-market-signature";
export const HEADER_TIMESTAMP = "x-market-timestamp";
export const HEADER_EVENT = "x-market-event";
export const HEADER_DELIVERY = "x-market-delivery";

export type WebhookCheck = { ok: true } | { ok: false; reason: "malformed_timestamp" | "stale_timestamp" | "malformed_signature" | "bad_signature" };

export type WebhookInput = {
  /** The shared secret the owner registered with the webhook URL, at least 32 characters. */
  secret: string | Secret;
  /** `X-Market-Timestamp`: Unix seconds. */
  timestamp: string | null | undefined;
  /** `X-Market-Signature`: `sha256=<hex>`. */
  signature: string | null | undefined;
  /** The request body exactly as received. Never re-serialized JSON. */
  rawBody: string | Uint8Array;
  /** Unix seconds; defaults to the system clock. */
  now?: number;
  toleranceSeconds?: number;
};

/**
 * Checks `X-Market-Signature` as the market's webhook reference defines it: the lowercase hex HMAC-SHA256, keyed with
 * the webhook secret, of the bytes `<timestamp>.<raw body>`. The comparison is constant time, and a malformed header
 * costs the same work as a wrong one, so the answer leaks nothing about the expected value.
 */
export function verifyWebhookSignature(input: WebhookInput): WebhookCheck {
  const secret = input.secret instanceof Secret ? input.secret.reveal() : input.secret;
  if (typeof secret !== "string" || secret.length < MIN_WEBHOOK_SECRET_CHARS) {
    throw new MarketError("INVALID_ARGUMENT", `a webhook secret has at least ${MIN_WEBHOOK_SECRET_CHARS} characters`);
  }
  const timestamp = typeof input.timestamp === "string" && /^\d{1,12}$/.test(input.timestamp) ? input.timestamp : null;
  const body = typeof input.rawBody === "string" ? Buffer.from(input.rawBody, "utf8") : Buffer.from(input.rawBody);
  const expected = createHmac("sha256", secret)
    .update(`${timestamp ?? "0"}.`, "utf8")
    .update(body)
    .digest();
  const hex = typeof input.signature === "string" && /^sha256=[0-9a-f]{64}$/.test(input.signature) ? input.signature.slice("sha256=".length) : null;
  // A malformed signature is compared against zeros, so every call does one HMAC and one fixed-length comparison.
  const provided = Buffer.from(hex ?? "00".repeat(32), "hex");
  const equal = timingSafeEqual(expected, provided);
  if (timestamp === null) return { ok: false, reason: "malformed_timestamp" };
  if (hex === null) return { ok: false, reason: "malformed_signature" };
  if (!equal) return { ok: false, reason: "bad_signature" };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > (input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale_timestamp" };
  return { ok: true };
}

export type ParsedWebhook = { known: true; event: WebhookEvent } | { known: false; name: string | null };

/**
 * Reads a webhook body after its signature was verified. An event this package does not use, or one with an
 * unexpected shape, comes back as unknown and can be answered with 2xx and ignored: the assignment list stays the
 * record of what to do. The title and description of a `hire.created` are the buyer's text, and they are data.
 */
export function parseWebhookEvent(rawBody: string | Uint8Array): ParsedWebhook {
  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { known: false, name: null };
  }
  const r = webhookEventSchema.safeParse(json);
  if (r.success) return { known: true, event: r.data };
  const name = json !== null && typeof json === "object" ? (json as { event?: unknown }).event : null;
  return { known: false, name: typeof name === "string" && /^[a-z_.]{1,64}$/.test(name) ? name : null };
}

export type WebhookResult = { status: 200; parsed: ParsedWebhook } | { status: 401; reason: Exclude<WebhookCheck, { ok: true }>["reason"] };

/**
 * Verify, then parse. Answer the returned status quickly and do the work afterwards: a 2xx on `hire.created` stamps
 * the assignment as started, and the worker's next poll picks it up.
 */
export function receiveWebhook(input: WebhookInput): WebhookResult {
  const check = verifyWebhookSignature(input);
  if (!check.ok) return { status: 401, reason: check.reason };
  return { status: 200, parsed: parseWebhookEvent(input.rawBody) };
}
