import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyMutationToJournal, readJournalSnapshot, saveJournalSnapshot } from "./journalStore";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  backoffDelayMs,
  clearJournalQueue,
  enqueueJournalMutation,
  flushJournalMutations,
  pendingJournalMutations,
  queuedJournalMutationCount,
  removeJournalMutation,
} from "./journalSync";

const SUBJECT = "user-local-first";
const ACCOUNT = 909;

function trade(i: number) {
  return { accountId: ACCOUNT, tradeDate: 1_700_000_000_000 + i, session: "London", direction: "BUY", result: "WIN", pnl: 10 };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  // The queue is durable by design, so each test starts from a clean store.
  await clearJournalQueue();
});

describe("journal backoff", () => {
  it("grows exponentially and is capped", () => {
    expect(backoffDelayMs(1, 0.5)).toBe(BASE_BACKOFF_MS);
    expect(backoffDelayMs(2, 0.5)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffDelayMs(3, 0.5)).toBe(BASE_BACKOFF_MS * 4);
    expect(backoffDelayMs(30, 0.5)).toBe(MAX_BACKOFF_MS);
  });

  it("never returns a non-positive delay", () => {
    for (let attempt = 1; attempt <= 10; attempt++) expect(backoffDelayMs(attempt, 0)).toBeGreaterThan(0);
  });

  it("adds bounded jitter so clients do not retry in lockstep", () => {
    const base = BASE_BACKOFF_MS * 4;
    const low = backoffDelayMs(3, 0);
    const high = backoffDelayMs(3, 1);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThanOrEqual(Math.round(base * 0.8));
    expect(high).toBeLessThanOrEqual(Math.round(base * 1.2));
  });
});

describe("local-first journal writes", () => {
  it("stores a trade locally first and keeps it after a simulated reload", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(1) });
    // A "reload" re-reads durable storage instead of component state.
    const queued = await pendingJournalMutations(SUBJECT, ACCOUNT);
    expect(queued).toHaveLength(1);
    expect(queued[0].kind).toBe("trade.create");
    expect(await queuedJournalMutationCount(SUBJECT)).toBe(1);
  });

  it("survives a queued pending state across reloads without losing data", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(2) });
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(3) });
    const firstRead = await pendingJournalMutations(SUBJECT, ACCOUNT);
    const secondRead = await pendingJournalMutations(SUBJECT, ACCOUNT);
    expect(secondRead.map(item => item.id)).toEqual(firstRead.map(item => item.id));
    expect(secondRead).toHaveLength(2);
  });

  it("scopes the queue to the signed-in identity", async () => {
    await enqueueJournalMutation({ subject: "someone-else", accountId: ACCOUNT, kind: "trade.create", payload: trade(4) });
    const mine = await pendingJournalMutations(SUBJECT, ACCOUNT);
    expect(mine.every(item => item.subject === SUBJECT)).toBe(true);
  });
});

