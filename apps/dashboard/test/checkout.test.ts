import { describe, expect, it } from "vitest";
import {
  availableMethods,
  checkoutCopy,
  confirmationProgress,
  countdownLabel,
  countdownTone,
  formatCountdown,
  initialMethod,
  isPublicCheckoutPath,
  isTerminal,
  phaseOf,
  redirectSecondsLeft,
  secondsLeft,
  type CheckoutPhase,
} from "@/lib/checkout";
import type { PaymentMethod } from "@/lib/schemas";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const later = new Date(NOW + 600_000).toISOString();
const earlier = new Date(NOW - 1000).toISOString();
const ctx = { amount: "25.00 USDC", paid: "20.00 USDC", remaining: "5.00 USDC", excess: "0.50 USDC", merchant: "Acme Store" };

describe("phaseOf", () => {
  it("follows the node's status", () => {
    expect(phaseOf({ status: "processing", expires_at: later }, { now: NOW })).toBe("processing");
    expect(phaseOf({ status: "paid", expires_at: earlier }, { now: NOW })).toBe("paid");
  });
  it("reads an open payment past its expiry as expired, and a partial one as underpaid", () => {
    expect(phaseOf({ status: "open", expires_at: earlier }, { now: NOW })).toBe("expired");
    expect(phaseOf({ status: "partially_paid", expires_at: earlier }, { now: NOW })).toBe("underpaid");
  });
  it("shows signing only while money can still be sent", () => {
    expect(phaseOf({ status: "open", expires_at: later }, { now: NOW, signing: true })).toBe("signing");
    expect(phaseOf({ status: "paid", expires_at: later }, { now: NOW, signing: true })).toBe("paid");
  });
});

describe("checkoutCopy", () => {
  const phases: CheckoutPhase[] = ["open", "signing", "processing", "partially_paid", "paid", "overpaid", "underpaid", "expired", "canceled"];
  it("gives every phase a headline, a now sentence and a next sentence, without em dashes", () => {
    for (const p of phases) {
      const c = checkoutCopy(p, ctx);
      expect(c.headline.length).toBeGreaterThan(5);
      expect(c.body.length).toBeGreaterThan(5);
      expect(c.next.length).toBeGreaterThan(5);
      expect(`${c.headline}${c.body}${c.next}`).not.toMatch(/\u2014/);
    }
  });
  it("states the amounts and that no funds were taken where true", () => {
    expect(checkoutCopy("partially_paid", ctx).body).toBe("Received 20.00 USDC of 25.00 USDC. Pay the remaining 5.00 USDC from your NEAR wallet.");
    expect(checkoutCopy("overpaid", ctx).next).toContain("0.50 USDC more");
    expect(checkoutCopy("expired", ctx).body).toBe("No funds were taken.");
    expect(checkoutCopy("canceled", ctx).body).toContain("No funds were taken.");
    expect(checkoutCopy("expired", { ...ctx, canRestart: true }).next).toContain("Start a new payment");
  });
  it("knows the terminal phases", () => {
    expect(isTerminal("paid")).toBe(true);
    expect(isTerminal("partially_paid")).toBe(false);
  });
});

describe("countdown", () => {
  it("counts down whole seconds and never below zero", () => {
    expect(secondsLeft(later, NOW)).toBe(600);
    expect(secondsLeft(earlier, NOW)).toBe(0);
  });
  it("formats minutes, hours and days", () => {
    expect(formatCountdown(892)).toBe("14:52");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(3849)).toBe("1:04:09");
    expect(formatCountdown(7 * 86_400 - 3600)).toBe("6d 23h");
  });
  it("turns amber under five minutes, red under one, and speaks in coarse units", () => {
    expect(countdownTone(59)).toBe("danger");
    expect(countdownTone(60)).toBe("warning");
    expect(countdownTone(299)).toBe("warning");
    expect(countdownTone(300)).toBe("neutral");
    expect(countdownLabel(0)).toBe("Expired");
    expect(countdownLabel(45)).toBe("45 seconds left");
    expect(countdownLabel(890)).toBe("15 minutes left");
  });
  it("counts the return-to-merchant redirect from 5", () => {
    expect(redirectSecondsLeft(NOW, NOW)).toBe(5);
    expect(redirectSecondsLeft(NOW, NOW + 2_400)).toBe(3);
    expect(redirectSecondsLeft(NOW, NOW + 9_000)).toBe(0);
  });
});

describe("confirmationProgress", () => {
  it("clamps to the required depth", () => {
    expect(confirmationProgress({ confirmations: { current: 2, required: 3 } })).toEqual({ current: 2, required: 3 });
    expect(confirmationProgress({ confirmations: { current: 9, required: 3 } })).toEqual({ current: 3, required: 3 });
    expect(confirmationProgress({ confirmations: null })).toBeNull();
  });
});

describe("isPublicCheckoutPath", () => {
  it("matches only the public pages", () => {
    expect(isPublicCheckoutPath("/pay/pay_abc")).toBe(true);
    expect(isPublicCheckoutPath("/l/pro-plan")).toBe(true);
    expect(isPublicCheckoutPath("/receipt/pay_abc")).toBe(true);
    expect(isPublicCheckoutPath("/payments")).toBe(false);
    expect(isPublicCheckoutPath("/links/plink_x")).toBe(false);
    expect(isPublicCheckoutPath("/pay/a/b")).toBe(false);
  });
});

describe("ways to pay", () => {
  const base = { methods: ["wallet", "voucher"] as PaymentMethod[], wallet: null, status: "open" as const, amount_paid: "0" };
  it("offers only the NEAR wallet, which carries the node-signed terms", () => {
    expect(availableMethods(base)).toEqual(["wallet"]);
    expect(initialMethod(base)).toBe("wallet");
  });
});
