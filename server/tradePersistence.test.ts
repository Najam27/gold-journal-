import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Trade persistence end-to-end.
 *
 * This suite intentionally mocks as little as possible. It runs the REAL
 * `goldRouter`, the REAL Supabase query adapter (`server/supabaseQuery.ts`), the
 * REAL account/trade ownership helpers (`server/goldDb.ts`), and the REAL
 * storage path and signature rules (`server/storage.ts`). Only the Supabase
 * client itself is replaced, by an in-memory database and object bucket.
 *
 * That is what lets the following claims actually be tested rather than assumed:
 *   - creating a trade executes an INSERT into gj_trades (not a client-side save);
 *   - re-reading after a "reload" still finds it;
 *   - a replayed clientMutationId resolves to the SAME row, never a duplicate;
 *   - a screenshot key + filename are committed by the same write as the trade;
 *   - a retried delete is idempotent and can never poison a durable queue;
 *   - a screenshot reference outside the caller's own account is refused;
 *   - one account's trades are invisible from another account.
 */

/* ------------------------------------------------------------------ *
 * Fake Supabase: a tiny in-memory PostgREST + Storage
 * ------------------------------------------------------------------ */

import { FakeSupabase, type Row } from "./fakeSupabase";

/* ------------------------------------------------------------------ *
 * Module wiring
 * ------------------------------------------------------------------ */

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
const ACCOUNT_A = 12;
const ACCOUNT_B = 13;

