type Bucket = { startedAt: number; count: number };

const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export function consumeRateLimit(scope: string, identity: string | number, limit: number, windowMs: number, now = Date.now()) {
  const key = `${scope}:${identity}`;
  for (const [bucketKey, bucket] of Array.from(buckets.entries())) {
    if (now - bucket.startedAt >= windowMs) buckets.delete(bucketKey);
  }
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    if (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value!);
    buckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export const rateLimitTestHooks = {
  reset: () => buckets.clear(),
  size: () => buckets.size,
};
