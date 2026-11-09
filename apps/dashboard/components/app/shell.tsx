"use client";

/**
 * The signed-in shell (docs/PRODUCT.md sections 3.1 and 7) and the gate in front of it: account screens render on
 * their own, everything else needs a session and is sent to /login otherwise.
 */
import { Suspense, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, KeyRound, MailWarning, MoreHorizontal, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { MOCK_MODE } from "@/lib/config";
import { useAccess, useSession } from "@/lib/session";
import { useLive } from "@/lib/live";
import { chainIdOf, useHealth, useInfo } from "@/lib/queries";
import { formatInt } from "@/lib/format";
import { isActiveHref, sectionOf } from "@/lib/nav";
import { isAuthPath, isAuthPathForSignedIn, loginHref, safeNext } from "@/lib/routes";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Sidebar, NavSections, SearchField, useNavModel } from "./sidebar";
import { AccountSwitcher, useSwitchView } from "./account-switcher";
import { UserMenu } from "./user-menu";
import { CommandPalette, openPalette } from "./command-palette";
import { ShortcutsSheet } from "./shortcuts-sheet";
import { StepUpDialog } from "./step-up-dialog";
import { useBadgeCounts } from "./nav-badges";

/** Mark: several obligations converging into one settled transfer. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-8", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <g fill="none" strokeLinecap="round" strokeWidth="2.2" className="stroke-primary-foreground">
        <path d="M7 9.5c6 0 7.5 6.5 13 6.5" opacity=".55" />
        <path d="M7 22.5c6 0 7.5-6.5 13-6.5" opacity=".55" />
        <path d="M7 16h18" />
        <path d="M21.5 12.5 25 16l-3.5 3.5" />
      </g>
    </svg>
  );
}

function LiveIndicator() {
  const { status, wasLive } = useLive();
  const access = useAccess();
  if (!access.can("agents.read")) return null;
  const label = status === "live" ? "Live" : status === "connecting" ? (wasLive ? "Reconnecting" : "Connecting") : "Offline";
  const tone = status === "live" ? "text-positive" : status === "connecting" ? "text-warning" : "text-negative";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground">
          <span className={cn("relative flex size-2", tone)}>
            {status === "live" && <span className="absolute inset-0 rounded-full bg-current [animation:pulse-ring_2s_ease-out_infinite]" />}
            {status === "connecting" && wasLive && <span className="absolute inset-0 rounded-full bg-current [animation:pulse-ring_1.6s_ease-out_infinite]" />}
            <span className="relative size-2 rounded-full bg-current" />
          </span>
          <span className="hidden sm:inline">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{status === "live" ? "Receiving live updates from your Payminto server" : status === "connecting" ? (wasLive ? "Live updates dropped; retrying" : "Opening live updates") : "No live updates. Screens refresh on demand."}</TooltipContent>
    </Tooltip>
  );
}

function NetworkPill() {
  const info = useInfo();
  const health = useHealth();
  if (!info.data) return <span className="h-8 w-36 animate-pulse rounded-md bg-muted" />;
  const chainId = chainIdOf(info.data);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex h-8 items-center gap-2 rounded-md border bg-card px-2.5 text-xs">
          <span className={cn("size-1.5 rounded-full", health.data && !health.data.ok ? "bg-negative" : "bg-positive")} aria-hidden />
          <span className="font-medium">{info.data.network.name}</span>
          {health.data?.blockNumber != null && <span className="num hidden text-muted-foreground lg:inline">block {formatInt(health.data.blockNumber)}</span>}
          {health.data && !health.data.ok && <span className="text-negative">Network unreachable</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent>Chain id {chainId}. Payments settle on this network.</TooltipContent>
    </Tooltip>
  );
}

/** "Testnet: no real money" or "Demo data" under the header, so nobody mistakes test money for real money. */
function EnvironmentStrip() {
  const info = useInfo();
  const chainId = chainIdOf(info.data);
  if (MOCK_MODE) {
    return (
      <div role="note" className="border-b border-warning/20 bg-warning-soft px-4 py-1.5 text-center text-xs font-medium text-warning sm:px-6">
        Demo data: this screen shows sample data and nothing touches a chain.
      </div>
    );
  }
  if (chainId !== 133 && chainId !== 11155111 && chainId !== 31337 && chainId !== 0) return null;
  if (!info.data) return null;
  return (
    <div role="note" className="border-b border-warning/20 bg-warning-soft px-4 py-1.5 text-center text-xs font-medium text-warning sm:px-6">
      {chainId === 31337 ? "Local test network: no real money." : "Testnet: no real money."}
    </div>
  );
}

