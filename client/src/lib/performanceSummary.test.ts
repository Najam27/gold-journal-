import { describe, expect, it } from "vitest";
import { monthKey, monthlyOverview, weeklyPnl } from "./performanceSummary";

const trades = [
  { tradeDate: "2026-08-03T12:00:00.000Z", result: "WIN", pnl: "100", risk: "20", reward: "100" },
  { tradeDate: "2026-08-06T12:00:00.000Z", result: "LOSS", pnl: "-20", risk: "20", reward: "40" },
  { tradeDate: "2026-08-14T12:00:00.000Z", result: "BREAK_EVEN", pnl: "0", risk: "20", reward: "60" },
  { tradeDate: "2026-07-30T12:00:00.000Z", result: "WIN", pnl: "10", risk: "10", reward: "20" },
];

describe("performance summaries", () => {
  it("calculates the selected month’s trade, win/loss, pnl, and risk/reward metrics", () => {
    expect(monthlyOverview(trades, "2026-08")).toMatchObject({ trades: 3, wins: 1, losses: 1, breakEven: 1, pnl: 80, winRate: 33.33333333333333, avgRr: 10 / 3 });
  });
  it("returns a week-end total only for trade dates in the inclusive calendar week", () => {
    expect(weeklyPnl(trades, new Date("2026-08-02T00:00:00"), new Date("2026-08-08T23:59:59"))).toBe(80);
  });
  it("groups month and week boundaries in fixed Pakistan time rather than browser-local time", () => {
    expect(monthKey("2026-08-31T20:30:00.000Z")).toBe("2026-09");
    const boundaryTrades = [
      { tradeDate: "2026-08-02T20:00:00.000Z", pnl: "15" }, // 03 Aug in PKT
      { tradeDate: "2026-08-09T19:00:00.000Z", pnl: "99" }, // 10 Aug in PKT
    ];
    expect(weeklyPnl(boundaryTrades, new Date("2026-08-02T19:00:00.000Z"), new Date("2026-08-09T18:59:59.000Z"))).toBe(15);
  });
});
