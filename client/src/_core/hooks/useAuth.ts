import { trpc } from "@/lib/trpc";
import { supabase } from "@/lib/supabase";
import { clearPrivateClientState } from "@/lib/queryClient";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

type UseAuthOptions = { redirectOnUnauthenticated?: boolean; redirectPath?: string };
export type AuthStatus = "booting" | "authenticated" | "unauthenticated" | "error";
export const AUTH_BOOTSTRAP_TIMEOUT_MS = 10_000;

type AuthSnapshot = {
  status: AuthStatus;
  session: Session | null;
  error: Error | null;
  event: string | null;
  revision: number;
};

const initialSnapshot: AuthSnapshot = { status: supabase ? "booting" : "error", session: null, error: supabase ? null : new Error("Supabase Auth is not configured."), event: null, revision: 0 };
let snapshot = initialSnapshot;
let started = false;
let bootstrapSettled = false;
let lastUserId: string | null | undefined;
let subscription: { unsubscribe: () => void } | null = null;
let invalidateMe: (() => void) | null = null;
const listeners = new Set<() => void>();

function notify() { listeners.forEach(listener => listener()); }
function transition(status: AuthStatus, session: Session | null, error: Error | null, event: string) {
  const nextUserId = session?.user?.id ?? null;
  if (lastUserId !== undefined && lastUserId !== nextUserId) clearPrivateClientState();
  lastUserId = nextUserId;
  snapshot = { status, session, error, event, revision: snapshot.revision + 1 };
  notify();
}

function timedSessionRequest() {
  return new Promise<Awaited<ReturnType<NonNullable<typeof supabase>["auth"]["getSession"]>>>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => reject(new Error("Supabase session bootstrap timed out.")), AUTH_BOOTSTRAP_TIMEOUT_MS);
    supabase!.auth.getSession().then(result => { globalThis.clearTimeout(timeout); resolve(result); }).catch(error => { globalThis.clearTimeout(timeout); reject(error); });
  });
}

function handleAuthEvent(event: string, session: Session | null) {
  if (event === "TOKEN_REFRESHED") console.info("[Auth] token:refreshed");
  if (event === "SIGNED_IN" || event === "USER_UPDATED" || event === "INITIAL_SESSION") {
    transition(session ? "authenticated" : "unauthenticated", session, null, event);
    if (event !== "INITIAL_SESSION") invalidateMe?.();
    console.info(session ? "[Auth] state:authenticated" : "[Auth] state:unauthenticated");
    return;
  }
  if (event === "TOKEN_REFRESHED") {
    transition(session ? "authenticated" : "unauthenticated", session, null, event);
    return;
  }
  if (event === "SIGNED_OUT") {
    transition("unauthenticated", null, null, event);
    invalidateMe?.();
    console.info("[Auth] state:unauthenticated");
  }
}

function runAuthBootstrap() {
  if (!supabase) return;
  bootstrapSettled = false;
  console.info("[Auth] bootstrap:start");
  void timedSessionRequest().then(({ data, error }) => {
    if (error) throw error;
    bootstrapSettled = true;
    console.info(data.session ? "[Auth] session:found" : "[Auth] session:none");
    handleAuthEvent("INITIAL_SESSION", data.session);
  }).catch(error => {
    if (bootstrapSettled) return;
    bootstrapSettled = true;
    const normalized = error instanceof Error ? error : new Error("Supabase Auth could not initialize.");
    console.warn("[Auth] session:error", normalized.message);
    transition("error", null, normalized, "BOOTSTRAP_ERROR");
  });
}

function startAuthBootstrap() {
  if (started) return;
  started = true;
  if (!supabase) return;
  const authListener = supabase.auth.onAuthStateChange((event, session) => handleAuthEvent(event, session));
  subscription = authListener.data.subscription;
  runAuthBootstrap();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  startAuthBootstrap();
  return () => listeners.delete(listener);
}
function getSnapshot() { return snapshot; }
function getServerSnapshot() { return initialSnapshot; }

export function resetAuthForTests() {
  subscription?.unsubscribe();
  subscription = null;
  started = false;
  bootstrapSettled = false;
  invalidateMe = null;
  lastUserId = undefined;
  snapshot = initialSnapshot;
  listeners.clear();
}

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const auth = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const utils = trpc.useUtils();
  const meQuery = trpc.auth.me.useQuery(undefined, { enabled: auth.status === "authenticated", retry: false, refetchOnWindowFocus: false, staleTime: 60_000 });
  const isAuthenticated = auth.status === "authenticated";
  const authMeError = meQuery.error ?? null;
  const profileError = useMemo(() => authMeError ?? (isAuthenticated && !meQuery.isLoading && meQuery.data === null ? new Error("Secure profile sync is temporarily unavailable.") : null), [authMeError, isAuthenticated, meQuery.data, meQuery.isLoading]);
  const profileReady = isAuthenticated && !meQuery.isLoading && !profileError;
  const invalidateMeForAuth = useCallback(() => { void utils.auth.me.invalidate(); }, [utils.auth.me]);
  useEffect(() => { invalidateMe = invalidateMeForAuth; return () => { if (invalidateMe === invalidateMeForAuth) invalidateMe = null; }; }, [invalidateMeForAuth]);
  const retryBootstrap = useCallback(() => {
    if (!supabase || auth.status === "booting") return;
    runAuthBootstrap();
  }, [auth.status]);
  const refresh = useCallback(async () => {
    if (supabase) {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) throw error;
        handleAuthEvent(data.session ? "SIGNED_IN" : "SIGNED_OUT", data.session);
      } catch (error) {
        console.warn("[Auth] session:refresh-error", error instanceof Error ? error.message : "unknown error");
      }
    }
    return meQuery.refetch();
  }, [meQuery.refetch]);
  const reconnect = useCallback(async () => {
    if (!supabase) return false;
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      handleAuthEvent(data.session ? "SIGNED_IN" : "SIGNED_OUT", data.session);
      await meQuery.refetch();
      return Boolean(data.session);
    } catch (error) {
      console.warn("[Auth] reconnect:error", error instanceof Error ? error.message : "unknown error");
      return false;
    }
  }, [meQuery.refetch]);
  const logout = useCallback(async () => {
    try { await supabase?.auth.signOut(); } finally { if (snapshot.status !== "unauthenticated") transition("unauthenticated", null, null, "SIGNED_OUT"); invalidateMe?.(); }
  }, []);
  useEffect(() => {
    if (auth.event === "SIGNED_OUT") utils.auth.me.setData(undefined, null);
  }, [auth.event, utils.auth.me]);
  useEffect(() => {
    if (!redirectOnUnauthenticated || auth.status === "booting" || auth.status === "authenticated") return;
    if (redirectPath && window.location.pathname !== redirectPath) window.location.href = redirectPath;
  }, [auth.status, redirectOnUnauthenticated, redirectPath]);
  return useMemo(() => ({
    user: meQuery.data ?? null,
    session: auth.session,
    status: auth.status,
    authStatus: auth.status,
    loading: auth.status === "booting",
    profileLoading: isAuthenticated && meQuery.isLoading,
    profileReady,
    profileError,
    error: auth.error ?? profileError,
    authError: auth.error,
    authMeError: profileError,
    isAuthenticated,
    refresh,
    retryBootstrap,
    reconnect,
    logout,
  }), [auth.error, auth.session, auth.status, authMeError, isAuthenticated, logout, meQuery.data, meQuery.isLoading, profileError, profileReady, reconnect, refresh, retryBootstrap]);
}

export function getAuthSubscriptionCountForTests() { return listeners.size; }
