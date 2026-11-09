/**
 * The sidebar model per role (docs/PRODUCT.md sections 3.2 to 3.4 and 7): which sections and pages a person sees,
 * in what order, and which sections start open. Pure, so the per-role trees are unit tested.
 */
import {
  BookOpenCheck,
  Blocks,
  Bot,
  BrainCircuit,
  Building2,
  CreditCard,
  House,
  Inbox,
  KeyRound,
  Layers,
  LifeBuoy,
  Link2,
  Percent,
  ScrollText,
  Settings,
  ShieldBan,
  ShieldCheck,
  Store,
  TrendingUp,
  Undo2,
  UserCog,
  UserPlus,
  Users,
  WalletCards,
  Waypoints,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { can, type Grants, type Permission, type Scope } from "./permissions";
import { agentAccess } from "./agents";

export type NavBadge = "blocked" | "requests";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Tab bar label when the full one does not fit. */
  short?: string;
  /** `G` then this key jumps here (section 7). */
  shortcut?: string;
  badge?: NavBadge;
  /** A plain line for the rail tooltip and the palette. */
  hint?: string;
  external?: boolean;
};

export type SectionId = "payments" | "agents" | "platform" | "records" | "developers";

export type NavSection = { id: SectionId; label: string; defaultOpen: boolean; items: NavItem[] };

export type NavModel = { home: NavItem; sections: NavSection[]; footer: NavItem[]; tabs: NavItem[] };

export type NavContext = {
  grants: Grants;
  /** The platform (all businesses) or one business. */
  scope: Scope;
  /** Any AI agent has paid this business; opens the Agents section by default. */
  agentPaid: boolean;
  /** SMTP is configured, so the Email outbox page is not needed. */
  smtpConfigured: boolean;
  /** Where Help points (developer docs). */
  helpUrl?: string;
};

/** Help opens the shortcuts sheet, with the docs link from NEXT_PUBLIC_DOCS_URL when set. */
export const HELP_URL = "#help";

export const PAGES = {
  home: { href: "/", label: "Home", icon: House, shortcut: "H", hint: "Today at a glance." },
  payments: { href: "/payments", label: "Payments", icon: CreditCard, shortcut: "P", hint: "Money a customer or agent sent you for one order." },
  links: { href: "/links", label: "Payment links", short: "Links", icon: Link2, shortcut: "L", hint: "A link you share; anyone who opens it can pay you." },
  refunds: { href: "/refunds", label: "Refunds", icon: Undo2, shortcut: "R", hint: "Send money back to the customer from your wallet." },
  customers: { href: "/customers", label: "Customers", icon: Users, shortcut: "C", hint: "People and agents who paid you, by email and wallet." },
  agentPayments: { href: "/payments?method=agent", label: "Agent payments", short: "Agents", icon: Bot, hint: "Payments made by AI agents." },
  aiAgents: { href: "/agents", label: "AI agents", icon: BrainCircuit, hint: "Agents that work for your business on your own AI account." },
  budgets: { href: "/mandates", label: "Budgets", icon: WalletCards, shortcut: "B", hint: "Spending limits an owner signs once for one AI agent." },
  services: { href: "/providers", label: "Paid services", short: "Services", icon: Store, hint: "An API, tool or agent that charges per call." },
  nextSettlement: { href: "/netting", label: "Next settlement", icon: Waypoints, shortcut: "N", hint: "What will move in the next bundled transfer." },
  settlements: { href: "/batches", label: "Settlements", icon: Layers, hint: "One on-chain transaction that pays many charges at once." },
  businesses: { href: "/platform/businesses", label: "Businesses", icon: Building2, hint: "Shops and companies that get paid through this server." },
  pricing: { href: "/platform/pricing", label: "Pricing plans", short: "Pricing", icon: Percent, hint: "What the platform charges a business per payment." },
  earnings: { href: "/platform/earnings", label: "Platform earnings", short: "Earnings", icon: TrendingUp, hint: "Fees the platform earned, by business and method." },
  platformTeam: { href: "/platform/team", label: "Platform team", icon: UserCog, hint: "People who help run this server." },
  requests: { href: "/platform/requests", label: "Sign-up requests", icon: UserPlus, badge: "requests", hint: "New businesses waiting for approval." },
  outbox: { href: "/platform/outbox", label: "Email outbox", icon: Inbox, hint: "Emails this server would have sent; no email server is set up." },
  blocked: { href: "/blocked", label: "Blocked", icon: ShieldBan, badge: "blocked", hint: "Payments and agent charges Payminto refused, with the reason." },
  balances: { href: "/ledger", label: "Balances", icon: BookOpenCheck, hint: "Who owes what, and what has been paid, with every entry." },
  verify: { href: "/receipts", label: "Verify", icon: ShieldCheck, hint: "Check one agent charge against the chain." },
  activity: { href: "/activity", label: "Activity log", icon: ScrollText, hint: "Who changed what, and when." },
  apiKeys: { href: "/developers/keys", label: "API keys", icon: KeyRound, hint: "Lets your own software create payments." },
  webhooks: { href: "/developers/webhooks", label: "Webhooks", icon: Webhook, hint: "A message Payminto sends to your server when something happens." },
  hashkey: { href: "/developers/hashkey", label: "HashKey Chain", icon: Blocks, hint: "Network facts, RPCs, explorers, faucet and contract addresses." },
  settings: { href: "/settings", label: "Settings", icon: Settings, shortcut: "S" },
  account: { href: "/account", label: "Your account", icon: UserCog, hint: "Profile, password and sessions." },
  help: { href: HELP_URL, label: "Help", icon: LifeBuoy, external: true, hint: "Payminto docs." },
} satisfies Record<string, NavItem>;

