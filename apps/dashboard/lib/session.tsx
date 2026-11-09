"use client";

/**
 * The signed-in person (docs/PRODUCT.md sections 4 and 10): a cookie session read from `GET /v1/auth/session` through
 * the dashboard's own `/api` path, or the recovery key kept for this tab. Exposes the console API client, the account
 * client, the grants and the open view (platform or one business).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createApi, type ClearingApi } from "./api";
import { HttpAccountApi, type AccountApi, type AccountSession } from "./account";
import { HttpSearchApi, type SearchApi } from "./search-api";
import { MOCK_MODE, readRecoveryKey, writeRecoveryKey } from "./config";
import { ApiError, setSessionHooks } from "./http";
import { getView, setView, subscribeView, type View } from "./merchant-scope";
import { can as canWith, type Permission, type Scope } from "./permissions";
import { requestStepUp } from "./step-up";

export type SignedOutReason = "expired" | "signed_out" | "revoked" | null;

type SessionState =
  | { status: "loading"; api: null; session: null }
  | { status: "signed-out"; api: null; session: null; reason: SignedOutReason; unreachable?: boolean }
  | { status: "signed-in"; api: ClearingApi; session: AccountSession };

export type SessionContextValue = SessionState & {
  account: AccountApi;
  search: SearchApi;
  /** After login, setup or invite acceptance: the server already set the cookie. */
  adopt: (session: AccountSession) => Promise<void>;
  signInWithRecoveryKey: (key: string) => Promise<void>;
  signOut: (opts?: { everywhere?: boolean }) => Promise<void>;
  /** Re-read the session (after a role or name change). */
  refresh: () => Promise<AccountSession | null>;
};

const SessionContext = createContext<SessionContextValue | null>(null);

function makeClients(): { account: AccountApi; search: SearchApi; recovery: string | null } {
  if (MOCK_MODE) {
    // Loaded lazily below; placeholders are replaced before first use.
    return { account: null as unknown as AccountApi, search: null as unknown as SearchApi, recovery: null };
  }
  const recovery = readRecoveryKey();
  return { account: new HttpAccountApi(), search: new HttpSearchApi("/api", recovery), recovery };
}

