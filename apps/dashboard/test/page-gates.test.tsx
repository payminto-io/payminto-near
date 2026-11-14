import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { can as canWith, grantsFor, type Grants, type Permission, type Scope } from "@/lib/permissions";

// Pages a role cannot use show the no-access screen before any of their data is asked for, so the session is all
// these tests provide: grants for one role in one business.
const who = vi.hoisted(() => ({ grants: { platform: [], businesses: {} } as Grants, scope: { kind: "business", merchantId: "mer_acme" } as Scope }));
vi.mock("@/lib/session", () => ({
  useCan: () => (p: Permission) => canWith(who.grants, p, who.scope),
  useAccess: () => ({ can: (p: Permission) => canWith(who.grants, p, who.scope), view: who.scope.kind === "business" ? who.scope : { kind: "platform" }, scope: who.scope, platformView: who.scope.kind === "platform", session: { user: null, memberships: [], grants: who.grants } }),
  useApi: () => {
    throw new Error("a gated page asked for data");
  },
  useSession: () => {
    throw new Error("a gated page asked for the session");
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/", useParams: () => ({}) }));

import { RequirePermission } from "@/components/app/states";
import NewLinkPage from "@/app/links/new/page";
import RefundsPage from "@/app/refunds/page";
import BalancePage from "@/app/balance/page";
import PricingPage from "@/app/platform/pricing/page";
import EarningsPage from "@/app/platform/earnings/page";
import PlatformSettingsPage from "@/app/settings/platform/page";

const A = "mer_acme";
const asRole = (role: "admin" | "staff" | "viewer" | null, platformRole: "owner" | "admin" | null = null, scope: Scope = { kind: "business", merchantId: A }) => {
  who.grants = grantsFor({ platformRole, memberships: role ? [{ merchantId: A, role }] : [] });
  who.scope = scope;
};
const NO_ACCESS = "You do not have access to this page";

describe("pages a role cannot use show the no-access screen, not a server error", () => {
  beforeEach(() => asRole(null));

  it("/links/new for a Viewer", () => {
    asRole("viewer");
    render(<NewLinkPage />);
    expect(screen.getByText(NO_ACCESS)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  });

  it("/refunds and /balance for someone outside the business", () => {
    asRole(null);
    render(<RefundsPage />);
    expect(screen.getByText(NO_ACCESS)).toBeInTheDocument();
    render(<BalancePage />);
    expect(screen.getAllByText(NO_ACCESS)).toHaveLength(2);
  });

  it("platform pages for a business Admin", () => {
    asRole("admin");
    for (const Page of [PricingPage, EarningsPage, PlatformSettingsPage]) {
      const { unmount } = render(<Page />);
      expect(screen.getByText(NO_ACCESS)).toBeInTheDocument();
      unmount();
    }
  });

  it("Earnings for a platform admin, who reads pricing but not earnings", () => {
    asRole(null, "admin", { kind: "platform" });
    render(<EarningsPage />);
    expect(screen.getByText(NO_ACCESS)).toBeInTheDocument();
  });
});

describe("the same gates let the right roles through", () => {
  const gate = (permission: Permission) => render(<RequirePermission permission={permission}><p>inside</p></RequirePermission>);
  it.each([
    ["links.write", "staff", null],
    ["payments.read", "viewer", null],
    ["pricing.read", null, "admin"],
    ["earnings.read", null, "owner"],
    ["platform.read", null, "admin"],
  ] as const)("%s for %s %s", (permission, role, platformRole) => {
    asRole(role, platformRole, platformRole ? { kind: "platform" } : { kind: "business", merchantId: A });
    gate(permission);
    expect(screen.getByText("inside")).toBeInTheDocument();
  });
});
