/**
 * Local-first journal persistence.
 *
 * The journal snapshot and the pending-sync queue are stored in IndexedDB,
 * which is asynchronous and suitable for larger datasets than `localStorage`.
 * When IndexedDB is unavailable (private mode, SSR, tests) the layer degrades to
 * an in-process map so the app keeps working instead of throwing.
 *
 * IndexedDB holds journal data only. The AI credential lives in the separate
 * browser AI storage module and is never written here.
 */

export const JOURNAL_DB_NAME = "gold-journal";
export const JOURNAL_DB_VERSION = 1;
export const JOURNAL_SNAPSHOT_STORE = "journal-snapshots";
export const JOURNAL_QUEUE_STORE = "journal-queue";

/** Broadcast so React trees and indicators can react without prop drilling. */
export const JOURNAL_LOCAL_EVENT = "gold-journal:local-journal";

export type JournalSyncState = "offline" | "synced" | "pending" | "syncing" | "failed";

export function indexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export function notifyJournalLocal() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(JOURNAL_LOCAL_EVENT));
}

const memory = new Map<string, Map<string, unknown>>();

function memoryBucket(store: string) {
  let bucket = memory.get(store);
  if (!bucket) {
    bucket = new Map<string, unknown>();
    memory.set(store, bucket);
  }
  return bucket;
}

let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (!indexedDbAvailable()) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase | null>(resolve => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(JOURNAL_DB_NAME, JOURNAL_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(JOURNAL_SNAPSHOT_STORE)) db.createObjectStore(JOURNAL_SNAPSHOT_STORE);
      if (!db.objectStoreNames.contains(JOURNAL_QUEUE_STORE)) db.createObjectStore(JOURNAL_QUEUE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return databasePromise;
}

/** Test/teardown seam: forget the open handle so a fresh database is opened. */
export function resetJournalDatabase() {
  databasePromise = null;
}

function runTransaction<T>(store: string, mode: IDBTransactionMode, work: (objectStore: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return openDatabase().then(db => {
    if (!db) return null;
    return new Promise<T | null>(resolve => {
      try {
        const transaction = db.transaction(store, mode);
        const request = work(transaction.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        transaction.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  });
}

export async function writeJournalRecord(store: string, key: string, value: unknown): Promise<void> {
  memoryBucket(store).set(key, value);
  if (!indexedDbAvailable()) return;
  await runTransaction(store, "readwrite", objectStore => objectStore.put(value, key));
}

export async function readJournalRecord<T>(store: string, key: string): Promise<T | null> {
  if (!indexedDbAvailable()) return (memoryBucket(store).get(key) as T | undefined) ?? null;
  const result = await runTransaction<T>(store, "readonly", objectStore => objectStore.get(key));
  if (result === null) return (memoryBucket(store).get(key) as T | undefined) ?? null;
  memoryBucket(store).set(key, result);
  return result;
}

export async function readJournalRecords<T>(store: string): Promise<T[]> {
  if (!indexedDbAvailable()) return Array.from(memoryBucket(store).values()) as T[];
  const result = await runTransaction<T[]>(store, "readonly", objectStore => objectStore.getAll());
  return result ?? [];
}

export async function deleteJournalRecord(store: string, key: string): Promise<void> {
  memoryBucket(store).delete(key);
  if (!indexedDbAvailable()) return;
  await runTransaction(store, "readwrite", objectStore => objectStore.delete(key));
}

/* ------------------------------------------------------------------ *
 * Journal snapshots
 * ------------------------------------------------------------------ */

export type JournalSnapshot = { accountId: number; savedAt: number; journal: Record<string, unknown> };

const snapshotKey = (accountId: number) => `account:${accountId}`;

export async function saveJournalSnapshot(accountId: number, journal: Record<string, unknown>) {
  const snapshot: JournalSnapshot = { accountId, savedAt: Date.now(), journal };
  await writeJournalRecord(JOURNAL_SNAPSHOT_STORE, snapshotKey(accountId), snapshot);
  return snapshot;
}

export function readJournalSnapshot(accountId: number) {
  return readJournalRecord<JournalSnapshot>(JOURNAL_SNAPSHOT_STORE, snapshotKey(accountId));
}

export function clearJournalSnapshot(accountId: number) {
  return deleteJournalRecord(JOURNAL_SNAPSHOT_STORE, snapshotKey(accountId));
}

/**
 * Optimistically applies a queued user edit to the local journal snapshot so the
 * UI can show it immediately, before any network round trip.
 *
 * Conflict rule: local intent is applied in queue order, and the server record
 * (identified by `clientMutationId`, which the replay path deduplicates) wins
 * for every field the user did not edit. A successful cloud fetch simply
 * replaces the snapshot, so a later refresh reconciles deterministically.
 */
export function applyMutationToJournal(journal: Record<string, unknown>, mutation: { id: string; kind: string; payload: Record<string, unknown> }): Record<string, unknown> {
  const payload = mutation.payload ?? {};
  if (mutation.kind === "trade.create") {
    const list = Array.isArray(journal.trades) ? [...(journal.trades as unknown[])] : [];
    // A negative placeholder id keeps the optimistic row distinguishable from a
    // server-assigned (always positive) identifier until the refetch lands.
    const localId = -(1_000_000 + (Date.now() % 1_000_000));
    list.unshift({ ...payload, id: localId, clientMutationId: mutation.id, localPending: true });
    return { ...journal, trades: list, goalTrades: Array.isArray(journal.goalTrades) ? [payload, ...(journal.goalTrades as unknown[])] : journal.goalTrades, localPending: true };
  }
  if (mutation.kind === "trade.update") {
    const tradeId = Number(payload.tradeId);
    return {
      ...journal,
      trades: (Array.isArray(journal.trades) ? (journal.trades as any[]) : []).map(trade => Number(trade?.id) === tradeId ? { ...trade, ...payload, localPending: true } : trade),
      goalTrades: (Array.isArray(journal.goalTrades) ? (journal.goalTrades as any[]) : []).map(trade => Number(trade?.id) === tradeId ? { ...trade, ...payload, localPending: true } : trade),
      localPending: true,
    };
  }
  if (mutation.kind === "trade.delete") {
    const tradeId = Number(payload.tradeId);
    return {
      ...journal,
      trades: (Array.isArray(journal.trades) ? (journal.trades as any[]) : []).filter(trade => Number(trade?.id) !== tradeId),
      goalTrades: (Array.isArray(journal.goalTrades) ? (journal.goalTrades as any[]) : []).filter(trade => Number(trade?.id) !== tradeId),
      localPending: true,
    };
  }
  if (mutation.kind === "cash.create") {
    const list = Array.isArray(journal.cashMovements) ? [...(journal.cashMovements as unknown[])] : [];
    list.unshift({ ...payload, id: -(list.length + 1), clientMutationId: mutation.id, localPending: true });
    return { ...journal, cashMovements: list, localPending: true };
  }
  return journal;
}