/** The view a person lands on: their stored choice when still allowed, else the platform or their last business. */
export function defaultView(s: AccountSession, stored: View | null): View | null {
  const platform = s.actorType === "recovery_key" || s.grants.platform.includes("businesses.read");
  const member = (id: string) => s.memberships.some((m) => m.merchantId === id);
  if (stored?.kind === "platform" && platform) return stored;
  if (stored?.kind === "business" && (platform || member(stored.merchantId))) return stored;
  if (platform) return { kind: "platform" };
  const last = s.user?.lastBusinessId;
  if (last && member(last)) return { kind: "business", merchantId: last };
  const first = s.memberships[0];
  return first ? { kind: "business", merchantId: first.merchantId } : null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  // `clients` is read in callbacks (ref) and exposed to screens (state); `setClients` keeps both in step.
  const [initial] = useState(makeClients);
  const clients = useRef(initial);
  const [shown, setShown] = useState(initial);
  const setClients = useCallback((next: Partial<ReturnType<typeof makeClients>>) => {
    clients.current = { ...clients.current, ...next };
    setShown(clients.current);
  }, []);
  const [ready, setReady] = useState(!MOCK_MODE);
  const [state, setState] = useState<SessionState>({ status: "loading", api: null, session: null });
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const enter = useCallback(
    async (session: AccountSession, recoveryKey: string | null) => {
      const events = session.actorType === "recovery_key" || session.grants.platform.includes("agents.read");
      const api = await createApi({ recoveryKey, events });
      setView(defaultView(session, getView()));
      setState({ status: "signed-in", api, session });
    },
    [],
  );

  const load = useCallback(async () => {
    const { account, recovery } = clients.current;
    try {
      const s = await account.session(recovery);
      await enter(s, recovery);
      return s;
    } catch (e) {
      if (recovery && e instanceof ApiError && e.status === 401) writeRecoveryKey(null);
      const unreachable = e instanceof ApiError && e.code === "NODE_UNREACHABLE";
      setState({ status: "signed-out", api: null, session: null, reason: null, unreachable });
      return null;
    }
  }, [enter]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (MOCK_MODE) {
        const m = await import("./mock/accounts");
        setClients({ account: new m.MockAccountApi(), search: new m.MockSearchApi(), recovery: readRecoveryKey() });
        if (cancelled) return;
        setReady(true);
      }
      if (!cancelled) await load();
    })();
    return () => {
      cancelled = true;
    };
  }, [load, setClients]);

  const expire = useCallback(
    (reason: SignedOutReason) => {
      if (stateRef.current.status !== "signed-in") return;
      writeRecoveryKey(null);
      setClients({ recovery: null });
      qc.clear();
      setState({ status: "signed-out", api: null, session: null, reason });
    },
    [qc, setClients],
  );

  // The HTTP layer asks the session for the CSRF value, a fresh one after CSRF_FAILED, a password for step-up, and
  // reports an ended session.
  useEffect(() => {
    setSessionHooks({
      csrf: () => (stateRef.current.status === "signed-in" ? stateRef.current.session.csrf : null),
      refreshCsrf: async () => {
        const s = await load();
        return s?.csrf ?? null;
      },
      stepUp: () => requestStepUp((password) => clients.current.account.stepUp(password)),
      unauthorized: (reason) => expire(reason === "expired" ? "expired" : reason === "revoked" ? "revoked" : "expired"),
    });
    return () => setSessionHooks(null);
  }, [load, expire]);

  const adopt = useCallback(
    async (session: AccountSession) => {
      qc.clear();
      writeRecoveryKey(null);
      setClients(MOCK_MODE ? { recovery: null } : { recovery: null, search: new HttpSearchApi("/api", null) });
      await enter(session, null);
    },
    [enter, qc, setClients],
  );

  const signInWithRecoveryKey = useCallback(
    async (key: string) => {
      const s = await clients.current.account.session(key);
      writeRecoveryKey(key);
      setClients(MOCK_MODE ? { recovery: key } : { recovery: key, search: new HttpSearchApi("/api", key) });
      qc.clear();
      await enter(s, key);
    },
    [enter, qc, setClients],
  );

  const signOut = useCallback(
    async (opts: { everywhere?: boolean } = {}) => {
      const { account, recovery } = clients.current;
      if (!recovery) {
        try {
          if (opts.everywhere) await account.logoutAll();
          else await account.logout();
        } catch {
          // The cookie may already be gone; signing out locally is what matters.
        }
      }
      writeRecoveryKey(null);
      setClients({ recovery: null });
      setView(null);
      qc.clear();
      setState({ status: "signed-out", api: null, session: null, reason: "signed_out" });
    },
    [qc, setClients],
  );

  const refresh = useCallback(async () => {
    const { account, recovery } = clients.current;
    try {
      const s = await account.session(recovery);
      setState((prev) => (prev.status === "signed-in" ? { ...prev, session: s } : prev));
      return s;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ ...(ready ? state : { status: "loading" as const, api: null, session: null }), account: shown.account, search: shown.search, adopt, signInWithRecoveryKey, signOut, refresh }),
    [ready, state, shown, adopt, signInWithRecoveryKey, signOut, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** The signed-in API client. Only call from screens rendered inside the console shell. */
export function useApi(): ClearingApi {
  const s = useSession();
  if (s.status !== "signed-in") throw new Error("useApi called without a session");
  return s.api;
}

export function useView(): View | null {
  return useSyncExternalStore(subscribeView, getView, () => null);
}

export type Access = {
  session: AccountSession;
  view: View | null;
  scope: Scope;
  /** The platform view is open (all businesses). */
  platformView: boolean;
  /** The actor holds a platform role (or is the recovery key). */
  platformRole: boolean;
  /** Is the permission held in the open view (or the given business)? */
  can: (permission: Permission, merchantId?: string | null) => boolean;
};

/** Grants and view for permission-aware UI. Only inside the console shell. */
export function useAccess(): Access {
  const s = useSession();
  const view = useView();
  if (s.status !== "signed-in") throw new Error("useAccess called without a session");
  const session = s.session;
  const scope: Scope = view?.kind === "business" ? { kind: "business", merchantId: view.merchantId } : { kind: "platform" };
  const platformRole = session.actorType === "recovery_key" || session.grants.platform.includes("businesses.read");
  return {
    session,
    view,
    scope,
    platformView: view?.kind === "platform",
    platformRole,
    can: (permission, merchantId) => canWith(session.grants, permission, merchantId ? { kind: "business", merchantId } : scope),
  };
}

/** Shorthand: `const can = useCan(); can("links.write")`. */
export function useCan(): Access["can"] {
  return useAccess().can;
}
