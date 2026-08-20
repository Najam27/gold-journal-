export const OFFLINE_QUEUE_EVENT = "gold-journal:offline-queue";
export const OFFLINE_CASH_REQUEST_EVENT = "gold-journal:queue-cash";
const STORAGE_KEY = "gold-journal:offline-mutations:v1";
const MAX_QUEUE_ITEMS = 50;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type OfflineMutationKind = "trade.create" | "cash.create";
export type OfflineMutation = { id: string; subject: string; accountId: number; kind: OfflineMutationKind; payload: Record<string, unknown>; createdAt: number; attempts: number };

function notify() { if (typeof window !== "undefined") window.dispatchEvent(new Event(OFFLINE_QUEUE_EVENT)); }
function isRecord(value: unknown): value is OfflineMutation { const item = value as Partial<OfflineMutation>; return Boolean(item && typeof item.id === "string" && typeof item.subject === "string" && Number.isInteger(item.accountId) && (item.kind === "trade.create" || item.kind === "cash.create") && item.payload && typeof item.payload === "object" && Number.isFinite(item.createdAt) && Number.isInteger(item.attempts)); }
function readAll() { if (typeof window === "undefined") return [] as OfflineMutation[]; try { const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); return Array.isArray(parsed) ? parsed.filter(isRecord).filter(item => Date.now() - item.createdAt <= MAX_AGE_MS) : []; } catch { return []; } }
function writeAll(items: OfflineMutation[]) { if (typeof window === "undefined") return; localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_QUEUE_ITEMS))); notify(); }

export function newOfflineMutationId() { return crypto.randomUUID().replace(/-/g, ""); }
export function queuedMutations(subject: string | null | undefined, accountId?: number) { return readAll().filter(item => item.subject === subject && (accountId == null || item.accountId === accountId)); }
export function enqueueOfflineMutation(input: Omit<OfflineMutation, "id" | "createdAt" | "attempts"> & { id?: string }) { const item: OfflineMutation = { ...input, id: input.id ?? newOfflineMutationId(), createdAt: Date.now(), attempts: 0 }; const current = readAll().filter(existing => existing.id !== item.id); writeAll([...current, item]); return item; }
export function clearOfflineMutation(id: string) { writeAll(readAll().filter(item => item.id !== id)); }
export function markOfflineMutationAttempt(id: string) { writeAll(readAll().map(item => item.id === id ? { ...item, attempts: item.attempts + 1 } : item)); }

export async function replayOfflineMutations(subject: string | null | undefined, accountId: number | undefined, dispatch: (item: OfflineMutation) => Promise<void>) {
  if (!subject || !accountId || typeof navigator !== "undefined" && !navigator.onLine) return { replayed: 0, pending: queuedMutations(subject, accountId).length, failed: false };
  let replayed = 0; let failed = false;
  for (const item of queuedMutations(subject, accountId)) {
    try { await dispatch(item); clearOfflineMutation(item.id); replayed += 1; }
    catch { markOfflineMutationAttempt(item.id); failed = true; break; }
  }
  return { replayed, pending: queuedMutations(subject, accountId).length, failed };
}
