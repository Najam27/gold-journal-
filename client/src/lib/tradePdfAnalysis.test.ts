import { describe, expect, it } from "vitest";
import { buildAnalysis, metricRow } from "@shared/analysisEngine";
import { TRADE_CLASSIFICATION_LABELS, classifyTradeProcess, type TradeClassification } from "@/lib/psychology";
import { groupTradesByPktDay, summarizeTradeRows } from "@/lib/performanceSummary";
import { formatMoney } from "@/lib/gold";
import { ANALYSIS_MISSING, allBlocks, buildPeriodAnalysis, findParagraph, findTable, metricValue } from "./tradePdfAnalysis";

const rows = [
  { id: 1, tradeDate: "2026-09-16T09:15:00.000Z", symbol: "XAUUSD", session: "New York", direction: "BUY", result: "WIN", pnl: "70.90", risk: "10.00", reward: "93.30", timeframe: "15m", level: "Daily RBS", setupQuality: "A+", executionType: "Manual direct", holdQuality: "Good", patienceScore: 4, planStatus: "PLANNED", planChecklist: "setup-exists|matches-plan|stop-defined|risk-in-limit|size-valid|rr-acceptable|session-valid|no-emotional-trigger|not-revenge", mistake: "Impatience", emotionBefore: "Calm", emotionDuring: "Fear", emotionAfter: "Regret", openTime: "2026-09-16T09:15:00.000Z", closeTime: "2026-09-16T09:19:00.000Z" },
  { id: 2, tradeDate: "2026-09-16T13:05:00.000Z", symbol: "XAUUSD", session: "London", direction: "SELL", result: "LOSS", pnl: "-48.20", risk: "10.00", reward: "93.30", timeframe: "5m", level: "H4 supply", setupQuality: "A", executionType: "Limit retest", holdQuality: "Average", patienceScore: 3, planStatus: "PLANNED", planChecklist: "setup-exists|stop-defined", mistake: "Closed early|Entered without confirmation", emotionBefore: "Neutral", emotionDuring: "Fear", emotionAfter: "Neutral" },
  { id: 3, tradeDate: "2026-09-17T02:10:00.000Z", symbol: "XAUUSD", session: "Asian", direction: "BUY", result: "BREAK_EVEN", pnl: "0.00", risk: "10.00", reward: "60.00", timeframe: "1H", level: "Daily RBS", setupQuality: "B+", executionType: "Manual direct", holdQuality: "Excellent", patienceScore: 5, planStatus: "UNPLANNED", planChecklist: "setup-exists", mistake: "Impatience", emotionBefore: "Anxious", emotionAfter: "Relieved" },
  { id: 4, tradeDate: "2026-09-17T09:20:00.000Z", symbol: "XAUUSD", session: "New York", direction: "SELL", result: "WIN", pnl: "134.10", risk: "10.00", reward: "93.30", timeframe: "15m", level: "H4 supply", setupQuality: "A", executionType: "Market on confirmation", holdQuality: "Good", patienceScore: 4, planStatus: "PLANNED", planChecklist: "setup-exists|matches-plan|entry-confirmed|stop-defined|risk-in-limit|size-valid|rr-acceptable|session-valid|no-emotional-trigger|not-revenge", emotionBefore: "Calm", emotionDuring: "Focused", emotionAfter: "Satisfied" },
  { id: 5, tradeDate: "2026-09-18T10:00:00.000Z", symbol: "XAUUSD", session: "London", result: "OPEN", pnl: "12.00" },
];

const model = buildPeriodAnalysis(rows as never, { accountName: "Blueberry live", rangeLabel: "2026-09-16 to 2026-09-18" });
const blocks = allBlocks(model);

