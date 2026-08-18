import { trpc } from "@/lib/trpc";
import { supabase } from "@/lib/supabase";
import { clearPrivateClientState } from "@/lib/queryClient";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type UseAuthOptions = { redirectOnUnauthenticated?: boolean; redirectPath?: string };
export const AUTH_BOOTSTRAP_TIMEOUT_MS = 10_000;

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const [session, setSession] = useState<any>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const lastUserId = useRef<string | null | undefined>(undefined);
  const utils = trpc.useUtils();
  const meQuery = trpc.auth.me.useQuery(undefined, { enabled: Boolean(session), retry: false, refetchOnWindowFocus: false });

  useEffect(() => {
    if (!supabase) { setSessionLoading(false); return; }
    let active = true;
    let settled = false;
    const timeout = globalThis.setTimeout(() => {
      if (!active || settled) return;
      settled = true;
      console.warn("[Auth] Supabase session bootstrap timed out");
      setSession(null);
      setSessionLoading(false);
    }, AUTH_BOOTSTRAP_TIMEOUT_MS);
    void supabase.auth.getSession().then(({ data }) => {
      if (!active || settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      const nextUserId = data.session?.user?.id ?? null;
      if (lastUserId.current !== undefined && lastUserId.current !== nextUserId) clearPrivateClientState();
      lastUserId.current = nextUserId;
      setSession(data.session);
      setSessionLoading(false);
    }).catch(error => {
      if (!active || settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      console.warn("[Auth] Supabase session bootstrap failed", error);
      clearPrivateClientState();
      lastUserId.current = null;
      setSession(null);
      setSessionLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextUserId = nextSession?.user?.id ?? null;
      if (lastUserId.current !== nextUserId) clearPrivateClientState();
      lastUserId.current = nextUserId;
      setSession(nextSession);
      setSessionLoading(false);
      void utils.auth.me.invalidate();
    });
    return () => { active = false; globalThis.clearTimeout(timeout); data.subscription.unsubscribe(); };
  }, [utils]);

  const logout = useCallback(async () => { if (supabase) await supabase.auth.signOut(); clearPrivateClientState(); lastUserId.current = null; setSession(null); utils.auth.me.setData(undefined, null); await utils.auth.me.invalidate(); }, [utils]);
  const state = useMemo(() => ({ user: meQuery.data ?? null, loading: sessionLoading || (Boolean(session) && meQuery.isLoading), error: meQuery.error ?? null, isAuthenticated: Boolean(session && meQuery.data) }), [meQuery.data, meQuery.error, meQuery.isLoading, session, sessionLoading]);

  useEffect(() => {
    if (!redirectOnUnauthenticated || state.loading || state.user) return;
    if (redirectPath && window.location.pathname !== redirectPath) window.location.href = redirectPath;
  }, [redirectOnUnauthenticated, redirectPath, state.loading, state.user]);

  return { ...state, refresh: () => meQuery.refetch(), logout };
}
