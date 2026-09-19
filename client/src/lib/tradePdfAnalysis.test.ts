import { describe, expect, it } from "vitest";
import { buildAnalysis, metricRow } from "@shared/analysisEngine";
import { TRADE_CLASSIFICATION_LABELS, classifyTradeProcess, type TradeClassification } from "@/lib/psychology";
import { groupTradesByPktDay, summarizeTradeRows } from "@/lib/performanceSummary";
import { formatMoney } from "@/lib/gold";
import { ANALYSIS_MISSING, buildPeriodAnalysis, findParagraph, findTable, metricValue } from "./tradePdfAnalysis";

const rows = [
  { id: 1, tradeDate: "2026-09-16T09:15:00.000Z", symbol: "XAUUSD", session: "New York", direction: "BUY", result: "WIN", pnl: "70.90", risk: "10.00", reward: "93.30", timeframe: "15m", level: "Daily RBS", setupQuality: "A+", executionType: "Manual direct", holdQuality: "Good", patienceScore: 4, planStatus: "PLANNED", planChecklist: "setup-exists|matches-plan|stop-defined|risk-in-limit|size-valid|rr-acceptable|session-valid|no-emotional-trigger|not-revenge", mistake: "Impatience", emotionBefore: "Calm", emotionDuring: "Fear", emotionAfter: "Regret", openTime: "2026-09-16T09:15:00.000Z", closeTime: "2026-09-16T09:19:00.000Z" },
  { id: 2, tradeDate: "2026-09-16T13:05:00.000Z", symbol: "XAUUSD", session: "London", direction: "SELL", result: "LOSS", pnl: "-48.20", risk: "10.00", reward: "93.30", timeframe: "5m", level: "H4 supply", setupQuality: "A", executionType: "Limit retest", holdQuality: "Average", patienceScore: 3, planStatus: "PLANNED", planChecklist: "setup-exists|stop-defined", mistake: "Closed early|Entered without confirmation", emotionBefore: "Neutral", emotionDuring: "Fear", emotionAfter: "Neutral" },
  { id: 3, tradeDate: "2026-09-17T02:10:00.000Z", symbol: "XAUUSD", session: "Asian", direction: "BUY", result: "BREAK_EVEN", pnl: "0.00", risk: "10.00", reward: "60.00", timeframe: "1H", level: "Daily RBS", setupQuality: "B+", executionType: "Manual direct", holdQuality: "Excellent", patienceScore: 5, planStatus: "UNPLANNED", planChecklist: "setup-exists", mistake: "Impatience", emotionBefore: "Anxious", emotionAfter: "Relieved" },
  { id: 4, tradeDate: "2026-09-17T09:20:00.000Z", symbol: "XAUUSD", session: "New York", direction: "SELL", result: "WIN", pnl: "134.10", risk: "10.00", reward: "93.30", timeframe: "15m", level: "H4 supply", setupQuality: "A", executionType: "Market on confirmation", holdQuality: "Good", patienceScore: 4, planStatus: "PLANNED", planChecklist: "setup-exists|matches-plan|entry-confirmed|stop-defined|risk-in-limit|size-valid|rr-acceptable|session-valid|no-emotional-trigger|not-revenge", emotionBefore: "Calm", emotionDuring: "Focused", emotionAfter: "Satisfied" },
  { id: 5, tradeDate: "2026-09-18T10:00:00.000Z", symbol: "XAUUSD", session: "London", result: "OPEN", pnl: "12.00" },
];

const model = buildPeriodAnalysis(rows as never, { accountName: "Blueberry live", rangeLabel: "2026-09-16 to 2026-09-18" });

