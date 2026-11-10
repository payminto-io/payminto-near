"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import type { AccountId } from "@payminto/protocol";
import type { Verdict, VerdictView } from "@payminto/payee-check";
import type { PayeeDecisionBody, PayeeReportBody } from "./api";
import { ApiError } from "./http";
import { PAYEE_APPROVAL_KEYS } from "./live";
import { PayeeCheckUnavailable, checkPayee, payeeCheckContext, signalTitles, viewOfVerdict } from "./payee-check";
import { qk, useInfo } from "./queries";
import { useApi, useSession } from "./session";
import type { PayeeApprovals } from "./schemas";

export const payeeKeys = {
  approvals: (budgetId: string): QueryKey => [...PAYEE_APPROVAL_KEYS, budgetId],
  reports: (account: string): QueryKey => ["payee-reports", account],
};

/** A route an older server does not have answers 404 or 405; that is "no such feature", not a failure. */
const routeMissing = (e: unknown) => e instanceof ApiError && (e.status === 404 || e.status === 405);

/**
 * The owner's decisions for a Budget and the Calls that wait for one. `data` is null on a server that predates Payee
 * approvals. It refreshes on the live events and every 20 seconds, because a repeated attempt sends no event.
 */
export function usePayeeApprovals(budgetId: string, enabled = true) {
  const api = useApi();
  return useQuery({
    queryKey: payeeKeys.approvals(budgetId),
    enabled,
    queryFn: async (): Promise<PayeeApprovals | null> => {
      try {
        return await api.payeeApprovals(budgetId);
      } catch (e) {
        if (routeMissing(e)) return null;
        throw e;
      }
    },
    retry: false,
    refetchInterval: 20_000,
  });
}

function useRefreshPayees(budgetId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: payeeKeys.approvals(budgetId) });
    void qc.invalidateQueries({ queryKey: qk.budget(budgetId) });
    void qc.invalidateQueries({ queryKey: qk.denials });
  };
}

/** Sends the owner's decision. The caller reads a 409 PAYEE_BLOCKED from the error and shows what is blocked. */
export function useDecidePayee(budgetId: string) {
  const api = useApi();
  const refresh = useRefreshPayees(budgetId);
  return useMutation({ mutationFn: (body: PayeeDecisionBody) => api.decidePayee(budgetId, body), onSuccess: refresh });
}

export function useWithdrawPayeeDecision(budgetId: string) {
  const api = useApi();
  const refresh = useRefreshPayees(budgetId);
  // A decision somebody else already withdrew is gone either way, so the lists are read again on an error too.
  return useMutation({ mutationFn: (payee: AccountId) => api.withdrawPayeeDecision(budgetId, payee), onSettled: refresh });
}

/** Reports against one account, read when `enabled`. Null on a server without reports. */
export function usePayeeReports(account: AccountId, enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: payeeKeys.reports(account),
    enabled,
    queryFn: async () => {
      try {
        return await api.payeeReports(account);
      } catch (e) {
        if (routeMissing(e)) return null;
        throw e;
      }
    },
    retry: false,
  });
}

/**
 * Files a report. The server looks at the account again in the background, so the Budget is read again at once and
 * once more a few seconds later, when that look has had time to finish.
 */
export function useReportPayee(budgetId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = useRefreshPayees(budgetId);
  return useMutation({
    mutationFn: (body: PayeeReportBody) => api.reportPayee(body),
    onSuccess: (_filed, body) => {
      void qc.invalidateQueries({ queryKey: payeeKeys.reports(body.account) });
      refresh();
      setTimeout(refresh, 4_000);
    },
  });
}

/** The package's plain words for a verdict the server sent. Loading the package is the only wait. */
export function useVerdictView(verdict: Verdict | null) {
  return useQuery({
    queryKey: ["payee-view", verdict?.payee, verdict?.checkedAtMs, verdict?.verdict, verdict?.signals.length],
    enabled: verdict !== null,
    queryFn: (): Promise<VerdictView> => viewOfVerdict(verdict!),
    retry: false,
    staleTime: Infinity,
  });
}