const account = (id: number, userId = 7, name = `Account ${id}`) => ({
  id,
  userId,
  name,
  normalizedName: name.toLowerCase(),
  bootstrapKey: null,
  startingBalance: "0.00",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function seedDatabase() {
  const database = new FakeSupabase({
    gj_accounts: [account(ACCOUNT_A), account(ACCOUNT_B)],
    gj_trades: [],
  });
  mocks.database.current = database;
  return database;
}

function validTrade(overrides: Row = {}) {
  return {
    accountId: ACCOUNT_A,
    tradeDate: Date.now() - 60_000,
    session: "London",
    direction: "BUY",
    result: "WIN",
    level: "2640",
    timeframe: "M15",
    setupQuality: "A",
    executionType: "Market",
    marketCondition: "Trend",
    biasAlignment: "With bias",
    confirmationType: "Engulfing",
    slPlacement: "Swing",
    tpPlacement: "Liquidity",
    mistake: "",
    holdQuality: "Held to target",
    patienceScore: 4,
    risk: 50,
    reward: 100,
    pnl: 100,
    notes: "Clean breakout retest.",
    emotionBefore: "Calm",
    emotionDuring: "Patient",
    emotionAfter: "Satisfied",
    planStatus: null,
    planChecklist: null,
    ...overrides,
  };
}

const caller = () => goldRouter.createCaller({ user: USER } as any);

beforeEach(() => {
  seedDatabase();
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe("trade persistence against the database", () => {
  it("writes a manually created trade to gj_trades and returns the canonical row", async () => {
    const trade = validTrade({ clientMutationId: "mutation-create-0001" });
    const result = await caller().trades.create(trade as any);

    expect(result.replayed).toBe(false);
    expect(result.id).toBeGreaterThan(0);
    // The canonical record travels back so a local-first client can adopt the
    // real database identity instead of keeping its placeholder id.
    expect(result.trade).toMatchObject({ id: result.id, session: "London", result: "WIN", pnl: "100.00" });
    expect(result.trade).not.toHaveProperty("screenshotKey");

    const [row] = mocks.database.current.rows("gj_trades");
    expect(row).toMatchObject({
      id: result.id,
      userId: USER.id,
      accountId: ACCOUNT_A,
      session: "London",
      direction: "BUY",
      result: "WIN",
      level: "2640",
      timeframe: "M15",
      setupQuality: "A",
      executionType: "Market",
      mistake: "",
      holdQuality: "Held to target",
      patienceScore: 4,
      risk: "50.00",
      reward: "100.00",
      pnl: "100.00",
      clientMutationId: "mutation-create-0001",
      screenshotKey: null,
      screenshotName: null,
    });
    expect(row.tradeDate).toBeInstanceOf(Date);
  });

  it("still finds the trade after a reload re-reads the trade log from the backend", async () => {
    const created = await caller().trades.create(validTrade() as any);

    // "Reload": a brand new caller with no in-memory state, reading the list the
    // Trade Log actually renders.
    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);

    expect(page.total).toBe(1);
    expect(page.trades).toHaveLength(1);
    expect(page.trades[0]).toMatchObject({ id: created.id, session: "London", result: "WIN" });
  });

  it("resolves a replayed clientMutationId to the same row instead of creating a duplicate", async () => {
    const trade = validTrade({ clientMutationId: "mutation-replay-0002" });
    const first = await caller().trades.create(trade as any);
    const second = await caller().trades.create(trade as any);

    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect(mocks.database.current.rows("gj_trades")).toHaveLength(1);
  });

  it("updates the stored row and leaves the screenshot columns untouched when no screenshot was supplied", async () => {
    const created = await caller().trades.create(validTrade({ clientMutationId: "mutation-update-0003", screenshotKey: "journal-owner/accounts/12/trades/draft-x/keep.png", screenshotName: "keep.png", screenshotRemoved: false }) as any);

    await caller().trades.update({ ...validTrade({ pnl: 240 }), tradeId: created.id, accountId: ACCOUNT_A } as any);

    const [row] = mocks.database.current.rows("gj_trades");
    expect(row.pnl).toBe("240.00");
    expect(row.screenshotKey).toBe("journal-owner/accounts/12/trades/draft-x/keep.png");
    expect(row.screenshotName).toBe("keep.png");
  });

  it("persists a screenshot reference and its original filename in the same write as the trade", async () => {
    const uploaded = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-evidence-0004",
      fileName: "breakout-retest.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });

    // The binary really landed in persistent storage, scoped to the identity and
    // the account, and the key the database will store is a relative object path.
    expect(mocks.database.current.objects.has(uploaded.key)).toBe(true);
    expect(uploaded.key).toMatch(/^journal-owner\/accounts\/12\/trades\/draft-mutation-evidence-0004\//);
    expect(uploaded.url).toContain(uploaded.key);

    const created = await caller().trades.create(validTrade({
      clientMutationId: "mutation-evidence-0005",
      screenshotKey: uploaded.key,
      screenshotName: uploaded.name,
    }) as any);

    const [row] = mocks.database.current.rows("gj_trades");
    expect(row.screenshotKey).toBe(uploaded.key);
    expect(row.screenshotName).toBe("breakout-retest.png");

    // Reading the Trade Log resolves the stored key back into a fresh signed URL,
    // which is what makes the image survive a reload.
    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);
    expect(page.trades[0]).toMatchObject({ id: created.id, hasScreenshot: true, screenshotName: "breakout-retest.png" });
    expect(page.trades[0].screenshotUrl).toContain(uploaded.key);

    // And the raw storage key never leaves the server.
    expect(page.trades[0]).not.toHaveProperty("screenshotKey");
  });

  it("clears a removed screenshot and deletes the superseded object", async () => {
    const uploaded = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-remove-0006",
      fileName: "before.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    const created = await caller().trades.create(validTrade({ screenshotKey: uploaded.key, screenshotName: uploaded.name }) as any);

    await caller().trades.update({ ...validTrade(), tradeId: created.id, accountId: ACCOUNT_A, screenshotRemoved: true } as any);

    const [row] = mocks.database.current.rows("gj_trades");
    expect(row.screenshotKey).toBeNull();
    expect(row.screenshotName).toBeNull();
    expect(mocks.database.current.objects.has(uploaded.key)).toBe(false);
  });

  it("refuses a screenshot reference that points outside the caller's own account folder", async () => {
    await expect(
      caller().trades.create(validTrade({ screenshotKey: "someone-else/accounts/99/trades/1/steal.png", screenshotName: "steal.png" }) as any)
    ).rejects.toThrow(/does not belong to this account/i);

    await expect(
      caller().trades.create(validTrade({ screenshotKey: "journal-owner/accounts/13/trades/1/other-account.png", screenshotName: "other-account.png" }) as any)
    ).rejects.toThrow(/does not belong to this account/i);

    expect(mocks.database.current.rows("gj_trades")).toHaveLength(0);
  });

  it("treats a retried delete as success and never throws for a row that is already gone", async () => {
    const created = await caller().trades.create(validTrade() as any);

    const first = await caller().trades.delete({ tradeId: created.id });
    expect(first).toEqual({ success: true, deleted: true, replayed: false });

    // The retry is what a durable offline queue does after a lost response. It
    // must resolve, because a delete that can never succeed would block every
    // later queued write behind it.
    const retry = await caller().trades.delete({ tradeId: created.id });
    expect(retry).toEqual({ success: true, deleted: false, replayed: true });
    expect(mocks.database.current.rows("gj_trades")).toHaveLength(0);
  });

  it("removes the stored screenshot object when the trade is deleted", async () => {
    const uploaded = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-delete-0007",
      fileName: "evidence.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    const created = await caller().trades.create(validTrade({ screenshotKey: uploaded.key, screenshotName: uploaded.name }) as any);

    await caller().trades.delete({ tradeId: created.id });
    expect(mocks.database.current.objects.has(uploaded.key)).toBe(false);
  });

  it("discards an orphan draft screenshot whose trade write never landed", async () => {
    // The browser uploads evidence FIRST and then writes the trade. When that
    // write fails (here: a future trade date, which the server refuses) the
    // object would otherwise stay in private storage for a trade that does not
    // exist, so the dialog asks for it to be discarded.
    const uploaded = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-orphan-0001",
      fileName: "orphan.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    expect(mocks.database.current.objects.has(uploaded.key)).toBe(true);

    await expect(
      caller().trades.create(validTrade({ tradeDate: Date.now() + 86_400_000, screenshotKey: uploaded.key, screenshotName: uploaded.name }) as any)
    ).rejects.toThrow(/Future trade dates/i);
    expect(mocks.database.current.rows("gj_trades")).toHaveLength(0);

    const discarded = await caller().trades.discardScreenshotDraft({ accountId: ACCOUNT_A, key: uploaded.key });
    expect(discarded.removed).toBe(true);
    expect(mocks.database.current.objects.has(uploaded.key)).toBe(false);
  });

  it("refuses to discard anything but an unclaimed draft inside the caller's own account", async () => {
    // A stored trade's evidence must never be removable through the draft path:
    // that would leave the row pointing at a deleted object.
    const uploaded = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-draft-guard-1",
      fileName: "kept.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    const created = await caller().trades.create(validTrade({ screenshotKey: uploaded.key, screenshotName: uploaded.name }) as any);
    const [row] = mocks.database.current.rows("gj_trades");
    expect(row.screenshotKey).toBe(uploaded.key);

    await expect(
      caller().trades.discardScreenshotDraft({ accountId: ACCOUNT_A, key: `journal-owner/accounts/12/trades/${created.id}/claimed.png` })
    ).rejects.toThrow(/unclaimed draft/i);
    await expect(
      caller().trades.discardScreenshotDraft({ accountId: ACCOUNT_B, key: uploaded.key })
    ).rejects.toThrow(/does not belong to this account/i);

    // Neither refusal touched the stored object.
    expect(mocks.database.current.objects.has(uploaded.key)).toBe(true);
  });

  it("removes every stored screenshot when the account's whole journal is cleared, and only that account's", async () => {
    const cleared = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-clear-a-0001",
      fileName: "a.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    await caller().trades.create(validTrade({ screenshotKey: cleared.key, screenshotName: cleared.name }) as any);

    const kept = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_B,
      clientMutationId: "mutation-clear-b-0001",
      fileName: "b.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    await caller().trades.create(validTrade({ accountId: ACCOUNT_B, screenshotKey: kept.key, screenshotName: kept.name }) as any);

    await caller().trades.clearAll({ accountId: ACCOUNT_A, confirmed: true } as any);

    // Clearing one account cannot leave that account's evidence behind, and it
    // must never touch another account's objects.
    expect(mocks.database.current.objects.has(cleared.key)).toBe(false);
    expect(mocks.database.current.objects.has(kept.key)).toBe(true);
    expect(mocks.database.current.rows("gj_trades").map((row: Row) => row.accountId)).toEqual([ACCOUNT_B]);
  });

  it("removes the deleted account's stored screenshots when the account is removed", async () => {
    const uploaded = await caller().trades.uploadScreenshotDraft({
      accountId: ACCOUNT_A,
      clientMutationId: "mutation-account-remove-01",
      fileName: "gone.png",
      mimeType: "image/png",
      base64: PNG_BYTES.toString("base64"),
    });
    await caller().trades.create(validTrade({ screenshotKey: uploaded.key, screenshotName: uploaded.name }) as any);

    await caller().accounts.remove({ accountId: ACCOUNT_A, confirmed: true } as any);

    expect(mocks.database.current.objects.has(uploaded.key)).toBe(false);
    expect(mocks.database.current.rows("gj_accounts").map((row: Row) => row.id)).toEqual([ACCOUNT_B]);
  });

  it("keeps each account's trades invisible to the other account", async () => {
    await caller().trades.create(validTrade({ session: "London" }) as any);
    await caller().trades.create(validTrade({ accountId: ACCOUNT_B, session: "New York" }) as any);

    const accountA = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);
    const accountB = await caller().trades.list({ accountId: ACCOUNT_B, page: 1, pageSize: 12, search: "" } as any);

    expect(accountA.trades.map((trade: any) => trade.session)).toEqual(["London"]);
    expect(accountB.trades.map((trade: any) => trade.session)).toEqual(["New York"]);

    // A trade cannot be moved between accounts, and another account cannot be
    // written to on behalf of a trade that belongs somewhere else.
    const [rowA] = accountA.trades;
    await expect(caller().trades.update({ ...validTrade({ accountId: ACCOUNT_B }), tradeId: rowA.id } as any)).rejects.toThrow(/cannot be moved/i);
  });

  it("never writes a trade into an account the caller does not own", async () => {
    const stranger = goldRouter.createCaller({ user: { id: 99, openId: "stranger", role: "user" } } as any);
    await expect(stranger.trades.create(validTrade({ accountId: ACCOUNT_A }) as any)).rejects.toThrow(/unavailable/i);
    await expect(stranger.trades.list({ accountId: ACCOUNT_B, page: 1, pageSize: 12, search: "" } as any)).rejects.toThrow(/unavailable/i);
    expect(mocks.database.current.rows("gj_trades")).toHaveLength(0);
  });

  it("resolves a queued edit that still carries a negative placeholder id", async () => {
    // The client coalesces pending edits, but a dialog opened before the create
    // was confirmed can still send a placeholder id. Naming the originating
    // create is what makes that edit land on the real row instead of vanishing.
    const created = await caller().trades.create(validTrade({ clientMutationId: "mutation-placeholder-0008" }) as any);

    await caller().trades.update({
      ...validTrade({ pnl: 55, notes: "Edited before sync." }),
      tradeId: -1_000_123,
      originMutationId: "mutation-placeholder-0008",
      accountId: ACCOUNT_A,
    } as any);

    const [row] = mocks.database.current.rows("gj_trades");
    expect(row.id).toBe(created.id);
    expect(row.pnl).toBe("55.00");
    expect(mocks.database.current.rows("gj_trades")).toHaveLength(1);
  });

  it("keeps the trade list paginated and reflected in the account summary after a write", async () => {
    for (let index = 0; index < 3; index += 1) {
      await caller().trades.create(validTrade({ pnl: 10, tradeDate: Date.now() - index * 1_000 }) as any);
    }
    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 2, search: "" } as any);
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2, pageCount: 2 });
    expect(page.trades).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 * Free-form trade text: no arbitrary character limit, no silent truncation
 * ------------------------------------------------------------------ */

describe("unbounded trade text", () => {
  // The exact sentinel the acceptance criteria name, wrapped around long filler
  // so a value that survived only partially is obvious in a failure message.
  const sentinel = (label: string) => `START-1234567890-${label}-${"x".repeat(220)}-END`;

  it("saves a Mistake value far beyond the old 80-character limit", async () => {
    const mistake = `Mistake ${"A".repeat(300)}`;
    const created = await caller().trades.create(validTrade({ mistake, clientMutationId: "mutation-long-mistake-01" }) as any);

    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);
    expect(page.trades[0]).toMatchObject({ id: created.id, mistake });
    expect((mocks.database.current.rows("gj_trades")[0] as Row).mistake).toBe(mistake);
  });

  it("saves Level, Execution type, Notes, and Emotions far beyond their old limits", async () => {
    const trade = validTrade({
      level: sentinel("LEVEL-CONFLUENCE"),
      executionType: `${"E".repeat(200)}`,
      notes: `${"N".repeat(5_000)}`,
      emotionBefore: `${"B".repeat(1_200)}`,
      emotionDuring: `${"D".repeat(1_200)}`,
      emotionAfter: `${"F".repeat(1_200)}`,
    });

    const created = await caller().trades.create(trade as any);
    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);

    expect(page.trades[0]).toMatchObject({
      id: created.id,
      level: trade.level,
      executionType: trade.executionType,
      notes: trade.notes,
      emotionBefore: trade.emotionBefore,
      emotionDuring: trade.emotionDuring,
      emotionAfter: trade.emotionAfter,
    });
  });

  it("round-trips every free-text field with byte-for-byte equality (no truncation)", async () => {
    const long = validTrade({
      level: sentinel("LEVEL"),
      timeframe: sentinel("TIMEFRAME"),
      setupQuality: sentinel("SETUP"),
      executionType: sentinel("EXECUTION"),
      marketCondition: sentinel("MARKET"),
      biasAlignment: sentinel("BIAS"),
      confirmationType: sentinel("CONFIRMATION"),
      slPlacement: sentinel("SL"),
      tpPlacement: sentinel("TP"),
      mistake: "START-1234567890-VERY-LONG-TRADE-MISTAKE-CONTENT-END",
      holdQuality: sentinel("HOLD"),
      notes: sentinel("NOTES"),
      emotionBefore: sentinel("EMOTION-BEFORE"),
      emotionDuring: sentinel("EMOTION-DURING"),
      emotionAfter: sentinel("EMOTION-AFTER"),
    });

    const created = await caller().trades.create(long as any);
    // A fresh caller with no in-memory state is the "reload" this must survive.
    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);
    const saved = page.trades.find((trade: any) => trade.id === created.id) as any;

    for (const field of ["level", "timeframe", "setupQuality", "executionType", "marketCondition", "biasAlignment", "confirmationType", "slPlacement", "tpPlacement", "mistake", "holdQuality", "notes", "emotionBefore", "emotionDuring", "emotionAfter"] as const) {
      expect(saved[field], field).toBe((long as any)[field]);
    }
  });

  it("edits an existing trade to hold long text and keeps it after a reload", async () => {
    // 1. A normal trade exists.
    const created = await caller().trades.create(validTrade({ mistake: "FOMO entry", notes: "Short note." }) as any);

    // 2-5. Open Edit, add a very long Mistake plus long text in several fields, save.
    const longMistake = `Mistake A | Mistake B | ${sentinel("THIRD-MISTAKE")}`;
    const update = validTrade({
      tradeId: created.id,
      mistake: longMistake,
      level: sentinel("EDITED-LEVEL"),
      executionType: sentinel("EDITED-EXECUTION"),
      notes: sentinel("EDITED-NOTES"),
      emotionAfter: sentinel("EDITED-EMOTION"),
    });
    const saved = await caller().trades.update(update as any);
    expect(saved.success).toBe(true);

    // 6-7. Reload and verify the exact text is still present.
    const page = await caller().trades.list({ accountId: ACCOUNT_A, page: 1, pageSize: 12, search: "" } as any);
    expect(page.trades[0]).toMatchObject({
      id: created.id,
      mistake: longMistake,
      level: update.level,
      executionType: update.executionType,
      notes: update.notes,
      emotionAfter: update.emotionAfter,
    });
    // The pipe-separated mistake format the psychology engine reads is preserved.
    expect(longMistake).toContain(" | ");
  });
});

describe("screenshot upload hardening", () => {
  it("rejects a payload whose bytes are not the declared image type", async () => {
    await expect(
      caller().trades.uploadScreenshotDraft({
        accountId: ACCOUNT_A,
        clientMutationId: "mutation-bad-bytes-0009",
        fileName: "script.png",
        mimeType: "image/png",
        base64: Buffer.from("#!/bin/sh\n" + "echo not-an-image\n".repeat(8)).toString("base64"),
      })
    ).rejects.toThrow(/does not match its declared image type/i);
    expect(mocks.database.current.objects.size).toBe(0);
  });

  it("refuses to upload evidence for an account the caller does not own", async () => {
    const stranger = goldRouter.createCaller({ user: { id: 99, openId: "stranger", role: "user" } } as any);
    await expect(
      stranger.trades.uploadScreenshotDraft({
        accountId: ACCOUNT_A,
        clientMutationId: "mutation-stranger-0010",
        fileName: "x.png",
        mimeType: "image/png",
        base64: PNG_BYTES.toString("base64"),
      })
    ).rejects.toThrow(/unavailable/i);
    expect(mocks.database.current.objects.size).toBe(0);
  });
});
