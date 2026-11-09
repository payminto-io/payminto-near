"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { formatDateTime, timeAgo } from "@/lib/format";

// One shared clock for every relative time on screen, so "7 sec. ago" keeps counting without a timer per row.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time, re-rendering the caller once a second. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now, () => now);
}

/** A relative time that ticks ("just now", "12 sec. ago", "3 min. ago"), with the exact time on hover. */
export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  const t = useNow();
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={cn("num", className)}>
      {timeAgo(iso, t)}
    </time>
  );
}
