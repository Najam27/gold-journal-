// Offline persistence: cache the last synced data per account (so the app can
// show data while offline) and queue writes made offline for replay on reconnect.

const SNAP_PREFIX = "gj-snap-";
const QUEUE_PREFIX = "gj-queue-";

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function write(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* quota / private mode — ignore */
  }
}

// ---- last-synced snapshot ----
export function saveSnapshot(userId, accountId, data) {
  if (!userId || !accountId) return;
  write(SNAP_PREFIX + userId + "-" + accountId, { ...data, ts: Date.now() });
}
export function loadSnapshot(userId, accountId) {
  if (!userId || !accountId) return null;
  return read(SNAP_PREFIX + userId + "-" + accountId, null);
}

// ---- offline write queue ----
export function getQueue(userId) {
  if (!userId) return [];
  return read(QUEUE_PREFIX + userId, []);
}
function setQueue(userId, arr) {
  write(QUEUE_PREFIX + userId, arr);
}
export function queueCount(userId) {
  return getQueue(userId).length;
}

export function enqueue(userId, op) {
  const q = getQueue(userId);
  q.push({ ...op, qid: crypto.randomUUID?.() || String(Date.now() + Math.random()), ts: Date.now() });
  setQueue(userId, q);
  return q.length;
}

// Replay queued ops in order via `apply(op)`. Successful ops are dropped;
// failures are retained for the next attempt. Returns counts.
export async function flushQueue(userId, apply) {
  const q = getQueue(userId);
  if (!q.length) return { synced: 0, failed: 0 };
  let synced = 0;
  const remaining = [];
  for (const op of q) {
    try {
      await apply(op);
      synced++;
    } catch {
      remaining.push(op);
    }
  }
  setQueue(userId, remaining);
  return { synced, failed: remaining.length };
}
