import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MarketError, Secret, parseWebhookEvent, receiveWebhook, verifyWebhookSignature } from "../src/index.ts";
import { fixture } from "./helpers.ts";

const SECRET = "a-webhook-secret-of-at-least-32-characters";
const NOW = 1_794_300_000;
const rawBody = JSON.stringify(fixture("webhook-hire-created.synthetic.json").body);

/** The market's reference: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>. */
const sign = (body: string, timestamp: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`;

describe("webhook signature", () => {
  const timestamp = String(NOW - 5);
  const good = { secret: SECRET, timestamp, signature: sign(rawBody, timestamp), rawBody, now: NOW };

  it("accepts the signature the market's reference defines", () => {
    expect(verifyWebhookSignature(good)).toEqual({ ok: true });
    expect(verifyWebhookSignature({ ...good, secret: new Secret(SECRET), rawBody: new TextEncoder().encode(rawBody) })).toEqual({ ok: true });
  });

  it("accepts a vector computed outside this code base", () => {
    // printf '%s' '1700000000.{"event":"webhook.ping"}' | openssl dgst -sha256 -hmac 'a-webhook-secret-of-at-least-32-characters'
    const signature = "sha256=5f113a94da2c787143e7671529bb39521a7e40fd9025bd24b842cb18d0856636";
    expect(verifyWebhookSignature({ secret: SECRET, timestamp: "1700000000", signature, rawBody: '{"event":"webhook.ping"}', now: 1_700_000_010 })).toEqual({ ok: true });
  });

  it("refuses a bad signature", () => {
    const flipped = good.signature.slice(0, -1) + (good.signature.endsWith("0") ? "1" : "0");
    expect(verifyWebhookSignature({ ...good, signature: flipped })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookSignature({ ...good, signature: sign(rawBody, timestamp, "another-secret-of-at-least-32-characters!") })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a body or a timestamp that was changed after signing", () => {
    expect(verifyWebhookSignature({ ...good, rawBody: rawBody.replace("0.25", "0.26") })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookSignature({ ...good, rawBody: JSON.stringify(JSON.parse(rawBody), null, 2) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyWebhookSignature({ ...good, timestamp: String(NOW - 4) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses malformed headers without throwing", () => {
    for (const signature of [undefined, null, "", "sha256=", "sha256=zz", good.signature.replace("sha256=", ""), good.signature.toUpperCase(), `${good.signature}00`, "sha1=abc"]) {
      expect(verifyWebhookSignature({ ...good, signature })).toEqual({ ok: false, reason: "malformed_signature" });
    }
    for (const timestamp of [undefined, null, "", "soon", "-5", "1.5", "1e9"]) {
      expect(verifyWebhookSignature({ ...good, timestamp })).toEqual({ ok: false, reason: "malformed_timestamp" });
    }
  });

  it("refuses a correctly signed delivery that is too old or too far ahead", () => {
    for (const offset of [-301, 301]) {
      const t = String(NOW + offset);
      expect(verifyWebhookSignature({ ...good, timestamp: t, signature: sign(rawBody, t) })).toEqual({ ok: false, reason: "stale_timestamp" });
    }
    const edge = String(NOW - 300);
    expect(verifyWebhookSignature({ ...good, timestamp: edge, signature: sign(rawBody, edge) })).toEqual({ ok: true });
  });

  it("will not run with a secret shorter than the market allows", () => {
    expect(() => verifyWebhookSignature({ ...good, secret: "short" })).toThrow(MarketError);
  });
});

describe("webhook events", () => {
  it("reads a hire.created body and keeps the brief as data", () => {
    const parsed = parseWebhookEvent(rawBody);
    expect(parsed).toMatchObject({ known: true, event: { event: "hire.created", assignment_id: "5b1f6c1e-7d0a-4a51-9a3e-2f6b8c0d4e11", amount: "0.25", token: "USDC", sla_seconds: 3600 } });
  });

  it("treats anything else as unknown, to be acknowledged and ignored", () => {
    expect(parseWebhookEvent('{"event":"payout.paid","amount":"1"}')).toEqual({ known: false, name: "payout.paid" });
    expect(parseWebhookEvent('{"event":"hire.created","assignment_id":"nope"}')).toEqual({ known: false, name: "hire.created" });
    expect(parseWebhookEvent("not json")).toEqual({ known: false, name: null });
    expect(parseWebhookEvent('{"event":"<script>"}')).toEqual({ known: false, name: null });
  });

  it("verifies before it parses", () => {
    const timestamp = String(NOW);
    expect(receiveWebhook({ secret: SECRET, timestamp, signature: sign(rawBody, timestamp), rawBody, now: NOW })).toMatchObject({ status: 200, parsed: { known: true } });
    expect(receiveWebhook({ secret: SECRET, timestamp, signature: `sha256=${"0".repeat(64)}`, rawBody, now: NOW })).toEqual({ status: 401, reason: "bad_signature" });
  });
});
