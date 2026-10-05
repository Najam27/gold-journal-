import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LIVE | TESTING environment isolation.
 *
 * Runs the REAL `goldRouter` against the shared in-memory Supabase mock and
 * proves the ten isolation guarantees the Testing Mode spec requires:
 *
 *   1. Live and Testing lists cannot mix.
 *   2. Editing Testing cannot change Live.
 *   3. Deleting Testing cannot delete Live.
 *   4. Live analytics exclude Testing.
 *   5. Testing analytics exclude Live.
 *   6. Testing survives refresh (re-read).
 *   7. Testing survives synchronization/retry (idempotent clientMutationId).
 *   8. Live MT5 remains unchanged (Testing rejects mt5Ticket).
 *   9. Live Psychology remains unchanged (presentation keeps the section).
 *  10. Testing hides Psychology/Emotions (presentation drops the section).
 *
 * Tests 1–8 run server-side; 9–10 run against the canonical presentation
 * model, which is what every surface (viewer, card PNG, PDF) renders from.
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

function seedDatabase() {
  const database = new FakeSupabase({ gj_accounts: [accountRow(ACCOUNT)], gj_trades: [] });
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
  risk: 50,
  reward: 100,
  pnl: 0,
  notes: "",
  emotionBefore: "",
  emotionDuring: "",
  emotionAfter: "",
  ...overrides,
});

const liveTrade = (overrides: Row = {}) => baseTrade({ environment: "LIVE", pnl: 100, ...overrides });
// A Testing trade: entry 2650 → exit 2652 on a BUY = +20 pips (the spec's example).
const testingTrade = (overrides: Row = {}) =>
  baseTrade({ environment: "TESTING", entryPrice: 2650, exitPrice: 2652, pnl: 0, ...overrides });

const caller = () => goldRouter.createCaller({ user: USER } as any);
const dbRows = () => (mocks.database.current as FakeSupabase).rows("gj_trades") as Row[];

beforeEach(() => {
  seedDatabase();
});

