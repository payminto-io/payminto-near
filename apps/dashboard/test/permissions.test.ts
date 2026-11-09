import { describe, expect, it } from "vitest";
import { can, grantsFor, NO_GRANTS, PLATFORM_SCOPE } from "@/lib/permissions";

const biz = (merchantId: string) => ({ kind: "business" as const, merchantId });
const A = "mer_acme";
const B = "mer_other";

describe("can (PRODUCT.md 10.4)", () => {
  it("gives the platform owner everything", () => {
    const g = grantsFor({ platformRole: "owner", memberships: [] });
    expect(can(g, "earnings.read")).toBe(true);
    expect(can(g, "pricing.manage")).toBe(true);
    expect(can(g, "payout.change", biz(A))).toBe(true);
    expect(can(g, "outbox.read")).toBe(true);
  });
  it("keeps a platform admin away from pricing changes, earnings, outbox and payout wallets", () => {
    const g = grantsFor({ platformRole: "admin", memberships: [] });
    expect(can(g, "pricing.read")).toBe(true);
    expect(can(g, "pricing.manage")).toBe(false);
    expect(can(g, "earnings.read")).toBe(false);
    expect(can(g, "outbox.read")).toBe(false);
    expect(can(g, "team.manage")).toBe(false);
    expect(can(g, "payout.change", biz(A))).toBe(false);
    expect(can(g, "refunds.issue", biz(A))).toBe(true);
  });
  it("scopes business roles to their own business", () => {
    const g = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "admin" }] });
    expect(can(g, "developers.manage", biz(A))).toBe(true);
    expect(can(g, "developers.manage", biz(B))).toBe(false);
    expect(can(g, "businesses.read")).toBe(false);
    expect(can(g, "agents.read")).toBe(false);
    expect(can(g, "audit.read", biz(A))).toBe(true);
  });
  it("lets Staff request but not issue or approve refunds", () => {
    const g = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "staff" }] });
    expect(can(g, "refunds.request", biz(A))).toBe(true);
    expect(can(g, "refunds.issue", biz(A))).toBe(false);
    expect(can(g, "refunds.approve", biz(A))).toBe(false);
    expect(can(g, "links.write", biz(A))).toBe(true);
    expect(can(g, "audit.read", biz(A))).toBe(false);
  });
  it("makes Viewer read-only", () => {
    const g = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "viewer" }] });
    expect(can(g, "payments.read", biz(A))).toBe(true);
    expect(can(g, "links.write", biz(A))).toBe(false);
    expect(can(g, "refunds.request", biz(A))).toBe(false);
  });
  it("checks business permissions on the platform scope against every business", () => {
    const owner = grantsFor({ platformRole: "owner", memberships: [] });
    const staff = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "staff" }] });
    expect(can(owner, "payments.read", PLATFORM_SCOPE)).toBe(true);
    expect(can(staff, "payments.read", PLATFORM_SCOPE)).toBe(false);
    expect(can(NO_GRANTS, "payments.read", biz(A))).toBe(false);
  });
  it("gives the recovery key every permission", () => {
    const g = grantsFor("recovery_key");
    expect(can(g, "earnings.read")).toBe(true);
    expect(can(g, "payout.change", biz(B))).toBe(true);
  });
});
