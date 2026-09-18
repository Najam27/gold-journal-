// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JOURNAL_QUEUE_STORE,
  applyMutationToJournal,
  clearJournalSnapshot,
  readJournalSnapshot,
  reconcileCanonicalTrade,
  saveJournalSnapshot,
  writeJournalRecord,
} from "./journalStore";
import {
  JournalMutationDiscarded,
  clearJournalQueue,
  enqueueJournalMutation,
  flushJournalMutations,
  foldTradeEditIntoPendingCreate,
  pendingJournalMutations,
  queuedJournalMutationCount,
  removeJournalMutation,
  type JournalMutation,
} from "./journalSync";
import { useLocalJournal } from "./useLocalJournal";

const SUBJECT = "user-alpha";
const ACCOUNT_A = 12;
const ACCOUNT_B = 13;

const trade = (index: number, accountId = ACCOUNT_A) => ({
  accountId,
  tradeDate: 1_800_000_000_000 + index,
  session: "London",
  direction: "BUY",
  result: "WIN",
  pnl: 100,
});

// Unmounting stops each hook's auto-flush interval, so tests cannot leak work
// into the next one.
afterEach(() => cleanup());

beforeEach(async () => {
  vi.restoreAllMocks();
  // IndexedDB is unavailable under jsdom, so the journal layer falls back to its
  // in-process store. Each test starts from an empty queue and empty snapshots.
  await clearJournalQueue();
  await clearJournalSnapshot(ACCOUNT_A);
  await clearJournalSnapshot(ACCOUNT_B);
});

/* ------------------------------------------------------------------ *
 * The durable queue
 * ------------------------------------------------------------------ */

describe("offline-first trade queue", () => {
  it("keeps a trade created offline queued and durable across a reload, and never claims it synced", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(1) });

    const dispatch = vi.fn(async () => undefined);
    const offline = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: false });

    expect(dispatch).not.toHaveBeenCalled();
    expect(offline.state).toBe("offline");
    expect(offline.synced).toBe(0);

    // A reload re-reads durable storage instead of component state.
    const afterReload = await pendingJournalMutations(SUBJECT, ACCOUNT_A);
    expect(afterReload).toHaveLength(1);
    expect(afterReload[0]).toMatchObject({ kind: "trade.create", attempts: 0, lastError: null });
    expect(await queuedJournalMutationCount(SUBJECT)).toBe(1);
  });

  it("sends an offline trade exactly once on reconnect and clears it only after the backend confirms", async () => {
    await enqueueJournalMutation({ id: "offline-create-0000001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(2) });

    const delivered: string[] = [];
    const dispatch = vi.fn(async (mutation: JournalMutation) => {
      delivered.push(String(mutation.payload.clientMutationId));
      return { trade: { id: 501, session: "London" } };
    });

    const result = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });

    expect(delivered).toEqual(["offline-create-0000001"]);
    expect(result.synced).toBe(1);
    expect(result.pending).toBe(0);
    expect(result.confirmed).toEqual([{ mutationId: "offline-create-0000001", trade: { id: 501, session: "London" } }]);
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(0);

    // A second flush must not re-send anything: exactly one backend trade.
    await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });
    expect(delivered).toHaveLength(1);
  });

  it("keeps the trade queued with a retry deadline when the backend fails, without losing local data", async () => {
    await enqueueJournalMutation({ id: "failing-create-000001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(3) });

    const dispatch = vi.fn(async () => {
      throw new Error("Supabase connection reset");
    });
    const result = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });

    expect(result.state).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);

    const queued = await pendingJournalMutations(SUBJECT, ACCOUNT_A);
    expect(queued).toHaveLength(1);
    expect(queued[0].attempts).toBe(1);
    expect(queued[0].nextAttemptAt).toBeGreaterThan(Date.now());
    expect(queued[0].lastError).toContain("Supabase connection reset");
    // Never silently marked as synced.
    expect(await queuedJournalMutationCount(SUBJECT)).toBe(1);
  });

  it("delivers exactly one backend trade when a failed request is retried", async () => {
    await enqueueJournalMutation({ id: "retry-create-0000001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(4) });

    const persisted: string[] = [];
    let attempt = 0;
    const dispatch = vi.fn(async (mutation: JournalMutation) => {
      attempt += 1;
      if (attempt === 1) throw new Error("502 Bad Gateway");
      const clientMutationId = String(mutation.payload.clientMutationId);
      if (!persisted.includes(clientMutationId)) persisted.push(clientMutationId);
      return { trade: { id: 900 + attempt } };
    });

    await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);

    // The backoff deadline is bypassed the way a real reconnect would.
    const [queued] = await pendingJournalMutations(SUBJECT, ACCOUNT_A);
    await writeJournalRecord(JOURNAL_QUEUE_STORE, queued.id, { ...queued, nextAttemptAt: 0 });
    await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });

    expect(persisted).toEqual(["retry-create-0000001"]);
    expect(attempt).toBe(2);
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(0);
  });

  it("discards an item that can never be applied instead of blocking every later write behind it", async () => {
    await enqueueJournalMutation({ id: "poisoned-update-0001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.update", payload: { ...trade(5), tradeId: -1_000_001 } });
    await enqueueJournalMutation({ id: "healthy-create-0001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(6) });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const delivered: string[] = [];
    const dispatch = vi.fn(async (mutation: JournalMutation) => {
      if (mutation.id === "poisoned-update-0001") throw new JournalMutationDiscarded("target trade never reached the server");
      delivered.push(mutation.id);
      return { trade: { id: 601 } };
    });

    const result = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });

    expect(result.discarded).toBe(1);
    expect(result.synced).toBe(1);
    // The healthy write behind it still reached the backend.
    expect(delivered).toEqual(["healthy-create-0001"]);
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("scopes the queue to the identity so a sign-out can never replay another user's writes", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(7) });
    await enqueueJournalMutation({ subject: "user-beta", accountId: ACCOUNT_A, kind: "trade.create", payload: trade(8) });

    const dispatch = vi.fn(async () => undefined);
    await flushJournalMutations({ subject: "user-beta", accountId: ACCOUNT_A, dispatch, online: true });
    expect(dispatch).toHaveBeenCalledTimes(1);

    // The first identity's work is untouched by the second identity's flush.
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);
    expect(await queuedJournalMutationCount("user-beta")).toBe(0);

    await clearJournalQueue("user-beta");
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);
  });

  it("isolates queued writes per account so switching accounts cannot cross-apply them", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(9, ACCOUNT_A) });
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT_B, kind: "trade.create", payload: trade(10, ACCOUNT_B) });

    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_B)).toHaveLength(1);

    const delivered: number[] = [];
    await flushJournalMutations({
      subject: SUBJECT,
      accountId: ACCOUNT_B,
      online: true,
      dispatch: async mutation => {
        delivered.push(Number(mutation.payload.accountId));
      },
    });

    expect(delivered).toEqual([ACCOUNT_B]);
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Coalescing a pending create with its own edits
 * ------------------------------------------------------------------ */