function AccountBanners() {
  const { session } = useAccess();
  const { account } = useSession();
  const [sent, setSent] = useState(false);
  const owner = session.actorType === "recovery_key" || session.user?.platformRole === "owner";
  return (
    <>
      {session.recoveryKeyEnabled && owner && (
        <div role="alert" className="flex items-center justify-center gap-2 border-b border-negative/20 bg-negative-soft px-4 py-1.5 text-xs font-medium text-negative">
          <KeyRound className="size-3.5" aria-hidden />
          The recovery key is enabled. Turn off ADMIN_TOKEN_BREAK_GLASS on the server once you are done.
        </div>
      )}
      {session.user && !session.user.emailVerified && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b bg-info-soft px-4 py-1.5 text-xs text-foreground">
          <span className="inline-flex items-center gap-1.5">
            <MailWarning className="size-3.5 text-primary" aria-hidden /> Verify your email to change payout wallets, create API keys and invite people.
          </span>
          <button
            type="button"
            disabled={sent}
            onClick={() =>
              void account.resendVerification().then(
                () => {
                  setSent(true);
                  toast.success(`Verification link sent to ${session.user!.email}.`);
                },
                (e: Error) => toast.error(e.message),
              )
            }
            className="font-medium text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"
          >
            {sent ? "Link sent" : "Resend link"}
          </button>
        </div>
      )}
    </>
  );
}

/** The last crumb on a page below a list ("Payments / Payment"), so a detail page never repeats the list's name. */
const DETAIL_CRUMBS: Record<string, { item: string; create?: string }> = {
  "/payments": { item: "Payment" },
  "/links": { item: "Payment link", create: "New payment link" },
  "/mandates": { item: "Budget", create: "New budget" },
  "/batches": { item: "Settlement" },
  "/receipts": { item: "Charge" },
  "/developers/webhooks": { item: "Webhook" },
  "/platform/businesses": { item: "Business", create: "Add business" },
  "/agents": { item: "AI agent", create: "New AI agent" },
};

function detailCrumb(base: string, pathname: string): string | null {
  const d = DETAIL_CRUMBS[base];
  if (!d || !pathname.startsWith(`${base}/`)) return null;
  if (base === "/agents" && pathname.startsWith("/agents/runs/")) return "Run";
  if (base === "/agents" && pathname.endsWith("/edit")) return "Edit AI agent";
  return pathname === `${base}/new` ? d.create ?? d.item : d.item;
}

function Breadcrumb() {
  const model = useNavModel();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const access = useAccess();
  const switchView = useSwitchView();
  const section = model.sections.find((s) => s.id === sectionOf(model, pathname, search));
  const page = [model.home, ...model.sections.flatMap((s) => s.items), ...model.footer].find((i) => !i.external && isActiveHref(pathname, search, i.href));
  const detail = page ? detailCrumb(page.href.split("?")[0]!, pathname) : null;
  // "Payments / Payments / Payment" reads as a stutter: a page named like its section is shown once.
  const sameAsSection = Boolean(section && page && section.label === page.label);
  return (
    <div className="flex min-w-0 items-center gap-2">
      {access.platformRole && access.view?.kind === "business" && (
        <button
          type="button"
          onClick={() => switchView({ kind: "platform" })}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border bg-card px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden /> Back to platform
        </button>
      )}
      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-sm md:flex">
        {section && <span className={sameAsSection && !detail ? "font-medium" : "text-muted-foreground"}>{section.label}</span>}
        {section && page && !sameAsSection && <span className="text-subtle">/</span>}
        {page && page !== model.home && !sameAsSection && (detail ? <span className="truncate text-muted-foreground">{page.label}</span> : <span className="truncate font-medium">{page.label}</span>)}
        {detail && (
          <>
            <span className="text-subtle">/</span>
            <span className="truncate font-medium">{detail}</span>
          </>
        )}
      </nav>
    </div>
  );
}

function MobileSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const model = useNavModel();
  const close = () => onOpenChange(false);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex h-[92dvh] flex-col gap-4 rounded-t-2xl p-4 pt-6">
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <span aria-hidden className="absolute top-2 left-1/2 h-1 w-10 -translate-x-1/2 rounded-full bg-border" />
        <AccountSwitcher />
        <SearchField onOpen={close} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <NavSections model={model} onNavigate={close} />
        </div>
        <div className="flex items-center gap-2 border-t pt-3">
          <UserMenu />
          <Link href="/settings" onClick={close} className="inline-flex h-9 items-center rounded-md border px-3 text-sm">
            Settings
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Phone navigation (section 7): Home, Payments, Payment links (Businesses for platform roles), Search and More. */
function TabBar({ onMore }: { onMore: () => void }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const model = useNavModel();
  const counts = useBadgeCounts();
  const inTabs = model.tabs.some((t) => isActiveHref(pathname, search, t.href));
  // Only badges of pages this person can open count toward the dot on More.
  const moreBadge = model.sections.flatMap((s) => s.items).reduce((n, i) => n + (i.badge ? counts[i.badge] : 0), 0);
  const cls = "relative flex h-full w-full flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors duration-150";
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md lg:hidden">
      <ul className="mx-auto grid h-16 max-w-lg grid-cols-5">
        {model.tabs.map((t) => {
          const active = isActiveHref(pathname, search, t.href);
          const Icon = t.icon;
          return (
            <li key={t.href}>
              <Link href={t.href} aria-current={active ? "page" : undefined} className={cn(cls, active ? "text-primary" : "text-muted-foreground")}>
                <Icon className="size-5" strokeWidth={active ? 2.2 : 1.8} aria-hidden />
                {t.short ?? t.label}
              </Link>
            </li>
          );
        })}
        <li>
          <button type="button" onClick={() => openPalette()} className={cn(cls, "text-muted-foreground")}>
            <Search className="size-5" strokeWidth={1.8} aria-hidden />
            Search
          </button>
        </li>
        <li>
          <button type="button" onClick={onMore} className={cn(cls, inTabs ? "text-muted-foreground" : "text-primary")}>
            <span className="relative">
              <MoreHorizontal className="size-5" strokeWidth={1.8} aria-hidden />
              {moreBadge > 0 && <span className="absolute -top-0.5 -right-1 size-2 rounded-full bg-negative ring-2 ring-card" aria-label={`${moreBadge} need attention`} />}
            </span>
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const pathname = usePathname();
  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">
        Skip to content
      </a>
      <Sidebar />
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur-md">
          <div className="flex h-14 items-center gap-2 px-4 sm:px-6">
            <Link href="/" aria-label="Payminto home" className="flex items-center gap-2 lg:hidden">
              <BrandMark className="size-7" />
              <span className="text-sm font-semibold max-[380px]:hidden">Payminto</span>
            </Link>
            <Breadcrumb />
            <div className="ml-auto flex items-center gap-1.5">
              <span className="max-sm:hidden">
                <NetworkPill />
              </span>
              <LiveIndicator />
            </div>
          </div>
          <EnvironmentStrip />
        </header>
        <AccountBanners />
        <main id="main" key={pathname} className="page-in mx-auto w-full max-w-[1320px] px-4 pt-6 pb-28 sm:px-6 sm:pt-8 lg:px-8 lg:pb-16">
          {children}
        </main>
        <TabBar onMore={() => setSheetOpen(true)} />
        <MobileSheet open={sheetOpen} onOpenChange={setSheetOpen} />
      </div>
      <CommandPalette />
      <ShortcutsSheet />
      <StepUpDialog />
    </div>
  );
}

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true" aria-label="Loading">
      <BrandMark className="size-9 animate-pulse" />
    </div>
  );
}

function Gate({ children }: { children: ReactNode }) {
  const session = useSession();
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const auth = isAuthPath(pathname);
  const pending = session.status === "signed-in" && session.session.user?.status === "pending";

  useEffect(() => {
    if (session.status === "signed-out" && !auth) {
      const here = `${pathname}${params.toString() ? `?${params.toString()}` : ""}`;
      router.replace(loginHref(here, session.reason === "signed_out" ? null : session.reason));
    }
    if (session.status === "signed-in") {
      if (pending && !/^\/(signup\/pending|verify|invite)/.test(pathname)) router.replace("/signup/pending");
      else if (!pending && auth && !isAuthPathForSignedIn(pathname)) router.replace(safeNext(params.get("next")));
    }
  }, [session, auth, pathname, params, router, pending]);

  if (session.status === "loading") return <Splash />;
  if (auth) return <>{children}</>;
  if (session.status !== "signed-in" || pending) return <Splash />;
  return <Shell>{children}</Shell>;
}

export function AppGate({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<Splash />}>
      <Gate>{children}</Gate>
    </Suspense>
  );
}
