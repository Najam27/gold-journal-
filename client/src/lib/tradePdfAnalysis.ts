/**
 * The period analysis of the trade-log PDF.
 *
 * Existing requirement: the PDF's numbers must be the application's numbers. So
 * this module owns no formulas of its own — it calls the same
 * `@shared/analysisEngine` the Analysis page, the AI payload, and the server use,
 * and only *formats* the result as compact, printable report blocks. Grouped
 * tables are built with the engine's own `metricRow`, so a session's win rate in
 * the PDF is computed exactly like the session's win rate on screen.
 *
 * Everything is deterministic and offline: no AI call, no network request, and no
 * metric is invented. A value the data cannot support renders `—`; it never
 * renders a fake zero.
 */

import { buildAnalysis, metricRow, type AnalysisTrade, type MetricRow } from "@shared/analysisEngine";
import { TRADE_CLASSIFICATION_LABELS, classifyTradeProcess, type TradeClassification } from "@/lib/psychology";
import { violationTags } from "@shared/psychologyEngine";
import { groupTradesByPktDay, summarizeTradeRows } from "@/lib/performanceSummary";
import { checklistCompletionRatio } from "@/lib/tradePdfModel";
import { formatMoney } from "@/lib/gold";

/** Rendered when a metric cannot be calculated from the selected trades. */
export const ANALYSIS_MISSING = "—";

export type AnalysisMetric = { label: string; value: string };
export type AnalysisColumn = { label: string; flex: number; align?: "left" | "right" };
export type AnalysisTable = { title: string; columns: AnalysisColumn[]; rows: string[][]; empty: string };

export type AnalysisBlock =
  | { kind: "heading"; title: string }
  | { kind: "metrics"; title: string; items: AnalysisMetric[] }
  | { kind: "table"; table: AnalysisTable }
  | { kind: "tableRow"; tables: AnalysisTable[] }
  | { kind: "paragraph"; title?: string; lines: string[]; flow?: boolean };

export type PeriodAnalysis = {
  blocks: AnalysisBlock[];
  /** Total trades handed to the analysis, including open positions. */
  total: number;
  /** Closed trades only, the sample every rate below is computed against. */
  closed: number;
};

export type PeriodAnalysisOptions = { accountName: string; rangeLabel: string };

/* ------------------------------------------------------------------ *
 * Formatting helpers (presentation only — never recalculation)
 * ------------------------------------------------------------------ */

