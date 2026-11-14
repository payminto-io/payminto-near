import { beforeEach, describe, expect, it } from "vitest";
import { anyChainState, checklistProgress, checklistSteps, isChecklistDismissed, dismissChecklist, payoutProven, type ChecklistFacts } from "@/lib/setup-checklist";
import { can, grantsFor, type Permission } from "@/lib/permissions";

const A = "mer_acme";
const biz = { kind: "business" as const, merchantId: A };
const role = (r: "admin" | "staff" | "viewer") => {
  const g = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: r }] });
  return (p: Permission) => can(g, p, biz);
};
const fresh: ChecklistFacts = { payoutProven: false, anyChain: "off", links: 0, team: 1, apiKeys: 0, paidPayments: 0 };

describe("payoutProven", () => {
  it("is true only when the newest change set today's payout with a signature", () => {
    expect(payoutProven({ payout: "shop.near", payout_history: [{ old_payout: null, new_payout: "shop.near", proven: true, changed_at: "2026-11-01" }] })).toBe(true);
    expect(payoutProven({ payout: "shop.near", payout_history: [{ old_payout: null, new_payout: "shop.near", proven: false, changed_at: "2026-11-01" }] })).toBe(false);
    expect(payoutProven({ payout: "new.near", payout_history: [{ old_payout: "a", new_payout: "old.near", proven: true, changed_at: "2026-11-01" }] })).toBe(false);
    expect(payoutProven({ payout: null, payout_history: [] })).toBe(false);
  });
  it("trusts a set payout when the server sends no history (the demo)", () => {
    expect(payoutProven({ payout: "shop.near" })).toBe(true);
    expect(payoutProven({ payout: null })).toBe(false);
  });
});

describe("anyChainState", () => {
  it("is unavailable when the server does not list the any-chain method", () => {
    expect(anyChainState([{ method: "wallet", enabled: true }])).toBe("unavailable");
    expect(anyChainState([{ method: "oneclick", enabled: false }])).toBe("off");
    expect(anyChainState([{ method: "oneclick", enabled: true }])).toBe("on");
  });
});

describe("checklistSteps", () => {
  it("gives an Admin all six steps, none done, in order", () => {
    const steps = checklistSteps(fresh, role("admin"));
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ["payout", false],
      ["anyChain", false],
      ["link", false],
      ["team", false],
      ["apiKey", false],
      ["firstPayment", false],
    ]);
    expect(steps.map((s) => s.href)).toEqual(["/settings/payout", "/settings/methods", "/links/new", "/settings/team?invite=1", "/developers/keys", "/links"]);
    expect(checklistProgress(steps)).toEqual({ done: 0, total: 6, label: "0 of 6", complete: false });
  });

  it("marks steps done from the data and counts them", () => {
    const steps = checklistSteps({ payoutProven: true, anyChain: "on", links: 2, team: 1, apiKeys: 0, paidPayments: 0 }, role("admin"));
    expect(steps.filter((s) => s.done).map((s) => s.key)).toEqual(["payout", "anyChain", "link"]);
    expect(checklistProgress(steps).label).toBe("3 of 6");
  });

  it("counts a teammate or a pending invite as an invited team", () => {
    expect(checklistSteps({ ...fresh, team: 2 }, role("admin")).find((s) => s.key === "team")?.done).toBe(true);
  });

  it("leaves out Accept any chain when the server does not run it", () => {
    const steps = checklistSteps({ ...fresh, anyChain: "unavailable" }, role("admin"));
    expect(steps.map((s) => s.key)).not.toContain("anyChain");
    expect(checklistProgress(steps).total).toBe(5);
  });

  it("shows Staff only the steps it can act on, and Viewer none", () => {
    expect(checklistSteps(fresh, role("staff")).map((s) => s.key)).toEqual(["link", "firstPayment"]);
    expect(checklistSteps(fresh, role("viewer"))).toEqual([]);
  });

  it("is complete once every shown step is done", () => {
    const all = checklistSteps({ payoutProven: true, anyChain: "on", links: 1, team: 3, apiKeys: 1, paidPayments: 4 }, role("admin"));
    expect(checklistProgress(all)).toEqual({ done: 6, total: 6, label: "6 of 6", complete: true });
    expect(checklistProgress([]).complete).toBe(true);
  });
});

describe("dismissal per business", () => {
  beforeEach(() => window.localStorage.clear());
  it("remembers a dismissal for that business only", () => {
    expect(isChecklistDismissed(A)).toBe(false);
    dismissChecklist(A);
    expect(isChecklistDismissed(A)).toBe(true);
    expect(isChecklistDismissed("mer_other")).toBe(false);
  });
  it("survives storage that throws", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(isChecklistDismissed(A, broken)).toBe(false);
    expect(() => dismissChecklist(A, broken)).not.toThrow();
  });
});
