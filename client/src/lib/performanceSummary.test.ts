import { describe, expect, it } from "vitest";
import { groupTradesByPktDay, monthKey, monthlyOverview, summarizeDayTrades, weeklyPnl } from "./performanceSummary";

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

const pkt = (tradeDate: string) => ({ tradeDate, result: "WIN", pnl: "0" });

const dayTrades = [
  { id: 1, tradeDate: "2026-08-20T04:42:00.000Z", result: "WIN", pnl: "180", risk: "100", reward: "200", session: "London", direction: "BUY" },
  { id: 2, tradeDate: "2026-08-20T06:10:00.000Z", result: "LOSS", pnl: "-40", risk: "100", reward: "200", session: "London", direction: "BUY" },
  { id: 3, tradeDate: "2026-08-20T09:20:00.000Z", result: "WIN", pnl: "95", risk: "50", reward: "150", session: "New York", direction: "SELL" },
  { id: 4, tradeDate: "2026-08-20T12:05:00.000Z", result: "WIN", pnl: "105", risk: "50", reward: "150", session: "New York", direction: "SELL" },
  { id: 5, tradeDate: "2026-08-21T06:00:00.000Z", result: "LOSS", pnl: "-500", risk: "250", reward: "500" },
];

describe("daily drill-down summaries", () => {
  it("returns an empty, unopenable summary for a day without trades", () => {
    const summary = summarizeDayTrades(dayTrades, "2026-08-19");
    expect(summary).toMatchObject({ count: 0, trades: [], pnl: 0, wins: 0, losses: 0, open: 0, winRate: 0, averageR: null, tone: "neutral" });
  });

  it("keeps only the selected day's trades", () => {
    const summary = summarizeDayTrades(dayTrades, "2026-08-21");
    expect(summary.trades.map(trade => trade.id)).toEqual([5]);
  });

  it("totals the day's exact P&L, wins, losses, and win rate", () => {
    const summary = summarizeDayTrades(dayTrades, "2026-08-20");
    expect(summary).toMatchObject({ count: 4, pnl: 340, wins: 3, losses: 1, breakEven: 0, open: 0, winRate: 75, tone: "positive" });
  });

  it("derives risk, reward, average R, and average trade P&L from the same rows", () => {
    const summary = summarizeDayTrades(dayTrades, "2026-08-20");
    expect(summary.totalRisk).toBe(300);
    expect(summary.totalReward).toBe(700);
    expect(summary.averagePnl).toBe(85);
    expect(summary.averageR).toBeCloseTo((1.8 - 0.4 + 1.9 + 2.1) / 4, 6);
  });

  it("labels a losing day as negative and a flat day as neutral", () => {
    expect(summarizeDayTrades(dayTrades, "2026-08-21")).toMatchObject({ pnl: -500, losses: 1, wins: 0, tone: "negative" });
    expect(summarizeDayTrades([{ tradeDate: "2026-08-22T06:00:00.000Z", result: "BREAK_EVEN", pnl: "0" }], "2026-08-22")).toMatchObject({ pnl: 0, breakEven: 1, tone: "neutral" });
  });

  it("reports open trades separately instead of counting them as wins or losses", () => {
    const summary = summarizeDayTrades([{ tradeDate: "2026-08-20T06:00:00.000Z", result: "OPEN", pnl: "45.2", risk: "50" }], "2026-08-20");
    expect(summary).toMatchObject({ count: 1, wins: 0, losses: 0, open: 1, pnl: 45.2, openPnl: 45.2, winRate: 0, tone: "positive" });
  });

  it("honours Pakistan time at the 23:59/00:00 boundary", () => {
    const boundary = [
      { tradeDate: "2026-08-03T18:59:00.000Z", result: "WIN", pnl: "10" }, // 03 Aug 23:59 PKT
      { tradeDate: "2026-08-03T19:00:00.000Z", result: "LOSS", pnl: "-5" }, // 04 Aug 00:00 PKT
      { tradeDate: "2026-08-03T00:00:00.000Z", result: "WIN", pnl: "7" }, // 03 Aug 05:00 PKT
    ];
    expect(summarizeDayTrades(boundary, "2026-08-03")).toMatchObject({ count: 2, pnl: 17, wins: 2, losses: 0 });
    expect(summarizeDayTrades(boundary, "2026-08-04")).toMatchObject({ count: 1, pnl: -5, losses: 1 });
    expect(summarizeDayTrades(boundary, "2026-08-02")).toMatchObject({ count: 0 });
  });

  it("groups trades by Pakistan-local day in one pass", () => {
    const grouped = groupTradesByPktDay([...dayTrades, pkt("2026-08-20T19:30:00.000Z")]);
    expect(Array.from(grouped.keys()).sort()).toEqual(["2026-08-20", "2026-08-21"]);
    expect(grouped.get("2026-08-20")).toHaveLength(4);
    expect(grouped.get("2026-08-21")).toHaveLength(2);
  });
});
