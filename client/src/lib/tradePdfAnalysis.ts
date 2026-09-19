/**
 * The period analysis of the trade-log report.
 *
 * The report's numbers must be the application's numbers, so this module owns no
 * performance formula of its own: it calls the same `@shared/analysisEngine` the
 * Analysis page, the AI payload, and the server use, and only *formats* the
 * result into report pages. Grouped tables are built with the engine's own
 * `metricRow`, so a session's win rate in the report is computed exactly like the
 * session's win rate on screen.
 *
 * The output is deliberately page-shaped — performance, process, psychology, and
 * review — so the renderer never has to decide what belongs together, and the
 * review lists are derived from recorded values by fixed rules. No metric is
 * invented, nothing is inferred about the trader, and a value the data cannot
 * support renders `—`; it never renders a fake zero.
 */

import { buildAnalysis, metricRow, type AnalysisTrade, type MetricRow } from "@shared/analysisEngine";
import { MISTAKE_BY_TAG, TRADE_CLASSIFICATION_LABELS, classifyTradeProcess, detectBehavioralTags, type TradeClassification } from "@/lib/psychology";
import type { MistakeCategory } from "@shared/psychologyEngine";
import { groupTradesByPktDay, summarizeTradeRows } from "@/lib/performanceSummary";
import { checklistCompletionRatio, type TradePdfTone } from "@/lib/tradePdfModel";
import { formatMoney } from "@/lib/gold";

/** Rendered when a metric cannot be calculated from the selected trades. */
export const ANALYSIS_MISSING = "—";

export type AnalysisMetric = { label: string; value: string; tone?: TradePdfTone };
export type AnalysisColumn = { label: string; flex: number; align?: "left" | "right" };
export type AnalysisTable = { title: string; columns: AnalysisColumn[]; rows: string[][]; empty: string };

export type AnalysisBlock =
  | { kind: "heading"; title: string }
  | { kind: "kpis"; title: string; items: AnalysisMetric[] }
  | { kind: "metrics"; title: string; items: AnalysisMetric[] }
  | { kind: "table"; table: AnalysisTable }
  | { kind: "tableRow"; tables: AnalysisTable[] }
  | { kind: "paragraph"; title?: string; lines: string[]; flow?: boolean };

/**
 * One page of the analysis section, with its own heading and question.
 * `twoColumn` lays the page's prose blocks out in two balanced columns, which is
 * how the review page stays readable on a single sheet.
 */
export type AnalysisPage = { eyebrow: string; title: string; caption: string; blocks: AnalysisBlock[]; twoColumn?: boolean };

/** What the trader should act on, derived from the recorded values by fixed rules. */
export type AnalysisReview = { repeat: string[]; review: string[]; watch: string[] };

export type AnalysisObservationGroup = { title: string; lines: string[] };

export type PeriodAnalysis = {
  pages: AnalysisPage[];
  total: number;
  /** Closed trades only: the sample every rate below is computed against. */
  closed: number;
  review: AnalysisReview;
  observations: AnalysisObservationGroup[];
  limitations: string[];
};

export type PeriodAnalysisOptions = { accountName: string; rangeLabel: string };

/* ------------------------------------------------------------------ *
 * Formatting helpers (presentation only — never recalculation)
 * ------------------------------------------------------------------ */

