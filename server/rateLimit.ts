import { createHash } from "node:crypto";
import { getSupabaseAdmin } from "./supabaseAdmin";

type Bucket = { startedAt: number; count: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;
const MAX_BUCKETS_PER_SCOPE = 2_000;

function localConsumeRateLimit(scope: string, identity: string | number, limit: number, windowMs: number, now = Date.now()) {
  const key = `${scope}:${identity}`;
  for (const [bucketKey, bucket] of Array.from(buckets.entries())) if (now - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    const scopePrefix = `${scope}:`;
    const scopeKeys = Array.from(buckets.keys()).filter(bucketKey => bucketKey.startsWith(scopePrefix));
    if (scopeKeys.length >= MAX_BUCKETS_PER_SCOPE) buckets.delete(scopeKeys[0]);
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
    buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function identityHash(identity: string | number) { return createHash("sha256").update(String(identity)).digest("hex"); }
function sharedLimiterConfigured() { return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()); }

/**
 * Production limiter. The Supabase RPC serializes each scope/identity bucket
 * with a transaction lock, so separate Netlify instances share one limit.
 * Local fallback is intentionally retained for unit tests and unconfigured dev.
 */
export function consumeRateLimit(scope: string, identity: string | number, limit: number, windowMs: number, now = Date.now()): boolean | Promise<boolean> {
  if (!sharedLimiterConfigured()) return localConsumeRateLimit(scope, identity, limit, windowMs, now);
  return (getSupabaseAdmin().rpc("gj_consume_rate_limit", { target_scope: scope, target_identity_hash: identityHash(identity), target_limit: limit, target_window_seconds: Math.max(1, Math.ceil(windowMs / 1000)) }) as Promise<{ data: unknown; error: { message?: string } | null }>).then(({ data, error }) => {
    if (error) {
      console.warn("[RateLimit] Shared limiter unavailable; rejecting request until the limiter recovers.");
      return false;
    }
    return data === true;
  });
}

export const rateLimitTestHooks = {
  reset: () => buckets.clear(),
  size: (scope?: string) => scope ? Array.from(buckets.keys()).filter(key => key.startsWith(`${scope}:`)).length : buckets.size,
  localConsume: localConsumeRateLimit,
};
