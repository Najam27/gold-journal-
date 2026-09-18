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

type Row = Record<string, any>;
type Filter =
  | { kind: "eq" | "like" | "gte" | "gt" | "lt"; column: string; value: unknown }
  | { kind: "and" | "or"; parts: Filter[] };

const asComparable = (value: unknown): number | string =>
  value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? value : Date.parse(String(value));

function matches(row: Row, filter: Filter | null | undefined): boolean {
  if (!filter) return true;
  if (filter.kind === "and") return filter.parts.every(part => matches(row, part));
  if (filter.kind === "or") return filter.parts.some(part => matches(row, part));
  const actual = row[filter.column];
  if (filter.kind === "eq") {
    if (filter.value === null) return actual === null || actual === undefined;
    return String(actual) === String(filter.value);
  }
  if (filter.kind === "like") {
    const needle = String(filter.value).replaceAll("%", "").toLowerCase();
    return String(actual ?? "").toLowerCase().includes(needle);
  }
  const left = asComparable(actual);
  const right = asComparable(filter.value);
  if (filter.kind === "gte") return left >= right;
  if (filter.kind === "gt") return left > right;
  return left < right;
}

/** Parses the `column.op.value,...` clause that `applyFilter` renders for `or()`. */
function parseCondition(clause: string): Filter {
  const [column, op, ...rest] = clause.split(".");
  const value = rest.join(".");
  if (op === "eq") return { kind: "eq", column, value: value === "null" ? null : value };
  if (op === "ilike") return { kind: "like", column, value };
  if (op === "gte") return { kind: "gte", column, value };
  if (op === "gt") return { kind: "gt", column, value };
  if (op === "lt") return { kind: "lt", column, value };
  return { kind: "eq", column, value };
}

function parseOrClause(clause: string): Filter {
  const parts: Filter[] = [];
  let current = "";
  for (let index = 0; index < clause.length; index += 1) {
    const char = clause[index];
    if (char === "\\") {
      current += clause[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (char === ",") {
      parts.push(parseCondition(current));
      current = "";
      continue;
    }
    current += char;
  }
  if (current) parts.push(parseCondition(current));
  return { kind: "or", parts };
}

class FakeQuery {
  private action: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row | Row[] | null = null;
  private conflictTargets: string[] = [];
  private ignoreDuplicates = false;
  private filter: Filter | null = null;
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private take?: number;
  private skip = 0;
  private returning = false;
  private wantCount = false;

  constructor(private readonly db: FakeSupabase, private readonly name: string) {}

  select(_columns?: string, options?: { count?: string }) {
    if (this.action === "select") this.wantCount = Boolean(options?.count);
    else this.returning = true;
    return this;
  }
  insert(values: Row | Row[]) {
    this.action = "insert";
    this.payload = values;
    return this;
  }
  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.action = "upsert";
    this.payload = values;
    this.conflictTargets = String(options?.onConflict ?? "").split(",").filter(Boolean);
    this.ignoreDuplicates = Boolean(options?.ignoreDuplicates);
    return this;
  }
  update(values: Row) {
    this.action = "update";
    this.payload = values;
    return this;
  }
  delete() {
    this.action = "delete";
    return this;
  }
  eq(column: string, value: unknown) { return this.and({ kind: "eq", column, value }); }
  is(column: string, value: unknown) { return this.and({ kind: "eq", column, value }); }
  ilike(column: string, value: string) { return this.and({ kind: "like", column, value }); }
  gte(column: string, value: unknown) { return this.and({ kind: "gte", column, value }); }
  gt(column: string, value: unknown) { return this.and({ kind: "gt", column, value }); }
  lt(column: string, value: unknown) { return this.and({ kind: "lt", column, value }); }
  or(clause: string) { return this.and(parseOrClause(clause)); }
  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.skip = from;
    this.take = to - from + 1;
    return this;
  }

  private and(filter: Filter) {
    this.filter = this.filter ? { kind: "and", parts: [this.filter, filter] } : filter;
    return this;
  }

  private run(): { data: Row[] | null; error: { message: string; code?: string } | null; count: number | null } {
    const rows = this.db.table(this.name);
    if (this.action === "insert" || this.action === "upsert") {
      const values = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      const written: Row[] = [];
      for (const value of values) {
        const existing =
          this.action === "upsert" && this.conflictTargets.length
            ? rows.find(row => this.conflictTargets.every(column => String(row[column]) === String((value as Row)[column])))
            : undefined;
        if (existing) {
          if (!this.ignoreDuplicates) Object.assign(existing, value);
          written.push(existing);
          continue;
        }
        const inserted: Row = { ...value, id: (value as Row).id ?? this.db.nextId() };
        rows.push(inserted);
        written.push(inserted);
      }
      return { data: this.returning ? written : null, error: null, count: null };
    }
    const matched = rows.filter(row => matches(row, this.filter));
    if (this.action === "update") {
      for (const row of matched) Object.assign(row, this.payload as Row);
      // PostgREST hands back fresh row snapshots, never live references, so a
      // caller that reads a row before an update must not observe the update.
      return { data: matched.map(row => ({ ...row })), error: null, count: null };
    }
    if (this.action === "delete") {
      for (const row of matched) rows.splice(rows.indexOf(row), 1);
      return { data: matched, error: null, count: null };
    }
    const ordered = [...matched].sort((left, right) => {
      for (const order of this.orders) {
        const a = asComparable(left[order.column]);
        const b = asComparable(right[order.column]);
        if (a === b) continue;
        const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
        return order.ascending ? comparison : -comparison;
      }
      return 0;
    });
    const page = this.take === undefined ? ordered.slice(this.skip) : ordered.slice(this.skip, this.skip + this.take);
    return { data: page.map(row => ({ ...row })), error: null, count: this.wantCount ? matched.length : null };
  }

  then(onFulfilled?: any, onRejected?: any) {
    return Promise.resolve(this.run()).then(onFulfilled, onRejected);
  }
}

