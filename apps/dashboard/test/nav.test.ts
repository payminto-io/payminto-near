import { describe, expect, it } from "vitest";
import { buildNav, goShortcuts, isActiveHref, navPages, sectionOf } from "@/lib/nav";
import { grantsFor } from "@/lib/permissions";

const A = "mer_acme";
const platform = { kind: "platform" as const };
const business = { kind: "business" as const, merchantId: A };
const base = { agentPaid: false, smtpConfigured: false };
const labels = (m: ReturnType<typeof buildNav>) => m.sections.map((s) => [s.label, s.defaultOpen, s.items.map((i) => i.label)]);

describe("buildNav per role (PRODUCT.md 3.2 to 3.4)", () => {
  it("gives the platform owner the full platform tree with the default open states", () => {
    const m = buildNav({ ...base, grants: grantsFor({ platformRole: "owner", memberships: [] }), scope: platform });
    expect(labels(m)).toEqual([
      ["Payments", true, ["Payments", "Payment links", "Refunds", "Customers"]],
      ["Agents", true, ["Budgets", "Paid services", "Next settlement", "Settlements", "Payouts", "Refusal alerts"]],
      ["Platform", true, ["Businesses", "Platform team", "Sign-up requests", "Email outbox"]],
      ["Records", false, ["Blocked", "Balances", "Verify", "Activity log"]],
      ["Developers", false, ["API keys", "Webhooks"]],
    ]);
    expect(m.tabs.map((t) => t.label)).toEqual(["Home", "Payments", "Businesses"]);
  });
  it("hides the outbox from a platform admin", () => {
    const m = buildNav({ ...base, grants: grantsFor({ platformRole: "admin", memberships: [] }), scope: platform });
    const platformItems = m.sections.find((s) => s.id === "platform")!.items.map((i) => i.label);
    expect(platformItems).toEqual(["Businesses", "Platform team", "Sign-up requests"]);
  });
  it("leaves AI agents out of the platform view, where no business is open", () => {
    const m = buildNav({ ...base, grants: grantsFor({ platformRole: "owner", memberships: [] }), scope: platform });
    expect(navPages(m).some((p) => p.href === "/agents")).toBe(false);
  });
  it("opens the Agents section for a business once an agent has paid", () => {
    const m = buildNav({ ...base, agentPaid: true, grants: grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "admin" }] }), scope: business });
    expect(m.sections.find((s) => s.id === "agents")?.defaultOpen).toBe(true);
  });
  it("drops the Email outbox once SMTP is configured", () => {
    const m = buildNav({ ...base, smtpConfigured: true, grants: grantsFor({ platformRole: "owner", memberships: [] }), scope: platform });
    expect(navPages(m).some((p) => p.label === "Email outbox")).toBe(false);
  });
  it("gives a business Admin payments, AI agents, records and developers", () => {
    const m = buildNav({ ...base, grants: grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "admin" }] }), scope: business });
    expect(labels(m)).toEqual([
      ["Payments", true, ["Payments", "Payment links", "Refunds", "Customers"]],
      ["Agents", false, ["AI agents"]],
      ["Records", false, ["Blocked", "Verify", "Activity log"]],
      ["Developers", false, ["API keys", "Webhooks"]],
    ]);
    expect(m.tabs.map((t) => t.label)).toEqual(["Home", "Payments", "Payment links"]);
  });
  it("gives Staff and Viewer only Payments, AI agents and Verify", () => {
    for (const role of ["staff", "viewer"] as const) {
      const m = buildNav({ ...base, grants: grantsFor({ platformRole: null, memberships: [{ merchantId: A, role }] }), scope: business });
      expect(labels(m)).toEqual([
        ["Payments", true, ["Payments", "Payment links", "Refunds", "Customers"]],
        ["Agents", false, ["AI agents"]],
        ["Records", false, ["Verify"]],
      ]);
    }
  });
  it("keeps the Agents section for a platform role that opened one business", () => {
    const m = buildNav({ ...base, grants: grantsFor({ platformRole: "owner", memberships: [] }), scope: business });
    expect(m.sections.find((s) => s.id === "agents")?.items.map((i) => i.label)).toEqual(["Agent payments", "AI agents", "Budgets", "Paid services", "Settlements"]);
    expect(m.sections.some((s) => s.id === "platform")).toBe(false);
  });
});

describe("active page and shortcuts", () => {
  const m = buildNav({ ...base, grants: grantsFor({ platformRole: "owner", memberships: [] }), scope: business });
  it("matches nested paths and query-specific items", () => {
    expect(isActiveHref("/payments/pay_1", "", "/payments")).toBe(true);
    expect(isActiveHref("/payments", "method=agent", "/payments")).toBe(false);
    expect(isActiveHref("/payments", "method=agent", "/payments?method=agent")).toBe(true);
    expect(isActiveHref("/", "", "/")).toBe(true);
    expect(isActiveHref("/links", "", "/")).toBe(false);
  });
  it("finds the section that holds a page", () => {
    expect(sectionOf(m, "/links/new")).toBe("payments");
    expect(sectionOf(m, "/receipts/0xabc")).toBe("records");
    expect(sectionOf(m, "/agents/runs/run_1")).toBe("agents");
    expect(sectionOf(m, "/")).toBeNull();
  });
  it("maps G shortcuts to pages the role can open", () => {
    const g = goShortcuts(m);
    expect(g.p).toBe("/payments");
    expect(g.h).toBe("/");
    expect(g.s).toBe("/settings");
    const staff = goShortcuts(buildNav({ ...base, grants: grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "staff" }] }), scope: business }));
    expect(staff.b).toBeUndefined();
  });
});
