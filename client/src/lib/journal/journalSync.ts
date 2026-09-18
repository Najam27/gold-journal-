/**
 * Durable journal sync queue.
 *
 * Journal writes land locally first (see journalStore) and are queued here.
 * Queued work is flushed automatically when the browser regains connectivity,
 * on app start, on a bounded timer, and after a successful user action.
 *
 * Guarantees:
 *  - queue items survive a reload because they are stored in IndexedDB;
 *  - every item carries a stable `clientMutationId` derived from its queue id,
 *    so a replayed request can never insert a duplicate record;
 *  - failed items back off exponentially with jitter and are never dropped
 *    because of a transient backend 5xx;
 *  - retry state resets after a successful synchronisation.
 */
import {
  JOURNAL_LOCAL_EVENT,
  JOURNAL_QUEUE_STORE,
  type JournalSyncState,
  deleteJournalRecord,
  readJournalRecords,
  notifyJournalLocal,
  writeJournalRecord,
} from "./journalStore";

export type { JournalSyncState };

export type JournalMutationKind = "trade.create" | "trade.update" | "trade.delete" | "cash.create";

export type JournalMutation = {
  /** Doubles as the server-side idempotency key (`clientMutationId`). */
  id: string;
  subject: string;
  accountId: number;
  kind: JournalMutationKind;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};

export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
export const MAX_QUEUE_ITEMS = 200;
export const MAX_QUEUE_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/** 1s, 2s, 4s, 8s, 16s, 32s, 60s with ±20% jitter. */
export function backoffDelayMs(attempts: number, random: number = Math.random()) {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 6);
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
  const jitter = base * 0.2 * (random * 2 - 1);
  return Math.max(BASE_BACKOFF_MS, Math.round(base + jitter));
}

export function newJournalMutationId() {
  return crypto.randomUUID().replace(/-/g, "");
}

export function isOnline() {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

export async function enqueueJournalMutation(input: {
  id?: string;
  subject: string;
  accountId: number;
  kind: JournalMutationKind;
  payload: Record<string, unknown>;
}): Promise<JournalMutation> {
  const id = input.id ?? newJournalMutationId();
  const mutation: JournalMutation = {
    id,
    subject: input.subject,
    accountId: input.accountId,
    kind: input.kind,
    payload: { ...input.payload, clientMutationId: id },
    createdAt: Date.now(),
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  };
  await writeJournalRecord(JOURNAL_QUEUE_STORE, id, mutation);
  notifyJournalLocal();
  return mutation;
}

async function allMutations(): Promise<JournalMutation[]> {
  const rows = await readJournalRecords<JournalMutation>(JOURNAL_QUEUE_STORE);
  const cutoff = Date.now() - MAX_QUEUE_AGE_MS;
  return rows
    .filter(row => row && typeof row.id === "string" && typeof row.createdAt === "number" && row.createdAt >= cutoff)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_QUEUE_ITEMS);
}

export async function pendingJournalMutations(subject: string | null | undefined, accountId?: number) {
  if (!subject) return [] as JournalMutation[];
  return (await allMutations()).filter(item => item.subject === subject && (accountId == null || item.accountId === accountId));
}

/** Counts everything queued for the signed-in identity, across accounts. */
export async function queuedJournalMutationCount(subject: string | null | undefined) {
  if (!subject) return 0;
  return (await allMutations()).filter(item => item.subject === subject).length;
}

export async function removeJournalMutation(id: string) {
  await deleteJournalRecord(JOURNAL_QUEUE_STORE, id);
  notifyJournalLocal();
}

/**
 * Drops queued work. Used on sign-out (a different identity must not inherit or
 * replay another user's pending writes) and by the sync tests.
 */
export async function clearJournalQueue(subject?: string | null) {
  const rows = await allMutations();
  await Promise.all(rows.filter(row => !subject || row.subject === subject).map(row => deleteJournalRecord(JOURNAL_QUEUE_STORE, row.id)));
  notifyJournalLocal();
}

async function recordAttempt(mutation: JournalMutation, error: unknown) {
  const attempts = mutation.attempts + 1;
  await writeJournalRecord(JOURNAL_QUEUE_STORE, mutation.id, {
    ...mutation,
    attempts,
    nextAttemptAt: Date.now() + backoffDelayMs(attempts),
    lastError: error instanceof Error ? error.message.slice(0, 300) : "Sync failed",
  });
  notifyJournalLocal();
}

/**
 * What a dispatch reports back after the backend accepted the write.
 *
 * A create/update returns the canonical stored trade so the browser can replace
 * its optimistic placeholder with the real database identity.
 */
