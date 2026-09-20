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
import { checklistCompletionRatio, type TradeTone } from "@/lib/tradePresentation";
import { formatMoney } from "@/lib/gold";

/** Rendered when a metric cannot be calculated from the selected trades. */
export const ANALYSIS_MISSING = "—";

export type AnalysisMetric = { label: string; value: string; tone?: TradeTone };
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

/**
 * The report's field ownership map.
 *
 * The four analysis pages have strict, non-overlapping responsibilities, so every
 * figure the report can print is named here exactly once with the page that owns it:
 *
 *   • Performance — what happened to the account (results, breakdowns);
 *   • Process     — how consistently the intended process was followed;
 *   • Psychology  — what behaviour, emotions and mistakes were recorded;
 *   • Review      — short factual summaries, never another copy of a table.
 *
 * A test asserts that every metric and table the report renders is on this list and
 * is only ever rendered on its owner's page, so a metric cannot quietly move or be
 * printed twice.
 */
export type ReportOwner = "performance" | "process" | "psychology" | "review";

export const REPORT_OWNERSHIP: Record<string, ReportOwner> = {
  // Performance — period and results.
  Account: "performance",
  "Start date": "performance",
  "End date": "performance",
  "Trades exported": "performance",
  "Closed trades": "performance",
  "Open trades": "performance",
  "Active days": "performance",
  "Selected period": "performance",
  "Period": "performance",
  "Net P&L": "performance",
  "Gross profit": "performance",
  "Gross loss": "performance",
  "Profit factor": "performance",
  "Win rate": "performance",
  Wins: "performance",
  Losses: "performance",
  "Break-even": "performance",
  "Average win": "performance",
  "Average loss": "performance",
  Expectancy: "performance",
  "Average R": "performance",
  "Total R": "performance",
  "Median R": "performance",
  "Best trade": "performance",
  "Worst trade": "performance",
  "Win rate range (95%)": "performance",
  "Median trade": "performance",
  "Data completeness": "performance",
  "Max drawdown": "performance",
  "Average drawdown": "performance",
  "Headline figures": "performance",
  Performance: "performance",
  "Session performance": "performance",
  "Direction performance": "performance",
  "Timeframe performance": "performance",
  "Setup performance": "performance",
  "Daily performance": "performance",
  // Process — plan, discipline, and risk control.
  "Plan & discipline": "process",
  "Planned trades": "process",
  "Unplanned trades": "process",
  "Plan not stated": "process",
  "Rule adherence": "process",
  "Trades with rule breaks": "process",
  "Checklist completion": "process",
  "Average patience score": "process",
  "Evaluated trades": "process",
  "Risk & process control": "process",
  "Drawdown episodes": "process",
  "Longest drawdown": "process",
  "Longest win streak": "process",
  "Longest loss streak": "process",
  "Average planned risk": "process",
  "Median planned risk": "process",
  "Risk consistency": "process",
  "Risk after a win": "process",
  "Risk after a loss": "process",
  "Average planned R": "process",
  "Average target capture": "process",
  "Reached or exceeded target": "process",
  "Process classification": "process",
  "Execution type": "process",
  "Hold quality": "process",
  "Patience distribution": "process",
  // Psychology — recorded behaviour only. One consolidated mistakes table.
  "Mistake / rule-break frequency": "psychology",
  "Process, emotional, and environmental tags": "psychology",
  "Recorded emotions": "psychology",
  "Data quality & limitations": "psychology",
  // Review — factual summaries.
  "Performance summary": "review",
  "Process summary": "review",
  "Psychology summary": "review",
  "Risk summary": "review",
  "Data quality": "review",
  "Review points": "review",
};

/** One review section: a short heading and at most a handful of factual lines. */
export type AnalysisReviewSection = { title: string; lines: string[] };

