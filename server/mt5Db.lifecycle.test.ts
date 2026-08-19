import { beforeEach, describe, expect, it, vi } from "vitest";
import { mt5Connections, mt5LivePositions, trades } from "../drizzle/schema";

const store = vi.hoisted(() => ({
  positions: new Map<string, any>(),
  journal: new Map<string, any>(),
  atomicCalls: 0,
  db: null as any,
}));

vi.mock("./db", () => ({ getDb: async () => store.db }));
vi.mock("./atomicOperations", () => ({ syncMt5PositionAtomic: async (_userId: number, accountId: number, position: any) => {
  store.atomicCalls += 1;
  const positionKey = key(accountId, BigInt(position.ticket));
  const existing = store.positions.get(positionKey);
  if (existing?.status === "CLOSED") return false;
  store.positions.set(positionKey, { ...(existing ?? {}), status: position.status, realizedPnl: position.realizedPnl, openTime: new Date(position.openTime), closeTime: position.closeTime ? new Date(position.closeTime) : null });
  store.journal.set(positionKey, { ...(store.journal.get(positionKey) ?? { notes: "" }), result: position.result, pnl: position.pnl });
  return true;
} }));

import { isMt5PositionAfterJournalReset, upsertMt5ClosedPosition, upsertMt5OpenPosition } from "./mt5Db";

const key = (accountId: number, ticket: bigint) => `${accountId}:${ticket}`;
const open = (ticket = 1001n) => ({ ticket, symbol: "XAUUSD", direction: "BUY" as const, lots: 0.01, openPrice: 3200, slPrice: 3190, tpPrice: 3220, riskUsd: 10, rewardUsd: 20, rrRatio: 2, floatingPnl: 1, openTime: new Date("2026-08-17T08:00:00Z") });
const close = (ticket = 1001n) => ({ ...open(ticket), closePrice: 3210, realizedPnl: 10, result: "WIN" as const, closeTime: new Date("2026-08-17T09:00:00Z") });

function installFakeDatabase() {
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => {
      const position = [...store.positions.values()][0];
      return position ? [{ status: position.status, openTime: position.openTime }] : [];
    } }) }) }),
    insert: (table: unknown) => ({ values: (record: any) => ({ onDuplicateKeyUpdate: async ({ set }: any) => {
      const target = table === mt5LivePositions ? store.positions : store.journal;
      const targetKey = key(record.accountId, record.ticket ?? record.mt5Ticket);
      target.set(targetKey, { ...(target.get(targetKey) ?? record), ...set });
    } }) }),
  };
  store.db = {
    select: (columns: any) => ({ from: (table: unknown) => ({ where: () => ({ limit: async () => table === mt5Connections ? [{ journalDataResetAt: null }] : [] }) }) }),
  };
}

describe("MT5 position lifecycle", () => {
  beforeEach(() => {
    store.positions.clear();
    store.journal.clear();
    store.atomicCalls = 0;
    installFakeDatabase();
  });

  it("finalizes one OPEN record to CLOSED, preserves manual journal context, and ignores delayed OPEN retries", async () => {
    await upsertMt5OpenPosition(7, 12, open());
    const journal = store.journal.get(key(12, 1001n));
    expect(journal).toMatchObject({ result: "OPEN", pnl: "1.00" });
    journal.notes = "Trader context remains private and unchanged";

    await upsertMt5OpenPosition(7, 12, { ...open(), floatingPnl: 4.5 });
    expect(store.journal).toHaveLength(1);
    expect(store.journal.get(key(12, 1001n))).toMatchObject({ result: "OPEN", pnl: "4.50" });

    await upsertMt5ClosedPosition(7, 12, close());
    await upsertMt5OpenPosition(7, 12, { ...open(), floatingPnl: 99 });

    expect(store.positions).toHaveLength(1);
    expect(store.positions.get(key(12, 1001n))).toMatchObject({ status: "CLOSED", realizedPnl: "10.00", openTime: open().openTime });
    expect(store.journal.get(key(12, 1001n))).toMatchObject({ result: "WIN", pnl: "10.00", notes: "Trader context remains private and unchanged" });
    expect(store.atomicCalls).toBe(4);
  });

  it("treats repeated closes as idempotent without altering the finalized journal result", async () => {
    await upsertMt5OpenPosition(7, 12, open(1001n));
    await upsertMt5ClosedPosition(7, 12, close(1001n));
    await upsertMt5ClosedPosition(7, 12, { ...close(1001n), realizedPnl: 999 });

    expect(store.positions).toHaveLength(1);
    expect(store.positions.get(key(12, 1001n))).toMatchObject({ status: "CLOSED", realizedPnl: "10.00" });
    expect(store.journal).toHaveLength(1);
  });

  it("keeps the same MT5 ticket independent across separate journal accounts", async () => {
    await upsertMt5OpenPosition(7, 12, open(1001n));
    await upsertMt5OpenPosition(7, 13, open(1001n));

    expect(store.positions).toHaveLength(2);
    expect(store.journal).toHaveLength(2);
    expect(store.journal.get(key(12, 1001n))).toMatchObject({ result: "OPEN", pnl: "1.00" });
    expect(store.journal.get(key(13, 1001n))).toMatchObject({ result: "OPEN", pnl: "1.00" });
  });

  it("ignores pre-reset position events while retaining a terminal close that occurs after a clear", () => {
    const resetAt = new Date("2026-08-17T12:00:00.000Z");
    expect(isMt5PositionAfterJournalReset(resetAt, { status: "OPEN", openTime: new Date("2026-08-17T11:59:00.000Z") })).toBe(false);
    expect(isMt5PositionAfterJournalReset(resetAt, { status: "CLOSED", openTime: new Date("2026-08-17T11:00:00.000Z"), closeTime: new Date("2026-08-17T12:01:00.000Z") })).toBe(true);
  });
});
