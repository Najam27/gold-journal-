import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Multi-timeframe Bias + Risk auto-detection.
 *
 * Runs the REAL `goldRouter` against the shared in-memory Supabase mock:
 *
 * Bias:
 *  1. All five timeframe values persist on create and survive a re-read.
 *  2. Direction stays independent from bias (BUY + Bear D1 is valid).
 *  3. Legacy biasAlignment is preserved, never reinterpreted.
 *  4. Partial bias (some null) persists; empty bias stores null.
 *
 * Risk:
 *  5. MT5 journaling auto-fills entry/SL/TP + risk/reward from the position row.
 *  6. MT5 MAE/MFE are stored as positive magnitudes ($250 / $180, never -$180).
 *  7. Editing an unrelated field preserves auto-detected values (no null wipe).
 *  8. SL on the wrong side of entry is rejected (BUY and SELL).
 *  9. Manual trades keep manual values; missing data stays null (never faked).
 */

import { FakeSupabase, type Row } from "./fakeSupabase";

const mocks = vi.hoisted(() => ({ database: { current: null as any } }));

vi.mock("./supabaseAdmin", () => ({
  getSupabaseAdmin: () => mocks.database.current,
  supabaseDataSourceReference: () => "gjsup-test",
}));
vi.mock("./db", async () => {
  const { supabaseDb } = await import("./supabaseQuery");
  return { getDb: async () => supabaseDb };
});
vi.mock("./rateLimit", () => ({ consumeRateLimit: async () => true }));

import { goldRouter } from "./goldRouter";

const USER = { id: 7, openId: "journal-owner", role: "user" } as any;
const ACCOUNT = 12;

const accountRow = (id: number) => ({
  id,
  userId: 7,
  name: `Account ${id}`,
  normalizedName: `account ${id}`,
  bootstrapKey: null,
  startingBalance: "1000.00",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const mt5PositionRow = (overrides: Row = {}) => ({
  id: 501,
  accountId: ACCOUNT,
  ticket: 987654321n,
  status: "CLOSED",
  openPrice: "2650.500000",
  slPrice: "2640.000000",
  tpPrice: "2670.000000",
  riskUsd: "120.00",
  rewardUsd: "240.00",
  mfeUsd: "250.00",
  maeUsd: "-180.00",
  lots: "1.00",
  ...overrides,
});

function seedDatabase(withPosition = false) {
  const seed: Record<string, Row[]> = {
    gj_accounts: [accountRow(ACCOUNT)],
    gj_trades: [],
  };
  if (withPosition) seed["gj_mt5_live_positions"] = [mt5PositionRow()];
  const database = new FakeSupabase(seed);
  mocks.database.current = database;
  return database;
}

const baseTrade = (overrides: Row = {}) => ({
  accountId: ACCOUNT,
  tradeDate: Date.now() - 60_000,
  session: "London",
  direction: "BUY",
  result: "WIN",
  level: "",
  timeframe: "",
  setupQuality: "",
  executionType: "",
  marketCondition: "",
  biasAlignment: "",
  biasTimeframes: null,
  confirmationType: "",
  slPlacement: "",
  tpPlacement: "",
  mistake: "",
  holdQuality: "",
  patienceScore: null,
  planFollowScore: null,
  planStatus: null,
  planChecklist: null,
  quickLogged: false,
  entryPrice: null,
  slPrice: null,
  tpPrice: null,
  exitPrice: null,
  mfe: null,
  mae: null,
  risk: null,
  reward: null,
  pnl: 0,
  notes: "",
  emotionBefore: "",
  emotionDuring: "",
  emotionAfter: "",
  environment: "LIVE",
  ...overrides,
});

const caller = () => goldRouter.createCaller({ user: USER } as any);
const dbRows = () => (mocks.database.current as FakeSupabase).rows("gj_trades") as Row[];

beforeEach(() => {
  seedDatabase();
});

describe("multi-timeframe bias", () => {
  it("1. persists all five timeframe values and survives a re-read", async () => {
    const bias = { D1: "Bull", H4: "Bear", H1: "Bull", M15: "Bear", M5: "Bull" };
    const created = await caller().trades.create(
      baseTrade({ biasTimeframes: bias, clientMutationId: "bias-full-0001-xxxx" }) as any
    );
    const stored = dbRows().find(row => row.id === created.id)!;
    expect(stored.biasTimeframes).toEqual(bias);

    const page = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "" } as any);
    expect((page.trades[0] as any).biasTimeframes).toEqual(bias);
  });

  it("2. direction stays independent from bias", async () => {
    const created = await caller().trades.create(
      baseTrade({
        direction: "BUY",
        biasTimeframes: { D1: "Bear", H4: "Bull", H1: "Bull", M15: "Bear", M5: "Bull" },
        clientMutationId: "bias-direction-0002xx",
      }) as any
    );
    const stored = dbRows().find(row => row.id === created.id)!;
    expect(stored.direction).toBe("BUY");
    expect(stored.biasTimeframes).toEqual({ D1: "Bear", H4: "Bull", H1: "Bull", M15: "Bear", M5: "Bull" });
  });

  it("3. legacy biasAlignment is preserved, never reinterpreted", async () => {
    const created = await caller().trades.create(
      baseTrade({ biasAlignment: "Counter-trend", clientMutationId: "bias-legacy-0003-xxx" }) as any
    );
    const stored = dbRows().find(row => row.id === created.id)!;
    expect(stored.biasAlignment).toBe("Counter-trend");
    // The legacy string does not become per-timeframe bias.
    expect(stored.biasTimeframes).toBe(null);
  });

  it("4. partial bias persists; empty bias stores null", async () => {
    const partial = await caller().trades.create(
      baseTrade({
        biasTimeframes: { D1: "Bull", H4: null, H1: null, M15: null, M5: "Bear" },
        clientMutationId: "bias-partial-0004-xxx",
      }) as any
    );
    expect(dbRows().find(row => row.id === partial.id)!.biasTimeframes).toEqual({
      D1: "Bull",
      H4: null,
      H1: null,
      M15: null,
      M5: "Bear",
    });

    const empty = await caller().trades.create(
      baseTrade({ biasTimeframes: null, clientMutationId: "bias-empty-0005-xxxx" }) as any
    );
    expect(dbRows().find(row => row.id === empty.id)!.biasTimeframes).toBe(null);
  });
});