class FakeSupabase {
  private readonly tables = new Map<string, Row[]>();
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();
  private sequence = 1_000;

  constructor(seed: Record<string, Row[]>) {
    for (const [name, rows] of Object.entries(seed)) this.tables.set(name, rows.map(row => ({ ...row })));
  }

  table(name: string) {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }
  rows(name: string) { return this.table(name); }
  nextId() { this.sequence += 1; return this.sequence; }

  from(name: string) { return new FakeQuery(this, name); }

  rpc(name: string, args: Row = {}) {
    if (name === "gj_account_cash_net") return Promise.resolve({ data: 0, error: null });
    if (name === "gj_account_trade_summary") {
      const trades = this.table("gj_trades");
      const pnl = trades.reduce((total, row) => total + Number(row.pnl ?? 0), 0);
      const wins = trades.filter(row => row.result === "WIN").length;
      const losses = trades.filter(row => row.result === "LOSS").length;
      return Promise.resolve({ data: [{ total_trades: trades.length, closed_trades: trades.length, win_trades: wins, loss_trades: losses, pnl }], error: null });
    }
    // Account-scoped destructive transactions, modelled closely enough to prove
    // that the account-wide paths delete exactly one account's rows.
    if (name === "gj_clear_account_journal_data") {
      const owned = (row: Row) => Number(row.userId) === Number(args.target_user_id) && Number(row.accountId) === Number(args.target_account_id);
      const trades = this.table("gj_trades");
      trades.splice(0, trades.length, ...trades.filter(row => !owned(row)));
      return Promise.resolve({ data: true, error: null });
    }
    if (name === "gj_remove_account") {
      const owned = (row: Row) => Number(row.userId) === Number(args.target_user_id) && Number(row.accountId) === Number(args.target_account_id);
      const accounts = this.table("gj_accounts");
      const index = accounts.findIndex(row => Number(row.id) === Number(args.target_account_id) && Number(row.userId) === Number(args.target_user_id));
      if (index >= 0) accounts.splice(index, 1);
      const trades = this.table("gj_trades");
      trades.splice(0, trades.length, ...trades.filter(row => !owned(row)));
      const replacement = accounts.find(row => Number(row.userId) === Number(args.target_user_id));
      return Promise.resolve({ data: [{ replacement_account_id: replacement?.id ?? null }], error: null });
    }
    return Promise.resolve({ data: null, error: null });
  }

  storage = {
    from: () => ({
      upload: (key: string, bytes: Buffer, options: { contentType: string }) => {
        if (this.objects.has(key)) return Promise.resolve({ data: null, error: { message: "The resource already exists" } });
        this.objects.set(key, { bytes: Buffer.from(bytes), contentType: options.contentType });
        return Promise.resolve({ data: { path: key }, error: null });
      },
      remove: (keys: string[]) => {
        for (const key of keys) this.objects.delete(key);
        return Promise.resolve({ data: null, error: null });
      },
      createSignedUrl: (key: string, expiresIn: number) =>
        this.objects.has(key)
          ? Promise.resolve({ data: { signedUrl: `https://signed.test/${key}?expires=${expiresIn}` }, error: null })
          : Promise.resolve({ data: null, error: { message: "Object not found" } }),
    }),
  };
}

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
