import { classifyMt5SyncHealth } from "./mt5Reliability";
import { describe, expect, it } from "vitest";

describe("MT5 sync health", () => {
  it("classifies fresh account contact as live and completed history as complete", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z"); const result = classifyMt5SyncHealth({ active: true, lastPing: new Date(now - 5_000), lastHistoryAttempt: new Date(now - 60_000), lastHistorySync: new Date(now - 30_000), lastHistoryStatus: "COMPLETED", lastHistoryMessage: null, historySyncedCount: 42 }, now);
    expect(result.state).toBe("LIVE"); expect(result.historyState).toBe("COMPLETE"); expect(result.message).toContain("42");
  });
  it("reports stale contact and a failed history safely", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z"); const result = classifyMt5SyncHealth({ active: true, lastPing: new Date(now - 61_000), lastHistoryAttempt: new Date(now - 5_000), lastHistorySync: null, lastHistoryStatus: "FAILED", lastHistoryMessage: "Invalid payload", historySyncedCount: 0 }, now);
    expect(result.state).toBe("STALE"); expect(result.historyState).toBe("FAILED"); expect(result.message).toBe("Invalid payload");
  });
});