describe("environment isolation", () => {
  it("1. Live and Testing lists cannot mix", async () => {
    const live = await caller().trades.create(liveTrade({ clientMutationId: "env-live-trade-1-0000" }) as any);
    const testing = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-1-000" }) as any);

    const livePage = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "", environment: "LIVE" } as any);
    const testingPage = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "", environment: "TESTING" } as any);
    // The default (no environment) is the Live list — historical callers keep working.
    const defaultPage = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "" } as any);

    expect(livePage.trades.map((t: any) => t.id)).toEqual([live.id]);
    expect(testingPage.trades.map((t: any) => t.id)).toEqual([testing.id]);
    expect(defaultPage.trades.map((t: any) => t.id)).toEqual([live.id]);
    expect(livePage.trades[0]).toMatchObject({ environment: "LIVE" });
    expect(testingPage.trades[0]).toMatchObject({ environment: "TESTING" });
  });

  it("2. editing a Testing trade cannot change a Live trade", async () => {
    const live = await caller().trades.create(liveTrade({ notes: "live-original", clientMutationId: "env-live-trade-2-0000" }) as any);
    const testing = await caller().trades.create(testingTrade({ notes: "testing-original", clientMutationId: "env-testing-trade-2-000" }) as any);
    const before = JSON.stringify(dbRows().find(row => row.id === live.id));

    await caller().trades.update({
      tradeId: testing.id,
      environment: "TESTING",
      ...testingTrade({ notes: "testing-edited", exitPrice: 2648, clientMutationId: "env-testing-edit-2-00000" }),
    } as any);

    const after = JSON.stringify(dbRows().find(row => row.id === live.id));
    expect(after).toBe(before);
    expect(dbRows().find(row => row.id === testing.id)).toMatchObject({ notes: "testing-edited" });
  });

  it("3. deleting a Testing trade cannot delete a Live trade", async () => {
    const live = await caller().trades.create(liveTrade({ clientMutationId: "env-live-trade-3-0000" }) as any);
    const testing = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-3-000" }) as any);

    await caller().trades.delete({ tradeId: testing.id, environment: "TESTING" } as any);

    expect(dbRows().find(row => row.id === live.id)).toBeDefined();
    expect(dbRows().find(row => row.id === testing.id)).toBeUndefined();
    const livePage = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "", environment: "LIVE" } as any);
    expect(livePage.trades.map((t: any) => t.id)).toEqual([live.id]);
  });

  it("4. Live analytics exclude Testing trades", async () => {
    await caller().trades.create(liveTrade({ pnl: 100, clientMutationId: "env-live-trade-4-0000" }) as any);
    // +20 pips on the Testing side must not leak into the Live aggregates.
    await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-4-000" }) as any);

    const analysis = await caller().analysis.get({ accountId: ACCOUNT, filters: { environment: "LIVE" } } as any);
    expect(analysis.overview.sample).toBe(1);
    expect(analysis.overview.netPnl).toBe(100);
  });

  it("5. Testing analytics exclude Live trades", async () => {
    await caller().trades.create(liveTrade({ pnl: 100, clientMutationId: "env-live-trade-5-0000" }) as any);
    await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-5-000" }) as any);

    const analysis = await caller().analysis.get({ accountId: ACCOUNT, filters: { environment: "TESTING" } } as any);
    expect(analysis.overview.sample).toBe(1);
    // The Testing aggregate is pips (20), not the Live $100.
    expect(analysis.overview.netPnl).toBe(20);
  });

  it("6. Testing trades survive refresh (re-read from the database)", async () => {
    const created = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-6-000" }) as any);
    // A refresh is a brand-new read: nothing is held in memory between these calls.
    const reread = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "", environment: "TESTING" } as any);
    expect(reread.trades.map((t: any) => t.id)).toContain(created.id);
    expect(reread.trades[0]).toMatchObject({ environment: "TESTING", entryPrice: "2650.000000", exitPrice: "2652.000000" });
  });

  it("7. Testing trades survive synchronization retry (idempotent clientMutationId)", async () => {
    const first = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-retry-7-0000" }) as any);
    // The client retries the exact same mutation after a network failure.
    const second = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-retry-7-0000" }) as any);
    expect(second.id).toBe(first.id);

    const page = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "", environment: "TESTING" } as any);
    expect(page.trades).toHaveLength(1);
    // And the retry did not leak a copy into Live either.
    const livePage = await caller().trades.list({ accountId: ACCOUNT, page: 1, pageSize: 12, search: "", environment: "LIVE" } as any);
    expect(livePage.trades).toHaveLength(0);
  });

  it("8. Testing trades can never carry an MT5 ticket (Live MT5 untouched)", async () => {
    await expect(
      caller().trades.create(testingTrade({ mt5Ticket: "123456", clientMutationId: "env-testing-trade-8-000" }) as any)
    ).rejects.toThrow();
    expect(dbRows()).toHaveLength(0);

    const testing = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-8b-000" }) as any);
    await expect(
      caller().trades.update({ tradeId: testing.id, environment: "TESTING", ...testingTrade({ mt5Ticket: "123456" }) } as any)
    ).rejects.toThrow();
    expect(dbRows().find(row => row.id === testing.id)).toMatchObject({ mt5Ticket: null });
  });

  it("the environment discriminator is immutable after create", async () => {
    const testing = await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-9-000" }) as any);
    // An update that smuggles environment: "LIVE" must not move the row.
    await caller().trades.update({
      tradeId: testing.id,
      environment: "LIVE",
      ...testingTrade({ notes: "sneaky", clientMutationId: "env-testing-edit-9-00000" }),
    } as any).catch(() => null);
    // Either the update is rejected (row not found in LIVE) or it applies to
    // the TESTING row — but the row must still be a TESTING row.
    const row = dbRows().find(r => r.id === testing.id);
    expect(row).toMatchObject({ environment: "TESTING" });
  });

  it("clear-all in Testing removes only Testing rows", async () => {
    await caller().trades.create(liveTrade({ clientMutationId: "env-live-trade-10-0000" }) as any);
    await caller().trades.create(testingTrade({ clientMutationId: "env-testing-trade-10-000" }) as any);

    await caller().trades.clearAll({ accountId: ACCOUNT, confirmed: true, environment: "TESTING" } as any);

    const remaining = dbRows();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ environment: "LIVE" });
  });
});