/** Short names for signal ids, such as "New account". Empty until the package has loaded, and the reasons still read. */
export function useSignalTitles(): Readonly<Record<string, string>> {
  const q = useQuery({ queryKey: ["payee-signal-titles"], queryFn: signalTitles, retry: false, staleTime: Infinity });
  return q.data ?? NO_TITLES;
}
const NO_TITLES: Readonly<Record<string, string>> = {};

export type FreshCheck =
  | { state: "idle" }
  | { state: "checking" }
  /** `by` says who looked: the server, or this browser when the server's check is off. */
  | { state: "done"; view: VerdictView; verdict: Verdict; from: string; by: "server" | "browser" }
  | { state: "unavailable"; message: string };

/**
 * A look at one Payee of a Budget, made now and on request. The server looks when it has the check on. It answers
 * 409 PAYEE_CHECK_OFF when it is off, and only then (or on a server that predates the check) this browser looks
 * instead, and the result says so.
 */
export function useFreshPayeeCheck(budgetId: string, payee: AccountId, others: readonly AccountId[], owner: AccountId | null, enabled: boolean): { check: FreshCheck; again: () => void } {
  const api = useApi();
  const info = useInfo();
  const ctx = useMemo(() => (info.data ? payeeCheckContext(info.data) : null), [info.data]);
  const q = useQuery({
    queryKey: ["payee-fresh-check", budgetId, payee, ctx?.rpcUrl, ctx?.token],
    enabled: enabled && ctx !== null,
    queryFn: async (): Promise<Extract<FreshCheck, { state: "done" }>> => {
      try {
        const verdict = await api.checkPayee(payee, budgetId);
        return { state: "done", verdict, view: await viewOfVerdict(verdict), from: api.mock ? "demo data on the demo server (no network)" : "NEAR by this Payminto server", by: "server" };
      } catch (e) {
        const off = e instanceof ApiError && (e.code === "PAYEE_CHECK_OFF" || routeMissing(e));
        if (!off) throw e;
      }
      const r = await checkPayee(ctx!, { payee, payer: owner, budgetPayees: others });
      return { state: "done", verdict: r.verdict, view: r.view, from: r.from, by: "browser" };
    },
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const qc = useQueryClient();
  const again = () => {
    void (info.isError ? info.refetch() : q.refetch()).then(() => qc.invalidateQueries({ queryKey: qk.budget(budgetId) }));
  };
  let check: FreshCheck;
  if (!enabled) check = { state: "idle" };
  else if (info.isError) check = { state: "unavailable", message: "The server's network details could not be loaded, so this Payee was not checked. Check again in a moment." };
  else if (q.isError) check = { state: "unavailable", message: q.error instanceof PayeeCheckUnavailable ? q.error.message : q.error instanceof ApiError && q.error.message ? `The server could not check this Payee: ${q.error.message}` : new PayeeCheckUnavailable().message };
  else if (q.isFetching || !q.data) check = { state: "checking" };
  else check = q.data;
  return { check, again };
}

/** The signed-in person's id, and the names of the platform team when this session may read them. */
export function useDeciderNames(): { me: string | null; names: ReadonlyMap<string, string> } {
  const s = useSession();
  const me = s.status === "signed-in" ? (s.session.user?.id ?? null) : null;
  const mayRead = s.status === "signed-in" && (s.session.actorType === "recovery_key" || s.session.grants.platform.includes("team.read"));
  const account = s.account;
  // The same key as the Platform team page, so one read serves both.
  const team = useQuery({ queryKey: ["account", "platform-team"], queryFn: () => account.platformTeam(), enabled: mayRead, retry: false, staleTime: 60_000 });
  const myName = s.status === "signed-in" ? (s.session.user?.name ?? null) : null;
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of team.data ?? []) m.set(p.userId, p.name);
    if (me && myName) m.set(me, myName);
    return m;
  }, [team.data, me, myName]);
  return { me, names };
}