const money = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : formatMoney(value));
const count = (value: number | null | undefined) => (value == null ? ANALYSIS_MISSING : String(value));
const rate = (value: number | null | undefined, sample: number) => (value == null || !sample ? ANALYSIS_MISSING : `${value.toFixed(1)}%`);
const decimal = (value: number | null | undefined, digits = 2) => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : value.toFixed(digits));
const factor = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : value.toFixed(2));
const rMultiple = (value: number | null | undefined) => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`);
const clean = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");

/** Picks the label of the row with the largest absolute net P&L, if any. */
function topByAbsolutePnl(rows: MetricRow[]) {
  return [...rows].filter(row => row.sample > 0).sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl))[0] ?? null;
}

/**
 * Groups trades by one field and scores each group with the engine's `metricRow`,
 * which is the same calculator the Analysis page renders. Open trades are
 * excluded from performance groupings because they have no outcome yet.
 */
function groupedMetricRows(trades: AnalysisTrade[], field: string): MetricRow[] {
  const groups = new Map<string, AnalysisTrade[]>();
  for (const trade of trades) {
    if (clean(trade.result) === "OPEN") continue;
    const value = clean((trade as Record<string, unknown>)[field]);
    if (!value) continue;
    const rows = groups.get(value) ?? [];
    rows.push(trade);
    groups.set(value, rows);
  }
  return Array.from(groups.entries())
    .map(([label, rows]) => metricRow(label, rows))
    .sort((a, b) => b.sample - a.sample || b.netPnl - a.netPnl || a.label.localeCompare(b.label));
}

function table(title: string, columns: AnalysisColumn[], build: () => { rows: string[][]; empty: string }): AnalysisTable {
  const { rows, empty } = build();
  return { title, columns, rows, empty };
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Builds every block the PDF analysis pages draw, from the exported trade set.
 * The trade rows are handed to the shared engine untouched, so filtering,
 * win-rate, drawdown, and edge definitions match the application exactly.
 */
export function buildPeriodAnalysis(trades: Record<string, unknown>[], options: PeriodAnalysisOptions): PeriodAnalysis {
  const rows = trades as unknown as AnalysisTrade[];
  const analysis = buildAnalysis(rows);
  const overview = analysis.overview;
  const closed = overview.sample;

  /* ---- period ---- */
  const dates = trades
    .map(trade => new Date(String((trade as { tradeDate?: unknown }).tradeDate ?? "")))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const dayKeys = Array.from(groupTradesByPktDay(trades as never).keys()).sort();
  const periodMetrics: AnalysisMetric[] = [
    { label: "Account", value: options.accountName },
    { label: "Start date", value: dates.length ? dayKeys[0] : ANALYSIS_MISSING },
    { label: "End date", value: dates.length ? dayKeys[dayKeys.length - 1] : ANALYSIS_MISSING },
    { label: "Trades exported", value: String(trades.length) },
    { label: "Closed trades", value: count(closed) },
    { label: "Open trades", value: String(Math.max(0, trades.length - closed)) },
    { label: "Active days", value: count(analysis.behavior.activity.activeDays) },
  ];

  /* ---- performance ---- */
  const performanceMetrics: AnalysisMetric[] = [
    { label: "Net P&L", value: money(overview.netPnl) },
    { label: "Gross profit", value: money(overview.grossProfit) },
    { label: "Gross loss", value: money(overview.grossLoss) },
    { label: "Profit factor", value: factor(overview.profitFactor) },
    { label: "Win rate", value: rate(overview.winRate, closed) },
    { label: "Wins", value: count(overview.wins) },
    { label: "Losses", value: count(overview.losses) },
    { label: "Break-even", value: count(overview.breakEven) },
    { label: "Average win", value: money(overview.averageWinner) },
    { label: "Average loss", value: money(overview.averageLoser) },
    { label: "Expectancy", value: money(closed ? overview.expectancy : null) },
    { label: "Average R", value: rMultiple(overview.averageR) },
    { label: "Total R", value: rMultiple(overview.totalR) },
    { label: "Median R", value: rMultiple(overview.medianR) },
    { label: "Best trade", value: money(overview.largestWinner) },
    { label: "Worst trade", value: money(overview.largestLoser) },
    { label: "Win rate range (95%)", value: closed ? `${overview.winRateInterval[0].toFixed(1)}% – ${overview.winRateInterval[1].toFixed(1)}%` : ANALYSIS_MISSING },
  ];

  /* ---- risk & drawdown ---- */
  const drawdownAvailable = closed >= 2;
  const riskMetrics: AnalysisMetric[] = [
    { label: "Maximum drawdown", value: drawdownAvailable ? money(analysis.drawdown.maximum) : ANALYSIS_MISSING },
    { label: "Average drawdown", value: drawdownAvailable ? money(analysis.drawdown.average) : ANALYSIS_MISSING },
    { label: "Drawdown episodes", value: drawdownAvailable ? count(analysis.drawdown.count) : ANALYSIS_MISSING },
    { label: "Longest drawdown", value: drawdownAvailable ? `${analysis.drawdown.durationTrades} trades` : ANALYSIS_MISSING },
    { label: "Longest win streak", value: count(analysis.streaks.longestWin) },
    { label: "Longest loss streak", value: count(analysis.streaks.longestLoss) },
    { label: "Average planned risk", value: money(analysis.risk.average) },
    { label: "Median planned risk", value: money(analysis.risk.median) },
    { label: "Risk consistency", value: analysis.risk.consistency == null ? ANALYSIS_MISSING : `${Math.round(analysis.risk.consistency * 100)}%` },
    { label: "Risk after a win", value: money(analysis.risk.afterWins) },
    { label: "Risk after a loss", value: money(analysis.risk.afterLosses) },
    { label: "Average planned R", value: rMultiple(analysis.execution.averagePlannedR) },
    { label: "Average actual R", value: rMultiple(analysis.execution.averageActualR) },
  ];

  /* ---- discipline & process ---- */
  // Behavioural metrics describe closed trades, exactly like the app's engine: an
  // open position has no outcome to judge and would distort the rates.
  const closedTrades = trades.filter(trade => clean((trade as { result?: unknown }).result).toUpperCase() !== "OPEN");
  const processAssessments = closedTrades.map(trade => classifyTradeProcess(trade as never));
  const evaluated = processAssessments.filter(item => !item.notEvaluated);
  const adherence = evaluated.map(item => item.ruleAdherence).filter((value): value is number => value != null);
  const checklistRatios = closedTrades.map(trade => checklistCompletionRatio((trade as { planChecklist?: unknown }).planChecklist)).filter((value): value is NonNullable<typeof value> => value !== null);
  const patienceValues = closedTrades.map(trade => Number((trade as { patienceScore?: unknown }).patienceScore)).filter(value => Number.isFinite(value) && value > 0);
  const planStatusOf = (trade: Record<string, unknown>) => clean(trade.planStatus).toUpperCase();
  const planned = closedTrades.filter(trade => planStatusOf(trade) === "PLANNED").length;
  const unplanned = closedTrades.filter(trade => planStatusOf(trade) === "UNPLANNED").length;
  const notEvaluated = closedTrades.length - planned - unplanned;
  const ruleBreaks = evaluated.filter(item => item.violations.length > 0).length;
  const averageOf = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const averageChecklist = averageOf(checklistRatios.map(ratio => ratio.percentage));
  const averagePatience = averageOf(patienceValues);

  const disciplineMetrics: AnalysisMetric[] = [
    { label: "Planned trades", value: String(planned) },
    { label: "Unplanned trades", value: String(unplanned) },
    { label: "Plan not stated", value: String(Math.max(0, notEvaluated)) },
    { label: "Rule adherence", value: adherence.length ? `${Math.round(averageOf(adherence) as number)}%` : ANALYSIS_MISSING },
    { label: "Trades with rule breaks", value: String(ruleBreaks) },
    { label: "Average checklist completion", value: averageChecklist == null ? ANALYSIS_MISSING : `${averageChecklist.toFixed(1)}%` },
    { label: "Average patience score", value: averagePatience == null ? ANALYSIS_MISSING : `${averagePatience.toFixed(1)} / 5` },
  ];

  /* ---- process classification (outcome vs process) ---- */
  const classificationGroups = new Map<string, AnalysisTrade[]>();
  for (let index = 0; index < closedTrades.length; index += 1) {
    const label = processAssessments[index].classification;
    const rows = classificationGroups.get(label) ?? [];
    rows.push(closedTrades[index] as AnalysisTrade);
    classificationGroups.set(label, rows);
  }
  const classificationRows = Array.from(classificationGroups.entries())
    .map(([classification, group]) => metricRow(TRADE_CLASSIFICATION_LABELS[classification as TradeClassification] ?? classification, group))
    .sort((a, b) => b.sample - a.sample || a.label.localeCompare(b.label));

  /* ---- sessions / directions / setups / timeframes ---- */
  const sessionsTable = table("Session analysis", [
    { label: "Session", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "BE", flex: 1, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
    { label: "Avg P&L", flex: 1.4, align: "right" },
  ], () => ({
    rows: analysis.sessions.map(row => [row.label, String(row.sample), String(row.wins), String(row.losses), String(row.breakEven), money(row.netPnl), money(row.averagePnl)]),
    empty: "No closed trade carries a session value for this period.",
  }));

  const directionsTable = table("Direction analysis", [
    { label: "Direction", flex: 1.4 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "BE", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: analysis.directions.map(row => [row.label, String(row.sample), String(row.wins), String(row.losses), String(row.breakEven), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No closed trade carries a direction value for this period.",
  }));

  const setupsTable = table("Setup analysis", [
    { label: "Setup", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
    { label: "Avg R", flex: 1.2, align: "right" },
  ], () => ({
    rows: analysis.setups.map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl), rMultiple(row.averageR)]),
    empty: "No closed trade carries a setup value for this period.",
  }));

  const timeframesTable = table("Timeframe analysis", [
    { label: "Timeframe", flex: 1.4 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: analysis.timeframes.map(row => [row.label, String(row.sample), String(row.wins), String(row.losses), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No closed trade carries a timeframe value for this period.",
  }));

  const executionTypesTable = table("Execution type", [
    { label: "Execution type", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => {
    const grouped = groupedMetricRows(rows, "executionType");
    return { rows: grouped.map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]), empty: "No closed trade carries an execution type for this period." };
  });

  const holdQualityTable = table("Hold quality", [
    { label: "Hold quality", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: groupedMetricRows(rows, "holdQuality").map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No closed trade carries a hold quality for this period.",
  }));

  const processTable = table("Process classification", [
    { label: "Classification", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: classificationRows.map(row => [row.label, String(row.sample), money(row.netPnl)]),
    empty: "No behavioural data was saved for these trades.",
  }));

  /* ---- behaviour ---- */
  const mistakesTable = table("Mistake / rule-break tags", [
    { label: "Tag", flex: 3 },
    { label: "Occurrences", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: analysis.behavior.tags.map(row => [row.label, String(row.sample), money(row.netPnl)]),
    empty: "No mistake or rule-break tag was recorded for this period.",
  }));

  const emotionsTable = table("Recorded emotions", [
    { label: "Stage", flex: 1.2 },
    { label: "Emotion", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: analysis.behavior.emotions.map(row => {
      const [stage, ...rest] = row.label.split(": ");
      return [stage, rest.join(": ") || ANALYSIS_MISSING, String(row.sample), money(row.netPnl)];
    }),
    empty: "No emotion field was saved for this period.",
  }));

  const patienceTable = table("Patience score distribution", [
    { label: "Patience", flex: 1.2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => {
    const grouped = groupedMetricRows(rows, "patienceScore");
    return { rows: grouped.map(row => [`${row.label} / 5`, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]), empty: "No patience score was saved for this period." };
  });

  /* ---- daily performance ---- */
  const dailyGroups = groupTradesByPktDay(trades as never);
  const dailyRows = Array.from(dailyGroups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayTrades]) => {
      const summary = summarizeTradeRows(dayTrades as never[], day);
      return [day, String(summary.count), String(summary.wins), String(summary.losses), String(summary.breakEven), money(summary.pnl)];
    });
  const dailyTable = table("Daily performance", [
    { label: "Date (PKT)", flex: 1.6 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "BE", flex: 1, align: "right" },
    { label: "Daily P&L", flex: 1.6, align: "right" },
  ], () => ({ rows: dailyRows, empty: "No trades were exported." }));

  /* ---- observations (deterministic sentences only) ---- */
  // Only deterministic statements built from the numbers above: no inference, no
  // psychological conclusion, and nothing the data does not literally support.
  const observations: string[] = [];
  if (closed) {
    observations.push(`${overview.wins} of ${closed} closed trade${closed === 1 ? " was a win" : "s were wins"} (${rate(overview.winRate, closed)} win rate); ${overview.losses} lost and ${overview.breakEven} finished break-even, for ${money(overview.netPnl)} net.`);
    if (overview.profitFactor != null) observations.push(`Profit factor ${overview.profitFactor.toFixed(2)} on ${money(overview.grossProfit)} gross profit and ${money(overview.grossLoss)} gross loss; average win ${money(overview.averageWinner)} against average loss ${money(overview.averageLoser)}.`);
    const topSession = topByAbsolutePnl(analysis.sessions);
    if (topSession) observations.push(`${topSession.label} accounted for ${money(topSession.netPnl)} of net P&L over ${topSession.sample} trade${topSession.sample === 1 ? "" : "s"}.`);
    const topSetup = topByAbsolutePnl(analysis.setups);
    if (topSetup) observations.push(`Most used setup context: ${topSetup.label} with ${topSetup.sample} trade${topSetup.sample === 1 ? "" : "s"} and ${money(topSetup.netPnl)} net P&L.`);
    if (adherence.length) observations.push(`Rule adherence averaged ${Math.round(averageOf(adherence) as number)}% across ${adherence.length} evaluated trade${adherence.length === 1 ? "" : "s"}${ruleBreaks ? `; rule breaks were recorded on ${ruleBreaks}` : "; no rule break was recorded"}.`);
    if (analysis.behavior.tags.length) observations.push(`${analysis.behavior.tags.reduce((sum, row) => sum + row.sample, 0)} tagged observations across ${analysis.behavior.tags.length} distinct tag${analysis.behavior.tags.length === 1 ? "" : "s"}; an emotion was recorded on ${analysis.behavior.coverage.emotionTaggedTrades} of ${closed} closed trade${closed === 1 ? "" : "s"}.`);
    if (analysis.risk.average != null) observations.push(`Average planned risk ${money(analysis.risk.average)} per trade${analysis.risk.consistency == null ? "" : `, size consistency ${Math.round(analysis.risk.consistency * 100)}%`}; ${analysis.behavior.activity.activeDays} active day${analysis.behavior.activity.activeDays === 1 ? "" : "s"} with at most ${analysis.behavior.activity.maxTradesInDay} trade${analysis.behavior.activity.maxTradesInDay === 1 ? "" : "s"} in a day.`);
    if (drawdownAvailable) observations.push(`Maximum closed-trade equity drawdown ${money(analysis.drawdown.maximum)} over ${analysis.drawdown.durationTrades} trade${analysis.drawdown.durationTrades === 1 ? "" : "s"}.`);
    const positiveDays = dailyRows.filter(row => !row[5].startsWith("-") && row[5] !== ANALYSIS_MISSING).length;
    observations.push(`${positiveDays} of ${dailyRows.length} trading day${dailyRows.length === 1 ? "" : "s"} finished flat or positive.`);
  } else {
    observations.push("No closed trades are available for this period, so performance metrics are not calculated.");
  }

  const limitations: string[] = [...analysis.warnings];
  for (const note of analysis.behavior.limitations) limitations.push(note);
  if (!drawdownAvailable && closed) limitations.push("Drawdown data unavailable for the selected period: fewer than two closed trades were exported.");
  if (analysis.mfeMae.unavailable) limitations.push(analysis.mfeMae.message);
  if (overview.profitFactor == null && closed) limitations.push("Profit factor is unavailable because no losing trade was recorded in this period.");
  if (!checklistRatios.length) limitations.push("No pre-trade checklist was saved on these trades, so checklist completion is unavailable.");
  if (processAssessments.some(item => item.notEvaluated)) limitations.push(`${processAssessments.filter(item => item.notEvaluated).length} trade(s) carry no behavioural field (typical for MT5 imports), so process metrics exclude them.`);

  const blocks: AnalysisBlock[] = [
    { kind: "heading", title: "Period" },
    { kind: "metrics", title: "Period", items: periodMetrics },
    { kind: "heading", title: "Performance overview" },
    { kind: "metrics", title: "Performance overview", items: performanceMetrics },
    { kind: "heading", title: "Risk & drawdown" },
    { kind: "metrics", title: "Risk & drawdown", items: riskMetrics },
    { kind: "heading", title: "Performance by context" },
    { kind: "tableRow", tables: [sessionsTable, directionsTable] },
    { kind: "tableRow", tables: [setupsTable, timeframesTable] },
    { kind: "heading", title: "Plan & discipline" },
    { kind: "metrics", title: "Plan & discipline", items: disciplineMetrics },
    { kind: "heading", title: "Process & behaviour" },
    { kind: "tableRow", tables: [processTable, executionTypesTable] },
    { kind: "tableRow", tables: [holdQualityTable, patienceTable] },
    { kind: "tableRow", tables: [mistakesTable, emotionsTable] },
    { kind: "table", table: dailyTable },
    { kind: "paragraph", title: "Period observations", lines: observations },
    // Limitations are diagnostics rather than report content, so they are set as
    // one flowing paragraph: same statements, far less vertical space.
    { kind: "paragraph", title: "Data quality & limitations", flow: true, lines: limitations.length ? limitations : ["Every metric above was calculated from the exported trades with no missing-field warnings."] },
  ];

  return { blocks, total: trades.length, closed };
}

/* ------------------------------------------------------------------ *
 * Test/lookup helpers
 * ------------------------------------------------------------------ */

export function findMetrics(blocks: AnalysisBlock[], title: string): AnalysisMetric[] | null {
  const block = blocks.find(entry => entry.kind === "metrics" && entry.title === title);
  return block && block.kind === "metrics" ? block.items : null;
}

export function metricValue(blocks: AnalysisBlock[], title: string, label: string): string | null {
  return findMetrics(blocks, title)?.find(item => item.label === label)?.value ?? null;
}

export function findTable(blocks: AnalysisBlock[], title: string): AnalysisTable | null {
  for (const block of blocks) {
    if (block.kind === "table" && block.table.title === title) return block.table;
    if (block.kind === "tableRow") {
      const match = block.tables.find(entry => entry.title === title);
      if (match) return match;
    }
  }
  return null;
}

export function findParagraph(blocks: AnalysisBlock[], title: string): string[] | null {
  const block = blocks.find(entry => entry.kind === "paragraph" && entry.title === title);
  return block && block.kind === "paragraph" ? block.lines : null;
}
