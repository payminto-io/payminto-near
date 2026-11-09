"use client";

/**
 * The account switcher at the top of the sidebar (docs/PRODUCT.md section 3.5): Platform (platform roles), every
 * business the person can open with a search field past six, then Add business. Choosing one sets the view, tells
 * the server (`last_business_id`) and resets cached screens so nothing from the previous business lingers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Check, ChevronsUpDown, LayoutGrid, Plus, Search } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { setView, type View } from "@/lib/merchant-scope";
import { useMerchants } from "@/lib/operator-queries";
import { ROLE_LABEL, roleKey } from "@/lib/permissions";
import { buildNav, navPages, isActiveHref } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type BusinessOption = { id: string; name: string; status: string; brandColor: string | null; role: string };

/** Businesses the person can open: every business for platform roles, else their memberships. */
export function useBusinessOptions(): BusinessOption[] {
  const access = useAccess();
  const merchants = useMerchants();
  return useMemo(() => {
    if (access.platformRole) {
      return (merchants.data ?? []).map((m) => ({ id: m.id, name: m.name, status: m.status, brandColor: m.brand_color ?? null, role: access.session.actorType === "recovery_key" ? "Recovery key" : "Platform" }));
    }
    return access.session.memberships.map((m) => ({ id: m.merchantId, name: m.name, status: m.status, brandColor: null, role: ROLE_LABEL[m.role] }));
  }, [access.platformRole, access.session, merchants.data]);
}

/**
 * Switch the view. Gateway and account screens are reset, not just invalidated, so no screen keeps showing the
 * previous business's data while the new one loads; a page the new view cannot open goes Home.
 */
export function useSwitchView(): (v: View) => void {
  const qc = useQueryClient();
  const { account } = useSession();
  const access = useAccess();
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (v: View) => {
      setView(v);
      void qc.resetQueries({ predicate: (q) => !["info", "health"].includes(String(q.queryKey[0])) && q.queryKey[0] !== "operator" });
      if (access.session.actorType === "user") void account.updateMe({ last_business_id: v.kind === "business" ? v.merchantId : null }).catch(() => undefined);
      const model = buildNav({ grants: access.session.grants, scope: v.kind === "business" ? v : { kind: "platform" }, agentPaid: false, smtpConfigured: access.session.smtpConfigured });
      const allowed = navPages(model).some((p) => isActiveHref(pathname, window.location.search, p.href)) || /^\/(account|settings)/.test(pathname);
      if (!allowed) router.push("/");
    },
    [qc, account, access.session, router, pathname],
  );
}

function Mark({ name, color, className }: { name: string; color?: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      style={color ? { background: color, color: "#fff" } : undefined}
      className={cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground", className)}
    >
      {name.trim().slice(0, 1).toUpperCase() || "P"}
    </span>
  );
}

function PlatformMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background", className)}>
      <LayoutGrid className="size-3.5" />
    </span>
  );
}

export function openSwitcher() {
  window.dispatchEvent(new CustomEvent("payminto:switcher"));
}