describe("PDF period analysis", () => {
  it("reads every performance metric from the shared analysis engine", () => {
    const analysis = buildAnalysis(rows as never);
    const overview = analysis.overview;
    expect(metricValue(model.blocks, "Performance overview", "Net P&L")).toBe(formatMoney(overview.netPnl));
    expect(metricValue(model.blocks, "Performance overview", "Gross profit")).toBe(formatMoney(overview.grossProfit));
    expect(metricValue(model.blocks, "Performance overview", "Gross loss")).toBe(formatMoney(overview.grossLoss));
    expect(metricValue(model.blocks, "Performance overview", "Win rate")).toBe(`${overview.winRate.toFixed(1)}%`);
    expect(metricValue(model.blocks, "Performance overview", "Wins")).toBe(String(overview.wins));
    expect(metricValue(model.blocks, "Performance overview", "Losses")).toBe(String(overview.losses));
    expect(metricValue(model.blocks, "Performance overview", "Break-even")).toBe(String(overview.breakEven));
    expect(metricValue(model.blocks, "Performance overview", "Average win")).toBe(formatMoney(overview.averageWinner as number));
    expect(metricValue(model.blocks, "Performance overview", "Average loss")).toBe(formatMoney(overview.averageLoser as number));
    expect(metricValue(model.blocks, "Performance overview", "Profit factor")).toBe(overview.profitFactor?.toFixed(2));
    expect(metricValue(model.blocks, "Performance overview", "Expectancy")).toBe(formatMoney(overview.expectancy));
    expect(metricValue(model.blocks, "Performance overview", "Average R")).toBe(`+${(overview.averageR as number).toFixed(2)}R`);
    expect(metricValue(model.blocks, "Performance overview", "Best trade")).toBe(formatMoney(overview.largestWinner as number));
    expect(metricValue(model.blocks, "Performance overview", "Worst trade")).toBe(formatMoney(overview.largestLoser as number));
    // The open trade is exported and counted, but never inflates a performance metric.
    expect(metricValue(model.blocks, "Period", "Trades exported")).toBe("5");
    expect(metricValue(model.blocks, "Period", "Closed trades")).toBe("4");
    expect(metricValue(model.blocks, "Period", "Open trades")).toBe("1");
    expect(model.total).toBe(5);
    expect(model.closed).toBe(4);
  });

  it("uses the engine's own rows for every context table", () => {
    const analysis = buildAnalysis(rows as never);
    const sessionTable = findTable(model.blocks, "Session analysis");
    expect(sessionTable?.rows.map(row => row[0])).toEqual(analysis.sessions.map(row => row.label));
    expect(sessionTable?.rows[0]).toEqual([
      "New York", String(analysis.sessions[0].sample), String(analysis.sessions[0].wins), String(analysis.sessions[0].losses),
      String(analysis.sessions[0].breakEven), formatMoney(analysis.sessions[0].netPnl), formatMoney(analysis.sessions[0].averagePnl),
    ]);
    expect(findTable(model.blocks, "Direction analysis")?.rows.map(row => row[0])).toEqual(analysis.directions.map(row => row.label));
    expect(findTable(model.blocks, "Setup analysis")?.rows.map(row => row[0])).toEqual(analysis.setups.map(row => row.label));
    expect(findTable(model.blocks, "Timeframe analysis")?.rows.map(row => row[0])).toEqual(analysis.timeframes.map(row => row.label));
    expect(findTable(model.blocks, "Session analysis")?.rows).toHaveLength(3);
  });

  it("reports risk and drawdown only when the data supports it", () => {
    const analysis = buildAnalysis(rows as never);
    expect(metricValue(model.blocks, "Risk & drawdown", "Maximum drawdown")).toBe(formatMoney(analysis.drawdown.maximum));
    expect(metricValue(model.blocks, "Risk & drawdown", "Longest win streak")).toBe(String(analysis.streaks.longestWin));
    expect(metricValue(model.blocks, "Risk & drawdown", "Longest loss streak")).toBe(String(analysis.streaks.longestLoss));
    expect(metricValue(model.blocks, "Risk & drawdown", "Average planned risk")).toBe(formatMoney(analysis.risk.average as number));
    expect(metricValue(model.blocks, "Risk & drawdown", "Risk consistency")).toBe(`${Math.round((analysis.risk.consistency as number) * 100)}%`);
  });

  it("keeps outcome and process separate using the shared classifier", () => {
    const analysis = buildAnalysis(rows as never);
    const classifications = rows.filter(row => row.result !== "OPEN").map(row => classifyTradeProcess(row as never).classification);
    const processTable = findTable(model.blocks, "Process classification");
    const total = (processTable?.rows ?? []).reduce((sum, row) => sum + Number(row[1]), 0);
    expect(total).toBe(4);
    // Rows use the same display labels as the app, one per classification present.
    const expectedLabels = Array.from(new Set(classifications)).map(key => TRADE_CLASSIFICATION_LABELS[key as TradeClassification]).sort();
    expect(processTable?.rows.map(row => row[0]).sort()).toEqual(expectedLabels);
    expect(metricValue(model.blocks, "Plan & discipline", "Planned trades")).toBe("3");
    expect(metricValue(model.blocks, "Plan & discipline", "Unplanned trades")).toBe("1");
    const adherence = rows.map(row => classifyTradeProcess(row as never).ruleAdherence).filter((value): value is number => value != null);
    expect(metricValue(model.blocks, "Plan & discipline", "Rule adherence")).toBe(`${Math.round(adherence.reduce((sum, value) => sum + value, 0) / adherence.length)}%`);
    // (90% + 20% + 10% + 100%) / 4 checked items across the four closed trades.
    expect(metricValue(model.blocks, "Plan & discipline", "Average checklist completion")).toBe("55.0%");
    expect(metricValue(model.blocks, "Plan & discipline", "Average patience score")).toBe("4.0 / 5");
    expect(findTable(model.blocks, "Execution type")?.rows.length).toBeGreaterThan(0);
    expect(findTable(model.blocks, "Hold quality")?.rows.length).toBeGreaterThan(0);
    expect(findTable(model.blocks, "Patience score distribution")?.rows.map(row => row[0]).sort()).toEqual(["3 / 5", "4 / 5", "5 / 5"]);
    expect(analysis.behavior.tags.length).toBeGreaterThan(0);
  });

  it("lists the recorded mistakes and emotions from the engine's behaviour rows", () => {
    const analysis = buildAnalysis(rows as never);
    const mistakes = findTable(model.blocks, "Mistake / rule-break tags");
    expect(mistakes?.rows.map(row => row[0])).toEqual(analysis.behavior.tags.map(row => row.label));
    expect(mistakes?.rows.every(row => Number(row[1]) >= 1)).toBe(true);
    const emotions = findTable(model.blocks, "Recorded emotions");
    expect(emotions?.rows).toHaveLength(analysis.behavior.emotions.length);
    expect(emotions?.rows.map(row => row[0])).toContain("Before");
    expect(emotions?.rows.some(row => row[1] === "Fear")).toBe(true);
    // A tag the taxonomy does not recognise is still reported, never dropped.
    const custom = buildPeriodAnalysis([{ ...rows[1], mistake: "Something new entirely" }] as never, { accountName: "A", rangeLabel: "B" });
    expect(findTable(custom.blocks, "Mistake / rule-break tags")?.rows.map(row => row[0])).toEqual(["Something new entirely"]);
  });

  it("builds the daily table from the same day summaries the calendar uses", () => {
    const table = findTable(model.blocks, "Daily performance");
    const days = Array.from(groupTradesByPktDay(rows as never).entries()).sort(([a], [b]) => a.localeCompare(b));
    expect(table?.rows.length).toBe(days.length);
    days.forEach(([day, dayTrades], index) => {
      const summary = summarizeTradeRows(dayTrades as never[], day);
      expect(table?.rows[index]).toEqual([day, String(summary.count), String(summary.wins), String(summary.losses), String(summary.breakEven), formatMoney(summary.pnl)]);
    });
    expect(table?.rows[0][0]).toBe("2026-09-16");
  });

  it("renders — instead of a fake zero when a metric cannot be calculated", () => {
    const single = buildPeriodAnalysis([rows[0]] as never, { accountName: "A", rangeLabel: "B" });
    expect(metricValue(single.blocks, "Performance overview", "Profit factor")).toBe(ANALYSIS_MISSING);
    expect(metricValue(single.blocks, "Performance overview", "Average loss")).toBe(ANALYSIS_MISSING);
    expect(metricValue(single.blocks, "Performance overview", "Worst trade")).toBe(ANALYSIS_MISSING);
    expect(metricValue(single.blocks, "Risk & drawdown", "Maximum drawdown")).toBe(ANALYSIS_MISSING);
    expect(findTable(single.blocks, "Direction analysis")?.rows).toHaveLength(1);
    const empty = buildPeriodAnalysis([], { accountName: "A", rangeLabel: "B" });
    expect(metricValue(empty.blocks, "Performance overview", "Win rate")).toBe(ANALYSIS_MISSING);
    expect(findParagraph(empty.blocks, "Period observations")?.[0]).toContain("No closed trades are available");
  });

  it("states only facts it can compute, with no psychological verdict", () => {
    const observations = findParagraph(model.blocks, "Period observations") ?? [];
    expect(observations.join(" ")).toContain("2 of 4 closed trades were wins");
    expect(observations.join(" ")).toContain("$156.80 net");
    expect(observations.join(" ")).toContain("New York accounted for");
    expect(observations.join(" ")).toContain("Rule adherence averaged");
    expect(observations.length).toBeGreaterThan(3);
    // No speculative psychology, no AI wording, no second-person judgement.
    expect(observations.join(" ")).not.toMatch(/you are|emotionally|likely|probably|suggests that you|advice/i);
    const limitations = findParagraph(model.blocks, "Data quality & limitations") ?? [];
    expect(limitations.join(" ")).toContain("OPEN trades are excluded from performance metrics.");
    expect(limitations.length).toBeGreaterThan(0);
  });

  it("matches metricRow for an ad-hoc grouping so no private formula exists", () => {
    const grouped = metricRow("Manual direct", rows.filter(row => row.executionType === "Manual direct") as never);
    const matched = rows.filter(row => row.executionType === "Manual direct" && row.result !== "OPEN");
    expect(matched.length).toBe(grouped.sample);
    expect(formatMoney(grouped.netPnl)).toBe("$70.90");
    expect(findTable(model.blocks, "Execution type")?.rows).toContainEqual(["Manual direct", String(grouped.sample), `${grouped.winRate.toFixed(1)}%`, formatMoney(grouped.netPnl)]);
  });
});
