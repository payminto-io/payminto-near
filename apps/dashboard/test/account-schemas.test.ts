import { describe, expect, it } from "vitest";
import { authErrorText, checkPassword, describeDevice, sessionSchema } from "@/lib/account";
import { defaultView } from "@/lib/session";

const raw = {
  actor_type: "user",
  user: { id: "usr_1", email: "priya@northwind.example", name: "Priya", email_verified: true, status: "active", platform_role: null, last_business_id: "mer_2" },
  memberships: [
    { merchant_id: "mer_1", business_name: "Acme", role: "admin" },
    { merchant_id: "mer_2", business_name: "Northwind", role: "viewer" },
  ],
  permissions: { platform: [], businesses: { mer_1: ["payments.read"], mer_2: ["payments.read"] } },
  csrf_token: "csrf",
  session: { id: "ses_1", expires_at: "2026-12-01T00:00:00.000Z" },
  signup_request: null,
  platform: { name: "Payminto", signup_mode: "open", smtp_configured: true, recovery_key_enabled: false },
};

describe("session object (PRODUCT.md 10.3)", () => {
  it("parses the documented shape", () => {
    const s = sessionSchema.parse(raw);
    expect(s.csrf).toBe("csrf");
    expect(s.memberships.map((m) => m.name)).toEqual(["Acme", "Northwind"]);
    expect(s.signupMode).toBe("open");
    expect(s.smtpConfigured).toBe(true);
    expect(s.user?.platformRole).toBeNull();
  });
  it("parses a recovery key session with no user", () => {
    const s = sessionSchema.parse({ actor_type: "recovery_key", user: null, memberships: [], permissions: { platform: ["businesses.read"], businesses: { "*": ["payments.read"] } }, csrf_token: null });
    expect(s.user).toBeNull();
    expect(defaultView(s, null)).toEqual({ kind: "platform" });
  });
  it("lands a business user on their last business, and refuses a stored view they lost", () => {
    const s = sessionSchema.parse(raw);
    expect(defaultView(s, null)).toEqual({ kind: "business", merchantId: "mer_2" });
    expect(defaultView(s, { kind: "platform" })).toEqual({ kind: "business", merchantId: "mer_2" });
    expect(defaultView(s, { kind: "business", merchantId: "mer_9" })).toEqual({ kind: "business", merchantId: "mer_2" });
    expect(defaultView(s, { kind: "business", merchantId: "mer_1" })).toEqual({ kind: "business", merchantId: "mer_1" });
  });
});

describe("account helpers", () => {
  it("checks password length and email reuse", () => {
    expect(checkPassword("short").ok).toBe(false);
    expect(checkPassword("me@example.com", "me@example.com").ok).toBe(false);
    expect(checkPassword("correct horse battery staple").ok).toBe(true);
  });
  it("turns error codes into plain sentences", () => {
    expect(authErrorText({ code: "WEAK_PASSWORD", details: { reason: "common" } })).toBe("This password is too common. Pick another.");
    expect(authErrorText({ code: "INVALID_CREDENTIALS" })).toMatch(/Wrong email or password/);
    expect(authErrorText({ code: "X", message: "Raw" })).toBe("Raw");
  });
  it("names devices", () => {
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(describeDevice(null)).toBe("Unknown device");
  });
});
