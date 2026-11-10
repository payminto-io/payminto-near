"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useSession } from "./session";
import { AGENT_RUN_EVENT_TYPES, EVENT_TYPES, type AgentRunEventType, type EventType, type NodeEvent } from "./schemas";
import { qk } from "./queries";
import { retainEvents } from "./operator-alerts";

/** The approvals and waiting Calls of every Budget (lib/use-payee-approvals.ts keys all start with it). */
export const PAYEE_APPROVAL_KEYS: QueryKey = ["payee-approvals"];

/** Every AI agent screen's cache (lib/agents-queries.ts keys all start with it). */
const AGENT_KEYS: QueryKey = ["agents"];

export type LiveStatus = "connecting" | "live" | "offline";

/** `wasLive` tells a first connection ("Connecting") apart from a dropped one ("Reconnecting"). */
type LiveValue = { status: LiveStatus; events: NodeEvent[]; lastEventAt: number | null; wasLive: boolean };
const LiveContext = createContext<LiveValue>({ status: "connecting", events: [], lastEventAt: null, wasLive: false });

const KEEP = 60;

/** Which cached screens each event makes stale. */
const INVALIDATES: Record<EventType, QueryKey[]> = {
  "call.accepted": [qk.overview, ["calls"], qk.preview, qk.providers, qk.budgets, ["ledger"], qk.trialBalance],
  "call.denied": [qk.overview, qk.denials, qk.budgets],
  "budget.opened": [qk.budgets, qk.overview],
  "budget.revoked": [qk.budgets, qk.overview],
  "batch.started": [qk.batches],
  "batch.submitted": [qk.batches],
  "batch.included": [qk.batches],
  "batch.confirmed": [qk.batches, qk.overview, qk.preview, ["calls"], qk.budgets, qk.providers, ["ledger"], qk.trialBalance, ["proof"]],
  "batch.failed": [qk.batches, qk.overview, qk.preview],
  "funds.warning": [qk.budgets, qk.preview],
  "payout.confirmed": [["payouts"], qk.budgets],
  "payout.failed": [["payouts"]],
  // A seller settled its own voucher on the hub: its Calls are settled with no batch, escrow moved to the seller's hub
  // credit, and what waits for the next settlement shrank.
  "seller.settled": [qk.overview, ["calls"], qk.preview, qk.budgets, qk.providers, ["ledger"], qk.trialBalance, ["proof"], ["payouts"]],
  // Shown as a warning (components/app/operator-warnings.tsx). A batch the hub holds under another settler is failed.
  "operator.alert": [qk.batches, qk.overview, qk.preview, ["calls"]],
  // The payee check: a Call waits for the owner, or an owner decided. The Budget page shows both without a reload.
  "payee.approval_requested": [qk.budgets, PAYEE_APPROVAL_KEYS, qk.denials],
  "payee.approval_decided": [qk.budgets, PAYEE_APPROVAL_KEYS],
  // AI agent runs (docs/AGENTS.md section 6): the run page follows its own run; lists and last runs refresh here.
  ...(Object.fromEntries(AGENT_RUN_EVENT_TYPES.map((t) => [t, t === "agent_run.step" ? [] : [AGENT_KEYS]])) as Record<AgentRunEventType, QueryKey[]>),
};

function parseEvent(type: EventType, raw: string): NodeEvent | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const inner = (data.data && typeof data.data === "object" ? data.data : data) as Record<string, unknown>;
    return {
      type,
      id: String(data.id ?? `${type}:${Date.now()}`),
      at: String(data.at ?? new Date().toISOString()),
      data: inner,
    };
  } catch {
    return null;
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const qc = useQueryClient();
  const [value, setValue] = useState<LiveValue>({ status: "connecting", events: [], lastEventAt: null, wasLive: false });
  const pending = useRef(new Map<string, QueryKey>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (session.status !== "signed-in") return;
    const api = session.api;

    // Coalesce invalidations: a burst of 50 calls refetches each screen once, not 50 times.
    const schedule = (keys: QueryKey[]) => {
      for (const k of keys) pending.current.set(JSON.stringify(k), k);
      if (flushTimer.current) return;
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null;
        for (const k of pending.current.values()) void qc.invalidateQueries({ queryKey: k });
        pending.current.clear();
      }, 700);
    };

    const onEvent = (e: NodeEvent) => {
      setValue((v) => ({ status: "live", events: retainEvents([e, ...v.events], KEEP), lastEventAt: Date.now(), wasLive: true }));
      schedule(INVALIDATES[e.type] ?? []);
    };

    if (api.subscribe) {
      const off = api.subscribe(onEvent);
      return () => off();
    }

    const url = api.eventsUrl();
    if (!url || typeof EventSource === "undefined") return;
    const es = new EventSource(url);
    es.onopen = () => setValue((v) => ({ ...v, status: "live", wasLive: true }));
    es.onerror = () => setValue((v) => ({ ...v, status: es.readyState === EventSource.CLOSED ? "offline" : "connecting" }));
    const handlers = EVENT_TYPES.map((type) => {
      const h = (m: MessageEvent<string>) => {
        const e = parseEvent(type, m.data);
        if (e) onEvent(e);
      };
      es.addEventListener(type, h as EventListener);
      return [type, h] as const;
    });
    return () => {
      for (const [type, h] of handlers) es.removeEventListener(type, h as EventListener);
      es.close();
    };
  }, [session, qc]);

  // In-process (mock) streams are always live; a node without an events URL has no stream at all.
  const api = session.status === "signed-in" ? session.api : null;
  const status: LiveStatus = api?.subscribe ? "live" : api && !api.eventsUrl() ? "offline" : value.status;
  const ctx = useMemo(() => ({ ...value, status }), [value, status]);
  return <LiveContext.Provider value={ctx}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue {
  return useContext(LiveContext);
}
