"use client";

/**
 * Settings as one page with a left tab list (PRODUCT.md section 3.5): Business tabs on a business view, Platform tabs
 * for platform roles, and Your account for everyone. Tabs a role cannot use are not shown.
 */
import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, CreditCard, Globe, Sparkles, SlidersHorizontal, UserRound, Users, Wallet } from "lucide-react";
import { useAccess } from "@/lib/session";
import { agentAccess } from "@/lib/agents";
import { cn } from "@/lib/utils";

type Tab = { href: string; label: string; icon: typeof Users };

export function useSettingsTabs(): { label: string; tabs: Tab[] }[] {
  const access = useAccess();
  const groups: { label: string; tabs: Tab[] }[] = [];
  if (access.view?.kind === "business") {
    const tabs: Tab[] = [{ href: "/settings", label: "Profile", icon: Building2 }];
    if (access.can("business.update") || access.can("payout.change")) tabs.push({ href: "/settings/payout", label: "Payout wallet", icon: Wallet });
    if (access.can("business.update")) tabs.push({ href: "/settings/methods", label: "Payment methods", icon: CreditCard });
    if (access.can("members.read")) tabs.push({ href: "/settings/team", label: "Team", icon: Users });
    if (agentAccess(access.session.grants, access.scope).read) tabs.push({ href: "/settings/ai", label: "AI models", icon: Sparkles });
    groups.push({ label: "Business", tabs });
  }
  if (access.can("platform.read")) {
    groups.push({
      label: "Platform",
      tabs: [
        { href: "/settings/platform", label: "General", icon: SlidersHorizontal },
        { href: "/settings/network", label: "Network", icon: Globe },
      ],
    });
  }
  if (access.session.user) groups.push({ label: "You", tabs: [{ href: "/account", label: "Your account", icon: UserRound }] });
  return groups;
}

export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const groups = useSettingsTabs();
  const nav = useRef<HTMLElement>(null);
  // On phones the tabs scroll sideways; keep the open one in view.
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pathname]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[12.5rem_minmax(0,1fr)] lg:gap-8">
      <nav ref={nav} aria-label="Settings" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
        <div className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-4 lg:overflow-visible lg:px-0">
          {groups.map((g) => (
            <div key={g.label} className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5">
              <p className="hidden px-2.5 pb-1 text-[0.6875rem] font-medium tracking-[0.06em] text-subtle uppercase lg:block">{g.label}</p>
              {g.tabs.map((t) => {
                const active = pathname === t.href;
                return (
                  <Link
                    key={t.href}
                    href={t.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-sm whitespace-nowrap transition-colors duration-150 ease-out",
                      active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <t.icon className="size-4 shrink-0" aria-hidden />
                    {t.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
