"use client";

/**
 * The user menu pinned at the bottom of the sidebar (docs/PRODUCT.md section 3.1): avatar, name and email; Your
 * account, Theme, Reset sidebar, Sign out and Sign out everywhere.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { ChevronsUpDown, KeyRound, LogOut, MonitorSmartphone, PanelLeft, UserRound } from "lucide-react";
import { useAccess, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { resetSidebar, userKey } from "./sidebar";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0]![0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "")).toUpperCase();
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground", className)}>
      {initials(name)}
    </span>
  );
}

export function UserMenu({ compact = false }: { compact?: boolean }) {
  const session = useSession();
  const access = useAccess();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the theme is only known after hydration
  useEffect(() => setMounted(true), []);
  const user = access.session.user;
  const recovery = access.session.actorType === "recovery_key";
  const name = user?.name ?? "Recovery key";
  const email = user?.email ?? "Emergency access";

  const signOut = async (everywhere: boolean) => {
    await session.signOut({ everywhere });
    router.replace(`/login?reason=signed_out`);
    if (everywhere) toast.success("Signed out on every device.");
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex min-w-0 items-center gap-2.5 rounded-md text-left outline-none transition-colors duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "size-10 justify-center" : "h-11 flex-1 px-1.5",
          )}
          aria-label={`Account menu for ${name}`}
        >
          {recovery ? (
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-negative-soft text-negative">
              <KeyRound className="size-4" />
            </span>
          ) : (
            <Avatar name={name} />
          )}
          {!compact && (
            <>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-medium">{name}</span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">{email}</span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-subtle" aria-hidden />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side={compact ? "right" : "top"} align="start" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {!recovery && (
            <DropdownMenuItem asChild>
              <Link href="/account">
                <UserRound aria-hidden /> Your account
              </Link>
            </DropdownMenuItem>
          )}
          {!recovery && (
            <DropdownMenuItem asChild>
              <Link href="/account#sessions">
                <MonitorSmartphone aria-hidden /> Sessions
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Theme</DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-36">
              <DropdownMenuRadioGroup value={mounted ? theme : "system"} onValueChange={setTheme}>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            onSelect={() => {
              resetSidebar(userKey(access));
              toast.success("Sidebar reset to its defaults.");
            }}
          >
            <PanelLeft aria-hidden /> Reset sidebar
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut(false)}>
            <LogOut aria-hidden /> Sign out
          </DropdownMenuItem>
          {!recovery && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmAll(true)}>
              <LogOut aria-hidden /> Sign out everywhere
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmAll} onOpenChange={setConfirmAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out everywhere?</AlertDialogTitle>
            <AlertDialogDescription>Every device signed in as {email}, including this one, will need to sign in again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void signOut(true)}>Sign out everywhere</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
