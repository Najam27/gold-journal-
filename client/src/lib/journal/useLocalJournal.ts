import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  JOURNAL_QUEUE_STORE,
  applyMutationToJournal,
  readJournalSnapshot,
  reconcileCanonicalTrade,
  saveJournalSnapshot,
  writeJournalRecord,
} from "./journalStore";
import {
  enqueueJournalMutation,
  foldTradeEditIntoPendingCreate,
  flushJournalMutations,
  isOnline,
  pendingJournalMutations,
  queuedJournalMutationCount,
  removeJournalMutation,
  subscribeJournalLocal,
  type JournalMutation,
  type JournalMutationKind,
  type JournalMutationOutcome,
  type JournalSyncState,
} from "./journalSync";

const AUTO_FLUSH_INTERVAL_MS = 20_000;
const MAX_CONFIRMED_CARRYOVER = 50;

export type LocalJournalQueueInput = { kind: JournalMutationKind; payload: Record<string, unknown>; id?: string };

/**
 * Local-first journal runtime.
 *
 * Responsibilities, in the order they matter:
 *   1. render the user's own data immediately (last durable snapshot first);
 *   2. keep the *authoritative* view equal to "the newest server payload, with
 *      every still-queued local edit overlaid in queue order";
 *   3. drain the durable queue, and only then treat a write as done;
 *   4. adopt the canonical server record the moment a queued create is
 *      confirmed, so a later edit or delete can address the real database row.
 *
 * The distinction that this hook exists to keep honest is between SERVER DATA
 * (authoritative), LOCAL OPTIMISTIC DATA (overlaid, still queued) and PENDING
 * UNSYNCED DATA (durable, not yet acknowledged). Local state never silently
 * overrides newer server data: the server payload is the base of every overlay.
 */
