import { describe, expect, it } from "vitest";
import { computeStreaks, type StreakTradeInput } from "./streaks";

/**
 * "Today" is pinned so streak arithmetic is deterministic: 2026-09-27 (PKT).
 * Trade dates use +05:00 offsets so the PKT day key is exactly the calendar
 * day written in the test.
 */
const TODAY = "2026-09-27";

const trade = (day: string, overrides: Partial<StreakTradeInput> = {}): StreakTradeInput => ({
  tradeDate: `${day}T13:00:00+05:00`,
  pnl: 100,
  result: "WIN",
  mistake: "",
  ...overrides,
});

describe("computeStreaks", () => {
  it("returns all zeros for an empty journal", () => {
    expect(computeStreaks([], { today: TODAY })).toEqual({
      journaling: { current: 0, best: 0 },
      greenDay: { current: 0, best: 0 },
      revengeFreeDays: 0,
      disciplinedDays: 0,
    });
  });

  it("counts a live journaling streak when today has trades", () => {
    const result = computeStreaks(
      [trade("2026-09-25"), trade("2026-09-26"), trade("2026-09-27")],
      { today: TODAY },
    );
    expect(result.journaling.current).toBe(3);
    expect(result.journaling.best).toBe(3);
  });

  it("starts the walk-back from yesterday when today has no trades", () => {
    // A trader who hasn't traded yet today hasn't broken the streak.
    const result = computeStreaks([trade("2026-09-25"), trade("2026-09-26")], { today: TODAY });
    expect(result.journaling.current).toBe(2);
  });

  it("breaks the current streak at the first missing day but keeps best", () => {
    const result = computeStreaks(
      [
        trade("2026-09-15"),
        trade("2026-09-16"),
        trade("2026-09-17"),
        // gap: 2026-09-18 has no trades
        trade("2026-09-19"),
        trade("2026-09-20"),
        trade("2026-09-27"),
      ],
      { today: TODAY },
    );
    expect(result.journaling.current).toBe(1);
    expect(result.journaling.best).toBe(3);
  });

  it("counts consecutive profitable days as a green-day streak", () => {
    const result = computeStreaks(
      [trade("2026-09-26", { pnl: 50 }), trade("2026-09-27", { pnl: 200 })],
      { today: TODAY },
    );
    expect(result.greenDay.current).toBe(2);
  });

  it("breaks the green-day streak on a break-even day, not just a loss", () => {
    const result = computeStreaks(
      [
        trade("2026-09-25", { pnl: 50 }),
        trade("2026-09-26", { pnl: 0 }), // flat: strictly-positive rule breaks here
        trade("2026-09-27", { pnl: 100 }),
      ],
      { today: TODAY },
    );
    expect(result.greenDay.current).toBe(1);
    expect(result.greenDay.best).toBe(1);
  });

  it("breaks the green-day streak on a non-trading day", () => {
    const result = computeStreaks(
      [trade("2026-09-25", { pnl: 50 }), trade("2026-09-27", { pnl: 50 })],
      { today: TODAY },
    );
    // Skipping a day is fine for journaling habits, but you can't claim a
    // green-day streak through days you didn't trade.
    expect(result.greenDay.current).toBe(1);
    expect(result.greenDay.best).toBe(1);
  });

  it("detects revenge trades case-insensitively and reports days since", () => {
    const result = computeStreaks(
      [trade("2026-09-24", { mistake: "ReVeNgE entry after stop" }), trade("2026-09-27")],
      { today: TODAY },
    );
    expect(result.revengeFreeDays).toBe(3);
  });

  it("treats FOMO as a revenge-pattern trade", () => {
    const result = computeStreaks(
      [trade("2026-09-27", { mistake: "fomo chase at the highs" })],
      { today: TODAY },
    );
    expect(result.revengeFreeDays).toBe(0);
  });

  it("returns the journal span when no revenge trade is on record", () => {
    const result = computeStreaks([trade("2026-09-25"), trade("2026-09-27")], { today: TODAY });
    // Revenge-free for the whole recorded history: 2026-09-25 -> 2026-09-27.
    expect(result.revengeFreeDays).toBe(2);
  });

  it("returns the journal span for disciplinedDays when no limit is configured", () => {
    const result = computeStreaks(
      [trade("2026-09-25"), trade("2026-09-26"), trade("2026-09-27")],
      { today: TODAY, maxTradesPerDay: null },
    );
    expect(result.disciplinedDays).toBe(2);
  });

  it("flags a day that exceeded maxTradesPerDay", () => {
    const result = computeStreaks(
      [
        trade("2026-09-26"),
        trade("2026-09-26"),
        trade("2026-09-26"), // 3 trades > limit of 2
        trade("2026-09-27"),
      ],
      { today: TODAY, maxTradesPerDay: 2 },
    );
    expect(result.disciplinedDays).toBe(1);
  });

  it("ignores trades with unparseable dates but accepts numeric timestamps", () => {
    const result = computeStreaks(
      [
        trade("2026-09-27"),
        { tradeDate: "not a date", pnl: 10 }, // dropped
        { tradeDate: Date.parse("2026-09-26T13:00:00+05:00"), pnl: 10 }, // kept
      ],
      { today: TODAY },
    );
    expect(result.journaling.current).toBe(2);
    expect(result.journaling.best).toBe(2);
  });

  it("groups multiple trades on one PKT day into a single journaling day", () => {
    const result = computeStreaks(
      [trade("2026-09-27"), trade("2026-09-27", { pnl: -30 })],
      { today: TODAY },
    );
    expect(result.journaling.current).toBe(1);
  });

  it("separates best from current when an older run was longer", () => {
    const result = computeStreaks(
      [
        trade("2026-09-01", { pnl: 10 }),
        trade("2026-09-02", { pnl: 10 }),
        trade("2026-09-03", { pnl: 10 }),
        trade("2026-09-04", { pnl: 10 }),
        trade("2026-09-27", { pnl: 10 }),
      ],
      { today: TODAY },
    );
    expect(result.greenDay.current).toBe(1);
    expect(result.greenDay.best).toBe(4);
  });
});
