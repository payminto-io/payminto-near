"use client";

/**
 * The sidebar (docs/PRODUCT.md sections 3 and 7): account switcher, search, collapsible sections with per-user state,
 * a 64 px icon rail with tooltips and section flyouts, and the pinned footer (Settings, Help, user menu).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { HoverCard } from "radix-ui";
import { ChevronRight, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { buildNav, isActiveHref, sectionOf, type NavItem, type NavModel, type NavSection, type SectionId } from "@/lib/nav";
import { isSectionOpen, loadPrefs, savePrefs, toggleSection, type SidebarPrefs } from "@/lib/sidebar-prefs";
import { useAccess } from "@/lib/session";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBadgeCounts, CountBadge, badgeLabel } from "./nav-badges";
import { AccountSwitcher } from "./account-switcher";
import { UserMenu } from "./user-menu";
import { openPalette } from "./command-palette";
import { openShortcuts } from "./shortcuts-sheet";

const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || null;

export function useNavModel(): NavModel {
  const access = useAccess();
  return useMemo(
    () => buildNav({ grants: access.session.grants, scope: access.scope, agentPaid: false, smtpConfigured: access.session.smtpConfigured, helpUrl: DOCS_URL ?? undefined }),
    [access.session.grants, access.scope, access.session.smtpConfigured],
  );
}

// ---------------------------------------------------------------------------
// Persisted state: sections and rail
// ---------------------------------------------------------------------------

const prefsListeners = new Set<() => void>();
const prefsCache = new Map<string, SidebarPrefs>();

function usePrefs(userId: string): [SidebarPrefs, (next: SidebarPrefs) => void] {
  const get = useCallback(() => {
    let p = prefsCache.get(userId);
    if (!p) {
      p = loadPrefs(userId);
      prefsCache.set(userId, p);
    }
    return p;
  }, [userId]);
  const prefs = useSyncExternalStore(
    (fn) => {
      prefsListeners.add(fn);
      return () => prefsListeners.delete(fn);
    },
    get,
    () => ({ sections: {}, rail: null }) as SidebarPrefs,
  );
  const set = useCallback(
    (next: SidebarPrefs) => {
      prefsCache.set(userId, next);
      savePrefs(userId, next);
      for (const l of prefsListeners) l();
    },
    [userId],
  );
  return [prefs, set];
}

/** "Reset sidebar" in the user menu. */
export function resetSidebar(userId: string) {
  const next: SidebarPrefs = { sections: {}, rail: null };
  prefsCache.set(userId, next);
  savePrefs(userId, next);
  for (const l of prefsListeners) l();
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", fn);
      return () => m.removeEventListener("change", fn);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The rail is the default between 1024 and 1280 px; the user's own choice wins once made. */
export function useRail(userId: string): [boolean, () => void] {
  const [prefs, setPrefs] = usePrefs(userId);
  const narrow = useMediaQuery("(min-width: 1024px) and (max-width: 1279px)");
  const rail = prefs.rail ?? narrow;
  const toggle = useCallback(() => setPrefs({ ...prefs, rail: !rail }), [prefs, rail, setPrefs]);
  return [rail, toggle];
}

function userKey(access: ReturnType<typeof useAccess>): string {
  return access.session.user?.id ?? access.session.actorType;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

function useIsActive() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return (href: string) => isActiveHref(pathname, search, href);
}

function NavLink({ item, onNavigate, count }: { item: NavItem; onNavigate?: () => void; count: number }) {
  const isActive = useIsActive();
  const active = !item.external && isActive(item.href);
  const Icon = item.icon;
  const cls = cn(
    "group/nav relative flex h-[1.875rem] items-center gap-2.5 rounded-md px-2 text-[0.8125rem] outline-none transition-[background-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
  const body = (
    <>
      <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-subtle group-hover/nav:text-foreground")} strokeWidth={active ? 2.2 : 1.8} aria-hidden />
      <span className="flex-1 truncate">{item.label}</span>
      {item.badge && <CountBadge n={count} label={badgeLabel(item.badge, count)} tone={item.badge === "requests" ? "primary" : "negative"} />}
    </>
  );
  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" className={cls} data-nav-focus>
        {body}
      </a>
    );
  }
  return (
    <Link href={item.href} onClick={onNavigate} aria-current={active ? "page" : undefined} className={cls} data-nav-focus>
      {body}
    </Link>
  );
}

