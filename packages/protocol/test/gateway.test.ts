import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ID_PREFIXES,
  newId,
  isId,
  newPaymentId,
  newLinkId,
  newRefundId,
  newWebhookEndpointId,
  newEventId,
  newDeliveryId,
  newApiKeyId,
  newLinkSlug,
  newWebhookSecret,
  newApiKeySecret,
  hashApiKeySecret,
  isLivemode,
  isTerminalPaymentStatus,
  checkoutUrl,
  linkUrl,
  newMerchantId,
  newFeePlanId,
  newCheckoutId,
  computeFees,
  feeBreakdownToJson,
  signWebhook,
  verifyWebhook,
  WEBHOOK_EVENT_TYPES,
  canonicalJson,
  canonicalOrder,
  metadataHash,
  orderHash,
  payoutChangeMessage,
  payoutProofRequest,
  verifyPayoutProofSignature,
  nep413Digest,
  signatureHex,
  lineItemsTotal,
  checkoutTermsToJson,
  checkoutTermsFromJson,
  refundTransferTx,
  ZERO_ID32,
  keypairFromSeed,
  sha256Text,
  verifyDigest,
  signDigest,
} from "../src/index.ts";

const VECTOR_ID = "pay_abcdefghijklmnopqrstuvwx";

describe("ids and secrets", () => {
  it("formats every id as prefix_ + 24 lowercase base32 characters", () => {
    const makers = [newPaymentId, newLinkId, newRefundId, newWebhookEndpointId, newEventId, newDeliveryId, newApiKeyId];
    const kinds = ["payment", "link", "refund", "webhookEndpoint", "event", "delivery", "apiKey"] as const;
    makers.forEach((make, i) => {
      const id = make();
      const kind = kinds[i]!;
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[a-z2-7]{24}$`));
      expect(isId(kind, id)).toBe(true);
    });
    expect(newPaymentId()).toMatch(/^pay_/);
    expect(newLinkId()).toMatch(/^plink_/);
    expect(newRefundId()).toMatch(/^re_/);
    expect(newWebhookEndpointId()).toMatch(/^we_/);
    expect(newEventId()).toMatch(/^evt_/);
    expect(newDeliveryId()).toMatch(/^whd_/);
    expect(newApiKeyId()).toMatch(/^key_/);
    expect(newMerchantId()).toMatch(/^mer_[a-z2-7]{24}$/);
    expect(newFeePlanId()).toMatch(/^fp_[a-z2-7]{24}$/);
  });

  it("does not repeat and rejects malformed ids", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newId("payment")));
    expect(ids.size).toBe(2000);
    expect(isId("payment", VECTOR_ID)).toBe(true);
    expect(isId("refund", VECTOR_ID)).toBe(false);
    expect(isId("payment", "pay_ABCDEFGHIJKLMNOPQRSTUVWX")).toBe(false);
    expect(isId("payment", "pay_abcdefghijklmnopqrstuvw")).toBe(false);
    expect(isId("payment", "pay_abcdefghijklmnopqrstuv01")).toBe(false);
    expect(isId("payment", 42)).toBe(false);
  });

  it("formats slugs and secrets", () => {
    expect(newLinkSlug()).toMatch(/^[a-z2-7]{8}$/);
    const whsec = newWebhookSecret();
    expect(whsec).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(newApiKeySecret(true)).toMatch(/^sk_live_[a-z2-7]{52}$/);
    expect(newApiKeySecret(false)).toMatch(/^sk_test_[a-z2-7]{52}$/);
    const secret = newApiKeySecret(false);
    expect(hashApiKeySecret(secret)).toBe(createHash("sha256").update(secret).digest("hex"));
  });

  it("knows livemode, terminal states and URLs", () => {
    expect(isLivemode("near:mainnet")).toBe(true);
    expect(isLivemode("near:testnet")).toBe(false);
    expect(isLivemode("near:sandbox")).toBe(false);
    expect(isTerminalPaymentStatus("paid")).toBe(true);
    expect(isTerminalPaymentStatus("expired")).toBe(true);
    expect(isTerminalPaymentStatus("partially_paid")).toBe(false);
    expect(isTerminalPaymentStatus("processing")).toBe(false);
    expect(checkoutUrl("https://pay.example.com/", VECTOR_ID)).toBe(`https://pay.example.com/pay/${VECTOR_ID}`);
    expect(linkUrl("http://localhost:3000", "abcd2345")).toBe("http://localhost:3000/l/abcd2345");
  });
});

describe("fees (section 14.1)", () => {
  const plan = { platform_fee_bps: 50, platform_fee_fixed: "0", min_fee: null, max_fee: null };
  const free = { fee_bps: 0, fee_fixed: "0", bearer: "merchant" as const };
  const quote = (amount: bigint, p: Parameters<typeof computeFees>[0]["plan"], m: Parameters<typeof computeFees>[0]["method"]) =>
    computeFees({ amount, plan: p, method: m });

  it("takes the platform fee out of the merchant's amount by default", () => {
    expect(quote(100_000_000n, plan, free)).toEqual({
      amount: 100_000_000n,
      surcharge: 0n,
      amount_due: 100_000_000n,
      platform_fee: 500_000n,
      method_fee: 0n,
      fee_total: 500_000n,
      net_amount: 99_500_000n,
    });
    expect(quote(100_000_000n, plan, null)).toEqual(quote(100_000_000n, plan, free));
  });

  it("floors the bps part and adds the fixed part", () => {
    const r = quote(199n, { ...plan, platform_fee_bps: 100, platform_fee_fixed: 7n }, null);
    expect(r.platform_fee).toBe(8n); // 7 + floor(1.99)
    expect(quote(99n, plan, null).platform_fee).toBe(0n);
  });

  it("clamps the platform fee to min_fee and max_fee", () => {
    expect(quote(1_000_000n, { ...plan, min_fee: "10000" }, null).platform_fee).toBe(10_000n);
    expect(quote(1_000_000_000n, { ...plan, max_fee: 1_000_000n }, null).platform_fee).toBe(1_000_000n);
    expect(quote(1_000_000n, { ...plan, min_fee: 5_000n, max_fee: 5_000n }, null).platform_fee).toBe(5_000n);
    expect(() => quote(1n, { ...plan, min_fee: 2n, max_fee: 1n }, null)).toThrow(/max_fee/);
  });

  it("charges a merchant-borne method fee to the merchant", () => {
    const r = quote(10_000_000n, plan, { fee_bps: 100, fee_fixed: "20000", bearer: "merchant" });
    expect(r).toMatchObject({ surcharge: 0n, amount_due: 10_000_000n, platform_fee: 50_000n, method_fee: 120_000n, fee_total: 170_000n, net_amount: 9_830_000n });
  });

  it("adds a customer-borne method fee as a surcharge", () => {
    const r = quote(10_000_000n, plan, { fee_bps: 100, fee_fixed: "20000", bearer: "customer" });
    // The platform fee is on the merchant price, not on the surcharge.
    expect(r).toMatchObject({ surcharge: 120_000n, amount_due: 10_120_000n, platform_fee: 50_000n, method_fee: 120_000n, fee_total: 170_000n, net_amount: 9_950_000n });
  });

  it("never lets fee_total exceed amount_due, cutting the platform fee first", () => {
    const r1 = quote(1_000n, { ...plan, min_fee: 5_000n }, null);
    expect(r1).toMatchObject({ amount_due: 1_000n, platform_fee: 1_000n, fee_total: 1_000n, net_amount: 0n });
    const r2 = quote(1_000n, { ...plan, min_fee: 5_000n }, { fee_bps: 0, fee_fixed: 300n, bearer: "merchant" });
    expect(r2).toMatchObject({ amount_due: 1_000n, method_fee: 300n, platform_fee: 700n, fee_total: 1_000n, net_amount: 0n });
    const r3 = quote(1_000n, plan, { fee_bps: 0, fee_fixed: 5_000n, bearer: "merchant" });
    expect(r3).toMatchObject({ amount_due: 1_000n, method_fee: 1_000n, platform_fee: 0n, fee_total: 1_000n, net_amount: 0n });
    const r4 = quote(1_000n, { ...plan, min_fee: 5_000n }, { fee_bps: 0, fee_fixed: 300n, bearer: "customer" });
    expect(r4).toMatchObject({ surcharge: 300n, amount_due: 1_300n, method_fee: 300n, platform_fee: 1_000n, fee_total: 1_300n, net_amount: 0n });
  });

  it("holds the invariants across a grid of inputs", () => {
    const amounts = [1n, 2n, 99n, 100n, 9_999n, 10_000n, 1_000_001n, 123_456_789n, 10n ** 18n];
    const plans = [
      plan,
      { platform_fee_bps: 0, platform_fee_fixed: 0n },
      { platform_fee_bps: 1000, platform_fee_fixed: 1_000n, min_fee: 500n, max_fee: 2_000_000n },
      { platform_fee_bps: 25, platform_fee_fixed: 0n, min_fee: 10_000n },
    ];
    const methods = [null, free, { fee_bps: 290, fee_fixed: 300_000n, bearer: "customer" as const }, { fee_bps: 10_000, fee_fixed: 1n, bearer: "merchant" as const }];
    for (const amount of amounts)
      for (const p of plans)
        for (const m of methods) {
          const r = quote(amount, p, m);
          expect(r.amount).toBe(amount);
          expect(r.amount_due).toBe(amount + r.surcharge);
          expect(r.fee_total).toBe(r.platform_fee + r.method_fee);
          expect(r.fee_total <= r.amount_due).toBe(true);
          expect(r.net_amount).toBe(r.amount_due - r.fee_total);
          expect(r.platform_fee >= 0n && r.method_fee >= 0n && r.net_amount >= 0n).toBe(true);
          if (m?.bearer !== "customer") expect(r.surcharge).toBe(0n);
        }
  });

  it("rejects invalid inputs", () => {
    expect(() => quote(0n, plan, null)).toThrow(/positive/);
    expect(() => quote(-1n, plan, null)).toThrow();
    expect(() => quote(1n, { ...plan, platform_fee_bps: 1001 }, null)).toThrow(/platform_fee_bps/);
    expect(() => quote(1n, { ...plan, platform_fee_bps: 1.5 }, null)).toThrow(/platform_fee_bps/);
    expect(() => quote(1n, plan, { ...free, fee_bps: 10_001 })).toThrow(/fee_bps/);
    expect(() => quote(1n, plan, { ...free, fee_fixed: "-1" })).toThrow(/fee_fixed/);
  });

  it("serializes to JSON strings", () => {
    expect(feeBreakdownToJson(quote(100_000_000n, plan, null))).toEqual({
      amount: "100000000",
      surcharge: "0",
      amount_due: "100000000",
      platform_fee: "500000",
      method_fee: "0",
      fee_total: "500000",
      net_amount: "99500000",
    });
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_x", type: "payment.paid", created: 1_800_000_000, livemode: false, data: { object: {} } });
  const t = 1_800_000_000;

  it("signs t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>", async () => {
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    expect(await signWebhook(secret, body, t)).toBe(`t=${t},v1=${expected}`);
    expect(await signWebhook(secret, new TextEncoder().encode(body), t)).toBe(`t=${t},v1=${expected}`);
    await expect(signWebhook(secret, body, 1.5)).rejects.toThrow();
  });

  it("verifies within the tolerance and rejects everything else", async () => {
    const header = await signWebhook(secret, body, t);
    expect(await verifyWebhook(body, header, secret, { now: t })).toBe(true);
    expect(await verifyWebhook(new TextEncoder().encode(body), header, secret, { now: t + 300 })).toBe(true);
    expect(await verifyWebhook(body, header, secret, { now: t + 301 })).toBe(false);
    expect(await verifyWebhook(body, header, secret, { now: t - 301 })).toBe(false);
    expect(await verifyWebhook(body, header, secret, { now: t + 3600, toleranceSec: 3600 })).toBe(true);
    expect(await verifyWebhook(`${body} `, header, secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, header, "whsec_other", { now: t })).toBe(false);
    expect(await verifyWebhook(body, header.replace(`t=${t}`, `t=${t + 1}`), secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, header.toUpperCase().replace("T=", "t=").replace("V1=", "v1="), secret, { now: t })).toBe(true);
    expect(await verifyWebhook(body, `t=${t}`, secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, header.split(",")[1], secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, "garbage", secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, null, secret, { now: t })).toBe(false);
    expect(await verifyWebhook(body, `t=${t},v1=deadbeef`, secret, { now: t })).toBe(false);
    // Several v1 values (for example during a secret rotation): any match passes.
    const v1 = header.split("v1=")[1];
    expect(await verifyWebhook(body, `t=${t},v1=${"0".repeat(64)},v1=${v1}`, secret, { now: t })).toBe(true);
    // Defaults to the current time.
    const fresh = await signWebhook(secret, body, Math.floor(Date.now() / 1000));
    expect(await verifyWebhook(body, fresh, secret)).toBe(true);
    expect(await verifyWebhook(body, header, secret)).toBe(false);
  });

  it("lists the subscribable event types", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("payment.paid");
    expect(WEBHOOK_EVENT_TYPES).toContain("refund.failed");
    expect(WEBHOOK_EVENT_TYPES).toContain("budget.refused");
    expect(WEBHOOK_EVENT_TYPES).toHaveLength(11);
  });
});

describe("NEP-413 payout proofs", () => {
  // Signed with near-kit 0.20.2 (`signNep413Message`), seed 0x07 x 32, nonce bytes 0..31.
  const nonce = new Uint8Array(32).map((_, i) => i);
  const key = keypairFromSeed(new Uint8Array(32).fill(7));
  const scope = { network: "near:testnet" as const, hub: "hub.payminto.testnet" };
  const message = "Payminto payout change new merchant.testnet 1800000000 network near:testnet hub hub.payminto.testnet";

  it("hashes the borsh payload with the NEP-413 tag exactly as NEAR wallets sign it", () => {
    expect(key.publicKey).toBe("ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");
    const near = signatureHex("fZJta7ek9nfOV1DcXpt+KMNJvaZyl0dfuoO+xLQS87p/gxbFt4wIKv+kQKlFJ9gOvOrU05X1ZjyElCbmHQvlCA==")!;
    const withCallback = signatureHex("X/85+ZC1PnIhpk0x7SkbKl4m5oIqd0u7J+ycpDhsl+2CBCktIMUNn2sSpLy+a1F4F1j0K4idt1BxCAq21ZjCDg==")!;
    const signed = (d: string, s: string) => verifyDigest(key.publicKey, d, s);
    expect(signed(nep413Digest({ message, nonce, recipient: scope.hub }), near)).toBe(true);
    expect(signed(nep413Digest({ message, nonce, recipient: "other.testnet" }), near)).toBe(false);
    expect(signed(nep413Digest({ message: "x", nonce, recipient: "r.near", callbackUrl: "https://a.example/cb" }), withCallback)).toBe(true);
    expect(signed(nep413Digest({ message: "x", nonce, recipient: "r.near" }), withCallback)).toBe(false);
    expect(() => nep413Digest({ message, nonce: new Uint8Array(31), recipient: "r" })).toThrow(/32 bytes/);
  });

  it("binds the message to the merchant, the payout account, the time, the network and the node's hub", () => {
    expect(payoutChangeMessage("new", "merchant.testnet", 1_800_000_000, scope)).toBe(message);
    expect(payoutChangeMessage("new", "merchant.testnet", 1_800_000_000, { ...scope, hub: "other-hub.testnet" })).not.toBe(message);
    const req = payoutProofRequest("new", "merchant.testnet", 1_800_000_000, scope);
    expect(req).toMatchObject({ message, recipient: scope.hub });
    expect(Buffer.from(req.nonce).toString("hex")).toBe(sha256Text(message));
  });

  it("verifies a wallet's proof and refuses a proof for another merchant, account, time or node", () => {
    const sign = (merchantId: string, payout: string, timestamp: number) =>
      Buffer.from(signDigest(key.secretKey, nep413Digest(payoutProofRequest(merchantId, payout, timestamp, scope))), "hex").toString("base64");
    const proof = { payout: "merchant.testnet", timestamp: 1_800_000_000, public_key: key.publicKey, signature: sign("mer_x", "merchant.testnet", 1_800_000_000) };
    expect(verifyPayoutProofSignature(proof, "mer_x", scope)).toBe(true);
    expect(verifyPayoutProofSignature(proof, "mer_y", scope)).toBe(false);
    expect(verifyPayoutProofSignature({ ...proof, payout: "evil.testnet" }, "mer_x", scope)).toBe(false);
    expect(verifyPayoutProofSignature({ ...proof, timestamp: 1_800_000_001 }, "mer_x", scope)).toBe(false);
    expect(verifyPayoutProofSignature(proof, "mer_x", { ...scope, network: "near:sandbox" })).toBe(false);
    expect(verifyPayoutProofSignature({ ...proof, signature: "not base64!" }, "mer_x", scope)).toBe(false);
    expect(verifyPayoutProofSignature({ ...proof, public_key: "ed25519:1" as never }, "mer_x", scope)).toBe(false);
  });
});

describe("checkout and refunds", () => {
  it("creates random 32-byte checkout ids and round-trips checkout terms through JSON", () => {
    expect(newCheckoutId()).toMatch(/^[0-9a-f]{64}$/);
    expect(newCheckoutId()).not.toBe(newCheckoutId());
    const t = { paymentId: "ab".repeat(32), merchant: "shop.testnet", amount: 25_000_000n, expiryMs: 1_800_000_000_000n };
    expect(checkoutTermsToJson(t)).toEqual({ payment_id: "ab".repeat(32), merchant: "shop.testnet", amount: "25000000", expiry_ms: "1800000000000" });
    expect(checkoutTermsFromJson(JSON.parse(JSON.stringify(checkoutTermsToJson(t))))).toEqual(t);
  });

  it("builds the merchant's refund as an ft_transfer from its own wallet with one yoctoNEAR", () => {
    expect(refundTransferTx("usdc.testnet", "payer.testnet", 1_500_000n, "re_abc")).toEqual({
      receiverId: "usdc.testnet",
      actions: [{ type: "FunctionCall", params: { methodName: "ft_transfer", args: { receiver_id: "payer.testnet", amount: "1500000", memo: "payminto refund re_abc" }, gas: "30000000000000", deposit: "1" } }],
    });
  });
});

describe("order commitment", () => {
  const base = {
    payment_id: "pay_aaaaaaaaaaaaaaaaaaaaaaaa",
    amount: "25000000",
    token: "usdc.fake.testnet",
    payout: "shop.testnet",
    reference: "inv-7",
    description: null,
    line_items: [{ name: "Pro plan", quantity: 1, unit_amount: "25000000" }],
  };

  it("hashes metadata canonically, and the zero id when there is none", () => {
    expect(metadataHash(undefined)).toBe(ZERO_ID32);
    expect(metadataHash({})).toBe(ZERO_ID32);
    expect(metadataHash({ b: "2", a: "1" })).toBe(createHash("sha256").update('{"a":"1","b":"2"}').digest("hex"));
    expect(metadataHash({ b: "2", a: "1" })).toBe(metadataHash({ a: "1", b: "2" }));
  });

  it("serializes sorted, without whitespace or metadata, and hashes with sha256", () => {
    const order = { ...base, metadata_hash: metadataHash({ crm: "c-1" }) };
    const json = canonicalOrder(order);
    expect(json).toBe(
      `{"amount":"25000000","description":null,"line_items":[{"name":"Pro plan","quantity":1,"unit_amount":"25000000"}],` +
        `"metadata_hash":"${metadataHash({ crm: "c-1" })}","payment_id":"pay_aaaaaaaaaaaaaaaaaaaaaaaa",` +
        `"payout":"shop.testnet","reference":"inv-7","token":"usdc.fake.testnet"}`,
    );
    expect(json).not.toContain("c-1");
    expect(orderHash(order)).toBe(createHash("sha256").update(json).digest("hex"));
    expect(orderHash({ ...order, metadata_hash: metadataHash({ crm: "c-2" }) })).not.toBe(orderHash(order));
    expect(canonicalJson({ z: [{ b: 1, a: 2 }], a: null })).toBe('{"a":null,"z":[{"a":2,"b":1}]}');
    expect(lineItemsTotal([{ name: "a", quantity: 3, unit_amount: "7" }, { name: "b", quantity: 1, unit_amount: "4" }])).toBe(25n);
  });
});
