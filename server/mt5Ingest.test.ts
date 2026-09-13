import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getActive: vi.fn(), touch: vi.fn(), open: vi.fn(), openBatch: vi.fn(), close: vi.fn(), closeBatch: vi.fn(), summary: vi.fn(), eventSuccess: vi.fn(), eventFailure: vi.fn(), completeHistory: vi.fn(), historyAttempt: vi.fn(), historyAccepted: vi.fn(), historyFailure: vi.fn(), historyRejections: vi.fn(), openTickets: vi.fn(), findRevoked: vi.fn(), authFailure: vi.fn() }));
vi.mock("./mt5Db", () => ({ getActiveMt5Connection: mocks.getActive, touchMt5Connection: mocks.touch, upsertMt5OpenPosition: mocks.open, upsertMt5OpenPositionBatch: mocks.openBatch, upsertMt5ClosedPosition: mocks.close, upsertMt5ClosedPositionBatch: mocks.closeBatch, updateMt5AccountSummary: mocks.summary, recordMt5EventSuccess: mocks.eventSuccess, recordMt5EventFailure: mocks.eventFailure, completeMt5HistorySync: mocks.completeHistory, recordMt5HistoryAttempt: mocks.historyAttempt, recordMt5HistoryAccepted: mocks.historyAccepted, recordMt5HistoryFailure: mocks.historyFailure, recordMt5HistoryRejections: mocks.historyRejections, getMt5OpenTickets: mocks.openTickets, findRevokedMt5Connection: mocks.findRevoked, recordMt5AuthFailure: mocks.authFailure }));

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
    mocks.openBatch.mockImplementation(async (_userId: number, _accountId: number, positions: unknown[]) => positions.length);
    mocks.close.mockResolvedValue(undefined);
    mocks.closeBatch.mockResolvedValue(0);
    mocks.summary.mockResolvedValue(undefined);
    mocks.eventSuccess.mockResolvedValue(undefined);
    mocks.eventFailure.mockResolvedValue(undefined);
    mocks.completeHistory.mockResolvedValue(undefined);
    mocks.historyAttempt.mockResolvedValue(undefined);
    mocks.historyAccepted.mockResolvedValue(undefined);
    mocks.historyFailure.mockResolvedValue(undefined);
    mocks.historyRejections.mockResolvedValue(undefined);
    mocks.openTickets.mockResolvedValue({ tickets: [], count: 0, truncated: false });
    mocks.findRevoked.mockResolvedValue(null);
    mocks.authFailure.mockResolvedValue(undefined);
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

  it("accepts an authenticated legacy payload with a stale optional connection ID because the API key alone defines the owned connection", async () => {
    await expect(processMt5Payload({ event: "ping", api_key: key("legacy-id"), connection_id: "retired-connection-id", ea_version: "2.4.0", payload_version: "2" })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "ping" } });
    expect(mocks.getActive).toHaveBeenCalledWith(key("legacy-id"));
    expect(mocks.touch).toHaveBeenCalledWith(44);
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

  it("forwards complete broker symbol constraints only through the authenticated account summary", async () => {
    await expect(processMt5Payload({ event: "summary", api_key: key("risk-spec"), mt5_login: "90123456", broker_server: "Broker-Live", currency: "USD", balance: 10000, equity: 10042.5, margin: 250, free_margin: 9792.5, floating_pnl: 42.5, risk_symbol: "XAUUSDm", risk_tick_size: 0.1, risk_tick_value_loss: 10, risk_contract_size: 100, risk_volume_min: 0.01, risk_volume_max: 50, risk_volume_step: 0.01 })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "summary" } });
    expect(mocks.summary).toHaveBeenCalledWith(44, expect.objectContaining({ riskSymbol: "XAUUSDm", riskTickSize: 0.1, riskTickValueLoss: 10, riskContractSize: 100, riskVolumeMin: 0.01, riskVolumeMax: 50, riskVolumeStep: 0.01 }));
  });

  it("upserts a bounded historical closed-trade batch under the resolved account and marks a completed backfill", async () => {
    const { floating_pnl, api_key: _nestedApiKeyMustBeAbsent, ...position } = openPayload(key("history"));
    const closed = { ...position, close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" };
    await expect(processMt5Payload({ event: "history_batch", api_key: key("history"), positions: [closed], complete: true })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "history_batch", synced: 1, complete: true, compatible: false } });
    expect(mocks.closeBatch).toHaveBeenCalledWith(77, 12, [expect.objectContaining({ ticket: 123456789n, result: "WIN" })]);
    expect(mocks.historyAttempt).toHaveBeenCalledWith(44, 1);
    expect(mocks.historyAccepted).toHaveBeenCalledWith(44, 1, true);
    expect(mocks.completeHistory).toHaveBeenCalledWith(44, 12);
  });

  it("persists a history batch in one account-scoped atomic operation", async () => {
    const first = { ...openPayload(key("history-seq")), ticket: "1001", close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" };
    const second = { ...first, ticket: "1002" };
    await expect(processMt5Payload({ event: "history_batch", api_key: key("history-seq"), positions: [first, second], complete: true })).resolves.toMatchObject({ status: 200, body: { synced: 2 } });
    expect(mocks.closeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.closeBatch).toHaveBeenCalledWith(77, 12, [expect.objectContaining({ ticket: 1001n }), expect.objectContaining({ ticket: 1002n })]);
  });

  it("records a migration-specific history failure when the sync RPC is unavailable", async () => {
    mocks.closeBatch.mockRejectedValue(new Error("column openTime does not exist"));
    await expect(processMt5Payload({ event: "history_batch", api_key: key("migration"), positions: [{ ...openPayload(key("migration")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" }], complete: false })).rejects.toThrow("column openTime does not exist");
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("MIGRATION_REQUIRED_0008"));
  });

  it("classifies PostgreSQL syntax errors as migration-specific history failures", async () => {
    mocks.closeBatch.mockRejectedValue(Object.assign(new Error("syntax error in gj_sync_mt5_position"), { supabaseCode: "42601" }));
    await expect(processMt5Payload({ event: "history_batch", api_key: key("syntax-provider"), positions: [{ ...openPayload(key("syntax-provider")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" }], complete: false })).rejects.toThrow("syntax error in gj_sync_mt5_position");
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("MIGRATION_REQUIRED_0008"));
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("migration 0016"));
  });

  it("preserves an unknown Supabase provider code in the safe history diagnostic", async () => {
    mocks.closeBatch.mockRejectedValue(Object.assign(new Error("provider rejected the write"), { supabaseCode: "XX999" }));
    await expect(processMt5Payload({ event: "history_batch", api_key: key("unknown-provider"), positions: [{ ...openPayload(key("unknown-provider")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" }], complete: false })).rejects.toThrow("provider rejected the write");
    expect(mocks.historyFailure).toHaveBeenCalledWith(44, expect.stringContaining("XX999"));
  });

  it("records a transient summary persistence failure without deleting or deactivating the authenticated connection", async () => {
    mocks.summary.mockRejectedValue(Object.assign(new Error("database request timed out"), { supabaseCode: "57014" }));
    await expect(processMt5Payload({ event: "summary", api_key: key("summary-timeout"), mt5_login: "90123456", broker_server: "Broker-Live", currency: "USD", balance: 10000, equity: 10042.5, margin: 250, free_margin: 9792.5, floating_pnl: 42.5 })).rejects.toThrow("database request timed out");
    expect(mocks.eventFailure).toHaveBeenCalledWith(44, "summary", "DATABASE_RETRYABLE", expect.stringContaining("temporarily unavailable"));
    expect(mocks.getActive).toHaveBeenCalledWith(key("summary-timeout"));
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

  it("persists an open batch in one account-scoped atomic operation to avoid repeated account-row locks", async () => {
    const first = { ...openPayload(key("open-seq")), ticket: "2001" };
    const second = { ...openPayload(key("open-seq")), ticket: "2002" };
    await expect(processMt5Payload({ event: "open_batch", api_key: key("open-seq"), positions: [first, second], broker_utc_offset_minutes: 180 })).resolves.toMatchObject({ status: 200, body: { event: "open_batch", synced: 2 } });
    expect(mocks.openBatch).toHaveBeenCalledTimes(1);
    expect(mocks.openBatch).toHaveBeenCalledWith(77, 12, [expect.objectContaining({ ticket: 2001n }), expect.objectContaining({ ticket: 2002n })]);
    expect(mocks.eventSuccess).toHaveBeenCalledWith(44, "open_batch");
  });

  it("quarantines one malformed history record instead of rejecting the whole batch forever", async () => {
    const good = { ...openPayload(key("quarantine")), ticket: "3001", close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" };
    // ticket 3002 is poisoned: an impossible broker date would previously fail
    // the entire batch, so the EA retried the same 50 records forever.
    const poisoned = { ...good, ticket: "3002", close_time: "2026-02-31 11:45:00" };
    const outcome = await processMt5Payload({ event: "history_batch", api_key: key("quarantine"), positions: [good, poisoned], complete: false });
    expect(outcome).toMatchObject({ status: 200, body: { ok: true, event: "history_batch", synced: 1, accepted: 1, rejected: 1, complete: false } });
    expect((outcome.body as { failed: Array<{ ticket: string; code: string; retryable: boolean }> }).failed).toEqual([{ ticket: "3002", code: "INVALID_MT5_TIMESTAMP", retryable: false }]);
    expect(mocks.closeBatch).toHaveBeenCalledTimes(1);
    expect(mocks.closeBatch).toHaveBeenCalledWith(77, 12, [expect.objectContaining({ ticket: 3001n })]);
    expect(mocks.historyRejections).toHaveBeenCalledWith(44, [{ ticket: "3002", code: "INVALID_MT5_TIMESTAMP", retryable: false }]);
    // The batch was accepted, so the EA advances its cursor past the poison record.
    expect(mocks.historyAccepted).toHaveBeenCalledWith(44, 1, false);
  });

  it("quarantines a structurally invalid historical record and reports the ticket", async () => {
    const good = { ...openPayload(key("structure")), ticket: "4001", close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-07-11 11:45:00" };
    const malformed = { ticket: "4002", symbol: "", direction: "SIDEWAYS", lots: Number.NaN, open_price: "nope" };
    const outcome = await processMt5Payload({ event: "history_batch", api_key: key("structure"), positions: [good, malformed], complete: true });
    expect(outcome).toMatchObject({ status: 200, body: { accepted: 1, rejected: 1 } });
    expect((outcome.body as { failed: Array<{ ticket: string; code: string }> }).failed[0]).toMatchObject({ ticket: "4002", code: "PAYLOAD_INVALID" });
    expect(mocks.closeBatch).toHaveBeenCalledWith(77, 12, [expect.objectContaining({ ticket: 4001n })]);
  });

  it("fails the batch only when every historical record is unusable", async () => {
    const poisoned = { ...openPayload(key("all-poison")), close_price: 3308, realized_pnl: 168, result: "Win", close_time: "2026-13-45 11:45:00" };
    await expect(processMt5Payload({ event: "history_batch", api_key: key("all-poison"), positions: [poisoned], complete: false })).resolves.toMatchObject({ status: 422, body: { ok: false, code: "SYNC_PARTIAL", rejected: 1 } });
    expect(mocks.closeBatch).not.toHaveBeenCalled();
  });

  it("keeps one bad open position from blocking the remaining live positions", async () => {
    const good = { ...openPayload(key("open-quarantine")), ticket: "5001" };
    const bad = { ...good, ticket: "5002", lots: "not-a-number" };
    const outcome = await processMt5Payload({ event: "open_batch", api_key: key("open-quarantine"), positions: [bad, good], broker_utc_offset_minutes: 180 });
    expect(outcome).toMatchObject({ status: 200, body: { event: "open_batch", accepted: 1, rejected: 1 } });
    expect(mocks.openBatch).toHaveBeenCalledWith(77, 12, [expect.objectContaining({ ticket: 5001n })]);
    expect(mocks.eventSuccess).toHaveBeenCalledWith(44, "open_batch");
  });

  it("rejects an oversized open batch with an actionable code instead of an opaque validation error", async () => {
    const positions = Array.from({ length: 201 }, (_, index) => ({ ...openPayload(key("oversized")), ticket: String(6000 + index) }));
    await expect(processMt5Payload({ event: "open_batch", api_key: key("oversized"), positions, broker_utc_offset_minutes: 180 })).resolves.toMatchObject({ status: 400, body: { ok: false, code: "BATCH_TOO_LARGE", maxPositionsPerBatch: 200 } });
    expect(mocks.openBatch).not.toHaveBeenCalled();
    expect(mocks.eventFailure).toHaveBeenCalledWith(44, "open_batch", "BATCH_TOO_LARGE", expect.stringContaining("at most 200"));
  });

  it("rejects an uninterpretable payload version explicitly so the EA can tell the trader to update", async () => {
    const outcome = await processMt5Payload({ event: "open_batch", api_key: key("future-payload"), positions: [], broker_utc_offset_minutes: 180, ea_version: "9.0.0", payload_version: "3" });
    expect(outcome).toMatchObject({ status: 400, body: { ok: false, code: "UNSUPPORTED_VERSION", supportedPayloadVersion: "2" } });
    expect((outcome.body as { diagnostic: string }).diagnostic).toContain("payload version 3");
    expect(mocks.openBatch).not.toHaveBeenCalled();
    expect(mocks.eventFailure).toHaveBeenCalledWith(44, "open_batch", "UNSUPPORTED_VERSION", expect.stringContaining("payload version 3"));
  });

  it("still answers compat and ping for an uninterpretable payload version so the EA can report the mismatch", async () => {
    await expect(processMt5Payload({ event: "compat", api_key: key("compat-future"), ea_version: "9.0.0", payload_version: "3" })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "compat", compatible: false, supportedPayloadVersion: "2" } });
    await expect(processMt5Payload({ event: "ping", api_key: key("ping-future"), ea_version: "9.0.0", payload_version: "3" })).resolves.toMatchObject({ status: 200, body: { ok: true, event: "ping" } });
  });

  it("publishes the server's open tickets with each heartbeat so the EA can reconcile missed closes", async () => {
    mocks.openTickets.mockResolvedValue({ tickets: ["7001", "7002"], count: 2, truncated: false });
    const outcome = await processMt5Payload({ event: "ping", api_key: key("open-feed") });
    expect(outcome).toMatchObject({ status: 200, body: { ok: true, event: "ping", openTicketFormat: "csv", openTickets: "7001,7002", openTicketCount: 2, openTicketsTruncated: false } });
    expect(mocks.openTickets).toHaveBeenCalledWith(12);
  });

  it("omits the reconciliation feed instead of claiming an empty account when the lookup fails", async () => {
    mocks.openTickets.mockRejectedValue(new Error("database request timed out"));
    const outcome = await processMt5Payload({ event: "ping", api_key: key("open-feed-failure") });
    expect(outcome).toMatchObject({ status: 200, body: { ok: true, event: "ping" } });
    expect(outcome.body).not.toHaveProperty("openTicketFormat");
    expect(outcome.body).not.toHaveProperty("openTickets");
  });

  it("attributes a rotated or retired key to its connection so the UI can say the key was rejected", async () => {
    mocks.getActive.mockResolvedValue(null);
    mocks.findRevoked.mockResolvedValue({ id: 91, previousApiKeyHash: null, active: false, retiredAt: new Date("2026-08-01T00:00:00Z") });
    await expect(processMt5Payload({ event: "ping", api_key: key("retired") })).resolves.toEqual({ status: 401, body: { ok: false, code: "UNAUTHORIZED" } });
    expect(mocks.authFailure).toHaveBeenCalledWith(91, "AUTH_REVOKED", expect.stringContaining("retired MT5 connection"));
  });

  it("still returns a plain 401 when a rejected key belongs to no known connection", async () => {
    mocks.getActive.mockResolvedValue(null);
    mocks.findRevoked.mockResolvedValue(null);
    await expect(processMt5Payload({ event: "ping", api_key: key("unknown-2") })).resolves.toEqual({ status: 401, body: { ok: false, code: "UNAUTHORIZED" } });
    expect(mocks.authFailure).not.toHaveBeenCalled();
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
