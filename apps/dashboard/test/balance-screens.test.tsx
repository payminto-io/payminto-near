import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { can as canWith, grantsFor, type Grants, type Permission } from "@/lib/permissions";
import type { Payouts } from "@/lib/schemas";

const A = "mer_acme";
const SHOP = "shop.testnet";
const now = Date.now();
const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();

const state = vi.hoisted(() => ({
  grants: { platform: [], businesses: {} } as Grants,
  links: [] as unknown[],
  members: [] as unknown[],
  paid: [] as unknown[],
  methods: [] as unknown[],
}));

const payouts: Payouts = {
  accounts: [{ account: "shop.testnet", status: "due", credit: "1500000", paidTotal: "2500000", attempts: 0, nextAttemptAt: null, lastError: null, checkedAt: iso(0) }],
  payouts: [{ seq: 7, status: "confirmed", trigger: "manual", txHash: "PayoutTxAbc123", explorerUrl: "https://testnet.nearblocks.io/txns/PayoutTxAbc123", error: null, createdAt: iso(1), finishedAt: iso(1), items: [{ account: "shop.testnet", creditBefore: "2500000", creditAfter: "0", paid: "2500000", outcome: "paid" }] }],
};

// The demo api: no HttpOperatorApi, so Balance is put together from the merchant and GET /v1/payouts.
const api = vi.hoisted(() => {
  const known: Record<string, unknown> = {};
  return new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : () => Promise.resolve([])) });
});
Object.assign(api, {
  mock: true,
  info: async () => ({ version: "0", network: { id: "near:testnet", name: "NEAR testnet", explorer: null, testnet: true, rpc_url: null }, hub: "hub.testnet", token: { address: "usdc.testnet", symbol: "USDC", decimals: 6 }, explorer: null, operator: "node.testnet" }),
  nearReader: () => null,
  payouts: async () => payouts,
  operator: { methods: async () => state.methods },
  gateway: {
    merchant: async () => ({ id: A, payout: SHOP, network: "near:testnet" }),
    links: async () => state.links,
    apiKeys: async () => [],
    payments: async () => ({ items: state.paid, nextCursor: null, counts: null }),
  },
});

const can = (p: Permission) => canWith(state.grants, p, { kind: "business", merchantId: A });
vi.mock("@/lib/session", () => ({
  useApi: () => api,
  useCan: () => can,
  useAccess: () => ({ can, view: { kind: "business", merchantId: A }, scope: { kind: "business", merchantId: A }, platformView: false, session: { user: null, memberships: [], grants: state.grants } }),
  useSession: () => ({ account: { members: async () => state.members, invites: async () => [] } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/", useParams: () => ({}) }));

import BalancePage from "@/app/balance/page";
import { BusinessSetupChecklist } from "@/components/gateway/setup-checklist";
import { TooltipProvider } from "@/components/ui/tooltip";

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  state.grants = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "admin" }] });
  state.links = [];
  state.members = [{ userId: "u1", role: "admin" }];
  state.paid = [];
  state.methods = [{ merchant_id: A, method: "wallet", enabled: true }];
});

describe("Balance page", () => {
  it("shows what waits, what is on its way and what was paid out, with the payout's transaction", async () => {
    state.grants = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "viewer" }] });
    wrap(<BalancePage />);
    const waiting = (await screen.findByText("Waiting for payout")).closest("div")!;
    expect(within(waiting).getByText("1.50")).toBeInTheDocument();
    expect(within(screen.getByText("Paid out, 30 days").closest("div")!).getAllByText("2.50").length).toBeGreaterThan(0);
    expect(screen.getByText("nothing in flight")).toBeInTheDocument();
    expect(screen.getByText("Paid out")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open payout transaction in the NEAR explorer" })).toHaveAttribute("href", "https://testnet.nearblocks.io/txns/PayoutTxAbc123");
    // A Viewer reads it all, with no way to change the payout wallet from here.
    expect(screen.queryByRole("link", { name: "Payout wallet settings" })).not.toBeInTheDocument();
    // This server does not run the any-chain checkout and delivered nothing, so that panel stays away.
    expect(screen.queryByText("Any-chain payments")).not.toBeInTheDocument();
  });
});

describe("Getting-started checklist", () => {
  it("counts done steps, gives each open step a button, and stays hidden once dismissed", async () => {
    state.links = [{ id: "plink_1" }];
    state.methods = [{ merchant_id: A, method: "oneclick", enabled: false }];
    const { unmount } = wrap(<BusinessSetupChecklist merchantId={A} />);
    expect(await screen.findByText("Get set up")).toBeInTheDocument();
    // The demo's payout is set, so it counts as proven; one link exists.
    expect(screen.getByText("2 of 6 done")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn on any chain" })).toHaveAttribute("href", "/settings/methods");
    expect(screen.getByRole("link", { name: "Invite people" })).toHaveAttribute("href", "/settings/team?invite=1");
    expect(screen.queryByRole("link", { name: "Create a link" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide the setup guide" }));
    await waitFor(() => expect(screen.queryByText("Get set up")).not.toBeInTheDocument());
    unmount();
    wrap(<BusinessSetupChecklist merchantId={A} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Get set up")).not.toBeInTheDocument();
  });

  it("is not shown to a Viewer, who has no step to take", async () => {
    state.grants = grantsFor({ platformRole: null, memberships: [{ merchantId: A, role: "viewer" }] });
    const { container } = wrap(<BusinessSetupChecklist merchantId={A} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });
});