describe("risk auto-detection", () => {
  it("5. MT5 journaling auto-fills entry/SL/TP and risk/reward from the position", async () => {
    seedDatabase(true);
    const created = await caller().trades.create(
      baseTrade({ mt5Ticket: "987654321", clientMutationId: "risk-mt5-auto-0006xx" }) as any
    );
    const stored = dbRows().find(row => row.id === created.id)!;
    expect(Number(stored.entryPrice)).toBeCloseTo(2650.5, 4);
    expect(Number(stored.slPrice)).toBeCloseTo(2640, 4);
    expect(Number(stored.tpPrice)).toBeCloseTo(2670, 4);
    expect(Number(stored.risk)).toBeCloseTo(120, 2);
    expect(Number(stored.reward)).toBeCloseTo(240, 2);
  });

  it("6. MT5 MAE/MFE are stored as positive magnitudes, separate from P&L", async () => {
    seedDatabase(true);
    const created = await caller().trades.create(
      baseTrade({ mt5Ticket: "987654321", pnl: 100, clientMutationId: "risk-mt5-mag-0007xxx" }) as any
    );
    const stored = dbRows().find(row => row.id === created.id)!;
    // MFE 250, MAE 180, P&L 100: three independent numbers, magnitudes positive.
    expect(Number(stored.mfe)).toBeCloseTo(250, 2);
    expect(Number(stored.mae)).toBeCloseTo(180, 2);
    expect(Number(stored.pnl)).toBeCloseTo(100, 2);
    expect(Number(stored.mae)).toBeGreaterThanOrEqual(0);
  });

  it("7. editing an unrelated field preserves auto-detected values", async () => {
    seedDatabase(true);
    const created = await caller().trades.create(
      baseTrade({ mt5Ticket: "987654321", clientMutationId: "risk-mt5-edit-0008yyxx" }) as any
    );
    const before = dbRows().find(row => row.id === created.id)!;
    expect(Number(before.mae)).toBeCloseTo(180, 2);

    // Edit only the notes, sending nulls for the auto fields (as the client
    // does for blank inputs) — the stored auto-detected values must survive.
    await caller().trades.update({
      tradeId: created.id,
      ...baseTrade({
        notes: "edited notes",
        entryPrice: null,
        slPrice: null,
        tpPrice: null,
        mfe: null,
        mae: null,
        risk: null,
        reward: null,
        clientMutationId: "risk-mt5-edit-0008yy",
      }),
    } as any);

    const after = dbRows().find(row => row.id === created.id)!;
    expect(after.notes).toBe("edited notes");
    expect(Number(after.entryPrice)).toBeCloseTo(2650.5, 4);
    expect(Number(after.mfe)).toBeCloseTo(250, 2);
    expect(Number(after.mae)).toBeCloseTo(180, 2);
    expect(Number(after.risk)).toBeCloseTo(120, 2);
  });

  it("8. SL/TP on the wrong side of entry are rejected", async () => {
    // BUY with SL above entry.
    await expect(
      caller().trades.create(
        baseTrade({ direction: "BUY", entryPrice: 100, slPrice: 105, tpPrice: 110, clientMutationId: "risk-bad-side-0009xx" }) as any
      )
    ).rejects.toThrow(/wrong side/i);
    // SELL with TP above entry.
    await expect(
      caller().trades.create(
        baseTrade({ direction: "SELL", entryPrice: 100, slPrice: 105, tpPrice: 110, clientMutationId: "risk-bad-side-0010xx" }) as any
      )
    ).rejects.toThrow(/wrong side/i);
    // Valid SELL passes.
    const ok = await caller().trades.create(
      baseTrade({ direction: "SELL", entryPrice: 100, slPrice: 105, tpPrice: 90, clientMutationId: "risk-ok-side-0011xxx" }) as any
    );
    expect(ok.id).toBeGreaterThan(0);
  });

  it("9. manual trades keep manual values; missing data stays null, never faked", async () => {
    const created = await caller().trades.create(
      baseTrade({
        entryPrice: 2650,
        slPrice: 2640,
        tpPrice: 2670,
        risk: 50,
        clientMutationId: "risk-manual-0012-xxx",
      }) as any
    );
    const stored = dbRows().find(row => row.id === created.id)!;
    expect(Number(stored.entryPrice)).toBeCloseTo(2650, 4);
    expect(Number(stored.risk)).toBeCloseTo(50, 2);
    // Reward/MAE/MFE were never provided and no MT5 source exists: null, not 0.
    expect(stored.reward).toBe(null);
    expect(stored.mae).toBe(null);
    expect(stored.mfe).toBe(null);
  });
});
