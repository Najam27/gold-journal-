import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getActive: vi.fn(), touch: vi.fn(), open: vi.fn(), close: vi.fn(), summary: vi.fn(), completeHistory: vi.fn(), historyAttempt: vi.fn(), historyAccepted: vi.fn(), historyFailure: vi.fn() }));
vi.mock("./mt5Db", () => ({ getActiveMt5Connection: mocks.getActive, touchMt5Connection: mocks.touch, upsertMt5OpenPosition: mocks.open, upsertMt5ClosedPosition: mocks.close, updateMt5AccountSummary: mocks.summary, completeMt5HistorySync: mocks.completeHistory, recordMt5HistoryAttempt: mocks.historyAttempt, recordMt5HistoryAccepted: mocks.historyAccepted, recordMt5HistoryFailure: mocks.historyFailure }));

import { mt5RateLimitTestHooks, processMt5Payload } from "./mt5Ingest";

const key = (suffix: string) => `mt5_live_key_${suffix.padEnd(32, "x")}`;
const openPayload = (api_key = key("open")) => ({ event: "open" as const, api_key, ticket: "123456789", symbol: "XAUUSD", direction: "Buy", lots: 0.01, open_price: 3285.5, sl_price: 3275, tp_price: 3310, risk_usd: 45, reward_usd: 200, rr_ratio: 4.44, floating_pnl: 12.5, open_time: "2026-07-11 09:30:00" });