describe("PDF period analysis", () => {
  it("is organised as four report pages, each answering one question", () => {
    expect(model.pages.map(page => page.title)).toEqual(["Performance overview", "Process & behaviour", "Psychology & mistakes", "Review summary"]);
    expect(model.pages.every(page => Boolean(page.caption) && Boolean(page.eyebrow))).toBe(true);
    expect(model.pages[3].twoColumn).toBe(true);
    expect(model.total).toBe(5);
    expect(model.closed).toBe(4);
  });

  it("reads every performance metric from the shared analysis engine", () => {
    const analysis = buildAnalysis(rows as never);
    const overview = analysis.overview;
    expect(metricValue(blocks, "Performance", "Net P&L")).toBe(formatMoney(overview.netPnl));
    expect(metricValue(blocks, "Performance", "Gross profit")).toBe(formatMoney(overview.grossProfit));
    expect(metricValue(blocks, "Performance", "Gross loss")).toBe(formatMoney(overview.grossLoss));
    expect(metricValue(blocks, "Performance", "Win rate")).toBe(`${overview.winRate.toFixed(1)}%`);
    expect(metricValue(blocks, "Performance", "Wins")).toBe(String(overview.wins));
    expect(metricValue(blocks, "Performance", "Losses")).toBe(String(overview.losses));
    expect(metricValue(blocks, "Performance", "Break-even")).toBe(String(overview.breakEven));
    expect(metricValue(blocks, "Performance", "Average win")).toBe(formatMoney(overview.averageWinner as number));
    expect(metricValue(blocks, "Performance", "Average loss")).toBe(formatMoney(overview.averageLoser as number));
    expect(metricValue(blocks, "Performance", "Profit factor")).toBe(overview.profitFactor?.toFixed(2));
    expect(metricValue(blocks, "Performance", "Expectancy")).toBe(formatMoney(overview.expectancy));
    expect(metricValue(blocks, "Performance", "Average R")).toBe(`+${(overview.averageR as number).toFixed(2)}R`);
    expect(metricValue(blocks, "Performance", "Total R")).toBe(`+${(overview.totalR as number).toFixed(2)}R`);
    expect(metricValue(blocks, "Performance", "Median R")).toBe(`+${(overview.medianR as number).toFixed(2)}R`);
    expect(metricValue(blocks, "Performance", "Median trade")).toBe(formatMoney(overview.medianPnl));
    expect(metricValue(blocks, "Performance", "Best trade")).toBe(formatMoney(overview.largestWinner as number));
    expect(metricValue(blocks, "Performance", "Worst trade")).toBe(formatMoney(overview.largestLoser as number));
    expect(metricValue(blocks, "Period", "Trades exported")).toBe("5");
    expect(metricValue(blocks, "Period", "Closed trades")).toBe("4");
    expect(metricValue(blocks, "Period", "Open trades")).toBe("1");
    expect(metricValue(blocks, "Period", "Account")).toBe("Blueberry live");
  });

  it("presents the period's headline figures as cards with a signed tone", () => {
    const kpis = findTable(blocks, "Session performance") ? blocks.find(block => block.kind === "kpis") : null;
    expect(kpis && kpis.kind === "kpis" ? kpis.items.map(item => item.label) : null).toEqual(["Net P&L", "Win rate", "Profit factor", "Expectancy", "Total R", "Max drawdown"]);
    const items = kpis && kpis.kind === "kpis" ? kpis.items : [];
    expect(items[0].tone).toBe("positive");
    expect(items[4].value).toBe(`+${(buildAnalysis(rows as never).overview.totalR as number).toFixed(2)}R`);
    expect(items[4].tone).toBe("positive");
  });

  it("uses the engine's own rows for every context table", () => {
    const analysis = buildAnalysis(rows as never);
    const sessionTable = findTable(blocks, "Session performance");
    expect(sessionTable?.rows.map(row => row[0])).toEqual(analysis.sessions.map(row => row.label));
    expect(sessionTable?.rows[0]).toEqual([
      "New York", String(analysis.sessions[0].sample), String(analysis.sessions[0].wins), String(analysis.sessions[0].losses),
      String(analysis.sessions[0].breakEven), `${analysis.sessions[0].winRate.toFixed(1)}%`, formatMoney(analysis.sessions[0].netPnl), formatMoney(analysis.sessions[0].averagePnl),
    ]);
    expect(findTable(blocks, "Direction performance")?.rows.map(row => row[0])).toEqual(analysis.directions.map(row => row.label));
    expect(findTable(blocks, "Setup performance")?.rows.map(row => row[0])).toEqual(analysis.setups.map(row => row.label));
    expect(findTable(blocks, "Timeframe performance")?.rows.map(row => row[0])).toEqual(analysis.timeframes.map(row => row.label));
    expect(findTable(blocks, "Session performance")?.rows).toHaveLength(3);
  });

  it("reports risk and drawdown only when the data supports it", () => {
    const analysis = buildAnalysis(rows as never);
    expect(metricValue(blocks, "Risk & drawdown", "Maximum drawdown")).toBe(`-${formatMoney(analysis.drawdown.maximum).replace("-", "")}`);
    expect(metricValue(blocks, "Risk & drawdown", "Longest win streak")).toBe(String(analysis.streaks.longestWin));
    expect(metricValue(blocks, "Risk & drawdown", "Longest loss streak")).toBe(String(analysis.streaks.longestLoss));
    expect(metricValue(blocks, "Risk & drawdown", "Average planned risk")).toBe(formatMoney(analysis.risk.average as number));
    expect(metricValue(blocks, "Risk & drawdown", "Risk consistency")).toBe(`${Math.round((analysis.risk.consistency as number) * 100)}%`);
  });

  it("keeps outcome and process separate using the shared classifier", () => {
    const classifications = rows.filter(row => row.result !== "OPEN").map(row => classifyTradeProcess(row as never).classification);
    const processTable = findTable(blocks, "Process classification");
    expect((processTable?.rows ?? []).reduce((sum, row) => sum + Number(row[1]), 0)).toBe(4);
    const expectedLabels = Array.from(new Set(classifications)).map(key => TRADE_CLASSIFICATION_LABELS[key as TradeClassification]).sort();
    expect(processTable?.rows.map(row => row[0]).sort()).toEqual(expectedLabels);
    expect(metricValue(blocks, "Plan & discipline", "Planned trades")).toBe("3");
    expect(metricValue(blocks, "Plan & discipline", "Unplanned trades")).toBe("1");
    const adherence = rows.map(row => classifyTradeProcess(row as never).ruleAdherence).filter((value): value is number => value != null);
    expect(metricValue(blocks, "Plan & discipline", "Rule adherence")).toBe(`${Math.round(adherence.reduce((sum, value) => sum + value, 0) / adherence.length)}%`);
    // (90% + 20% + 10% + 100%) / 4 checked items across the four closed trades.
    expect(metricValue(blocks, "Plan & discipline", "Checklist completion")).toBe("55.0%");
    expect(metricValue(blocks, "Plan & discipline", "Average patience score")).toBe("4.0 / 5");
    expect(findTable(blocks, "Execution type")?.rows.length).toBeGreaterThan(0);
    expect(findTable(blocks, "Hold quality")?.rows.length).toBeGreaterThan(0);
    expect(findTable(blocks, "Patience distribution")?.rows.map(row => row[0]).sort()).toEqual(["3 / 5", "4 / 5", "5 / 5"]);
  });

  it("lists the recorded mistakes, categories, and emotions from the engine's behaviour rows", () => {
    const analysis = buildAnalysis(rows as never);
    const mistakes = findTable(blocks, "Mistake / rule-break frequency");
    expect(mistakes?.rows.map(row => row[0])).toEqual(analysis.behavior.tags.map(row => row.label));
    expect(mistakes?.rows.every(row => Number(row[1]) >= 1)).toBe(true);
    // Category rows come from the taxonomy the app already assigns.
    const categoryTable = findTable(blocks, "Process, emotional, and environmental tags");
    expect(categoryTable?.rows.some(row => row[0] === "Emotional" && row[1] === "Impatience")).toBe(true);
    expect(categoryTable?.rows.some(row => row[0] === "Execution" && row[1] === "Closed early")).toBe(true);
    expect(categoryTable?.rows.some(row => row[0] === "Analytical" && row[1] === "Entered without confirmation")).toBe(true);
    const emotions = findTable(blocks, "Recorded emotions");
    expect(emotions?.rows).toHaveLength(analysis.behavior.emotions.length);
    expect(emotions?.rows.map(row => row[0])).toContain("Before");
    expect(emotions?.rows.some(row => row[1] === "Fear")).toBe(true);
    // A tag recorded on more than one trade is reported as a repeated pattern.
    expect(findTable(blocks, "Repeated behavioural patterns")?.rows.map(row => row[0])).toEqual(["Impatience"]);
    // A tag the taxonomy does not recognise is still reported, never dropped.
    const custom = buildPeriodAnalysis([{ ...rows[1], mistake: "Something new entirely" }] as never, { accountName: "A", rangeLabel: "B" });
    expect(findTable(allBlocks(custom), "Mistake / rule-break frequency")?.rows.map(row => row[0])).toEqual(["Something new entirely"]);
  });

  it("builds the daily table from the same day summaries the calendar uses", () => {
    const table = findTable(blocks, "Daily performance");
    const days = Array.from(groupTradesByPktDay(rows as never).entries()).sort(([a], [b]) => a.localeCompare(b));
    expect(table?.rows.length).toBe(days.length);
    days.forEach(([day, dayTrades], index) => {
      const summary = summarizeTradeRows(dayTrades as never[], day);
      expect(table?.rows[index]).toEqual([day, String(summary.count), String(summary.wins), String(summary.losses), String(summary.breakEven), `${summary.winRate.toFixed(1)}%`, formatMoney(summary.pnl)]);
    });
    expect(table?.rows[0][0]).toBe("2026-09-16");
  });

  it("renders — instead of a fake zero when a metric cannot be calculated", () => {
    const single = buildPeriodAnalysis([rows[0]] as never, { accountName: "A", rangeLabel: "B" });
    const singleBlocks = allBlocks(single);
    expect(metricValue(singleBlocks, "Performance", "Profit factor")).toBe(ANALYSIS_MISSING);
    expect(metricValue(singleBlocks, "Performance", "Average loss")).toBe(ANALYSIS_MISSING);
    expect(metricValue(singleBlocks, "Performance", "Worst trade")).toBe(ANALYSIS_MISSING);
    expect(metricValue(singleBlocks, "Risk & drawdown", "Maximum drawdown")).toBe(ANALYSIS_MISSING);
    expect(findTable(singleBlocks, "Direction performance")?.rows).toHaveLength(1);
    const empty = buildPeriodAnalysis([], { accountName: "A", rangeLabel: "B" });
    expect(metricValue(allBlocks(empty), "Performance", "Win rate")).toBe(ANALYSIS_MISSING);
    expect(findParagraph(allBlocks(empty), "Performance observations")?.[0]).toContain("No closed trades are available");
  });

  it("states only facts it can compute, with no psychological verdict", () => {
    expect(model.observations.map(group => group.title)).toEqual([
      "Performance observations", "Risk observations", "Execution observations", "Process observations", "Psychology observations", "Data-quality limitations",
    ]);
    const prose = model.observations.flatMap(group => group.lines).join(" ");
    expect(prose).toContain("2 of 4 closed trades were wins");
    expect(prose).toContain("New York");
    expect(prose).toContain("Rule adherence averaged");
    expect(prose).not.toMatch(/you are|emotionally|likely|probably|suggests that you|advice/i);
    expect(model.limitations.join(" ")).toContain("OPEN trades are excluded from performance metrics.");
  });

  it("builds the action list from recorded values with fixed rules", () => {
    expect(model.review.repeat.join(" ")).toContain("repeat this context");
    expect(model.review.review.join(" ")).toMatch(/review (those entries|those decisions)/);
    expect(model.review.watch.join(" ")).toContain("Longest losing streak");
    expect(model.review.watch.join(" ")).toContain("small sample");
    const joined = [...model.review.repeat, ...model.review.review, ...model.review.watch].join(" ");
    expect(joined).not.toMatch(/you are|your personality|emotionally unstable/i);
    // With no trades at all, every list still says something truthful.
    const empty = buildPeriodAnalysis([], { accountName: "A", rangeLabel: "B" });
    expect(empty.review.review).toEqual(["No closed trades are available for this period."]);
    expect(empty.review.repeat[0]).toContain("No context met the criteria");
    expect(empty.review.watch[0]).toContain("No watch-out threshold");
  });

  it("matches metricRow for an ad-hoc grouping so no private formula exists", () => {
    const grouped = metricRow("Manual direct", rows.filter(row => row.executionType === "Manual direct") as never);
    const matched = rows.filter(row => row.executionType === "Manual direct" && row.result !== "OPEN");
    expect(matched.length).toBe(grouped.sample);
    expect(formatMoney(grouped.netPnl)).toBe("$70.90");
    expect(findTable(blocks, "Execution type")?.rows).toContainEqual(["Manual direct", String(grouped.sample), `${grouped.winRate.toFixed(1)}%`, formatMoney(grouped.netPnl)]);
  });
});
