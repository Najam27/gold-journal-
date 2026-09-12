import { useCallback, useEffect, useRef, useState } from "react";
import { applyMutationToJournal, readJournalSnapshot, saveJournalSnapshot } from "./journalStore";
import {
  enqueueJournalMutation,
  flushJournalMutations,
  isOnline,
  pendingJournalMutations,
  queuedJournalMutationCount,
  subscribeJournalLocal,
  type JournalMutation,
  type JournalMutationKind,
  type JournalSyncState,
} from "./journalSync";

const AUTO_FLUSH_INTERVAL_MS = 20_000;

export type LocalJournalQueueInput = { kind: JournalMutationKind; payload: Record<string, unknown>; id?: string };

/**
 * Local-first journal runtime.
 *
 * Hydrates the last local snapshot so the UI renders immediately, mirrors every
 * cloud snapshot back to IndexedDB, queues user edits locally before any
 * network call, and drains the queue whenever connectivity returns.
 */
export function useLocalJournal(options: {
  accountId?: number;
  subject?: string | null;
  journal?: Record<string, unknown> | null;
  dispatch: (mutation: JournalMutation) => Promise<void>;
  onSynced?: () => void;
}) {
  const { accountId, subject, journal, dispatch, onSynced } = options;
  const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null);
  const [syncState, setSyncState] = useState<JournalSyncState>("synced");
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState(() => isOnline());
  const dispatchRef = useRef(dispatch);
  const onSyncedRef = useRef(onSynced);
  const flushingRef = useRef(false);
  dispatchRef.current = dispatch;
  onSyncedRef.current = onSynced;

  const refreshQueue = useCallback(async () => {
    if (!subject) {
      setPendingCount(0);
      setSyncState("synced");
      return;
    }
    const count = await queuedJournalMutationCount(subject);
    setPendingCount(count);
    setSyncState(count === 0 ? "synced" : isOnline() ? "pending" : "offline");
  }, [subject]);

  const flush = useCallback(async () => {
    if (!subject || flushingRef.current) return;
    flushingRef.current = true;
    try {
      setSyncState(current => (isOnline() ? "syncing" : "offline"));
      const result = await flushJournalMutations({
        subject,
        accountId,
        dispatch: mutation => dispatchRef.current(mutation),
      });
      setPendingCount(result.pending);
      setSyncState(result.state);
      if (result.synced) onSyncedRef.current?.();
    } finally {
      flushingRef.current = false;
    }
  }, [accountId, subject]);

  // Hydrate the last local snapshot for this account.
  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setSnapshot(null);
      return;
    }
    void readJournalSnapshot(accountId).then(local => {
      if (!cancelled) setSnapshot(local?.journal ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Mirror the cloud snapshot locally, keeping any not-yet-synced local edits.
  useEffect(() => {
    if (!accountId || !journal) return;
    let cancelled = false;
    void (async () => {
      const pending = await pendingJournalMutations(subject, accountId);
      let next = journal;
      for (const mutation of pending) next = applyMutationToJournal(next, mutation);
      if (cancelled) return;
      setSnapshot(next);
      await saveJournalSnapshot(accountId, next);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, journal, subject]);

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
      const mutation = await enqueueJournalMutation({ ...input, accountId, subject });
      setSnapshot(current => {
        const next = applyMutationToJournal(current ?? journal ?? {}, mutation);
        void saveJournalSnapshot(accountId, next);
        return next;
      });
      await refreshQueue();
      void flush();
      return mutation;
    },
    [accountId, subject, journal, refreshQueue, flush]
  );

  return {
    /** Last known journal for this account, safe to use as placeholder data. */
    localSnapshot: snapshot,
    syncState,
    pendingCount,
    online,
    queueMutation,
    flush,
    refreshQueue,
  };
}
