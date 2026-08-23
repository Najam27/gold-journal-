import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;
let cachedConfig = "";
let cachedClient: any;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit) {
  const timeoutSignal = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}

export function getSupabaseAdmin(): any {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Supabase server configuration is unavailable.");
  const config = `${url}\u0000${key}`;
  if (cachedClient && cachedConfig === config) return cachedClient;
  cachedClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchWithTimeout } });
  cachedConfig = config;
  return cachedClient;
}

/** A non-secret tag for comparing the configured database source across MT5 POST and workspace reads. */
export function supabaseDataSourceReference() {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) return null;
  return `gjsup-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
}