describe("edits of a not-yet-synced trade", () => {
  it("folds an edit into the queued create so exactly one backend trade is created, with the final values", async () => {
    const create = await enqueueJournalMutation({ id: "coalesce-create-001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(11) });
    const optimistic = applyMutationToJournal({ trades: [], goalTrades: [] }, create);
    const localId = Number((optimistic.trades as any[])[0].id);
    expect(localId).toBeLessThan(0);

    const folded = foldTradeEditIntoPendingCreate(create, { kind: "trade.update", payload: { tradeId: localId, session: "New York", pnl: 250, clientMutationId: "edit-id-00000001" } });
    expect(folded).not.toBeNull();
    await writeJournalRecord(JOURNAL_QUEUE_STORE, folded!.id, folded!);

    const delivered: JournalMutation[] = [];
    await flushJournalMutations({
      subject: SUBJECT,
      accountId: ACCOUNT_A,
      online: true,
      dispatch: async mutation => {
        delivered.push(mutation);
        return { trade: { id: 700 } };
      },
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0].kind).toBe("trade.create");
    expect(delivered[0].payload).toMatchObject({ session: "New York", pnl: 250, clientMutationId: "coalesce-create-001" });
    expect(delivered[0].payload.tradeId).toBeUndefined();
  });

  it("cancels a queued create outright when the user deletes it before it syncs", async () => {
    const create = await enqueueJournalMutation({ id: "cancel-create-0001", subject: SUBJECT, accountId: ACCOUNT_A, kind: "trade.create", payload: trade(12) });

    expect(foldTradeEditIntoPendingCreate(create, { kind: "trade.delete", payload: { tradeId: -1 } })).toBeNull();

    // What the runtime does with that null: drop the queued create and the
    // optimistic row, so nothing is ever sent for a trade the user removed.
    await removeJournalMutation(create.id);
    const journal = applyMutationToJournal({ trades: [{ id: -1, session: "London" }], goalTrades: [{ id: -1 }] }, { id: create.id, kind: "trade.delete", payload: { tradeId: -1 } });

    const dispatch = vi.fn(async () => undefined);
    await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT_A, dispatch, online: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect((journal.trades as any[])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Canonical reconciliation
 * ------------------------------------------------------------------ */

describe("canonical server reconciliation", () => {
  it("replaces the local placeholder with the stored trade and keeps the server id", () => {
    const create = { id: "reconcile-00000001", kind: "trade.create", payload: { accountId: ACCOUNT_A, clientMutationId: "reconcile-00000001", session: "London", pnl: 40 } };
    const optimistic = applyMutationToJournal({ trades: [], goalTrades: [] }, create);
    expect(Number((optimistic.trades as any[])[0].id)).toBeLessThan(0);

    const reconciled = reconcileCanonicalTrade(optimistic, "reconcile-00000001", { id: 808, session: "London", pnl: "40.00", hasScreenshot: false });

    expect(reconciled.trades).toHaveLength(1);
    expect((reconciled.trades as any[])[0]).toMatchObject({ id: 808, pnl: "40.00" });
    expect((reconciled.trades as any[])[0].localPending).toBeUndefined();
  });

  it("never renders a replayed create twice", () => {
    const once = reconcileCanonicalTrade({ trades: [], goalTrades: [] }, "replay-000000001", { id: 909, session: "London" });
    const twice = reconcileCanonicalTrade(once, "replay-000000001", { id: 909, session: "London" });
    expect(twice.trades).toHaveLength(1);
    expect(twice.goalTrades).toHaveLength(1);
  });

  it("does not resurrect a stale duplicate that the server already carries", () => {
    const journal = { trades: [{ id: 42, session: "London" }], goalTrades: [{ id: 42, session: "London" }] };
    const reconciled = reconcileCanonicalTrade(journal, "later-0000000001", { id: 42, session: "London" });
    expect(reconciled.trades).toHaveLength(1);
    expect(reconciled.goalTrades).toHaveLength(1);
  });

  it("keeps a durable snapshot that a reload can read back for the same account only", async () => {
    await saveJournalSnapshot(ACCOUNT_A, { trades: [{ id: 1, session: "London" }] });
    const restored = await readJournalSnapshot(ACCOUNT_A);
    expect(restored?.accountId).toBe(ACCOUNT_A);
    expect(restored?.journal.trades).toHaveLength(1);
    // A different account has no snapshot, so one account's journal can never be
    // served as another's.
    expect(await readJournalSnapshot(ACCOUNT_B)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The runtime hook
 * ------------------------------------------------------------------ */

describe("useLocalJournal runtime", () => {
  const serverPayload = (id = ACCOUNT_A, trades: unknown[] = []) => ({ activeAccount: { id }, trades, goalTrades: trades, cashMovements: [] });

  it("shows a just-saved trade immediately as pending, then keeps it visible after the backend confirms", async () => {
    // A held-back acknowledgement keeps the write observably in flight, which is
    // exactly the window the user is looking at right after pressing Save.
    let acknowledge: () => void = () => undefined;
    const inFlight = new Promise<void>(resolve => {
      acknowledge = resolve;
    });
    const dispatch = vi.fn(async () => {
      await inFlight;
      return { trade: { id: 601, session: "London", pnl: "100.00", hasScreenshot: false } };
    });
    const { result } = renderHook(() =>
      useLocalJournal({ accountId: ACCOUNT_A, subject: SUBJECT, journal: serverPayload(), dispatch })
    );

    await act(async () => {
      await result.current.queueMutation({ kind: "trade.create", payload: trade(20) });
    });
    // Rendered from LOCAL state and labelled pending — the server payload is empty.
    await waitFor(() => expect(result.current.pendingTrades).toHaveLength(1));
    expect(result.current.pendingTrades[0]).toMatchObject({ session: "London", localPending: true });
    expect((result.current.reconciled as any).trades).toHaveLength(1);
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    // Once acknowledged the trade leaves the queue, but the canonical record
    // still renders, so it cannot blink out before the refetch lands.
    await act(async () => {
      acknowledge();
    });
    await waitFor(() => expect(result.current.pendingTrades).toHaveLength(0));
    await waitFor(() => expect((result.current.reconciled as any).trades).toHaveLength(1));
    expect((result.current.reconciled as any).trades[0]).toMatchObject({ id: 601 });
    await waitFor(() => expect(result.current.syncState).toBe("synced"));
  });

  it("reports a failed backend write instead of claiming success, and keeps the trade queued", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("Supabase is unavailable");
    });
    const { result } = renderHook(() =>
      useLocalJournal({ accountId: ACCOUNT_A, subject: SUBJECT, journal: serverPayload(), dispatch })
    );

    await act(async () => {
      await result.current.queueMutation({ kind: "trade.create", payload: trade(21) });
    });

    await waitFor(() => expect(result.current.syncState).toBe("failed"));
    expect(result.current.pendingCount).toBe(1);
    // Local data is preserved for the user while the sync is broken.
    await waitFor(() => expect(result.current.pendingTrades).toHaveLength(1));
    expect(result.current.pendingTrades[0].localPending).toBe(true);
    const [queued] = await pendingJournalMutations(SUBJECT, ACCOUNT_A);
    expect(queued.attempts).toBeGreaterThan(0);
    expect(queued.nextAttemptAt).toBeGreaterThan(0);
  });

  it("keeps a queued trade out of a different account's view", async () => {
    // A failing backend keeps the write queued, so the account scoping of the
    // durable queue is what is actually under test.
    const dispatch = vi.fn(async () => {
      throw new Error("Supabase is unavailable");
    });
    const { result, rerender } = renderHook(
      (props: { accountId: number; journal: Record<string, unknown> }) =>
        useLocalJournal({ accountId: props.accountId, subject: SUBJECT, journal: props.journal, dispatch }),
      { initialProps: { accountId: ACCOUNT_A, journal: serverPayload(ACCOUNT_A) } }
    );

    await act(async () => {
      await result.current.queueMutation({ kind: "trade.create", payload: trade(22, ACCOUNT_A) });
    });
    await waitFor(() => expect(result.current.pendingCount).toBe(1));
    expect(result.current.pendingTrades).toHaveLength(1);

    rerender({ accountId: ACCOUNT_B, journal: serverPayload(ACCOUNT_B) });
    await waitFor(() => expect(result.current.pendingTrades).toHaveLength(0));
    // No optimistic row, and no durable snapshot, leaks into the other account's
    // view. (`pendingCount` stays 1 on purpose: it counts the identity's
    // outstanding work across accounts so the sync badge remains truthful.)
    expect(result.current.pendingCount).toBe(1);
    expect(result.current.localSnapshot).toBeNull();
    // The other account's queued work is still there, waiting for its own view.
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_B)).toHaveLength(0);
  });

  it("does not carry another identity's queued writes across a sign-out", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("Supabase is unavailable");
    });
    const { result, rerender } = renderHook(
      (props: { subject: string }) => useLocalJournal({ accountId: ACCOUNT_A, subject: props.subject, journal: serverPayload(), dispatch }),
      { initialProps: { subject: SUBJECT } }
    );

    await act(async () => {
      await result.current.queueMutation({ kind: "trade.create", payload: trade(23) });
    });
    await waitFor(() => expect(result.current.pendingCount).toBe(1));

    rerender({ subject: "user-beta" });
    await waitFor(() => expect(result.current.pendingCount).toBe(0));
    expect(result.current.pendingTrades).toHaveLength(0);
    // The signed-out identity's work is preserved for that identity, never
    // handed to the next one.
    expect(await pendingJournalMutations(SUBJECT, ACCOUNT_A)).toHaveLength(1);
  });

  it("restores still-unsynced work on an offline cold start instead of an empty log", async () => {
    // First session: the backend is down, so the create stays queued while the
    // hook mirrors this account's journal into durable storage.
    const failing = vi.fn(async () => {
      throw new Error("Supabase is unavailable");
    });
    const first = renderHook(() =>
      useLocalJournal({ accountId: ACCOUNT_A, subject: SUBJECT, journal: serverPayload(), dispatch: failing })
    );
    await act(async () => {
      await first.result.current.queueMutation({ kind: "trade.create", payload: trade(24) });
    });
    await waitFor(() => expect(first.result.current.pendingTrades).toHaveLength(1));
    const [queuedRow] = await pendingJournalMutations(SUBJECT, ACCOUNT_A);
    const createdTradeDate = trade(24).tradeDate;

    // A hard reload throws away every in-memory value; only durable local state
    // remains.
    first.unmount();
    await waitFor(async () => expect((await readJournalSnapshot(ACCOUNT_A))?.journal).toBeTruthy());

    const offlineSpy = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      const dispatch = vi.fn(async () => undefined);
      const second = renderHook(() =>
        useLocalJournal({ accountId: ACCOUNT_A, subject: SUBJECT, journal: null, dispatch })
      );

      // The unsynced trade is still shown, from the durable snapshot alone, and
      // the badge admits the work has not reached the backend.
      await waitFor(() => expect(second.result.current.pendingTrades).toHaveLength(1));
      expect(second.result.current.pendingTrades[0]).toMatchObject({ localPending: true, tradeDate: createdTradeDate });
      await waitFor(() => expect(second.result.current.syncState).toBe("offline"));
      expect(dispatch).not.toHaveBeenCalled();

      // It is still queued for exactly one future delivery.
      const stillQueued = await pendingJournalMutations(SUBJECT, ACCOUNT_A);
      expect(stillQueued).toHaveLength(1);
      expect(stillQueued[0].id).toBe(queuedRow.id);
      expect(await queuedJournalMutationCount(SUBJECT)).toBe(1);
    } finally {
      offlineSpy.mockRestore();
    }
  });
});
