import { describe, expect, it } from "vitest";
import { buildAnalysis, compareAnalysis, metricRow, wilsonInterval } from "./analysisEngine";

const trade = (overrides: Record<string, unknown> = {}) => ({ tradeDate: new Date("2026-01-01T00:00:00Z"), result: "WIN", pnl: 10, risk: 10, reward: 20, session: "London", timeframe: "M5", level: "Support", setupQuality: "A", direction: "BUY", notes: "reviewed", ...overrides });

describe("deterministic analysis engine", () => {
  it("excludes OPEN trades from performance metrics", () => {
    const row = metricRow("all", [trade(), trade({ result: "LOSS", pnl: -5 }), trade({ result: "OPEN", pnl: 999 })]);
    expect(row.sample).toBe(2);
    expect(row.netPnl).toBe(5);
    expect(row.wins).toBe(1);
    expect(row.losses).toBe(1);
  });

  it("handles zero-loss, zero-win, and break-even samples without Infinity", () => {
    expect(metricRow("wins", [trade(), trade({ pnl: 5 })]).profitFactor).toBeNull();
    expect(metricRow("break-even", [trade({ result: "BREAK_EVEN", pnl: 0 })]).profitFactor).toBe(0);
    expect(metricRow("empty", []).profitFactor).toBe(0);
    expect(metricRow("empty", []).winRate).toBe(0);
  });

  it("calculates R metrics, Wilson intervals, and evidence tiers", () => {
    const row = metricRow("r", [trade({ pnl: 20, risk: 10 }), trade({ result: "LOSS", pnl: -10, risk: 10 }), trade({ result: "BREAK_EVEN", pnl: 0, risk: 10 })]);
    expect(row.totalR).toBe(1);
    expect(row.averageR).toBeCloseTo(1 / 3, 4);
    expect(row.expectancyR).toBeCloseTo(1 / 3, 4);
    expect(row.evidenceTier).toBe("INSUFFICIENT DATA");
    expect(wilsonInterval(0, 5)[0]).toBe(0);
    expect(wilsonInterval(5, 5)[1]).toBe(100);
  });

  it("calculates streaks and drawdown from chronological closed trades", () => {
    const rows = [trade({ tradeDate: "2026-01-01", pnl: 10 }), trade({ tradeDate: "2026-01-02", result: "LOSS", pnl: -20 }), trade({ tradeDate: "2026-01-03", result: "LOSS", pnl: -10 }), trade({ tradeDate: "2026-01-04", pnl: 30 })];
    const analysis = buildAnalysis(rows);
    expect(analysis.streaks.longestLoss).toBe(2);
    expect(analysis.streaks.current).toEqual({ type: "WIN", length: 1 });
    expect(analysis.drawdown.maximum).toBe(30);
    expect(analysis.drawdown.count).toBeGreaterThan(0);
  });

  it("filters by account-independent analysis dimensions and warns on missing fields", () => {
    const rows = [trade({ session: "London", direction: "BUY" }), trade({ session: "New York", direction: "SELL", level: "" }), trade({ result: "OPEN", session: "London" })];
    const analysis = buildAnalysis(rows, { session: "London", direction: "BUY" });
    expect(analysis.overview.sample).toBe(1);
    expect(analysis.journalQuality.warnings.some(item => item.field === "level")).toBe(false);
    const all = buildAnalysis(rows);
    expect(all.warnings.some(warning => warning.includes("level"))).toBe(true);
    expect(all.mfeMae.available).toBe(0);
  });

  it("compares periods without inventing PF or R deltas when either side is unavailable", () => {
    const current = buildAnalysis([trade(), trade({ tradeDate: "2026-01-02", pnl: 5 })]);
    const previous = buildAnalysis([trade({ result: "BREAK_EVEN", pnl: 0, risk: null })]);
    const comparison = compareAnalysis(current, previous);
    expect(comparison.overview.winRate).toBe(100);
    expect(comparison.overview.profitFactor).toBeNull();
    expect(comparison.overview.averageR).toBeNull();
  });

  it("does not automatically let five perfect trades beat a large positive context", () => {
    const small = Array.from({ length: 5 }, (_, index) => trade({ session: "Small", tradeDate: `2026-01-${String(index + 1).padStart(2, "0")}`, pnl: 20 }));
    const large = Array.from({ length: 100 }, (_, index) => trade({ session: "Large", tradeDate: `2026-02-${String((index % 28) + 1).padStart(2, "0")}`, result: index % 20 < 13 ? "WIN" : "LOSS", pnl: index % 20 < 13 ? 8 : -4 }));
    const analysis = buildAnalysis([...small, ...large]);
    expect(analysis.sessions.find(row => row.label === "Large")?.edgeScore).toBeGreaterThan(analysis.sessions.find(row => row.label === "Small")?.edgeScore ?? 0);
  });
});
