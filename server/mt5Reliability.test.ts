import { classifyMt5SyncHealth } from "./mt5Reliability";
import { describe, expect, it } from "vitest";

describe("MT5 sync health", () => {
  it("classifies fresh terminal contact and a current successful snapshot as connected", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth(
      {
        active: true,
        lastPing: new Date(now - 5_000),
        lastContactAt: new Date(now - 5_000),
        lastSummarySuccessAt: new Date(now - 4_000),
        lastHistoryAttempt: new Date(now - 60_000),
        lastHistorySync: new Date(now - 30_000),
        lastHistoryStatus: "COMPLETED",
        lastHistoryMessage: null,
        historySyncedCount: 42,
      },
      now
    );
    expect(result.state).toBe("CONNECTED");
    expect(result.historyState).toBe("COMPLETE");
    expect(result.message).toContain("snapshot");
  });
  it("reports stale contact and a failed history safely", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth(
      {
        active: true,
        lastPing: new Date(now - 61_000),
        lastHistoryAttempt: new Date(now - 5_000),
        lastHistorySync: null,
        lastHistoryStatus: "FAILED",
        lastHistoryMessage: "Invalid payload",
        historySyncedCount: 0,
      },
      now
    );
    expect(result.state).toBe("STALE");
    expect(result.historyState).toBe("FAILED");
    expect(result.message).toBe("Invalid payload");
  });
  it("reports a connected terminal with an unsaved or failed snapshot as degraded", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth(
      {
        active: true,
        lastPing: new Date(now - 3_000),
        lastContactAt: new Date(now - 3_000),
        lastSummarySuccessAt: new Date(now - 20_000),
        lastSummaryErrorAt: new Date(now - 2_000),
        lastErrorCode: "DATABASE_RETRYABLE",
        lastErrorMessage: "Database update timed out.",
        consecutiveFailures: 2,
        lastHistoryAttempt: null,
        lastHistorySync: null,
        lastHistoryStatus: null,
        lastHistoryMessage: null,
        historySyncedCount: 0,
      },
      now
    );
    expect(result.state).toBe("DEGRADED");
    expect(result.message).toContain("snapshot");
    expect(result.message).toContain("DATABASE_RETRYABLE");
  });
  it("keeps the terminal connected when open-position synchronization is current but the first account snapshot is pending", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth({
      active: true,
      lastPing: new Date(now - 3_000),
      lastContactAt: new Date(now - 3_000),
      lastSummarySuccessAt: null,
      lastOpenSyncSuccessAt: new Date(now - 2_000),
      lastHistoryAttempt: null,
      lastHistorySync: null,
      lastHistoryStatus: null,
      lastHistoryMessage: null,
      historySyncedCount: 0,
    }, now);
    expect(result.state).toBe("CONNECTED");
    expect(result.snapshotState).toBe("PENDING");
    expect(result.openSyncState).toBe("CURRENT");
  });
  it("accepts Supabase ISO timestamp strings for a persisted first contact", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth({
      active: true,
      lastPing: "2026-08-20T11:59:58.000Z",
      lastContactAt: "2026-08-20T11:59:58.000Z",
      lastSummarySuccessAt: null,
      lastOpenSyncSuccessAt: null,
      lastHistoryAttempt: null,
      lastHistorySync: null,
      lastHistoryStatus: null,
      lastHistoryMessage: null,
      historySyncedCount: 0,
    }, now);
    expect(result.state).toBe("DEGRADED");
    expect(result.lastContactAgeSeconds).toBe(2);
    expect(result.snapshotState).toBe("PENDING");
  });
  it("reports degraded rather than offline when a current open sync follows a summary failure", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth({
      active: true,
      lastPing: new Date(now - 3_000),
      lastContactAt: new Date(now - 3_000),
      lastSummarySuccessAt: new Date(now - 20_000),
      lastSummaryErrorAt: new Date(now - 2_000),
      lastOpenSyncSuccessAt: new Date(now - 2_000),
      lastHistoryAttempt: null,
      lastHistorySync: null,
      lastHistoryStatus: null,
      lastHistoryMessage: null,
      historySyncedCount: 0,
    }, now);
    expect(result.state).toBe("DEGRADED");
    expect(result.lastContactAgeSeconds).toBe(3);
  });
  it("reports degraded when terminal contact is current but both live streams are stale", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const result = classifyMt5SyncHealth({
      active: true,
      lastPing: new Date(now - 3_000),
      lastContactAt: new Date(now - 3_000),
      lastSummarySuccessAt: new Date(now - 20_000),
      lastOpenSyncSuccessAt: new Date(now - 20_000),
      lastHistoryAttempt: null,
      lastHistorySync: null,
      lastHistoryStatus: null,
      lastHistoryMessage: null,
      historySyncedCount: 0,
    }, now);
    expect(result.state).toBe("DEGRADED");
    expect(result.snapshotState).toBe("STALE");
    expect(result.openSyncState).toBe("STALE");
  });
  it("distinguishes a missing record from an offline active connection", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    expect(classifyMt5SyncHealth(null, now).state).toBe("MISSING");
    const offline = classifyMt5SyncHealth(
        {
          active: true,
          lastPing: new Date(now - 301_000),
          lastHistoryAttempt: null,
          lastHistorySync: null,
          lastHistoryStatus: null,
          lastHistoryMessage: null,
          historySyncedCount: 0,
        },
        now
      );
    expect(offline.state).toBe("OFFLINE");
    expect(offline.message).toContain("connection record remains active");
  });
  it("gives a concrete setup checklist before the first terminal contact", () => {
    const result = classifyMt5SyncHealth({
      active: true,
      lastPing: null,
      lastHistoryAttempt: null,
      lastHistorySync: null,
      lastHistoryStatus: null,
      lastHistoryMessage: null,
      historySyncedCount: 0,
    });
    expect(result.state).toBe("WAITING");
    expect(result.message).toContain("server origin");
    expect(result.message).toContain("WebRequest");
    expect(result.message).toContain("API key");
    expect(result.message).toContain("Auto Trading may remain off");
  });
});