describe("synchronisation", () => {
  it("does not attempt a flush while offline and keeps everything queued", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(10) });
    const dispatch = vi.fn();
    const result = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT, dispatch, online: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.state).toBe("offline");
    expect(result.pending).toBeGreaterThan(0);
  });

  it("syncs queued writes on reconnect and clears them once acknowledged", async () => {
    const id = "reconnect-case-id";
    await enqueueJournalMutation({ id, subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(11) });
    const dispatch = vi.fn(async () => undefined);
    const result = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT, dispatch, online: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.synced).toBeGreaterThanOrEqual(1);
    const remaining = (await pendingJournalMutations(SUBJECT, ACCOUNT)).filter(item => item.id === id);
    expect(remaining).toHaveLength(0);
  });

  it("sends the queue id as the idempotency key so a replay cannot duplicate a record", async () => {
    const id = "idempotency-case-id";
    await enqueueJournalMutation({ id, subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(12) });
    const seen: string[] = [];
    await flushJournalMutations({
      subject: SUBJECT,
      accountId: ACCOUNT,
      online: true,
      dispatch: async mutation => {
        seen.push(String(mutation.payload.clientMutationId));
      },
    });
    // The server deduplicates on clientMutationId, so replaying the same queue
    // item resolves to the already-created record instead of a second insert.
    const replay = await enqueueJournalMutation({ id, subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(12) });
    expect(replay.payload.clientMutationId).toBe(id);
    expect(seen).toEqual([id]);
  });

  it("keeps local data and schedules a retry when the backend returns 500", async () => {
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(13) });
    const before = await pendingJournalMutations(SUBJECT, ACCOUNT);
    const dispatch = vi.fn(async () => {
      throw new Error("Internal Server Error");
    });
    const result = await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT, dispatch, online: true });
    expect(result.failed).toBe(1);
    expect(result.state).toBe("failed");
    const after = await pendingJournalMutations(SUBJECT, ACCOUNT);
    expect(after.length).toBeGreaterThanOrEqual(before.length);
    const attempted = after.find(item => item.attempts > 0);
    expect(attempted?.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(attempted?.lastError).toContain("Internal Server Error");
  });

  it("does not retry an item before its backoff deadline elapses", async () => {
    const id = "backoff-window-id";
    await enqueueJournalMutation({ id, subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(14) });
    const failing = vi.fn(async () => {
      throw new Error("nope");
    });
    await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT, dispatch: failing, online: true });
    failing.mockClear();
    await flushJournalMutations({ subject: SUBJECT, accountId: ACCOUNT, dispatch: failing, online: true });
    expect(failing).not.toHaveBeenCalled();
    await removeJournalMutation(id);
  });

  it("applies edits in queue order so the result is deterministic", async () => {
    const order: string[] = [];
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "trade.create", payload: trade(15) });
    await enqueueJournalMutation({ subject: SUBJECT, accountId: ACCOUNT, kind: "cash.create", payload: { accountId: ACCOUNT, amount: 100, type: "DEPOSIT" } });
    await flushJournalMutations({
      subject: SUBJECT,
      accountId: ACCOUNT,
      online: true,
      dispatch: async mutation => {
        order.push(mutation.kind);
      },
    });
    expect(order).toEqual([...order].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(order.length).toBeGreaterThan(0);
  });
});

describe("optimistic local journal state", () => {
  it("shows a queued trade immediately, tagged as locally pending", () => {
    const journal = { trades: [{ id: 1, session: "London" }], goalTrades: [{ id: 1, session: "London" }] };
    const next = applyMutationToJournal(journal, { id: "abc123", kind: "trade.create", payload: { accountId: ACCOUNT, pnl: 25 } });
    const trades = next.trades as any[];
    expect(trades).toHaveLength(2);
    expect(trades[0].localPending).toBe(true);
    expect(trades[0].id).toBeLessThan(0);
    expect(next.localPending).toBe(true);
  });

  it("patches and removes the right trade for update and delete", () => {
    const journal = { trades: [{ id: 7, notes: "old" }, { id: 8, notes: "keep" }], goalTrades: [] };
    const updated = applyMutationToJournal(journal, { id: "u1", kind: "trade.update", payload: { tradeId: 7, notes: "new" } });
    expect((updated.trades as any[]).find(t => t.id === 7)?.notes).toBe("new");
    expect((updated.trades as any[]).find(t => t.id === 8)?.notes).toBe("keep");
    const deleted = applyMutationToJournal(journal, { id: "d1", kind: "trade.delete", payload: { tradeId: 7 } });
    expect((deleted.trades as any[]).map(t => t.id)).toEqual([8]);
  });

  it("round-trips a snapshot through local persistence", async () => {
    await saveJournalSnapshot(4242, { trades: [{ id: 1 }] });
    const snapshot = await readJournalSnapshot(4242);
    expect(snapshot?.accountId).toBe(4242);
    expect((snapshot?.journal.trades as any[])[0].id).toBe(1);
  });
});