export function useLocalJournal(options: {
  accountId?: number;
  subject?: string | null;
  journal?: Record<string, unknown> | null;
  dispatch: (mutation: JournalMutation) => Promise<JournalMutationOutcome>;
  onSynced?: () => void;
}) {
  const { accountId, subject, journal, dispatch, onSynced } = options;
  // The snapshot is tagged with the account it belongs to: a local read for a
  // newly selected account resolves asynchronously, and showing the previous
  // account's journal in the meantime would mislabel one journal as another.
  const [snapshot, setSnapshot] = useState<{
    accountId?: number;
    journal: Record<string, unknown> | null;
  }>({ journal: null });
  const [syncState, setSyncState] = useState<JournalSyncState>("synced");
  const [pendingCount, setPendingCount] = useState(0);
  // The queue for THIS account, so optimistic rows can be shown as pending.
  const [queued, setQueued] = useState<JournalMutation[]>([]);
  // Canonical records the backend confirmed during this session but that the
  // current server payload does not carry yet. Kept so a freshly saved trade
  // cannot blink out of the UI between "queue drained" and "refetch landed".
  const [confirmed, setConfirmed] = useState<Array<{ clientMutationId: string; trade: Record<string, unknown> }>>([]);
  const [online, setOnline] = useState(() => isOnline());
  const dispatchRef = useRef(dispatch);
  const onSyncedRef = useRef(onSynced);
  const flushingRef = useRef(false);
  // A flush requested while another is already running must not be dropped: the
  // save path asks for a flush immediately after queueing, and swallowing that
  // request would leave a freshly saved trade waiting for the next timer tick.
  const flushAgainRef = useRef(false);
  // "The last attempt failed" is state the queue read cannot reconstruct, and the
  // queue read is what a local event triggers. Tracking it here keeps the sync
  // indicator honest instead of letting a refresh downgrade it to "pending".
  const failedRef = useRef(false);
  dispatchRef.current = dispatch;
  onSyncedRef.current = onSynced;

  const refreshQueue = useCallback(async () => {
    if (!subject) {
      setPendingCount(0);
      setQueued([]);
      setSyncState("synced");
      return;
    }
    const [items, total] = await Promise.all([pendingJournalMutations(subject, accountId), queuedJournalMutationCount(subject)]);
    setQueued(items);
    setPendingCount(total);
    if (total === 0) failedRef.current = false;
    setSyncState(total === 0 ? "synced" : failedRef.current ? "failed" : isOnline() ? "pending" : "offline");
  }, [accountId, subject]);

  const flush = useCallback(async () => {
    if (!subject) return;
    if (flushingRef.current) {
      flushAgainRef.current = true;
      return;
    }
    flushingRef.current = true;
    try {
      setSyncState(current => (isOnline() ? "syncing" : "offline"));
      // Drain in passes. `refreshQueue` runs inside the pass and the "was another
      // flush requested?" check happens AFTER it, with no await in between the
      // check and clearing the in-flight flag — otherwise a save that asks for a
      // flush while this one is finishing its bookkeeping would be lost and the
      // trade would sit unsynced until the next timer tick.
      for (let pass = 0; pass < 5; pass += 1) {
        flushAgainRef.current = false;
        const result = await flushJournalMutations({
          subject,
          accountId,
          dispatch: mutation => dispatchRef.current(mutation),
        });
        // "The last attempt failed" is state the queue read cannot reconstruct.
        failedRef.current = result.failed > 0;
        if (result.confirmed.length) {
          setConfirmed(current => {
            const next = [...current];
            const added = next.length;
            for (const entry of result.confirmed) {
              // `mutationId` IS the clientMutationId: the queue id doubles as the
              // server-side idempotency key.
              if (!next.some(item => item.clientMutationId === entry.mutationId)) {
                next.push({ clientMutationId: entry.mutationId, trade: entry.trade });
              }
            }
            // Returning the previous reference when nothing was added lets React
            // bail out of a render instead of re-rendering for no change.
            if (next.length === added && next.length <= MAX_CONFIRMED_CARRYOVER) return current;
            return next.slice(-MAX_CONFIRMED_CARRYOVER);
          });
        }
        // The backend now holds canonical data, so every account-scoped read is
        // refetched instead of trusting local state.
        if (result.synced) onSyncedRef.current?.();
        // A fresh read, so the indicator can never show "0 pending" for a trade
        // that is genuinely still waiting on a stale snapshot.
        await refreshQueue();
        // A failure stops the drain (queue order must hold).
        if (result.failed) break;
        if (!flushAgainRef.current) break;
      }
    } finally {
      flushingRef.current = false;
    }
  }, [accountId, refreshQueue, subject]);

  // Hydrate the last durable snapshot for this account (offline / cold start).
  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setSnapshot({ journal: null });
      return;
    }
    void readJournalSnapshot(accountId).then(local => {
      if (!cancelled) setSnapshot({ accountId, journal: local?.journal ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const reconciled = useMemo(() => {
    if (!journal) return null;
    let next = journal;
    for (const mutation of queued) next = applyMutationToJournal(next, mutation);
    for (const entry of confirmed) {
      const list = Array.isArray((next as { trades?: unknown }).trades) ? ((next as { trades: Record<string, unknown>[] }).trades ?? []) : [];
      const alreadyPresent = list.some(row => Number(row?.id) === Number(entry.trade.id) || row?.clientMutationId === entry.clientMutationId);
      if (!alreadyPresent) next = reconcileCanonicalTrade(next, entry.clientMutationId, entry.trade);
    }
    return next;
  }, [confirmed, journal, queued]);

  // Once the server payload carries a confirmed record, the carry-over copy has
  // done its job and must not shadow newer server values.
  useEffect(() => {
    if (!journal || !confirmed.length) return;
    const list = Array.isArray((journal as { trades?: unknown }).trades) ? ((journal as { trades: Record<string, unknown>[] }).trades ?? []) : [];
    setConfirmed(current => {
      const next = current.filter(entry => !list.some(row => Number(row?.id) === Number(entry.trade.id) || row?.clientMutationId === entry.clientMutationId));
      // Same list means nothing was superseded: returning the current reference
      // keeps this effect from re-rendering in a loop when a parent hands down a
      // fresh journal object on every render.
      return next.length === current.length ? current : next;
    });
  }, [confirmed, journal]);

  // Mirror the authoritative journal into durable storage so an offline reload
  // shows the same thing the user was last looking at. When there is no server
  // payload at all (offline cold start) the optimistic snapshot is what must
  // survive, not nothing.
  const snapshotJournal = snapshot.accountId === accountId ? snapshot.journal : null;
  useEffect(() => {
    if (!accountId) return;
    const next = reconciled ?? snapshotJournal;
    if (!next) return;
    void saveJournalSnapshot(accountId, next);
  }, [accountId, reconciled, snapshotJournal]);

  // Connectivity changes trigger an immediate retry, and pending work keeps
  // retrying on a bounded timer while the tab stays open.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const up = () => {
      setOnline(true);
      void flush();
    };
    const down = () => {
      setOnline(false);
      void refreshQueue();
    };
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, [flush, refreshQueue]);

  useEffect(() => {
    void refreshQueue();
    void flush();
    const timer = setInterval(() => {
      void flush();
    }, AUTO_FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [flush, refreshQueue]);

  useEffect(() => subscribeJournalLocal(() => void refreshQueue()), [refreshQueue]);

  /**
   * Applies the edit locally, queues it durably, and attempts a sync.
   * The caller never waits on the network to see the change.
   */
  const queueMutation = useCallback(
    async (input: LocalJournalQueueInput) => {
      if (!accountId || !subject) throw new Error("Sign in before saving journal changes.");
      const snapshotRow = await readJournalSnapshot(accountId);
      const currentJournal = snapshotRow?.journal ?? null;

      // An edit or delete of a trade that is ITSELF still queued cannot be sent
      // as its own mutation: the trade has a negative placeholder id and no
      // database row. It is folded into the queued create instead, so exactly
      // one backend create carries the user's final values.
      if (input.kind === "trade.update" || input.kind === "trade.delete") {
        const tradeId = Number((input.payload as { tradeId?: unknown }).tradeId);
        if (!(Number.isInteger(tradeId) && tradeId > 0)) {
          const localRow = currentJournal
            ? (Array.isArray((currentJournal as { trades?: unknown }).trades) ? ((currentJournal as { trades: Record<string, unknown>[] }).trades ?? []) : []).find(row => Number(row?.id) === tradeId)
            : undefined;
          const origin = (await pendingJournalMutations(subject, accountId)).find(
            item => item.kind === "trade.create" && item.payload.clientMutationId === localRow?.clientMutationId
          );
          if (origin) {
            const folded = foldTradeEditIntoPendingCreate(origin, { kind: input.kind, payload: input.payload });
            if (folded) await writeJournalRecord(JOURNAL_QUEUE_STORE, origin.id, folded);
            else await removeJournalMutation(origin.id);
            if (currentJournal) {
              const next = applyMutationToJournal(currentJournal, { id: origin.id, kind: input.kind, payload: input.payload });
              setSnapshot({ accountId, journal: next });
              await saveJournalSnapshot(accountId, next);
            }
            await refreshQueue();
            void flush();
            return folded ?? origin;
          }
        }
      }

      const mutation = await enqueueJournalMutation({ ...input, accountId, subject });
      // The snapshot itself is persisted by the effect above, so this stays a
      // pure state update instead of writing to storage during a render pass.
      setSnapshot(current => {
        const base = current.accountId === accountId ? current.journal : null;
        return { accountId, journal: applyMutationToJournal(base ?? currentJournal ?? journal ?? {}, mutation) };
      });
      await refreshQueue();
      void flush();
      return mutation;
    },
    [accountId, flush, journal, refreshQueue, subject]
  );

  /**
   * Trades this tab has queued but the backend has not acknowledged yet.
   *
   * Read from the reconciled payload when a server payload exists, and from the
   * durable snapshot otherwise, so an offline cold start still shows the work the
   * user did on this device instead of an empty table.
   */
  const pendingTrades = useMemo(() => {
    const reconciledTrades = (reconciled as { trades?: unknown } | null)?.trades;
    const list = Array.isArray(reconciledTrades)
      ? (reconciledTrades as Record<string, unknown>[])
      : snapshot.accountId === accountId && Array.isArray((snapshot.journal as { trades?: unknown } | null)?.trades)
        ? ((snapshot.journal as { trades: Record<string, unknown>[] }).trades ?? [])
        : [];
    return list.filter(row => row?.localPending === true);
  }, [accountId, reconciled, snapshot]);

  /** Server trade ids this tab has queued a delete for (already hidden locally). */
  const pendingDeletedIds = useMemo(
    () =>
      queued
        .filter(item => item.kind === "trade.delete")
        .map(item => Number((item.payload as { tradeId?: unknown }).tradeId))
        .filter(id => Number.isInteger(id) && id > 0),
    [queued]
  );

  return {
    /** Newest server payload with every still-queued local edit applied. */
    reconciled,
    /** Last durable snapshot for this account; only used with no server payload. */
    localSnapshot: snapshot.accountId === accountId ? snapshot.journal : null,
    pendingTrades,
    pendingDeletedIds,
    syncState,
    pendingCount,
    /**
     * The real, safe reason the newest queued write failed to reach the backend
     * (for example a validation message). Surfaced so the UI can explain WHY a
     * save is not yet committed instead of showing a generic failure.
     */
    lastError: queued.find(item => item.lastError)?.lastError ?? null,
    online,
    queueMutation,
    flush,
    refreshQueue,
  };
}