export function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const access = useAccess();
  const options = useBusinessOptions();
  const switchTo = useSwitchView();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const { session, view, platformRole } = access;

  // A stored business that no longer exists (or a link to one) falls back to the platform view or the first business.
  const merchantsLoaded = useMerchants().isSuccess || !platformRole;
  useEffect(() => {
    if (!merchantsLoaded || view?.kind !== "business" || options.some((o) => o.id === view.merchantId)) return;
    setView(platformRole ? { kind: "platform" } : options[0] ? { kind: "business", merchantId: options[0].id } : null);
  }, [merchantsLoaded, view, options, platformRole]);

  useEffect(() => {
    if (open && options.length > 6) window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [open, options.length]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("payminto:switcher", onOpen);
    return () => window.removeEventListener("payminto:switcher", onOpen);
  }, []);

  const current = view?.kind === "business" ? options.find((o) => o.id === view.merchantId) ?? null : null;
  const membership = view?.kind === "business" ? session.memberships.find((m) => m.merchantId === view.merchantId) : undefined;
  const role = roleKey(session.user?.platformRole ?? null, membership?.role ?? null, session.actorType);
  const title = view?.kind === "platform" ? session.platformName || "Platform" : current?.name ?? membership?.name ?? "Loading";
  const subtitle = view?.kind === "platform" ? (role ? ROLE_LABEL[role] : "Platform") : role ? (platformRole ? `${ROLE_LABEL[role]}, in this business` : ROLE_LABEL[role]) : "";
  const many = options.length > 6;
  const shown = many && query ? options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase())) : options;
  // A business user with one business and nothing else to choose has no menu to open.
  const nothingToSwitch = !platformRole && options.length <= 1 && session.signupMode !== "open";

  const trigger = (
    <button
      type="button"
      disabled={nothingToSwitch}
      aria-label={`${title}, ${subtitle}. ${nothingToSwitch ? "" : "Switch business"}`}
      className={cn(
        "flex items-center gap-2.5 rounded-lg text-left text-sm outline-none transition-[background-color,border-color] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
        compact ? "size-10 justify-center" : "h-12 w-full border bg-card px-2.5 hover:bg-muted/60 disabled:hover:bg-card",
      )}
    >
      {view?.kind === "platform" ? <PlatformMark className={compact ? "size-8" : undefined} /> : <Mark name={title} color={current?.brandColor} className={compact ? "size-8" : undefined} />}
      {!compact && (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium leading-tight">{title}</span>
            <span className="block truncate text-[0.6875rem] text-muted-foreground">{subtitle}</span>
          </span>
          {!nothingToSwitch && <ChevronsUpDown className="size-4 shrink-0 text-subtle" aria-hidden />}
        </>
      )}
    </button>
  );

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {title}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" side={compact ? "right" : "bottom"} className="w-64">
        {platformRole && (
          <>
            <DropdownMenuItem onSelect={() => switchTo({ kind: "platform" })} className="gap-2.5">
              <PlatformMark className="size-6" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">Platform</span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">All businesses</span>
              </span>
              {view?.kind === "platform" && <Check className="size-4 text-primary" aria-label="Current" />}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="text-xs text-muted-foreground">Businesses</DropdownMenuLabel>
        {many && (
          <div className="px-1 pb-1">
            <label className="flex h-8 items-center gap-2 rounded-md border bg-background px-2 text-sm">
              <Search className="size-3.5 text-subtle" aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Find a business"
                aria-label="Find a business"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle"
              />
            </label>
          </div>
        )}
        <div className="max-h-72 overflow-y-auto">
          {shown.map((o) => (
            <DropdownMenuItem key={o.id} onSelect={() => switchTo({ kind: "business", merchantId: o.id })} className="gap-2.5">
              <Mark name={o.name} color={o.brandColor} className="size-6 text-[0.625rem]" />
              <span className={cn("min-w-0 flex-1", o.status === "suspended" && "text-muted-foreground")}>
                <span className="block truncate">{o.name}</span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">{o.status === "suspended" ? "Suspended" : o.role}</span>
              </span>
              {view?.kind === "business" && o.id === view.merchantId && <Check className="size-4 text-primary" aria-label="Current" />}
            </DropdownMenuItem>
          ))}
          {shown.length === 0 && <p className="px-2 py-3 text-center text-sm text-muted-foreground">{options.length ? "No business matches" : "No businesses yet"}</p>}
        </div>
        {(access.can("businesses.manage") || session.signupMode === "open") && <DropdownMenuSeparator />}
        {access.can("businesses.manage") && (
          <DropdownMenuItem asChild className="gap-2.5">
            <Link href="/platform/businesses/new">
              <Plus className="size-4" aria-hidden /> Add business
            </Link>
          </DropdownMenuItem>
        )}
        {!platformRole && session.signupMode === "open" && (
          <DropdownMenuItem asChild className="gap-2.5">
            <Link href="/signup">
              <Building2 className="size-4" aria-hidden /> Create a business
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
