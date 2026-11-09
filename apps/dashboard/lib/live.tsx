"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useSession } from "./session";
import { AGENT_RUN_EVENT_TYPES, EVENT_TYPES, type AgentRunEventType, type EventType, type NodeEvent } from "./schemas";
import { qk } from "./queries";

/** Every AI agent screen's cache (lib/agents-queries.ts keys all start with it). */
const AGENT_KEYS: QueryKey = ["agents"];

export type LiveStatus = "connecting" | "live" | "offline";

/** `wasLive` tells a first connection ("Connecting") apart from a dropped one ("Reconnecting"). */
type LiveValue = { status: LiveStatus; events: NodeEvent[]; lastEventAt: number | null; wasLive: boolean };
const LiveContext = createContext<LiveValue>({ status: "connecting", events: [], lastEventAt: null, wasLive: false });

const KEEP = 60;

/** Which cached screens each event makes stale. */
const INVALIDATES: Record<EventType, QueryKey[]> = {
  "call.accepted": [qk.overview, ["calls"], qk.preview, qk.providers, qk.mandates, ["ledger"], qk.trialBalance],
  "call.denied": [qk.overview, qk.denials, qk.mandates],
  "mandate.opened": [qk.mandates, qk.overview],
  "mandate.revoked": [qk.mandates, qk.overview],
  "batch.started": [qk.batches],
  "batch.submitted": [qk.batches],
  "batch.included": [qk.batches],
  "batch.confirmed": [qk.batches, qk.overview, qk.preview, ["calls"], qk.mandates, qk.providers, ["ledger"], qk.trialBalance],
  "batch.failed": [qk.batches, qk.overview, qk.preview],
  "hsp.updated": [qk.batches],
  "funds.warning": [qk.mandates, qk.preview],
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
      setValue((v) => ({ status: "live", events: [e, ...v.events].slice(0, KEEP), lastEventAt: Date.now(), wasLive: true }));
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
