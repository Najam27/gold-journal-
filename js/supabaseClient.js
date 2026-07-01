// Supabase client singleton. Loaded from the ESM CDN so the app stays a
// pure static site with no build step.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from "./config.js";

let _client = null;

export function getSupabase() {
  if (!isConfigured()) return null;
  if (_client) return _client;
  _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce",
      storageKey: "gold-journal-auth",
    },
    realtime: { params: { eventsPerSecond: 5 } },
  });
  return _client;
}

// Normalise Supabase/network errors into clear, user-facing messages.
export function humanError(err) {
  if (!err) return "Unknown error.";
  const msg = (err.message || err.error_description || String(err)).toLowerCase();
  if (msg.includes("failed to fetch") || msg.includes("network"))
    return "Network error — check your connection and try again.";
  if (msg.includes("invalid login credentials"))
    return "Wrong email or password.";
  if (msg.includes("email not confirmed"))
    return "Email not confirmed yet — check your inbox for the confirmation link.";
  if (msg.includes("already registered") || msg.includes("already been registered") || msg.includes("user already"))
    return "That email is already registered — try signing in instead.";
  if (msg.includes("password should be") || msg.includes("weak"))
    return "Password is too weak — use at least 8 characters.";
  if (msg.includes("jwt") || msg.includes("expired") || msg.includes("session"))
    return "Your session expired — please sign in again.";
  if (msg.includes("rate limit") || msg.includes("too many"))
    return "Too many attempts — please wait a moment and try again.";
  if (msg.includes("not found")) return "Not found.";
  if (msg.includes("row-level security") || msg.includes("permission"))
    return "You don't have permission to do that.";
  return err.message || "Something failed — please try again.";
}