const money = (value: number | null | undefined): string => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : formatMoney(value));
const count = (value: number | null | undefined): string => (value == null ? ANALYSIS_MISSING : String(value));
const rate = (value: number | null | undefined, sample: number): string => (value == null || !sample ? ANALYSIS_MISSING : `${value.toFixed(1)}%`);
const factor = (value: number | null | undefined): string => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : value.toFixed(2));
const rMultiple = (value: number | null | undefined): string => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`);
const percent = (value: number | null | undefined, digits = 1): string => (value == null || !Number.isFinite(value) ? ANALYSIS_MISSING : `${value.toFixed(digits)}%`);
const clean = (value: unknown): string => String(value ?? "").trim().replace(/\s+/g, " ");
const toneFor = (value: number): TradePdfTone => (value > 0 ? "positive" : value < 0 ? "negative" : "neutral");

/** Picks the row with the largest absolute net P&L, if any. */
function topByAbsolutePnl(rows: MetricRow[]) {
  return [...rows].filter(row => row.sample > 0).sort((a, b) => Math.abs(b.netPnl) - Math.abs(a.netPnl))[0] ?? null;
}

/**
 * Groups trades by one field and scores each group with the engine's `metricRow`,
 * the same calculator the Analysis page renders. Open trades are excluded from
 * performance groupings because they have no outcome yet.
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

/** A metric whose tone follows the sign of the number it shows. */
function signed(label: string, value: number | null | undefined, format: (value: number) => string): AnalysisMetric {
  if (value == null || !Number.isFinite(value)) return { label, value: ANALYSIS_MISSING };
  return { label, value: format(value), tone: toneFor(value) };
}

/** Groups the recorded mistake tags by the taxonomy category the app already assigns. */
function categoryTagRows(trades: AnalysisTrade[]): Array<{ category: MistakeCategory; label: string; occurrences: number; netPnl: number }> {
  const groups = new Map<string, { category: MistakeCategory; label: string; rows: AnalysisTrade[] }>();
  for (const trade of trades) {
    if (clean(trade.result) === "OPEN") continue;
    const { tags } = detectBehavioralTags(trade.mistake);
    for (const tag of tags) {
      const definition = MISTAKE_BY_TAG[tag];
      if (!definition) continue;
      const key = `${definition.category}|${tag}`;
      const entry = groups.get(key) ?? { category: definition.category, label: definition.label, rows: [] };
      entry.rows.push(trade);
      groups.set(key, entry);
    }
  }
  return Array.from(groups.values())
    .map(entry => ({ category: entry.category, label: entry.label, occurrences: entry.rows.length, netPnl: metricRow(entry.label, entry.rows).netPnl }))
    .sort((a, b) => b.occurrences - a.occurrences || a.label.localeCompare(b.label));
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

/**
 * Builds every analysis page from the exported trade set. The trade rows are
 * handed to the shared engine untouched, so filtering, win-rate, drawdown, edge,
 * and behaviour definitions match the application exactly.
 */
export function buildPeriodAnalysis(trades: Record<string, unknown>[], options: PeriodAnalysisOptions): PeriodAnalysis {
  const rows = trades as unknown as AnalysisTrade[];
  const analysis = buildAnalysis(rows);
  const overview = analysis.overview;
  const closed = overview.sample;
  const closedTrades = rows.filter(trade => clean((trade as { result?: unknown }).result).toUpperCase() !== "OPEN");

  /* ---- period ---- */
  const dayKeys = Array.from(groupTradesByPktDay(trades as never).keys()).sort();
  const periodMetrics: AnalysisMetric[] = [
    { label: "Account", value: options.accountName },
    { label: "Start date", value: dayKeys[0] ?? ANALYSIS_MISSING },
    { label: "End date", value: dayKeys[dayKeys.length - 1] ?? ANALYSIS_MISSING },
    { label: "Trades exported", value: String(trades.length) },
    { label: "Closed trades", value: count(closed) },
    { label: "Open trades", value: String(Math.max(0, trades.length - closed)) },
    { label: "Active days", value: count(analysis.behavior.activity.activeDays) },
    { label: "Selected period", value: options.rangeLabel },
  ];

  // The six headline figures of the period, presented as cards.
  const kpis: AnalysisMetric[] = [
    signed("Net P&L", closed ? overview.netPnl : null, value => formatMoney(value)),
    { label: "Win rate", value: rate(overview.winRate, closed) },
    { label: "Profit factor", value: factor(overview.profitFactor) },
    signed("Expectancy", closed ? overview.expectancy : null, value => formatMoney(value)),
    signed("Total R", overview.totalR, value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`),
    { label: "Max drawdown", value: closed >= 2 ? money(analysis.drawdown.maximum) : ANALYSIS_MISSING, tone: "negative" },
  ];

  /* ---- performance ---- */
  const performanceMetrics: AnalysisMetric[] = [
    signed("Net P&L", closed ? overview.netPnl : null, value => formatMoney(value)),
    { label: "Gross profit", value: money(overview.grossProfit) },
    { label: "Gross loss", value: money(overview.grossLoss) },
    { label: "Profit factor", value: factor(overview.profitFactor) },
    { label: "Win rate", value: rate(overview.winRate, closed) },
    { label: "Wins", value: count(overview.wins) },
    { label: "Losses", value: count(overview.losses) },
    { label: "Break-even", value: count(overview.breakEven) },
    signed("Average win", overview.averageWinner, value => formatMoney(value)),
    signed("Average loss", overview.averageLoser, value => formatMoney(value)),
    { label: "Expectancy", value: closed ? money(overview.expectancy) : ANALYSIS_MISSING },
    signed("Average R", overview.averageR, value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`),
    signed("Total R", overview.totalR, value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`),
    signed("Median R", overview.medianR, value => `${value >= 0 ? "+" : ""}${value.toFixed(2)}R`),
    signed("Best trade", overview.largestWinner, value => formatMoney(value)),
    signed("Worst trade", overview.largestLoser, value => formatMoney(value)),
    { label: "Win rate range (95%)", value: closed ? `${overview.winRateInterval[0].toFixed(1)}% – ${overview.winRateInterval[1].toFixed(1)}%` : ANALYSIS_MISSING },
    { label: "Median trade", value: closed ? money(overview.medianPnl) : ANALYSIS_MISSING },
    { label: "Data completeness", value: percent(overview.dataCompleteness, 0) },
  ];

  /* ---- risk & drawdown ---- */
  const drawdownAvailable = closed >= 2;
  const riskMetrics: AnalysisMetric[] = [
    signed("Maximum drawdown", drawdownAvailable ? analysis.drawdown.maximum : null, value => value > 0 ? `-${formatMoney(value).replace("-", "")}` : formatMoney(value)),
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

  /* ---- process ---- */
  const processAssessments = closedTrades.map(trade => classifyTradeProcess(trade as never));
  const evaluated = processAssessments.filter(item => !item.notEvaluated);
  const adherence = evaluated.map(item => item.ruleAdherence).filter((value): value is number => value != null);
  const checklistRatios = closedTrades.map(trade => checklistCompletionRatio((trade as { planChecklist?: unknown }).planChecklist)).filter((value): value is NonNullable<typeof value> => value !== null);
  const patienceValues = closedTrades.map(trade => Number((trade as { patienceScore?: unknown }).patienceScore)).filter(value => Number.isFinite(value) && value > 0);
  const planStatusOf = (trade: Record<string, unknown>) => clean(trade.planStatus).toUpperCase();
  const planned = closedTrades.filter(trade => planStatusOf(trade) === "PLANNED").length;
  const unplanned = closedTrades.filter(trade => planStatusOf(trade) === "UNPLANNED").length;
  const planNotStated = closedTrades.length - planned - unplanned;
  const ruleBreaks = evaluated.filter(item => item.violations.length > 0).length;
  const averageOf = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const averageAdherence = averageOf(adherence);
  const averageChecklist = averageOf(checklistRatios.map(ratio => ratio.percentage));
  const averagePatience = averageOf(patienceValues);

  const disciplineMetrics: AnalysisMetric[] = [
    { label: "Planned trades", value: String(planned) },
    { label: "Unplanned trades", value: String(unplanned) },
    { label: "Plan not stated", value: String(Math.max(0, planNotStated)) },
    { label: "Rule adherence", value: averageAdherence == null ? ANALYSIS_MISSING : `${Math.round(averageAdherence)}%` },
    { label: "Trades with rule breaks", value: String(ruleBreaks) },
    { label: "Checklist completion", value: percent(averageChecklist) },
    { label: "Average patience score", value: averagePatience == null ? ANALYSIS_MISSING : `${averagePatience.toFixed(1)} / 5` },
    { label: "Evaluated trades", value: String(evaluated.length) },
  ];

  const classificationGroups = new Map<string, AnalysisTrade[]>();
  for (let index = 0; index < closedTrades.length; index += 1) {
    const label = processAssessments[index].classification;
    const bucket = classificationGroups.get(label) ?? [];
    bucket.push(closedTrades[index] as AnalysisTrade);
    classificationGroups.set(label, bucket);
  }
  const classificationRows = Array.from(classificationGroups.entries())
    .map(([classification, group]) => metricRow(TRADE_CLASSIFICATION_LABELS[classification as TradeClassification] ?? classification, group))
    .sort((a, b) => b.sample - a.sample || a.label.localeCompare(b.label));

  /* ---- tables ---- */
  const sessionsTable = table("Session performance", [
    { label: "Session", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "BE", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
    { label: "Avg P&L", flex: 1.4, align: "right" },
  ], () => ({
    rows: analysis.sessions.map(row => [row.label, String(row.sample), String(row.wins), String(row.losses), String(row.breakEven), rate(row.winRate, row.sample), money(row.netPnl), money(row.averagePnl)]),
    empty: "No closed trade carries a session value for this period.",
  }));

  const directionsTable = table("Direction performance", [
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

  const timeframesTable = table("Timeframe performance", [
    { label: "Timeframe", flex: 1.4 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
    { label: "Avg R", flex: 1.2, align: "right" },
  ], () => ({
    rows: analysis.timeframes.map(row => [row.label, String(row.sample), String(row.wins), String(row.losses), rate(row.winRate, row.sample), money(row.netPnl), rMultiple(row.averageR)]),
    empty: "No closed trade carries a timeframe value for this period.",
  }));

  const setupsTable = table("Setup performance", [
    { label: "Setup", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
    { label: "Avg R", flex: 1.2, align: "right" },
  ], () => ({
    rows: analysis.setups.map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl), rMultiple(row.averageR)]),
    empty: "No closed trade carries a setup value for this period.",
  }));

  const dailyGroups = groupTradesByPktDay(trades as never);
  const dailyRows = Array.from(dailyGroups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, dayTrades]) => {
      const summary = summarizeTradeRows(dayTrades as never[], day);
      return [day, String(summary.count), String(summary.wins), String(summary.losses), String(summary.breakEven), rate(summary.winRate, summary.count), money(summary.pnl)];
    });
  const dailyTable = table("Daily performance", [
    { label: "Date (PKT)", flex: 1.6 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Wins", flex: 1, align: "right" },
    { label: "Losses", flex: 1, align: "right" },
    { label: "BE", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Daily P&L", flex: 1.6, align: "right" },
  ], () => ({ rows: dailyRows, empty: "No trades were exported." }));

  const processTable = table("Process classification", [
    { label: "Classification", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: classificationRows.map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No behavioural data was saved for these trades.",
  }));

  const executionTypesTable = table("Execution type", [
    { label: "Execution type", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: groupedMetricRows(rows, "executionType").map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No closed trade carries an execution type for this period.",
  }));

  const holdQualityTable = table("Hold quality", [
    { label: "Hold quality", flex: 2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: groupedMetricRows(rows, "holdQuality").map(row => [row.label, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No closed trade carries a hold quality for this period.",
  }));

  const patienceTable = table("Patience distribution", [
    { label: "Patience", flex: 1.2 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Win rate", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: groupedMetricRows(rows, "patienceScore").map(row => [`${row.label} / 5`, String(row.sample), rate(row.winRate, row.sample), money(row.netPnl)]),
    empty: "No patience score was saved for this period.",
  }));

  const mistakesTable = table("Mistake / rule-break frequency", [
    { label: "Tag", flex: 3 },
    { label: "Occurrences", flex: 1.3, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: analysis.behavior.tags.map(row => [row.label, String(row.sample), money(row.netPnl)]),
    empty: "No mistake or rule-break tag was recorded for this period.",
  }));

  const categoryRows = categoryTagRows(rows);
  const categoryTable = table("Process, emotional, and environmental tags", [
    { label: "Category", flex: 1.2 },
    { label: "Recorded tag", flex: 2.4 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Net P&L", flex: 1.4, align: "right" },
  ], () => ({
    rows: categoryRows.map(row => [row.category.charAt(0) + row.category.slice(1).toLowerCase(), row.label, String(row.occurrences), money(row.netPnl)]),
    empty: "No taxonomy tag was recorded on these trades.",
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

  const repeatedTags = analysis.behavior.tags.filter(row => row.sample >= 2);
  const repeatedTable = table("Repeated behavioural patterns", [
    { label: "Tag", flex: 2.4 },
    { label: "Trades", flex: 1, align: "right" },
    { label: "Net P&L", flex: 1.6, align: "right" },
  ], () => ({
    rows: repeatedTags.map(row => [row.label, String(row.sample), money(row.netPnl)]),
    empty: "No tag was recorded on more than one trade in this period.",
  }));

  /* ---- limitations (diagnostics, not report content) ---- */
  const limitations: string[] = [...analysis.warnings];
  for (const note of analysis.behavior.limitations) limitations.push(note);
  if (overview.profitFactor == null && closed) limitations.push("Profit factor is unavailable because no losing trade was recorded in this period.");
  if (!drawdownAvailable && closed) limitations.push("Drawdown data unavailable for the selected period: fewer than two closed trades were exported.");
  if (analysis.mfeMae.unavailable) limitations.push(analysis.mfeMae.message);
  if (!checklistRatios.length) limitations.push("No pre-trade checklist was saved on these trades, so checklist completion is unavailable.");
  if (processAssessments.some(item => item.notEvaluated)) limitations.push(`${processAssessments.filter(item => item.notEvaluated).length} trade(s) carry no behavioural field (typical for MT5 imports), so process metrics exclude them.`);

  /* ---- observations, grouped by the question they answer ---- */
  const observations: AnalysisObservationGroup[] = [];
  const performanceLines: string[] = [];
  if (closed) {
    performanceLines.push(`${overview.wins} of ${closed} closed trade${closed === 1 ? " was a win" : "s were wins"} (${rate(overview.winRate, closed)} win rate); ${overview.losses} lost and ${overview.breakEven} finished break-even.`);
    performanceLines.push(`Net period P&L was ${money(overview.netPnl)} across ${trades.length} exported trade${trades.length === 1 ? "" : "s"}.`);
    if (overview.profitFactor != null) performanceLines.push(`Profit factor ${overview.profitFactor.toFixed(2)} on ${money(overview.grossProfit)} gross profit and ${money(overview.grossLoss)} gross loss.`);
    if (overview.averageWinner != null) performanceLines.push(overview.averageLoser == null
      ? `Average win was ${money(overview.averageWinner)}; no losing trade was recorded in this period.`
      : `Average win ${money(overview.averageWinner)} against average loss ${money(overview.averageLoser)}.`);
    if (overview.expectancy) performanceLines.push(`Expectancy was ${money(overview.expectancy)} per closed trade${overview.totalR == null ? "" : ` (${rMultiple(overview.totalR)} in total)`}.`);
    const best = overview.largestWinner;
    const worst = overview.largestLoser;
    if (best != null || worst != null) performanceLines.push(`Best trade ${money(best)} · worst trade ${money(worst)}.`);
    const positiveDays = dailyRows.filter(row => !row[6].startsWith("-") && row[6] !== ANALYSIS_MISSING).length;
    performanceLines.push(`${positiveDays} of ${dailyRows.length} trading day${dailyRows.length === 1 ? "" : "s"} finished flat or positive.`);
    const topSession = topByAbsolutePnl(analysis.sessions);
    if (topSession) performanceLines.push(`${topSession.label} contributed ${money(topSession.netPnl)} of net P&L over ${topSession.sample} trade${topSession.sample === 1 ? "" : "s"}.`);
    const topSetup = topByAbsolutePnl(analysis.setups);
    if (topSetup) performanceLines.push(`Most used setup context: ${topSetup.label} with ${topSetup.sample} trade${topSetup.sample === 1 ? "" : "s"} and ${money(topSetup.netPnl)} net P&L.`);
  } else {
    performanceLines.push("No closed trades are available for this period, so performance metrics are not calculated.");
  }
  observations.push({ title: "Performance observations", lines: performanceLines });

  const riskLines: string[] = [];
  if (drawdownAvailable) riskLines.push(`Maximum closed-trade equity drawdown ${money(analysis.drawdown.maximum)} over ${analysis.drawdown.durationTrades} trade${analysis.drawdown.durationTrades === 1 ? "" : "s"}.`);
  riskLines.push(`Longest winning streak ${analysis.streaks.longestWin} · longest losing streak ${analysis.streaks.longestLoss}.`);
  if (analysis.risk.average != null) riskLines.push(`Average planned risk ${money(analysis.risk.average)} per trade${analysis.risk.consistency == null ? "" : `, with ${Math.round(analysis.risk.consistency * 100)}% size consistency`}.`);
  observations.push({ title: "Risk observations", lines: riskLines });

  const executionLines: string[] = [];
  if (closed) executionLines.push(`${planned} of ${closed} closed trade${closed === 1 ? "" : "s"} were planned entries; ${unplanned} ${unplanned === 1 ? "was" : "were"} unplanned${planNotStated ? ` and ${planNotStated} had no plan status saved` : ""}.`);
  if (analysis.execution.averageTargetCapture != null) executionLines.push(`Average target capture ${analysis.execution.averageTargetCapture.toFixed(1)}% of the planned reward (${analysis.execution.reachedOrExceededTarget} trade(s) reached or exceeded the target).`);
  if (analysis.execution.averagePlannedR != null) executionLines.push(`Average planned R ${rMultiple(analysis.execution.averagePlannedR)} against average actual R ${rMultiple(analysis.execution.averageActualR)}.`);
  observations.push({ title: "Execution observations", lines: executionLines.length ? executionLines : ["No execution details were recorded on these trades."] });

  const processLines: string[] = [];
  if (averageAdherence != null) processLines.push(`Rule adherence averaged ${Math.round(averageAdherence)}% across ${adherence.length} evaluated trade${adherence.length === 1 ? "" : "s"}, with a rule break recorded on ${ruleBreaks}.`);
  if (averageChecklist != null) processLines.push(`Pre-trade checklist completion averaged ${averageChecklist.toFixed(1)}%.`);
  if (classificationRows.length) processLines.push(`Process classification: ${classificationRows.map(row => `${row.label} ${row.sample}`).join(" · ")}.`);
  observations.push({ title: "Process observations", lines: processLines.length ? processLines : ["No behavioural field was saved, so process metrics are unavailable."] });

  const psychologyLines: string[] = [];
  if (analysis.behavior.coverage.emotionTaggedTrades) psychologyLines.push(`An emotion was recorded on ${analysis.behavior.coverage.emotionTaggedTrades} of ${closed} closed trade${closed === 1 ? "" : "s"}.`);
  if (analysis.behavior.tags.length) psychologyLines.push(`${analysis.behavior.tags.reduce((sum, row) => sum + row.sample, 0)} tagged observations across ${analysis.behavior.tags.length} distinct tag${analysis.behavior.tags.length === 1 ? "" : "s"}; the most recorded was ${analysis.behavior.tags[0].label} (${analysis.behavior.tags[0].sample}).`);
  if (repeatedTags.length) psychologyLines.push(`${repeatedTags.length} tag${repeatedTags.length === 1 ? "" : "s"} appeared on more than one trade.`);
  observations.push({ title: "Psychology observations", lines: psychologyLines.length ? psychologyLines : ["No emotion or behaviour tag was recorded for this period."] });
  observations.push({ title: "Data-quality limitations", lines: limitations.length ? limitations : ["Every metric above was calculated from the exported trades with no missing-field warnings."] });

  /* ---- review: what to repeat / review / watch ---- */
  const repeat: string[] = [];
  const review: string[] = [];
  const watch: string[] = [];
  const namedRows = (rowsToScan: MetricRow[], dimension: string) => rowsToScan.map(row => ({ ...row, dimension }));

  if (closed) {
    if (overview.profitFactor != null && overview.profitFactor > 1.2) repeat.push(`Profit factor ${overview.profitFactor.toFixed(2)}: the setup selection and exit rules produced a positive edge over ${closed} closed trades.`);
    for (const row of namedRows(analysis.sessions, "Session")) if (row.sample >= 2 && row.netPnl > 0 && row.winRate >= 50) repeat.push(`${row.dimension} ${row.label}: ${row.wins} of ${row.sample} trades won for ${money(row.netPnl)} net — repeat this context.`);
    for (const row of namedRows(analysis.setups, "Setup")) if (row.sample >= 2 && row.netPnl > 0 && row.winRate >= 50) repeat.push(`${row.dimension} ${row.label}: ${row.wins} of ${row.sample} trades won for ${money(row.netPnl)} net — repeat this context.`);
    if (averageAdherence != null && averageAdherence >= 90) repeat.push(`Rule adherence averaged ${Math.round(averageAdherence)}% — the pre-trade routine was followed.`);
    if (evaluated.length && ruleBreaks === 0) repeat.push(`No rule break was recorded on any of the ${evaluated.length} evaluated trade${evaluated.length === 1 ? "" : "s"}.`);
    if (averageChecklist != null && averageChecklist >= 80) repeat.push(`Pre-trade checklist completion averaged ${averageChecklist.toFixed(1)}%.`);
    if (!analysis.behavior.tags.length) repeat.push("No mistake tag was recorded in this period.");

    for (const row of namedRows(analysis.sessions, "Session")) if (row.sample >= 2 && row.netPnl < 0) review.push(`${row.dimension} ${row.label}: ${row.losses} of ${row.sample} trades lost for ${money(row.netPnl)} net — review those entries.`);
    for (const row of namedRows(analysis.setups, "Setup")) if (row.sample >= 2 && row.netPnl < 0) review.push(`${row.dimension} ${row.label}: ${row.losses} of ${row.sample} trades lost for ${money(row.netPnl)} net — review those entries.`);
    for (const row of namedRows(analysis.timeframes, "Timeframe")) if (row.sample >= 2 && row.netPnl < 0) review.push(`${row.dimension} ${row.label} lost ${money(row.netPnl)} over ${row.sample} trades.`);
    for (const row of analysis.behavior.emotions) if (row.sample >= 2 && row.netPnl < 0) review.push(`${row.label} was recorded on ${row.sample} trades totalling ${money(row.netPnl)}.`);
    if (averageAdherence != null && (averageAdherence < 100 || ruleBreaks)) review.push(`Rule adherence was ${Math.round(averageAdherence)}% with ${ruleBreaks} trade(s) breaking a recorded rule — review those decisions.`);
    if (averageChecklist != null && averageChecklist < 100) review.push(`Checklist completion averaged ${averageChecklist.toFixed(1)}% — some pre-trade checks were saved as unconfirmed.`);
    if (overview.breakEven) review.push(`${overview.breakEven} break-even trade${overview.breakEven === 1 ? " was" : "s were"} recorded — review management on those positions.`);
    if (unplanned) review.push(`${unplanned} trade${unplanned === 1 ? " was" : "s were"} logged as unplanned entries.`);

    watch.push(`Longest losing streak: ${analysis.streaks.longestLoss} trade${analysis.streaks.longestLoss === 1 ? "" : "s"}.`);
    if (drawdownAvailable) watch.push(`Maximum closed-trade equity drawdown ${money(analysis.drawdown.maximum)} — watch exposure during a drawdown.`);
    if (analysis.risk.consistency != null && analysis.risk.consistency < 1) watch.push(`Risk size varied (${Math.round(analysis.risk.consistency * 100)}% consistency) — watch position sizing.`);
    if (analysis.behavior.coverage.taggedTrades < closed) watch.push(`${closed - analysis.behavior.coverage.taggedTrades} of ${closed} closed trade(s) carry no behaviour tag — watch journal completeness.`);
    if (analysis.behavior.coverage.emotionTaggedTrades < closed) watch.push(`${closed - analysis.behavior.coverage.emotionTaggedTrades} closed trade(s) have no emotion recorded — watch the emotional log.`);
    if (analysis.behavior.coverage.patienceRatedTrades < closed) watch.push(`${closed - analysis.behavior.coverage.patienceRatedTrades} closed trade(s) have no patience score.`);
    if (classificationGroups.get("BAD_WIN")?.length || classificationGroups.get("BAD_LOSS")?.length) {
      const badWins = classificationGroups.get("BAD_WIN")?.length ?? 0;
      const badLosses = classificationGroups.get("BAD_LOSS")?.length ?? 0;
      watch.push(`Process classification flagged ${badWins} bad win(s) and ${badLosses} bad loss(es) — watch the same triggers next session.`);
    }
    if (closed < 20) watch.push(`Only ${closed} closed trade${closed === 1 ? "" : "s"} were exported, so every rate above is a small sample.`);
  } else {
    review.push("No closed trades are available for this period.");
  }
  if (!repeat.length) repeat.push("No context met the criteria for a repeat recommendation in this period.");
  if (!review.length) review.push("No review trigger was recorded in this period.");
  if (!watch.length) watch.push("No watch-out threshold was reached in this period.");

  const pages: AnalysisPage[] = [
    {
      eyebrow: "GOLD JOURNAL · PERFORMANCE REPORT",
      title: "Performance overview",
      caption: "How the selected period performed. Every figure is calculated from the exported trades by the same engine as the Performance view.",
      blocks: [
        { kind: "kpis", title: "Headline figures", items: kpis },
        { kind: "metrics", title: "Period", items: periodMetrics },
        { kind: "metrics", title: "Performance", items: performanceMetrics },
        { kind: "tableRow", tables: [sessionsTable, directionsTable] },
        { kind: "tableRow", tables: [timeframesTable, setupsTable] },
        { kind: "table", table: dailyTable },
      ],
    },
    {
      eyebrow: "GOLD JOURNAL · PROCESS REPORT",
      title: "Process & behaviour",
      caption: "How well the trading process was followed, independent of the outcome of any single trade.",
      blocks: [
        { kind: "metrics", title: "Plan & discipline", items: disciplineMetrics },
        { kind: "metrics", title: "Risk & drawdown", items: riskMetrics },
        { kind: "tableRow", tables: [processTable, executionTypesTable] },
        { kind: "tableRow", tables: [holdQualityTable, patienceTable] },
      ],
    },
    {
      eyebrow: "GOLD JOURNAL · BEHAVIOUR REPORT",
      title: "Psychology & mistakes",
      caption: "What was recorded about behaviour and mistakes. Only recorded journal data is shown; no psychological conclusions are drawn.",
      blocks: [
        { kind: "tableRow", tables: [mistakesTable, repeatedTable] },
        { kind: "tableRow", tables: [categoryTable, emotionsTable] },
        { kind: "paragraph", title: "Data quality & limitations", flow: true, lines: limitations.length ? limitations : ["Every metric above was calculated from the exported trades with no missing-field warnings."] },
      ],
    },
    {
      eyebrow: "GOLD JOURNAL · REVIEW",
      title: "Review summary",
      caption: "What the recorded evidence shows, grouped by the question it answers, followed by the action list for the next session.",
      twoColumn: true,
      blocks: [
        { kind: "paragraph", title: "Performance observations", lines: observations[0].lines },
        { kind: "paragraph", title: "Risk observations", lines: observations[1].lines },
        { kind: "paragraph", title: "Execution observations", lines: observations[2].lines },
        { kind: "paragraph", title: "Process observations", lines: observations[3].lines },
        { kind: "paragraph", title: "Psychology observations", lines: observations[4].lines },
        { kind: "paragraph", title: "Data-quality limitations", flow: true, lines: observations[5].lines },
        { kind: "paragraph", title: "What to repeat", lines: repeat },
        { kind: "paragraph", title: "What to review", lines: review },
        { kind: "paragraph", title: "What to watch next session", lines: watch },
      ],
    },
  ];

  return { pages, total: trades.length, closed, review: { repeat, review, watch }, observations, limitations };
}

/* ------------------------------------------------------------------ *
 * Lookup helpers (used by the renderer's tests and diagnostics)
 * ------------------------------------------------------------------ */

/** Every block of every analysis page, in page order. */
export function allBlocks(analysis: PeriodAnalysis): AnalysisBlock[] {
  return analysis.pages.flatMap(page => page.blocks);
}

export function findMetrics(blocks: AnalysisBlock[], title: string): AnalysisMetric[] | null {
  const block = blocks.find(entry => (entry.kind === "metrics" || entry.kind === "kpis") && entry.title === title);
  return block && (block.kind === "metrics" || block.kind === "kpis") ? block.items : null;
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
