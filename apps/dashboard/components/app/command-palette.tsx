"use client";

/**
 * The command palette (docs/PRODUCT.md section 5): Cmd/Ctrl K or `/` anywhere in the signed-in app, and the sidebar
 * search field. Empty query shows Recent, Quick actions and Pages; typing searches the server (GET /v1/search) and
 * the static pages and actions, grouped by type with full keyboard control.
 * Also owns the global shortcuts: `G` then a letter, `?` for the shortcut sheet and `[` for the rail.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArrowRight,
  Bot,
  Building2,
  Clock,
  CornerDownLeft,
  CreditCard,
  FileText,
  Keyboard,
  Layers,
  Link2,
  Loader2,
  LogOut,
  Moon,
  Plus,
  Search,
  Settings,
  Store,
  Undo2,
  UserPlus,
  Users,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { withBusiness } from "@/lib/merchant-scope";
import { useAccess, useSession } from "@/lib/session";
import { goShortcuts, navPages, PAGES } from "@/lib/nav";
import {
  FILTER_LABEL,
  GROUP_LABEL,
  buildGroups,
  cycleFilter,
  detect,
  detectedHint,
  filterPrefix,
  flatten,
  highlight,
  moveIndex,
  parseQuery,
  pushRecent,
  shouldSearchServer,
  typesFor,
  type Filter,
  type GroupType,
  type SearchGroup,
  type SearchItem,
} from "@/lib/search";
import { useNavModel, useRail, userKey } from "./sidebar";
import { openSwitcher, useBusinessOptions } from "./account-switcher";
import { openShortcuts } from "./shortcuts-sheet";

// ---------------------------------------------------------------------------
// Open from anywhere
// ---------------------------------------------------------------------------

const OPEN_EVENT = "payminto:palette";
export function openPalette(query = "") {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { query } }));
}

const TYPE_ICON: Record<GroupType, LucideIcon> = {
  recent: Clock,
  action: ArrowRight,
  page: FileText,
  payment: CreditCard,
  link: Link2,
  customer: Users,
  refund: Undo2,
  business: Building2,
  budget: WalletCards,
  paid_service: Store,
  settlement: Layers,
  setting: Settings,
  shortcut: Keyboard,
};

const ACTION_ICON: Record<string, LucideIcon> = { newLink: Plus, newBudget: Bot, refund: Undo2, invite: UserPlus, switch: Building2, theme: Moon, shortcuts: Keyboard, signOut: LogOut };

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

// ---------------------------------------------------------------------------
// Local recent items (fast first paint; the server keeps the real list)
// ---------------------------------------------------------------------------

function recentKey(user: string) {
  return `payminto.recent.${user}`;
}
function loadLocalRecent(user: string): SearchItem[] {
  try {
    const raw = window.localStorage.getItem(recentKey(user));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && typeof (x as SearchItem).title === "string" && typeof (x as SearchItem).href === "string") as SearchItem[]) : [];
  } catch {
    return [];
  }
}
function saveLocalRecent(user: string, list: SearchItem[]) {
  try {
    window.localStorage.setItem(recentKey(user), JSON.stringify(list.slice(0, 20)));
  } catch {
    // Storage blocked: recent items last for this page.
  }
}

// ---------------------------------------------------------------------------
// Static entries
// ---------------------------------------------------------------------------

function useStaticEntries() {
  const access = useAccess();
  const model = useNavModel();
  const options = useBusinessOptions();
  const can = access.can;
  return useMemo(() => {
    const pages: SearchItem[] = navPages(model).map((p) => ({ key: `page:${p.href}`, type: "page", id: p.href, title: p.label, subtitle: p.hint ?? null, href: p.href, shortcut: p.shortcut ? `G ${p.shortcut}` : undefined, keywords: keywordsFor(p.href) }));
    if (access.session.user) pages.push({ key: "page:/account", type: "page", id: "/account", title: PAGES.account.label, subtitle: PAGES.account.hint, href: "/account", keywords: ["profile", "password", "sessions", "me"] });
    const actions: SearchItem[] = [];
    const act = (action: string, title: string, subtitle: string, keywords: string[] = [], href?: string) => actions.push({ key: `action:${action}`, type: "action", id: action, title, subtitle, action, href, keywords });
    if (can("links.write")) act("newLink", "New payment link", "Create a link anyone can pay", ["create", "link"], "/links/new");
    if (can("agents.manage")) act("newBudget", "New budget", "Give an AI agent a spending limit", ["budget", "agent", "create"], "/budgets/new");
    if (can("refunds.request")) act("refund", "Issue refund", "Pick a paid payment to refund", ["refund", "money back"], "/payments?tab=paid");
    if (can("members.manage") || can("team.manage")) act("invite", "Invite teammate", "Add someone to this team", ["team", "member", "invite"], access.platformView ? "/platform/team?invite=1" : "/settings/team?invite=1");
    if (access.platformRole || options.length > 1) act("switch", "Switch business", "Open another business or the platform", ["account", "business", "platform"]);
    act("theme", "Toggle dark mode", "Switch between light and dark", ["theme", "dark", "light"]);
    act("shortcuts", "Keyboard shortcuts", "Every shortcut in one list", ["help", "keys", "?"]);
    act("signOut", "Sign out", "End this session", ["logout", "log out"]);
    const settings: SearchItem[] = [];
    const set = (id: string, title: string, href: string, keywords: string[] = []) => settings.push({ key: `setting:${id}`, type: "setting", id, title, href, subtitle: "Settings", keywords });
    if (access.view?.kind === "business") {
      if (can("business.update")) set("profile", "Business profile", "/settings", ["name", "logo", "brand color", "support email", "checkout"]);
      if (can("business.update")) set("methods", "Payment methods", "/settings/methods", ["wallet", "deposit", "agent", "fees"]);
      if (can("payout.change")) set("payout", "Payout wallet", "/settings/payout", ["wallet", "address"]);
      if (can("members.read")) set("team", "Team", "/settings/team", ["members", "roles", "invite"]);
    }
    if (can("platform.read")) {
      set("platform", "Platform settings", "/settings/platform", ["name", "sign-ups", "fee wallet", "default pricing", "email", "smtp", "recovery key"]);
      set("network", "Network", "/settings/network", ["rpc", "chain", "explorer", "contracts"]);
    }
    return { pages, actions, settings };
  }, [model, access.session.user, access.platformView, access.platformRole, access.view, options.length, can]);
}

function keywordsFor(href: string): string[] {
  const k: Record<string, string[]> = {
    "/budgets": ["budget", "agent", "spending"],
    "/providers": ["provider", "api", "paid service"],
    "/netting": ["netting", "bundle"],
    "/batches": ["batch", "settlement"],
    "/ledger": ["ledger", "balance"],
    "/receipts": ["receipt", "proof", "verify"],
    "/blocked": ["denial", "screening", "deny list", "blocked wallets"],
    "/platform/businesses": ["merchant", "business"],
    "/activity": ["audit", "log", "history"],
  };
  return k[href] ?? [];
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlight(text, query).map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-[2px] bg-[color-mix(in_oklab,var(--primary)_18%,transparent)] text-inherit">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  tx_hash: "Transaction",
  payer: "Payer",
  payment_address: "Payment address",
  payout: "Payout wallet",
  agent: "Agent",
  owner: "Budget owner",
  payee: "Paid service",
  customer_email: "Email",
  email: "Email",
  amount: "Amount",
  wallet: "Wallet",
  reference: "Reference",
};

export function CommandPalette() {
  const router = useRouter();
  const session = useSession();
  const access = useAccess();
  const { setTheme, resolvedTheme } = useTheme();
  const model = useNavModel();
  const [, toggleRail] = useRail(userKey(access));
  const { pages, actions, settings } = useStaticEntries();
  const user = userKey(access);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<Filter | null>(null);
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<SearchGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchedFor, setSearchedFor] = useState("");
  const [recent, setRecent] = useState<SearchItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  // A typed prefix becomes the chip, so `p:` reads as a filter and the text stays clean.
  const parsed = parseQuery(query);
  const filter = parsed.filter ?? chip;
  const text = parsed.filter ? parsed.text : query.trim();
  const effective = filter ? `${filterPrefix(filter)}${text}` : text;

  const show = useCallback((q = "") => {
    setQuery(q);
    setChip(null);
    setActive(0);
    setOpen(true);
  }, []);

  // Recent items: local first, then the server's list.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once per open from browser storage
    setRecent(loadLocalRecent(user));
    let off = false;
    session.search
      .recent()
      .then((items) => {
        if (!off && items.length) setRecent(items);
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [open, user, session.search]);

  // Server search within 150 ms of the last keystroke; earlier answers are dropped when a newer query starts.
  useEffect(() => {
    if (!open) return;
    if (!shouldSearchServer(effective)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale results when the query gets short
      setRemote([]);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = window.setTimeout(() => {
      session.search
        .search(text, { types: typesFor(filter), limit: 6, signal: ctrl.signal })
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setRemote(r.groups);
          setSearchedFor(text);
        })
        .catch(() => {
          if (!ctrl.signal.aborted) setRemote([]);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [effective, text, filter, open, session.search]);

  const groups = useMemo(
    () => buildGroups({ query: effective, recent, actions, pages, settings, remote: text === searchedFor || loading ? remote : [] }),
    [effective, recent, actions, pages, settings, remote, text, searchedFor, loading],
  );
  const rows = flatten(groups);
  const activeRow = rows[Math.min(active, rows.length - 1)] ?? null;

  // Keep the active row in view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(activeRow?.key ?? "")}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeRow?.key]);

  const remember = (item: SearchItem) => {
    if (!item.href || item.type === "action") return;
    const entry: SearchItem = { ...item, subtitle: GROUP_LABEL[item.type === "recent" ? "page" : item.type] ?? null };
    const next = pushRecent(recent, entry);
    setRecent(next);
    saveLocalRecent(user, next);
    const type = item.type === "page" || item.type === "setting" || item.type === "recent" ? "page" : item.type;
    void session.search.record({ type, id: item.id, title: item.title, href: item.href }).catch(() => undefined);
  };

  const runAction = (id: string) => {
    switch (id) {
      case "switch":
        window.setTimeout(openSwitcher, 50);
        return true;
      case "theme":
        setTheme(resolvedTheme === "dark" ? "light" : "dark");
        return true;
      case "shortcuts":
        window.setTimeout(openShortcuts, 50);
        return true;
      case "signOut":
        void session.signOut().then(() => router.replace("/login?reason=signed_out"));
        return true;
      default:
        return false;
    }
  };

  const choose = (item: SearchItem, newTab = false) => {
    setOpen(false);
    if (item.action && runAction(item.action)) return;
    if (!item.href) return;
    remember(item);
    // On the platform view a record names its business in the URL, so its detail page sends the right Merchant-Id.
    const href = item.merchantId && item.type !== "business" ? withBusiness(item.href, item.merchantId) : item.href;
    if (newTab || item.external) window.open(href, "_blank", "noopener");
    else router.push(href);
  };

  const availableFilters = useMemo(() => {
    const f: Filter[] = ["payment", "link", "customer"];
    if (access.can("businesses.read")) f.push("business");
    if (access.can("agents.read")) f.push("budget");
    f.push("action");
    return f;
  }, [access]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => moveIndex(Math.min(i, rows.length - 1), e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Home" && rows.length && !query) {
      setActive(0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeRow) choose(activeRow, e.metaKey || e.ctrlKey);
      else if (text) {
        setOpen(false);
        router.push(`/payments?q=${encodeURIComponent(text)}`);
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const next = cycleFilter(filter, availableFilters, e.shiftKey);
      setChip(next);
      setQuery(text);
      setActive(0);
    } else if (e.key === "Backspace" && !query && filter) {
      e.preventDefault();
      setChip(null);
    }
  };

  // Global shortcuts (section 7): Cmd/Ctrl K, `/`, `G` then a letter, `?`, `[`.
  const go = useMemo(() => goShortcuts(model), [model]);
  useEffect(() => {
    let gAt = 0;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => {
          if (!o) {
            setQuery("");
            setChip(null);
            setActive(0);
          }
          return !o;
        });
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      if (e.key === "/") {
        e.preventDefault();
        show();
      } else if (e.key === "?") {
        e.preventDefault();
        openShortcuts();
      } else if (e.key === "[") {
        e.preventDefault();
        toggleRail();
      } else if (e.key.toLowerCase() === "g") {
        gAt = Date.now();
      } else if (Date.now() - gAt < 1200) {
        const k = e.key.toLowerCase();
        gAt = 0;
        if (k === "b" && !go.b) {
          e.preventDefault();
          openSwitcher();
        } else if (go[k]) {
          e.preventDefault();
          router.push(go[k]!);
        }
      }
    };
    const onOpen = (e: Event) => show((e as CustomEvent<{ query?: string }>).detail?.query ?? "");
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [go, router, show, toggleRail]);

  const d = detect(text);
  const hint = filter ? null : detectedHint(d);
  const noResults = text.length >= 2 && !loading && rows.length === 0;
  const indexOf = new Map(rows.map((r, i) => [r.key, i]));

  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed top-[10vh] left-1/2 z-50 flex max-h-[min(36rem,80vh)] w-[calc(100vw-2rem)] max-w-[40rem] -translate-x-1/2 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-top-2"
        >
          <DialogPrimitive.Title className="sr-only">Search or jump to</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b px-3.5">
            {loading ? <Loader2 className="size-4 shrink-0 animate-spin text-subtle" aria-hidden /> : <Search className="size-4 shrink-0 text-subtle" aria-hidden />}
            {filter && (
              <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-accent pr-1 pl-2 text-xs font-medium text-accent-foreground">
                {FILTER_LABEL[filter]}
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => {
                    setChip(null);
                    setQuery(text);
                    inputRef.current?.focus();
                  }}
                  className="rounded p-0.5 hover:bg-background/40"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            )}
            <input
              ref={inputRef}
              value={parsed.filter ? text : query}
              onChange={(e) => {
                const v = e.target.value;
                const p = parseQuery(v);
                if (p.filter) {
                  setChip(p.filter);
                  setQuery(p.text);
                } else setQuery(v);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={filter ? `Search ${FILTER_LABEL[filter].toLowerCase()}` : "Search payments, links, customers, pages..."}
              aria-label="Search or jump to"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeRow ? `${listId}-${activeRow.key}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              spellCheck={false}
              className="h-12 min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-subtle"
            />
            <kbd className="hash hidden rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 text-subtle sm:inline">Esc</kbd>
          </div>
          {hint && <p className="border-b bg-muted/40 px-3.5 py-1.5 text-xs text-muted-foreground">{hint}</p>}
          <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {groups.map((g) => (
              <div key={g.type} role="group" aria-label={GROUP_LABEL[g.type]} className="pb-1 [&+&]:border-t [&+&]:pt-1">
                <p className="flex items-center justify-between px-2 pt-1.5 pb-1 text-[0.6875rem] font-medium tracking-[0.06em] text-subtle uppercase">
                  {GROUP_LABEL[g.type]}
                  {g.total > g.items.length && <span className="normal-case tracking-normal">{g.total} matches</span>}
                </p>
                {g.items.map((item) => (
                  <Row key={item.key} id={`${listId}-${item.key}`} item={item} query={text} active={activeRow?.key === item.key} onHover={() => setActive(indexOf.get(item.key) ?? 0)} onChoose={(newTab) => choose(item, newTab)} />
                ))}
              </div>
            ))}
            {noResults && (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No results for <span className="font-medium text-foreground">&ldquo;{text}&rdquo;</span>
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    router.push(`/payments?q=${encodeURIComponent(text)}`);
                  }}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm transition-colors hover:bg-muted"
                >
                  <Search className="size-3.5" aria-hidden /> Search all payments for &ldquo;{text}&rdquo;
                </button>
              </div>
            )}
          </div>
          <div className="hidden items-center gap-4 border-t px-3.5 py-2 text-[0.6875rem] text-subtle sm:flex">
            <Key k="↑↓">Move</Key>
            <Key k="↵">Open</Key>
            <Key k={mac ? "⌘ ↵" : "Ctrl ↵"}>New tab</Key>
            <Key k="Tab">Filter</Key>
            <span className="ml-auto">
              Type <span className="hash">p:</span> <span className="hash">l:</span> <span className="hash">c:</span> <span className="hash">&gt;</span> to filter
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Key({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="hash rounded border bg-muted px-1 leading-4">{k}</kbd>
      {children}
    </span>
  );
}

function Row({ id, item, query, active, onHover, onChoose }: { id: string; item: SearchItem; query: string; active: boolean; onHover: () => void; onChoose: (newTab: boolean) => void }) {
  const Icon = item.type === "action" ? ACTION_ICON[item.action ?? ""] ?? ArrowRight : TYPE_ICON[item.type];
  const field = item.matched && item.matched.field !== "title" && item.matched.field !== "name" && item.matched.field !== "label" && item.matched.field !== "description" ? item.matched : null;
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-row={item.key}
      onMouseMove={onHover}
      onClick={(e) => onChoose(e.metaKey || e.ctrlKey)}
      className={cn("flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm transition-colors duration-100", active ? "bg-accent text-accent-foreground" : "text-foreground")}
    >
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md border bg-card", active && "border-transparent bg-background/60")}>
        <Icon className="size-3.5 text-muted-foreground" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          <Highlighted text={item.title} query={query} />
        </span>
        {(item.subtitle || field) && (
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            {field && (
              <span className="hash shrink-0 truncate rounded bg-muted px-1 text-[0.6875rem]">
                {FIELD_LABEL[field.field] ?? field.field}: <Highlighted text={field.snippet} query={query} />
              </span>
            )}
            {item.subtitle && <span className="truncate first-letter:uppercase">{item.subtitle}</span>}
          </span>
        )}
      </span>
      {item.shortcut && <kbd className="hash hidden shrink-0 rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 text-subtle sm:inline">{item.shortcut}</kbd>}
      {active && <CornerDownLeft className="size-3.5 shrink-0 text-subtle" aria-hidden />}
    </div>
  );
}
