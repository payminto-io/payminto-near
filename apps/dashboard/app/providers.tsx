"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { ApiError } from "@/lib/api";
import { SessionProvider } from "@/lib/session";
import { LiveProvider } from "@/lib/live";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { AppGate } from "@/components/app/shell";
import { isPublicCheckoutPath } from "@/lib/checkout";
import { MOCK_MODE } from "@/lib/config";
import { captureDemoSwitches } from "@/lib/mock/capture";

export function Providers({ children }: { children: ReactNode }) {
  // The hosted checkout and link pages are public: no session, no console event stream, no shell.
  const isPublic = isPublicCheckoutPath(usePathname());
  const [qc] = useState(() => {
    // Mock mode only: keep the `?demo=` switches for the tab before the sign-in redirect drops the query.
    if (MOCK_MODE) captureDemoSwitches();
    return new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
          },
        },
    });
  });
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={qc}>
        <TooltipProvider delayDuration={250}>
          {isPublic ? (
            children
          ) : (
            <SessionProvider>
              <LiveProvider>
                <AppGate>{children}</AppGate>
              </LiveProvider>
            </SessionProvider>
          )}
        </TooltipProvider>
        {/* Clear the phone tab bar (4rem plus the safe area). */}
        <Toaster position="bottom-right" mobileOffset={{ bottom: isPublic ? "1rem" : "calc(5rem + env(safe-area-inset-bottom))" }} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
