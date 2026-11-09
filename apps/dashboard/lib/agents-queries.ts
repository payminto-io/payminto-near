"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccess, useApi, useView } from "./session";
import { useLive } from "./live";
import { agentAccess, currentMonth, runIdOfEvent, type AgentAccess } from "./agents";
import { RunFollower, type FollowState } from "./run-follower";
import type { RunsQuery } from "./agents-api";
import type { AgentRun } from "./schemas";

/** Query keys for the AI agent screens; every key starts with "agents" and the open business, so switching business never shows another business's data. */
export const ak = {
  all: ["agents"] as const,
  providers: ["agents", "providers"] as const,
  connections: (b: string) => ["agents", b, "connections"] as const,
  models: (b: string, id: string) => ["agents", b, "models", id] as const,
  usage: (b: string, month: string) => ["agents", b, "usage", month] as const,
  agents: (b: string) => ["agents", b, "list"] as const,
  agent: (b: string, id: string) => ["agents", b, "agent", id] as const,
  runs: (b: string, q: RunsQuery) => ["agents", b, "runs", q] as const,
};

/** The open business id, or "" on the platform view (where these screens ask you to open a business). */
export function useBusinessId(): string {
  const view = useView();
  return view?.kind === "business" ? view.merchantId : "";
}

/** What the signed-in person may do with AI agents in the open business. */
export function useAgentAccess(): AgentAccess {
  const access = useAccess();
  return agentAccess(access.session.grants, access.scope);
}

export function useAiProviders() {
  const api = useApi();
  return useQuery({ queryKey: ak.providers, queryFn: () => api.agents.providers(), staleTime: 10 * 60_000 });
}

export function useAiConnections() {
  const api = useApi();
  const b = useBusinessId();
  return useQuery({ queryKey: ak.connections(b), queryFn: () => api.agents.connections(), enabled: Boolean(b) });
}

/** The provider's model list for a connection; null when it has none. Not retried: a rejected key fails fast. */
export function useAiModels(connectionId: string | null | undefined) {
  const api = useApi();
  const b = useBusinessId();
  return useQuery({ queryKey: ak.models(b, connectionId ?? ""), queryFn: () => api.agents.models(connectionId!), enabled: Boolean(b && connectionId), retry: false, staleTime: 5 * 60_000 });
}

export function useAiUsage(month = currentMonth()) {
  const api = useApi();
  const b = useBusinessId();
  return useQuery({ queryKey: ak.usage(b, month), queryFn: () => api.agents.usage(month), enabled: Boolean(b), refetchInterval: 60_000 });
}

export function useAgents() {
  const api = useApi();
  const b = useBusinessId();
  return useQuery({ queryKey: ak.agents(b), queryFn: () => api.agents.agents(), enabled: Boolean(b) });
}

export function useAgent(id: string) {
  const api = useApi();
  const b = useBusinessId();
  return useQuery({ queryKey: ak.agent(b, id), queryFn: () => api.agents.agent(id), enabled: Boolean(b && id) });
}

/** Run history; refreshes while any listed run is still waiting or working. */
export function useAgentRuns(q: RunsQuery) {
  const api = useApi();
  const b = useBusinessId();
  return useQuery({
    queryKey: ak.runs(b, q),
    queryFn: () => api.agents.runs(q),
    enabled: Boolean(b),
    placeholderData: (prev) => prev,
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === "queued" || r.status === "running") ? 4_000 : 30_000),
  });
}

/**
 * One run, followed until it ends (lib/run-follower.ts). The live stream is trusted once it has delivered an update
 * for this run; until then, and whenever it drops, the run is long-polled.
 */
export function useFollowRun(id: string | null): FollowState & { nudge: () => void; adopt: (run: AgentRun) => void } {
  const api = useApi();
  const qc = useQueryClient();
  const live = useLive();
  const b = useBusinessId();
  const [state, setState] = useState<FollowState>({ run: null, events: [], error: null, done: false });
  const follower = useRef<RunFollower | null>(null);
  const streamUp = live.status === "live";
  const streamRef = useRef(streamUp);

  useEffect(() => {
    if (!id || !b) return;
    const f = new RunFollower(id, api.agents);
    f.setStream(streamRef.current);
    follower.current = f;
    const off = f.subscribe(setState);
    void f.start();
    return () => {
      off();
      f.stop();
      follower.current = null;
    };
  }, [id, b, api]);

  useEffect(() => {
    streamRef.current = streamUp;
    follower.current?.setStream(streamUp);
  }, [streamUp]);

  const latest = live.events[0];
  useEffect(() => {
    if (latest && id && runIdOfEvent(latest) === id) follower.current?.streamEvent();
  }, [latest, id]);

  // A run that ends changes the agent's last run and the history lists.
  const done = state.done;
  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: ak.all });
  }, [done, qc]);

  const nudge = useCallback(() => follower.current?.nudge(), []);
  const adopt = useCallback((run: AgentRun) => follower.current?.adopt(run), []);
  return useMemo(() => ({ ...state, nudge, adopt }), [state, nudge, adopt]);
}