describe("MT5 EA ingest", () => {
  beforeEach(() => {
    mt5RateLimitTestHooks.reset();
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.getActive.mockResolvedValue({ id: 44, userId: 77, accountId: 12, active: true });
    mocks.touch.mockResolvedValue(undefined);
    mocks.open.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.summary.mockResolvedValue(undefined);
    mocks.completeHistory.mockResolvedValue(undefined);
    mocks.historyAttempt.mockResolvedValue(undefined);
    mocks.historyAccepted.mockResolvedValue(undefined);
    mocks.historyFailure.mockResolvedValue(undefined);
  });

  it("authorizes by active API key, touches the connection, and upserts an open position under its account", async () => {
    await expect(processMt5Payload(openPayload())).resolves.toMatchObject({ status: 200, body: { ok: true, event: "open", compatible: false } });
    expect(mocks.getActive).toHaveBeenCalledWith(key("open"));
    expect(mocks.touch).toHaveBeenCalledWith(44);
    expect(mocks.open).toHaveBeenCalledWith(77, 12, expect.objectContaining({ ticket: 123456789n, direction: "BUY", floatingPnl: 12.5, symbol: "XAUUSD" }));
  });

  it("treats timezone-less MQL5 broker timestamps as UTC+3 for live and historical positions", async () => {
    await expect(processMt5Payload(openPayload(key("mql-date")))).resolves.toMatchObject({ status: 200, body: { ok: true, event: "open", compatible: false } });
    expect(mocks.open).toHaveBeenCalledWith(77, 12, expect.objectContaining({ openTime: new Date("2026-07-11T06:30:00Z") }));
  });

  it("preserves an explicit UTC+3 broker timestamp so journal sync can classify the corresponding PKT session", async () => {
    await expect(processMt5Payload({ ...openPayload(key("broker-utc3")), open_time: "2026.07.11 09:30:00+03:00" })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "open", compatible: false } });
    expect(mocks.open).toHaveBeenCalledWith(77, 12, expect.objectContaining({ openTime: new Date("2026-07-11T06:30:00Z") }));
  });

  it("uses the authenticated connection broker offset for offset-free MQL timestamps", async () => {
    mocks.getActive.mockResolvedValue({ id: 44, userId: 77, accountId: 12, active: true, brokerUtcOffsetMinutes: 120 });
    await expect(processMt5Payload(openPayload(key("broker-utc2")))).resolves.toMatchObject({ status: 200, body: { ok: true, event: "open", compatible: false } });
    expect(mocks.open).toHaveBeenCalledWith(77, 12, expect.objectContaining({ openTime: new Date("2026-07-11T07:30:00Z") }));
  });

  it("rejects only a genuinely future normalized MT5 timestamp", async () => {
    await expect(processMt5Payload({ ...openPayload(key("future")), open_time: "2099-07-11 09:30:00" })).resolves.toMatchObject({ status: 422, body: { ok: false, code: "FUTURE_TRADE", diagnostic: expect.stringContaining("future") } });
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("rejects an unknown API key without touching a connection or writing a position", async () => {
    mocks.getActive.mockResolvedValue(null);
    await expect(processMt5Payload(openPayload(key("unknown")))).resolves.toEqual({ status: 401, body: { ok: false, code: "UNAUTHORIZED" } });
    expect(mocks.touch).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("stores a close event as a closed position with realized P&L and a normalized result", async () => {
    const { floating_pnl, open_time, ...base } = openPayload(key("close"));
    await expect(processMt5Payload({ ...base, event: "close", close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00", open_time })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "close", compatible: false } });
    expect(mocks.close).toHaveBeenCalledWith(77, 12, expect.objectContaining({ ticket: 123456789n, result: "WIN", realizedPnl: 168, closePrice: 3308 }));
  });

  it("stores MT5 account balance, equity, margin, and floating P&L only after resolving the API key", async () => {
    await expect(processMt5Payload({ event: "summary", api_key: key("summary"), mt5_login: "90123456", broker_server: "Broker-Live", currency: "USD", balance: 10000, equity: 10042.5, margin: 250, free_margin: 9792.5, floating_pnl: 42.5 })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "summary", compatible: false } });
    expect(mocks.summary).toHaveBeenCalledWith(44, expect.objectContaining({ mt5Login: 90123456n, balance: 10000, equity: 10042.5, floatingPnl: 42.5, brokerServer: "Broker-Live" }));
  });

  it("upserts a bounded historical closed-trade batch under the resolved account and marks a completed backfill", async () => {
    const { floating_pnl, api_key: _nestedApiKeyMustBeAbsent, ...position } = openPayload(key("history"));
    const closed = { ...position, close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" };
    await expect(processMt5Payload({ event: "history_batch", api_key: key("history"), positions: [closed], complete: true })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "history_batch", synced: 1, complete: true, compatible: false } });
    expect(mocks.close).toHaveBeenCalledWith(77, 12, expect.objectContaining({ ticket: 123456789n, result: "WIN" }));
    expect(mocks.historyAttempt).toHaveBeenCalledWith(44, 1);
    expect(mocks.historyAccepted).toHaveBeenCalledWith(44, 1, true);
    expect(mocks.completeHistory).toHaveBeenCalledWith(44, 12);
  });

  it("persists a history batch sequentially to avoid account-row lock contention", async () => {
    const order: string[] = [];
    mocks.close.mockImplementation(async (_userId: number, _accountId: number, position: { ticket: bigint }) => { order.push(position.ticket.toString()); });
    const first = { ...openPayload(key("history-seq")), ticket: "1001", close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" };
    const second = { ...first, ticket: "1002" };
    await expect(processMt5Payload({ event: "history_batch", api_key: key("history-seq"), positions: [first, second], complete: true })).resolves.toMatchObject({ status: 200, body: { synced: 2 } });
    expect(order).toEqual(["1001", "1002"]);
  });

  it("records a migration-specific history failure when the sync RPC is unavailable", async () => {
    mocks.close.mockRejectedValue(new Error("column openTime does not exist"));
    await expect(processMt5Payload({ event: "history_batch", api_key: key("migration"), positions: [{ ...openPayload(key("migration")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" }], complete: false })).rejects.toThrow("column openTime does not exist");
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("MIGRATION_REQUIRED_0008"));
  });

  it("classifies PostgreSQL syntax errors as migration-specific history failures", async () => {
    mocks.close.mockRejectedValue(Object.assign(new Error("syntax error in gj_sync_mt5_position"), { supabaseCode: "42601" }));
    await expect(processMt5Payload({ event: "history_batch", api_key: key("syntax-provider"), positions: [{ ...openPayload(key("syntax-provider")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" }], complete: false })).rejects.toThrow("syntax error in gj_sync_mt5_position");
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("MIGRATION_REQUIRED_0008"));
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("migration 0010"));
  });

  it("preserves an unknown Supabase provider code in the safe history diagnostic", async () => {
    mocks.close.mockRejectedValue(Object.assign(new Error("provider rejected the write"), { supabaseCode: "XX999" }));
    await expect(processMt5Payload({ event: "history_batch", api_key: key("unknown-provider"), positions: [{ ...openPayload(key("unknown-provider")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" }], complete: false })).rejects.toThrow("provider rejected the write");
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("XX999"));
  });

  it("derives the target account from the authenticated connection even when a payload attempts to supply another account", async () => {
    await expect(processMt5Payload({ ...openPayload(key("spoofed-account")), accountId: 999 })).resolves.toMatchObject({ status: 200 });
    expect(mocks.open).toHaveBeenCalledWith(77, 12, expect.objectContaining({ ticket: 123456789n }));
    expect(mocks.open).not.toHaveBeenCalledWith(77, 999, expect.anything());
  });

  it("keeps identical tickets independent when separate API keys resolve to separate accounts", async () => {
    mocks.getActive.mockImplementation(async (apiKey: string) => apiKey === key("account-b") ? { id: 45, userId: 77, accountId: 13, active: true } : { id: 44, userId: 77, accountId: 12, active: true });
    await processMt5Payload(openPayload(key("account-a")));
    await processMt5Payload(openPayload(key("account-b")));
    expect(mocks.open).toHaveBeenCalledWith(77, 12, expect.objectContaining({ ticket: 123456789n }));
    expect(mocks.open).toHaveBeenCalledWith(77, 13, expect.objectContaining({ ticket: 123456789n }));
  });

  it("persists an open batch sequentially to avoid account-row lock contention", async () => {
    const order: string[] = [];
    mocks.open.mockImplementation(async (_userId: number, _accountId: number, position: { ticket: bigint }) => { order.push(position.ticket.toString()); });
    const first = { ...openPayload(key("open-seq")), ticket: "2001" };
    const second = { ...openPayload(key("open-seq")), ticket: "2002" };
    await expect(processMt5Payload({ event: "open_batch", api_key: key("open-seq"), positions: [first, second], broker_utc_offset_minutes: 180 })).resolves.toMatchObject({ status: 200, body: { event: "open_batch", synced: 2 } });
    expect(order).toEqual(["2001", "2002"]);
  });

  it("limits a single API key to five events per second", async () => {
    const burstKey = key("rate");
    for (let index = 0; index < 5; index += 1) await expect(processMt5Payload({ event: "ping", api_key: burstKey })).resolves.toMatchObject({ status: 200 });
    await expect(processMt5Payload({ event: "ping", api_key: burstKey })).resolves.toEqual({ status: 429, body: { ok: false, code: "RATE_LIMITED" } });
  });

  it("bounds rate-limit memory for large numbers of unknown key fingerprints", async () => {
    for (let index = 0; index < 2_050; index += 1) await processMt5Payload({ event: "ping", api_key: key(`bound-${index}`) });
    expect(mt5RateLimitTestHooks.size()).toBeLessThanOrEqual(2_000);
  });
});
