import { describe, expect, it } from "vitest";
import { REDIRECTS, isAuthPath, loginHref, redirectFor, safeNext } from "@/lib/routes";
import { apiTarget } from "@/lib/proxy-match";

describe("old URLs redirect (PRODUCT.md 2.4)", () => {
  it("moves operator pages to platform", () => {
    expect(redirectFor("/operator/merchants")).toBe("/platform/businesses");
    expect(redirectFor("/operator/merchants/mer_1")).toBe("/platform/businesses/mer_1");
    expect(redirectFor("/operator/merchants/new")).toBe("/platform/businesses/new");
    expect(redirectFor("/operator/fee-plans")).toBe("/platform/pricing");
    expect(redirectFor("/operator/earnings")).toBe("/platform/earnings");
    expect(redirectFor("/operator/platform")).toBe("/settings/platform");
  });
  it("merges denials and screening into Blocked", () => {
    expect(redirectFor("/denials")).toBe("/blocked");
    expect(redirectFor("/developers/screening")).toBe("/blocked?tab=wallets");
    expect(redirectFor("/payments")).toBeNull();
  });
  it("lists only permanent redirects", () => {
    expect(REDIRECTS.every((r) => r.permanent)).toBe(true);
  });
});

describe("account routes", () => {
  it("knows the screens that render without the shell", () => {
    for (const p of ["/login", "/setup", "/signup", "/signup/pending", "/forgot", "/reset/t", "/verify/t", "/invite/t"]) expect(isAuthPath(p)).toBe(true);
    for (const p of ["/", "/payments", "/account", "/invite", "/verify"]) expect(isAuthPath(p)).toBe(false);
  });
  it("only returns to safe in-app paths", () => {
    expect(safeNext("/payments?tab=paid")).toBe("/payments?tab=paid");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("/login")).toBe("/");
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
    expect(safeNext(null)).toBe("/");
  });
  it("builds the sign-in link with the reason", () => {
    expect(loginHref("/links", "expired")).toBe("/login?next=%2Flinks&reason=expired");
    expect(loginHref("/", null)).toBe("/login");
  });
});

describe("apiTarget (proxy /api/*)", () => {
  it("forwards the versioned API and the health check only", () => {
    expect(apiTarget("/api/v1/auth/session")).toBe("/v1/auth/session");
    expect(apiTarget("/api/healthz")).toBe("/healthz");
    expect(apiTarget("/api/metrics")).toBeNull();
    expect(apiTarget("/api/v1/../admin")).toBeNull();
    expect(apiTarget("/apis/v1/x")).toBeNull();
    expect(apiTarget("/l/slug")).toBeNull();
  });
});