function SectionBlock({ section, open, onToggle, counts, onNavigate }: { section: NavSection; open: boolean; onToggle: () => void; counts: Record<string, number>; onNavigate?: () => void }) {
  const id = `nav-section-${section.id}`;
  const total = section.items.reduce((a, i) => a + (i.badge ? counts[i.badge] ?? 0 : 0), 0);
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        data-nav-focus
        className="group/sec flex h-7 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-subtle outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-left">{section.label}</span>
        {/* Linear and Stripe: the chevron sits after the label, shown on hover, and stays when the section is closed. */}
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-[transform,opacity] duration-[180ms] ease-out",
            open ? "rotate-90 opacity-0 group-hover/sec:opacity-100 group-focus-visible/sec:opacity-100" : "opacity-100",
          )}
          aria-hidden
        />
        <span className="flex-1" />
        {!open && total > 0 && <CountBadge n={total} label={`${total} in ${section.label}`} />}
      </button>
      <div id={id} className={cn("grid transition-[grid-template-rows,opacity] duration-[180ms] ease-out", open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")} inert={!open}>
        <div className="min-h-0 overflow-hidden">
          <div className="flex flex-col gap-px pt-0.5">
            {section.items.map((item) => (
              <NavLink key={item.href} item={item} onNavigate={onNavigate} count={item.badge ? counts[item.badge] ?? 0 : 0} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Arrow keys move between section headers and items; Home and End jump to the ends (section 7). */
function onNavKeyDown(e: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-nav-focus]")].filter((el) => !el.closest("[inert]"));
  const i = all.indexOf(document.activeElement as HTMLElement);
  if (i < 0 && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length;
  all[next]?.focus();
}

export function NavSections({ model, onNavigate }: { model: NavModel; onNavigate?: () => void }) {
  const access = useAccess();
  const [prefs, setPrefs] = usePrefs(userKey(access));
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const counts = useBadgeCounts();
  const active = sectionOf(model, pathname, search);
  // The section holding the page opens on every navigation, even if collapsed before; the user may close it again.
  const [forced, setForced] = useState<SectionId | null>(active);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setForced(active);
  }
  const isActive = useIsActive();
  return (
    <nav aria-label="Main" className="flex flex-col gap-3" onKeyDown={onNavKeyDown}>
      <NavLink item={model.home} onNavigate={onNavigate} count={0} />
      {model.sections.map((s) => {
        const open = isSectionOpen(s, prefs, forced);
        return (
          <SectionBlock
            key={s.id}
            section={s}
            open={open}
            counts={counts}
            onNavigate={onNavigate}
            onToggle={() => {
              if (forced === s.id) setForced(null);
              // Collapsing the section that holds the page keeps it collapsed; navigation reopens it.
              setPrefs(toggleSection(prefs, s, open));
              void isActive;
            }}
          />
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Rail (collapsed)
// ---------------------------------------------------------------------------

function RailItem({ item, count }: { item: NavItem; count: number }) {
  const isActive = useIsActive();
  const active = !item.external && isActive(item.href);
  const Icon = item.icon;
  const cls = cn(
    "relative flex size-10 items-center justify-center rounded-md outline-none transition-colors duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  );
  const inner = (
    <>
      <Icon className="size-[1.125rem]" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
      {count > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-negative ring-2 ring-rail" aria-label={item.badge ? badgeLabel(item.badge, count) : undefined} />}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {item.external ? (
          <a href={item.href} target="_blank" rel="noreferrer" aria-label={item.label} className={cls} data-nav-focus>
            {inner}
          </a>
        ) : (
          <Link href={item.href} aria-label={item.label} aria-current={active ? "page" : undefined} className={cls} data-nav-focus>
            {inner}
          </Link>
        )}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="flex items-center gap-2">
        {item.label}
        {item.shortcut && (
          <kbd className="hash rounded bg-background/20 px-1 text-[0.625rem]">
            G {item.shortcut}
          </kbd>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function RailDivider({ section, counts }: { section: NavSection; counts: Record<string, number> }) {
  return (
    <HoverCard.Root openDelay={120} closeDelay={120}>
      <HoverCard.Trigger asChild>
        <button type="button" className="group/div flex h-4 w-10 items-center justify-center outline-none" aria-label={`${section.label} pages`} data-nav-focus>
          <span className="h-px w-6 bg-border transition-[width,background-color] duration-150 group-hover/div:w-8 group-hover/div:bg-subtle group-focus-visible/div:bg-ring" />
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content side="right" align="start" sideOffset={10} className="z-50 w-56 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <p className="px-2 pt-1 pb-1.5 text-[0.6875rem] font-medium tracking-[0.06em] text-subtle uppercase">{section.label}</p>
          <div className="flex flex-col gap-0.5">
            {section.items.map((i) => (
              <NavLink key={i.href} item={i} count={i.badge ? counts[i.badge] ?? 0 : 0} />
            ))}
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

function RailNav({ model }: { model: NavModel }) {
  const counts = useBadgeCounts();
  return (
    <nav aria-label="Main" className="flex flex-col items-center gap-1" onKeyDown={onNavKeyDown}>
      <RailItem item={model.home} count={0} />
      {model.sections.map((s) => (
        <div key={s.id} className="flex flex-col items-center gap-1">
          <RailDivider section={s} counts={counts} />
          {s.items.map((i) => (
            <RailItem key={i.href} item={i} count={i.badge ? counts[i.badge] ?? 0 : 0} />
          ))}
        </div>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Search field
// ---------------------------------------------------------------------------

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export function SearchField({ onOpen }: { onOpen?: () => void }) {
  const [mac, setMac] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the platform is only known in the browser
  useEffect(() => setMac(isMac()), []);
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        openPalette();
      }}
      className="flex h-9 w-full items-center gap-2 rounded-md border bg-card px-2.5 text-left text-sm text-muted-foreground shadow-xs transition-[border-color,color] duration-150 ease-out hover:border-subtle hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      aria-label="Search or jump to"
      aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}
    >
      <Search className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate">Search or jump to...</span>
      <kbd className="hash rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 text-subtle">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The sidebar
// ---------------------------------------------------------------------------

function ScrollArea({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const [edges, setEdges] = useState({ top: false, bottom: false });
  // Keep the current page's item visible after navigation.
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active) return;
    const t = window.setTimeout(() => {
      const a = active.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (a.top < box.top || a.bottom > box.bottom - 24) el.scrollTo({ top: el.scrollTop + a.top - box.top - box.height / 2 + a.height / 2, behavior: "smooth" });
    }, 200);
    return () => window.clearTimeout(t);
  }, [pathname]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setEdges({ top: el.scrollTop > 1, bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1 });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);
  const mask =
    edges.top || edges.bottom
      ? `linear-gradient(to bottom, ${edges.top ? "transparent, black 1.5rem" : "black"}, ${edges.bottom ? "black calc(100% - 2rem), transparent" : "black"})`
      : undefined;
  return (
    <div ref={ref} className={cn("-mx-1 min-h-0 flex-1 overflow-y-auto px-1 py-1", className)} style={{ maskImage: mask, WebkitMaskImage: mask }}>
      {children}
    </div>
  );
}

function FooterLinks({ model, rail }: { model: NavModel; rail: boolean }) {
  const settings = model.footer.find((i) => i.href === "/settings")!;
  const help = model.footer.find((i) => i.label === "Help")!;
  const Help = help.icon;
  if (rail) {
    return (
      <div className="flex flex-col items-center gap-1">
        <RailItem item={settings} count={0} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => openShortcuts()} aria-label="Help" className="flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Help className="size-[1.125rem]" strokeWidth={1.8} aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Help and keyboard shortcuts
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <NavLink item={settings} count={0} />
      <button
        type="button"
        onClick={() => openShortcuts()}
        className="group/nav flex h-[1.875rem] items-center gap-2.5 rounded-md px-2 text-[0.8125rem] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Help className="size-4 shrink-0 text-subtle group-hover/nav:text-foreground" strokeWidth={1.8} aria-hidden />
        <span className="flex-1 text-left">Help</span>
        <kbd className="hash rounded border bg-muted px-1.5 text-[0.6875rem] leading-5 text-subtle">?</kbd>
      </button>
    </div>
  );
}

export function Sidebar() {
  const access = useAccess();
  const model = useNavModel();
  const [rail, toggleRail] = useRail(userKey(access));
  return (
    <aside
      aria-label="Sidebar"
      data-rail={rail || undefined}
      className={cn(
        "sticky top-0 hidden h-dvh flex-col gap-3 border-r bg-rail py-4 transition-[width,padding] duration-200 ease-out lg:flex",
        rail ? "w-16 items-center px-3" : "w-[15.5rem] px-3",
      )}
    >
      <AccountSwitcher compact={rail} />
      {rail ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={() => openPalette()} aria-label="Search or jump to" className="flex size-10 items-center justify-center rounded-md border bg-card text-muted-foreground transition-colors hover:text-foreground">
              <Search className="size-4" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Search <kbd className="hash ml-1 text-[0.625rem]">{isMac() ? "⌘K" : "Ctrl K"}</kbd>
          </TooltipContent>
        </Tooltip>
      ) : (
        <SearchField />
      )}
      <ScrollArea className={rail ? "w-full" : undefined}>{rail ? <RailNav model={model} /> : <NavSections model={model} />}</ScrollArea>
      <div className={cn("flex flex-col gap-2 border-t pt-3", rail ? "w-full items-center" : "")}>
        <FooterLinks model={model} rail={rail} />
        <div className={cn("flex items-center gap-1", rail ? "flex-col" : "")}>
          <UserMenu compact={rail} />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleRail}
                aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
                aria-keyshortcuts="["
                className="flex size-8 shrink-0 items-center justify-center rounded-md text-subtle transition-colors hover:bg-muted hover:text-foreground"
              >
                {rail ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {rail ? "Expand sidebar" : "Collapse sidebar"} <kbd className="hash ml-1 text-[0.625rem]">[</kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}

export { userKey };
