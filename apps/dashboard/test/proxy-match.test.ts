import { describe, expect, it } from "vitest";
import { x402PathFor, x402Target } from "@/lib/proxy-match";

const h = (headers: Record<string, string>) => new Headers(headers);
const BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

describe("x402PathFor", () => {
  it("maps link and payment URLs to the node's x402 routes", () => {
    expect(x402PathFor("/l/pro-plan")).toBe("/v1/pay/l/pro-plan");
    expect(x402PathFor("/pay/pay_abc234")).toBe("/v1/pay/pay_abc234");
    expect(x402PathFor("/pay/pay_abc234/")).toBe("/v1/pay/pay_abc234");
  });
  it("ignores everything else and unsafe segments", () => {
    expect(x402PathFor("/payments")).toBeNull();
    expect(x402PathFor("/l/a/b")).toBeNull();
    expect(x402PathFor("/l/..%2Fadmin")).toBeNull();
    expect(x402PathFor("/l/%E0%A4%A")).toBeNull();
  });
});

describe("x402Target", () => {
  it("lets browsers through to the hosted page", () => {
    expect(x402Target("/l/pro-plan", h({ accept: BROWSER }))).toBeNull();
  });
  it("sends agents, curl and JSON clients to the node", () => {
    expect(x402Target("/l/pro-plan", h({ accept: "*/*" }))).toBe("/v1/pay/l/pro-plan");
    expect(x402Target("/l/pro-plan", h({ accept: "application/json" }))).toBe("/v1/pay/l/pro-plan");
    expect(x402Target("/pay/pay_abc", h({}))).toBe("/v1/pay/pay_abc");
  });
  it("always sends a paid retry to the node, even from a browser-like client", () => {
    expect(x402Target("/l/pro-plan", h({ accept: BROWSER, "payment-signature": "eyJ4In0=" }))).toBe("/v1/pay/l/pro-plan");
  });
  it("never intercepts the Next.js router's own requests", () => {
    expect(x402Target("/pay/pay_abc", h({ accept: "*/*", rsc: "1" }))).toBeNull();
    expect(x402Target("/pay/pay_abc", h({ accept: "*/*", "next-router-prefetch": "1" }))).toBeNull();
    expect(x402Target("/pay/pay_abc", h({ accept: "*/*", purpose: "prefetch" }))).toBeNull();
  });
});