function section(id: SectionId, label: string, defaultOpen: boolean, items: (NavItem | false | null | undefined)[]): NavSection | null {
  const list = items.filter((i): i is NavItem => Boolean(i));
  return list.length ? { id, label, defaultOpen, items: list } : null;
}

/**
 * The sidebar for one person in one view. Pages a role cannot open are left out, never shown disabled (section 3.4).
 * Platform view: section 3.2. A business (opened by its own team or by a platform role): sections 3.3 and 3.4.
 */
export function buildNav(ctx: NavContext): NavModel {
  const P = PAGES;
  const { grants, scope } = ctx;
  const has = (p: Permission) => can(grants, p, scope);
  const help = ctx.helpUrl ? { ...P.help, href: ctx.helpUrl } : P.help;
  const platformView = scope.kind === "platform";
  const sections: (NavSection | null)[] = [];
  const read = has("payments.read");

  sections.push(section("payments", "Payments", true, [read && P.payments, read && P.links, read && P.refunds, read && P.customers]));

  if (platformView) {
    const agents = has("agents.read");
    sections.push(section("agents", "Agents", true, [agents && P.budgets, agents && P.services, agents && P.nextSettlement, agents && P.settlements]));
    sections.push(
      section("platform", "Platform", true, [
        has("businesses.read") && P.businesses,
        has("pricing.read") && P.pricing,
        has("earnings.read") && P.earnings,
        has("team.read") && P.platformTeam,
        has("signups.review") && P.requests,
        has("outbox.read") && !ctx.smtpConfigured && P.outbox,
      ]),
    );
    sections.push(section("records", "Records", false, [has("screening.read") && P.blocked, agents && P.balances, P.verify, has("audit.read") && P.activity]));
  } else {
    // Budgets, paid services and settlements have no business owner yet (10.4), so only platform roles see them here.
    const agents = has("agents.read");
    // AI agents belong to the business (AGENTS.md section 7), so every member sees them; the rest stays platform-only.
    const ai = agentAccess(grants, scope).read;
    sections.push(section("agents", "Agents", agents || ctx.agentPaid, [agents && read && P.agentPayments, ai && P.aiAgents, agents && P.budgets, agents && P.services, agents && P.settlements]));
    // Staff and Viewer get Verify only (3.4); Blocked follows whoever can manage the blocked list.
    sections.push(section("records", "Records", false, [has("screening.manage") && P.blocked, agents && P.balances, P.verify, has("audit.read") && P.activity]));
  }
  sections.push(section("developers", "Developers", false, [has("developers.manage") && P.apiKeys, has("developers.manage") && P.webhooks, P.hashkey]));

  const home = P.home;
  const tabs: NavItem[] = platformView && has("businesses.read") ? [home, P.payments, P.businesses] : [home, P.payments, P.links];
  return { home, sections: sections.filter((s): s is NavSection => Boolean(s)), footer: [P.settings, help], tabs };
}

/** Every internal page in a model, in sidebar order (for the palette and `G` shortcuts). */
export function navPages(model: NavModel): NavItem[] {
  const out = [model.home, ...model.sections.flatMap((s) => s.items), ...model.footer];
  const seen = new Set<string>();
  return out.filter((i) => !i.external && !seen.has(i.href) && seen.add(i.href));
}

/** Path part of an href, so `/payments?method=agent` matches as `/payments` only when the query matches too. */
export function isActiveHref(pathname: string, search: string, href: string): boolean {
  const [path, query] = href.split("?") as [string, string | undefined];
  if (path === "/") return pathname === "/";
  const onPath = pathname === path || pathname.startsWith(`${path}/`);
  if (!onPath) return false;
  const params = new URLSearchParams(search);
  if (query) {
    const want = new URLSearchParams(query);
    for (const [k, v] of want) if (params.get(k) !== v) return false;
    return true;
  }
  // `/payments` is not active while the agent filter is on, so only one item lights up.
  return !(path === "/payments" && params.get("method") === "agent");
}

/** The section that holds the page at this location; it always opens on navigation (section 7). */
export function sectionOf(model: NavModel, pathname: string, search = ""): SectionId | null {
  for (const s of model.sections) if (s.items.some((i) => isActiveHref(pathname, search, i.href))) return s.id;
  return null;
}

/** `G` shortcuts available in a model: key -> href. */
export function goShortcuts(model: NavModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of navPages(model)) if (i.shortcut) out[i.shortcut.toLowerCase()] = i.href;
  return out;
}
