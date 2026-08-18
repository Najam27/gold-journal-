import { supabase } from "./supabase";

export const AUTH_SESSION_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Read the current Supabase access token without allowing the tRPC link's
 * header phase to block indefinitely. A missing or temporarily unavailable
 * session is treated as unauthenticated; the API then returns a normal auth
 * state instead of leaving the protected loader pending forever.
 */
export async function getSupabaseAccessToken(): Promise<string | undefined> {
  if (!supabase) return undefined;
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    const session = await Promise.race([
      supabase.auth.getSession(),
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => reject(new Error("Supabase session lookup timed out")), AUTH_SESSION_LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return session.data.session?.access_token || undefined;
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error("Supabase session lookup failed.");
    console.warn("[Auth] Supabase access-token lookup failed", normalized.message);
    throw normalized;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}