export type JournalMutationOutcome = { trade?: Record<string, unknown>; tradeId?: number } | void;

/**
 * Thrown by a dispatcher when a queued item can never be applied — for example
 * a change that targets a trade the server never saw.
 *
 * Such an item is discarded rather than retried forever: retrying something
 * that cannot succeed kept the whole FIFO queue blocked behind it, so every
 * later write for the account silently never reached the backend.
 */
export class JournalMutationDiscarded extends Error {
  constructor(message = "This queued change can no longer be applied and was discarded.") {
    super(message);
    this.name = "JournalMutationDiscarded";
  }
}

export type FlushResult = {
  synced: number;
  pending: number;
  failed: number;
  discarded: number;
  state: JournalSyncState;
  /** Canonical records the backend confirmed during this pass. */
  confirmed: Array<{ mutationId: string; trade: Record<string, unknown> }>;
};

/**
 * Flushes queued journal edits in order.
 *
 * A failure stops the run so a later edit cannot overtake an earlier one, the
 * failed item stays queued with a backoff deadline, and local data is never
 * removed. The server's `clientMutationId` check makes replaying a
 * partially-applied item idempotent. A queue item is only removed after the
 * backend confirmed it — never on the strength of a local assumption.
 */
export async function flushJournalMutations(input: {
  subject: string | null | undefined;
  accountId?: number;
  dispatch: (mutation: JournalMutation) => Promise<JournalMutationOutcome>;
  now?: number;
  online?: boolean;
}): Promise<FlushResult> {
  const now = input.now ?? Date.now();
  const online = input.online ?? isOnline();
  const subject = input.subject;
  const pending = await pendingJournalMutations(subject, input.accountId);
  const confirmed: Array<{ mutationId: string; trade: Record<string, unknown> }> = [];
  if (!pending.length) return { synced: 0, pending: 0, failed: 0, discarded: 0, state: "synced", confirmed };
  if (!online || !subject) return { synced: 0, pending: pending.length, failed: 0, discarded: 0, state: "offline", confirmed };

  notifyJournalLocal();
  let synced = 0;
  let failed = 0;
  let discarded = 0;
  for (const mutation of pending) {
    if (mutation.nextAttemptAt > now) continue;
    try {
      const outcome = await input.dispatch(mutation);
      if (outcome && outcome.trade) confirmed.push({ mutationId: mutation.id, trade: outcome.trade });
      await removeJournalMutation(mutation.id);
      synced += 1;
    } catch (error) {
      if (error instanceof JournalMutationDiscarded) {
        console.warn("[journal] discarded an unreplayable queued change", mutation.kind, mutation.id, error.message);
        await removeJournalMutation(mutation.id);
        discarded += 1;
        continue;
      }
      await recordAttempt(mutation, error);
      failed += 1;
      break;
    }
  }
  const remaining = await pendingJournalMutations(subject, input.accountId);
  const state: JournalSyncState = remaining.length === 0 ? "synced" : failed ? "failed" : "pending";
  return { synced, pending: remaining.length, failed, discarded, state, confirmed };
}

/**
 * Folds an edit of a trade that has not reached the server yet into the queued
 * create it belongs to.
 *
 * A locally-queued trade carries a negative placeholder id, so queueing the edit
 * as a separate `trade.update` would address a row that does not exist — and can
 * never exist. Merging keeps exactly one backend create per trade, carrying the
 * user's final values. A delete of a still-queued create cancels it outright,
 * which is signalled by returning `null`.
 */
export function foldTradeEditIntoPendingCreate(
  create: JournalMutation,
  edit: { kind: "trade.update" | "trade.delete"; payload: Record<string, unknown> }
): JournalMutation | null {
  if (edit.kind === "trade.delete") return null;
  const fields: Record<string, unknown> = { ...edit.payload };
  delete fields.tradeId;
  delete fields.clientMutationId;
  const createMutationId = typeof create.payload.clientMutationId === "string" ? create.payload.clientMutationId : create.id;
  return { ...create, payload: { ...create.payload, ...fields, clientMutationId: createMutationId } };
}

/** Next moment at which some queued item becomes eligible for a retry. */
export function nextRetryDelayMs(mutations: JournalMutation[], now = Date.now()) {
  const waits = mutations.map(item => Math.max(0, item.nextAttemptAt - now));
  return waits.length ? Math.min(...waits) : null;
}

export function subscribeJournalLocal(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(JOURNAL_LOCAL_EVENT, listener);
  return () => window.removeEventListener(JOURNAL_LOCAL_EVENT, listener);
}