export type PeriodAnalysis = {
  pages: AnalysisPage[];
  total: number;
  /** Closed trades only: the sample every rate below is computed against. */
  closed: number;
  /** The review page's sections, each a plain-language summary of one question. */
  review: AnalysisReviewSection[];
  limitations: string[];
  /** The field ownership map the pages above were built from. */
  ownership: Record<string, ReportOwner>;
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
const toneFor = (value: number): TradeTone => (value > 0 ? "positive" : value < 0 ? "negative" : "neutral");

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
    { label: "Max drawdown", value: closed >= 2 ? `-${money(analysis.drawdown.maximum).replace("-", "")}` : ANALYSIS_MISSING, tone: "negative" },
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
    // Drawdown amounts are results, so the Performance page owns them.
    { label: "Average drawdown", value: closed >= 2 ? money(analysis.drawdown.average) : ANALYSIS_MISSING },
    { label: "Data completeness", value: percent(overview.dataCompleteness, 0) },
  ];

  /* ---- risk control & streak context (the drawdown *amounts* belong to performance) ---- */
  const drawdownAvailable = closed >= 2;
  const riskMetrics: AnalysisMetric[] = [
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
    { label: "Average target capture", value: percent(analysis.execution.averageTargetCapture) },
    { label: "Reached or exceeded target", value: analysis.execution.targetCaptureAvailable ? `${analysis.execution.reachedOrExceededTarget} / ${analysis.execution.targetCaptureAvailable}` : ANALYSIS_MISSING },
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

  // The one consolidated behaviour table. A tag can be recorded once per trade, so
  // the trade count is the occurrence count; this dataset is never printed twice.
  const mistakesTable = table("Mistake / rule-break frequency", [
    { label: "Tag", flex: 3 },
    { label: "Trades", flex: 1.3, align: "right" },
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

  /* ---- limitations (diagnostics, not report content) ---- */
  const limitations: string[] = [...analysis.warnings];
  for (const note of analysis.behavior.limitations) limitations.push(note);
  if (overview.profitFactor == null && closed) limitations.push("Profit factor is unavailable because no losing trade was recorded in this period.");
  if (!drawdownAvailable && closed) limitations.push("Drawdown data unavailable for the selected period: fewer than two closed trades were exported.");
  if (analysis.mfeMae.unavailable) limitations.push(analysis.mfeMae.message);
  if (!checklistRatios.length) limitations.push("No pre-trade checklist was saved on these trades, so checklist completion is unavailable.");
  if (processAssessments.some(item => item.notEvaluated)) limitations.push(`${processAssessments.filter(item => item.notEvaluated).length} trade(s) carry no behavioural field (typical for MT5 imports), so process metrics exclude them.`);

  /* ---- review summaries: factual lines only, one short section per question ---- */
  const topSession = topByAbsolutePnl(analysis.sessions);
  const topSetup = topByAbsolutePnl(analysis.setups);
  const positiveDays = dailyRows.filter(row => !row[6].startsWith("-") && row[6] !== ANALYSIS_MISSING).length;

  const performanceSummary: string[] = [];
  if (closed) {
    performanceSummary.push(`${overview.wins} of ${closed} closed trade${closed === 1 ? " was a win" : "s were wins"} (${rate(overview.winRate, closed)} win rate); ${overview.losses} lost and ${overview.breakEven} finished break-even.`);
    performanceSummary.push(`Net period P&L ${money(overview.netPnl)} across ${trades.length} exported trade${trades.length === 1 ? "" : "s"}; profit factor ${factor(overview.profitFactor)} on ${money(overview.grossProfit)} gross profit and ${money(overview.grossLoss)} gross loss.`);
    performanceSummary.push(`Average win ${money(overview.averageWinner)} · average loss ${money(overview.averageLoser)} · expectancy ${money(overview.expectancy)} per closed trade.`);
    performanceSummary.push(`${positiveDays} of ${dailyRows.length} trading day${dailyRows.length === 1 ? "" : "s"} finished flat or positive.`);
  } else {
    performanceSummary.push("No closed trades are available for this period, so performance metrics are not calculated.");
  }

  const processSummary: string[] = [];
  if (closed) {
    processSummary.push(`${planned} of ${closed} closed trade${closed === 1 ? "" : "s"} were planned entries; ${unplanned} ${unplanned === 1 ? "was" : "were"} unplanned${planNotStated ? ` and ${planNotStated} had no plan status saved` : ""}.`);
    if (averageAdherence != null) processSummary.push(`Rule adherence averaged ${Math.round(averageAdherence)}% across ${adherence.length} evaluated trade${adherence.length === 1 ? "" : "s"}; a rule break was recorded on ${ruleBreaks}.`);
    processSummary.push(`Pre-trade checklist completion averaged ${percent(averageChecklist)} · average patience ${averagePatience == null ? ANALYSIS_MISSING : `${averagePatience.toFixed(1)} / 5`}.`);
    if (classificationRows.length) processSummary.push(`Process classification: ${classificationRows.map(row => `${row.label} ${row.sample}`).join(" · ")}.`);
  } else {
    processSummary.push("No closed trades are available for this period, so process metrics are not calculated.");
  }

  const psychologySummary: string[] = [];
  const taggedObservations = analysis.behavior.tags.reduce((sum, row) => sum + row.sample, 0);
  if (closed) psychologySummary.push(`An emotion was recorded on ${analysis.behavior.coverage.emotionTaggedTrades} of ${closed} closed trade${closed === 1 ? "" : "s"}.`);
  if (analysis.behavior.tags.length) {
    psychologySummary.push(`${taggedObservations} tagged observation${taggedObservations === 1 ? "" : "s"} across ${analysis.behavior.tags.length} distinct tag${analysis.behavior.tags.length === 1 ? "" : "s"}; ${analysis.behavior.tags[0].label} was recorded most often (${analysis.behavior.tags[0].sample}).`);
    if (repeatedTags.length) psychologySummary.push(`${repeatedTags.length} tag${repeatedTags.length === 1 ? "" : "s"} appeared on more than one trade: ${repeatedTags.map(row => `${row.label} ${row.sample}`).join(" · ")}.`);
  } else {
    psychologySummary.push("No mistake, rule-break, or emotion tag was recorded for this period.");
  }

  const riskSummary: string[] = [];
  if (drawdownAvailable) riskSummary.push(`Maximum closed-trade equity drawdown ${money(analysis.drawdown.maximum)} over ${analysis.drawdown.durationTrades} trade${analysis.drawdown.durationTrades === 1 ? "" : "s"}; average drawdown ${money(analysis.drawdown.average)}.`);
  riskSummary.push(`Longest winning streak ${analysis.streaks.longestWin} · longest losing streak ${analysis.streaks.longestLoss}.`);
  if (analysis.risk.average != null) riskSummary.push(`Average planned risk ${money(analysis.risk.average)} per trade${analysis.risk.consistency == null ? "" : ` with ${Math.round(analysis.risk.consistency * 100)}% size consistency`}.`);

  const dataQuality: string[] = [
    `${closed} closed trade${closed === 1 ? "" : "s"} carry an outcome; ${analysis.behavior.coverage.taggedTrades} carry a behaviour tag and ${analysis.behavior.coverage.patienceRatedTrades} carry a patience score.`,
    limitations[0] ?? "Every figure in this report was calculated from the exported trades with no missing-field warnings.",
  ];

  /* ---- review points: what the recorded values put in front of the trader ---- */
  const reviewPoints: string[] = [];
  if (closed) {
    if (topSession) reviewPoints.push(`Most traded session: ${topSession.label} with ${topSession.sample} trade${topSession.sample === 1 ? "" : "s"} and ${money(topSession.netPnl)} net P&L.`);
    if (topSetup) reviewPoints.push(`Most traded setup: ${topSetup.label} with ${topSetup.sample} trade${topSetup.sample === 1 ? "" : "s"} and ${money(topSetup.netPnl)} net P&L.`);
    if (averageAdherence != null) reviewPoints.push(`Rule adherence ${Math.round(averageAdherence)}% across ${adherence.length} evaluated trade${adherence.length === 1 ? "" : "s"}; ${ruleBreaks} recorded a rule break.`);
    if (unplanned || overview.breakEven) reviewPoints.push(`${unplanned} trade${unplanned === 1 ? "" : "s"} logged as unplanned and ${overview.breakEven} finished break-even.`);
    if (closed < 20) reviewPoints.push(`${closed} closed trade${closed === 1 ? "" : "s"} were exported, so every rate in this report is a small sample.`);
  } else {
    reviewPoints.push("No closed trades are available for this period.");
  }

  const review: AnalysisReviewSection[] = [
    { title: "Performance summary", lines: performanceSummary.slice(0, 4) },
    { title: "Process summary", lines: processSummary.slice(0, 4) },
    { title: "Psychology summary", lines: psychologySummary.slice(0, 4) },
    { title: "Risk summary", lines: riskSummary.slice(0, 3) },
    { title: "Data quality", lines: dataQuality.slice(0, 2) },
    { title: "Review points", lines: reviewPoints.slice(0, 5) },
  ];

  const pages: AnalysisPage[] = [
    {
      eyebrow: "GOLD JOURNAL · PERFORMANCE REPORT",
      title: "Performance overview",
      caption: "What happened to the account in the selected period. Every figure is calculated from the exported trades by the same engine as the Performance view.",
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
      caption: "How consistently the intended process was followed, independent of the outcome of any single trade.",
      blocks: [
        { kind: "metrics", title: "Plan & discipline", items: disciplineMetrics },
        { kind: "metrics", title: "Risk & process control", items: riskMetrics },
        { kind: "tableRow", tables: [processTable, executionTypesTable] },
        { kind: "tableRow", tables: [holdQualityTable, patienceTable] },
      ],
    },
    {
      eyebrow: "GOLD JOURNAL · BEHAVIOUR REPORT",
      title: "Psychology & mistakes",
      caption: "What was recorded about behaviour and mistakes. Only recorded journal data is shown; no psychological conclusions are drawn.",
      blocks: [
        { kind: "tableRow", tables: [mistakesTable, categoryTable] },
        { kind: "table", table: emotionsTable },
        { kind: "paragraph", title: "Data quality & limitations", flow: true, lines: limitations.length ? limitations : ["Every metric above was calculated from the exported trades with no missing-field warnings."] },
      ],
    },
    {
      eyebrow: "GOLD JOURNAL · REVIEW",
      title: "Review summary",
      caption: "A short factual summary of each question, then what the recorded values put in front of the trader. The full tables and rankings are on the pages above.",
      twoColumn: true,
      blocks: review.map(section => ({ kind: "paragraph" as const, title: section.title, lines: section.lines })),
    },
  ];

  return { pages, total: trades.length, closed, review, limitations, ownership: REPORT_OWNERSHIP };
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
