import { pktDateToTimestamp } from "./pktDate";

export type AnalysisTrade = {
  id?: number | string;
  tradeDate?: number | string | Date | null;
  result?: string | null;
  pnl?: number | string | null;
  risk?: number | string | null;
  reward?: number | string | null;
  session?: string | null;
  timeframe?: string | null;
  level?: string | null;
  setupQuality?: string | null;
  direction?: string | null;
  mistake?: string | null;
  holdQuality?: string | null;
  patienceScore?: number | string | null;
  emotionBefore?: string | null;
  emotionDuring?: string | null;
  emotionAfter?: string | null;
  notes?: string | null;
  screenshotKey?: string | null;
  openTime?: number | string | Date | null;
  closeTime?: number | string | Date | null;
  mfe?: number | string | null;
  mae?: number | string | null;
};

export type AnalysisFilters = {
  startDate?: string | null;
  endDate?: string | null;
  session?: string | null;
  timeframe?: string | null;
  level?: string | null;
  setup?: string | null;
  direction?: "BUY" | "SELL" | null;
  result?: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN" | null;
};

export type EvidenceTier = "OBSERVED BEST CONTEXT" | "POTENTIAL EDGE" | "DEVELOPING EDGE" | "REPEATABLE EDGE" | "VALIDATED EDGE";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export type MetricRow = {
  key: string;
  label: string;
  sample: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  lossRate: number;
  breakEvenRate: number;
  netPnl: number;
  averagePnl: number;
  medianPnl: number;
  averageWinner: number | null;
  averageLoser: number | null;
  largestWinner: number | null;
  largestLoser: number | null;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  averageR: number | null;
  medianR: number | null;
  totalR: number | null;
  expectancyR: number | null;
  rWinRate: number | null;
  averageWinningR: number | null;
  averageLosingR: number | null;
  bestR: number | null;
  worstR: number | null;
  maxDrawdown: number;
  drawdownCount: number;
  longestWinStreak: number;
  longestLossStreak: number;
  edgeScore: number;
  evidenceTier: EvidenceTier;
  confidence: Confidence;
  winRateInterval: [number, number];
  dataCompleteness: number;
};

export type QualityWarning = { field: string; missing: number; total: number; percentage: number; message: string };

export type AnalysisResult = {
  version: "analysis-v1";
  filters: AnalysisFilters;
  timezone: "Asia/Karachi";
  period: { start: string | null; end: string | null; sample: number };
  overview: MetricRow;
  sessions: MetricRow[];
  timeframes: MetricRow[];
  levels: MetricRow[];
  setups: MetricRow[];
  directions: MetricRow[];
  days: MetricRow[];
  hours: MetricRow[];
  sessionTimeframes: MetricRow[];
  levelSessions: MetricRow[];
  levelTimeframes: MetricRow[];
  sessionTimeframeLevels: MetricRow[];
  setupSessions: MetricRow[];
  setupTimeframes: MetricRow[];
  setupLevels: MetricRow[];
  rolling: Array<{ window: number; sample: number; expectancy: number; winRate: number; profitFactor: number | null; averageR: number | null }>;
  decay: { recent10: MetricRow | null; recent20: MetricRow | null; recent30: MetricRow | null; fullHistory: MetricRow; direction: "IMPROVING" | "STABLE" | "DETERIORATING" | "INSUFFICIENT DATA" };
  streaks: { current: { type: "WIN" | "LOSS" | "NONE"; length: number }; longestWin: number; longestLoss: number; afterWin: MetricRow | null; afterLoss: MetricRow | null };
  drawdown: { maximum: number; average: number; largest: number; count: number; durationTrades: number; recoveryTrades: number };
  duration: { available: number; unavailable: number; averageMinutes: number | null; medianMinutes: number | null; buckets: MetricRow[] };
  risk: { available: number; average: number | null; median: number | null; consistency: number | null; afterWins: number | null; afterLosses: number | null; duringDrawdown: number | null };
  winLoss: { winners: MetricRow; losers: MetricRow; dimensions: Array<{ dimension: string; winnerContext: string | null; loserContext: string | null; winnerSample: number; loserSample: number }> };
  behavior: { tags: MetricRow[]; emotions: MetricRow[]; activity: { activeDays: number; averageTradesPerActiveDay: number; maxTradesInDay: number; concentratedDays: number }; coverage: { taggedTrades: number; emotionTaggedTrades: number; patienceRatedTrades: number; closedTrades: number }; limitations: string[] };
  journalQuality: { complete: number; incomplete: number; completeness: number; warnings: QualityWarning[] };
  mfeMae: { available: number; unavailable: number; message: string; mfe: MetricRow | null; mae: MetricRow | null };
  exitEfficiency: { available: false; message: string };
  edgeCards: { top: MetricRow | null; weak: MetricRow | null; mostConsistent: MetricRow | null; highestExpectancy: MetricRow | null; bestR: MetricRow | null };
  warnings: string[];
};

export const EDGE_MIN_SAMPLE = 5;
export const EDGE_SCORE_WEIGHTS = { sample: 20, expectancy: 25, profitFactor: 15, consistency: 15, drawdown: 15, dataQuality: 10 } as const;

const finite = (value: unknown) => { const n = typeof value === "number" ? value : Number(value ?? 0); return Number.isFinite(n) ? n : 0; };
const dateValue = (value: unknown) => { const time = value instanceof Date ? value.getTime() : new Date(value as any).getTime(); return Number.isFinite(time) ? time : 0; };
const clean = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");
const keyPart = (value: unknown) => clean(value).toLocaleLowerCase();
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 4) => Number(value.toFixed(digits));

function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); if (!sorted.length) return 0; const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function safeRatio(numerator: number, denominator: number) { return denominator ? numerator / denominator : null; }
function evidenceTier(sample: number, expectancy: number, profitFactor: number | null, interval: [number, number]): EvidenceTier { if (sample < 5 || expectancy <= 0 || (profitFactor !== null && profitFactor <= 1)) return "OBSERVED BEST CONTEXT"; if (sample < 10) return "POTENTIAL EDGE"; if (sample < 20) return "DEVELOPING EDGE"; if (sample < 30) return "REPEATABLE EDGE"; return interval[0] >= 50 && profitFactor !== null && profitFactor > 1 ? "VALIDATED EDGE" : "REPEATABLE EDGE"; }
function confidenceFor(sample: number, interval: [number, number]) { const width = interval[1] - interval[0]; if (sample >= 30 && width <= 0.25) return "HIGH"; if (sample >= 10 && width <= 0.45) return "MEDIUM"; return "LOW"; }

export function wilsonInterval(wins: number, sample: number, z = 1.96): [number, number] {
  if (!sample) return [0, 0];
  const p = wins / sample;
  const denominator = 1 + z * z / sample;
  const centre = (p + z * z / (2 * sample)) / denominator;
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * sample)) / sample) / denominator;
  return [round(clamp(centre - spread) * 100, 2), round(clamp(centre + spread) * 100, 2)];
}

function sortedClosed(trades: AnalysisTrade[]) { return trades.filter(trade => clean(trade.result) !== "OPEN").sort((a, b) => dateValue(a.tradeDate) - dateValue(b.tradeDate)); }
function equityStats(trades: AnalysisTrade[]) {
  let equity = 0; let peak = 0; let max = 0; let currentStart = -1; let drawdowns = 0; let duration = 0; let recovery = 0; let recoveryStart = -1;
  for (let index = 0; index < trades.length; index += 1) {
    equity += finite(trades[index].pnl);
    if (equity >= peak) { if (currentStart >= 0) { recovery += index - recoveryStart; currentStart = -1; recoveryStart = -1; } peak = equity; }
    const drawdown = peak - equity;
    if (drawdown > max) max = drawdown;
    if (drawdown > 0 && currentStart < 0) { currentStart = index; recoveryStart = index; drawdowns += 1; }
    if (currentStart >= 0) duration = Math.max(duration, index - currentStart + 1);
  }
  return { maxDrawdown: round(max, 2), drawdownCount: drawdowns, durationTrades: duration, recoveryTrades: recovery };
}
function streakStats(trades: AnalysisTrade[]) {
  let longestWin = 0; let longestLoss = 0; let currentWin = 0; let currentLoss = 0;
  for (const trade of trades) { if (trade.result === "WIN") { currentWin += 1; currentLoss = 0; longestWin = Math.max(longestWin, currentWin); } else if (trade.result === "LOSS") { currentLoss += 1; currentWin = 0; longestLoss = Math.max(longestLoss, currentLoss); } else { currentWin = 0; currentLoss = 0; } }

  return { longestWin, longestLoss, current: { type: currentWin ? "WIN" as const : currentLoss ? "LOSS" as const : "NONE" as const, length: Math.max(currentWin, currentLoss) } };
}

export function metricRow(label: string, trades: AnalysisTrade[]): MetricRow {
  const closed = sortedClosed(trades); const sample = closed.length;
  const wins = closed.filter(t => t.result === "WIN").length; const losses = closed.filter(t => t.result === "LOSS").length; const breakEven = closed.filter(t => t.result === "BREAK_EVEN").length;
  const pnls = closed.map(t => finite(t.pnl)); const winners = pnls.filter(value => value > 0); const losers = pnls.filter(value => value < 0); const grossProfit = winners.reduce((sum, value) => sum + value, 0); const grossLoss = Math.abs(losers.reduce((sum, value) => sum + value, 0));
  const rValues = closed.map(t => { const risk = finite(t.risk); return risk > 0 ? finite(t.pnl) / risk : null; }).filter((value): value is number => value !== null && Number.isFinite(value));
  const drawdown = equityStats(closed); const interval = wilsonInterval(wins, sample); const completenessFields = ["session", "timeframe", "level", "setupQuality", "direction", "risk", "reward", "notes", "screenshotKey", "result"] as const;
  const completeCells = closed.reduce((sum, trade) => sum + completenessFields.filter(field => clean(trade[field]) !== "" && !(field === "risk" && finite(trade.risk) === 0 && trade.risk == null) && !(field === "reward" && finite(trade.reward) === 0 && trade.reward == null)).length, 0);
  const dataCompleteness = sample ? completeCells / (sample * completenessFields.length) : 0;
  const pf = grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? null : 0;
  const expectancy = sample ? pnls.reduce((sum, value) => sum + value, 0) / sample : 0;
  const averageR = rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : null;
  const scale = Math.max(Math.abs(median(pnls)), Math.abs(expectancy), 1);
  const sampleComponent = EDGE_SCORE_WEIGHTS.sample * clamp(sample / 30);
  const expectancyComponent = EDGE_SCORE_WEIGHTS.expectancy * clamp(0.5 + expectancy / (2 * scale));
  const pfComponent = EDGE_SCORE_WEIGHTS.profitFactor * (pf === null ? 1 : clamp(pf / 3));
  const consistencyComponent = EDGE_SCORE_WEIGHTS.consistency * clamp(1 - (interval[1] - interval[0]) / 100);
  const drawdownComponent = EDGE_SCORE_WEIGHTS.drawdown * clamp(1 - drawdown.maxDrawdown / Math.max(Math.abs(pnls.reduce((sum, value) => sum + value, 0)), scale * 4));
  const score = sample ? Math.round(clamp((sampleComponent + expectancyComponent + pfComponent + consistencyComponent + drawdownComponent + EDGE_SCORE_WEIGHTS.dataQuality * dataCompleteness) / 100) * 100) : 0;
  return { key: keyPart(label), label, sample, wins, losses, breakEven, winRate: sample ? round(wins / sample * 100, 2) : 0, lossRate: sample ? round(losses / sample * 100, 2) : 0, breakEvenRate: sample ? round(breakEven / sample * 100, 2) : 0, netPnl: round(pnls.reduce((sum, value) => sum + value, 0), 2), averagePnl: round(expectancy, 2), medianPnl: round(median(pnls), 2), averageWinner: winners.length ? round(grossProfit / winners.length, 2) : null, averageLoser: losers.length ? round(-grossLoss / losers.length, 2) : null, largestWinner: winners.length ? round(Math.max(...winners), 2) : null, largestLoser: losers.length ? round(Math.min(...losers), 2) : null, grossProfit: round(grossProfit, 2), grossLoss: round(grossLoss, 2), profitFactor: pf === null ? null : round(pf, 3), expectancy: round(expectancy, 2), averageR: averageR === null ? null : round(averageR, 4), medianR: rValues.length ? round(median(rValues), 4) : null, totalR: rValues.length ? round(rValues.reduce((sum, value) => sum + value, 0), 4) : null, expectancyR: rValues.length ? round(rValues.reduce((sum, value) => sum + value, 0) / rValues.length, 4) : null, rWinRate: rValues.length ? round(rValues.filter(value => value > 0).length / rValues.length * 100, 2) : null, averageWinningR: rValues.filter(value => value > 0).length ? round(rValues.filter(value => value > 0).reduce((sum, value) => sum + value, 0) / rValues.filter(value => value > 0).length, 4) : null, averageLosingR: rValues.filter(value => value < 0).length ? round(rValues.filter(value => value < 0).reduce((sum, value) => sum + value, 0) / rValues.filter(value => value < 0).length, 4) : null, bestR: rValues.length ? round(Math.max(...rValues), 4) : null, worstR: rValues.length ? round(Math.min(...rValues), 4) : null, maxDrawdown: drawdown.maxDrawdown, drawdownCount: drawdown.drawdownCount, longestWinStreak: streakStats(closed).longestWin, longestLossStreak: streakStats(closed).longestLoss, edgeScore: score, evidenceTier: evidenceTier(sample, expectancy, pf, interval), confidence: confidenceFor(sample, interval), winRateInterval: interval, dataCompleteness: round(dataCompleteness * 100, 2) };
}

function groupBy(trades: AnalysisTrade[], dimensions: Array<keyof AnalysisTrade | string>) {
  const groups = new Map<string, AnalysisTrade[]>();
  for (const trade of trades) { if (clean(trade.result) === "OPEN") continue; const values = dimensions.map(dimension => clean((trade as Record<string, unknown>)[String(dimension)])); if (values.some(value => !value)) continue; const key = values.map(keyPart).join("|"); const current = groups.get(key) ?? []; current.push(trade); groups.set(key, current); }
  return Array.from(groups.entries()).map(([key, rows]) => ({ ...metricRow(dimensions.map((dimension) => clean((rows[0] as Record<string, unknown>)[String(dimension)])).join(" · "), rows), key })).filter(row => row.sample > 0);
}
function rank(rows: MetricRow[]) { return [...rows].sort((a, b) => b.edgeScore - a.edgeScore || b.expectancy - a.expectancy || b.sample - a.sample); }
const confidenceRank: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
function pktParts(date: Date) { return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", weekday: "long", hour: "2-digit", hourCycle: "h23" }).formatToParts(date); }
function groupedDays(trades: AnalysisTrade[]) { return groupBy(sortedClosed(trades).map(trade => { const parts = pktParts(new Date(dateValue(trade.tradeDate))); return { ...trade, day: parts.find(part => part.type === "weekday")?.value ?? "Unknown" }; }), ["day"]); }
function groupedHours(trades: AnalysisTrade[]) { return groupBy(sortedClosed(trades).map(trade => { const parts = pktParts(new Date(dateValue(trade.tradeDate))); const hour = parts.find(part => part.type === "hour")?.value ?? "00"; return { ...trade, hour: `${hour}:00 PKT` }; }), ["hour"]); }
function durationMetrics(trades: AnalysisTrade[]) { const values = sortedClosed(trades).map(trade => { const start = dateValue(trade.openTime); const end = dateValue(trade.closeTime); return start && end && end >= start ? (end - start) / 60_000 : null; }).filter((value): value is number => value !== null); const buckets = [[0, 5, "<5 min"], [5, 15, "5–15 min"], [15, 30, "15–30 min"], [30, 60, "30–60 min"], [60, 240, "1–4h"], [240, Infinity, "4h+"]] as const; const bucketRows = buckets.map(([min, max, label]) => metricRow(label, sortedClosed(trades).filter(trade => { const start = dateValue(trade.openTime); const end = dateValue(trade.closeTime); const minutes = start && end && end >= start ? (end - start) / 60_000 : null; return minutes !== null && minutes >= min && minutes < max; }))); return { available: values.length, unavailable: sortedClosed(trades).length - values.length, averageMinutes: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null, medianMinutes: values.length ? round(median(values), 2) : null, buckets: bucketRows }; }
function riskMetrics(trades: AnalysisTrade[]) { const closed = sortedClosed(trades); const risks = closed.map(t => finite(t.risk)).filter(value => value > 0); const meanRisk = risks.length ? risks.reduce((sum, value) => sum + value, 0) / risks.length : 0; const averageForPreviousOutcome = (outcome: "WIN" | "LOSS") => { const values = closed.slice(1).filter((_, index) => closed[index]?.result === outcome).map(trade => finite(trade.risk)).filter(value => value > 0); return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 2) : null; }; let equity = 0; let peak = 0; const drawdownRisks: number[] = []; for (const trade of closed) { equity += finite(trade.pnl); if (equity > peak) peak = equity; else if (peak > equity) { const risk = finite(trade.risk); if (risk > 0) drawdownRisks.push(risk); } } return { available: risks.length, average: risks.length ? round(meanRisk, 2) : null, median: risks.length ? round(median(risks), 2) : null, consistency: risks.length ? round(1 - Math.min(1, Math.sqrt(risks.reduce((sum, value) => sum + (value - meanRisk) ** 2, 0) / risks.length) / Math.max(1, meanRisk)), 4) : null, afterWins: averageForPreviousOutcome("WIN"), afterLosses: averageForPreviousOutcome("LOSS"), duringDrawdown: drawdownRisks.length ? round(drawdownRisks.reduce((sum, value) => sum + value, 0) / drawdownRisks.length, 2) : null }; }
function splitBehaviorTags(value: unknown) { const raw = clean(value); if (!raw) return []; try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) return Array.from(new Set(parsed.map(clean).filter(Boolean))); } catch { /* historic tags may be plain text */ } return Array.from(new Set(raw.split(/[;,|/]/).map(clean).filter(Boolean))); }
function behavioralMetrics(trades: AnalysisTrade[]) {
  const closed = sortedClosed(trades); const tagGroups = new Map<string, AnalysisTrade[]>(); const emotionGroups = new Map<string, AnalysisTrade[]>();
  const add = (groups: Map<string, AnalysisTrade[]>, label: string, trade: AnalysisTrade) => { const rows = groups.get(label) ?? []; rows.push(trade); groups.set(label, rows); };
  for (const trade of closed) {
    for (const tag of splitBehaviorTags(trade.mistake)) add(tagGroups, tag, trade);
    for (const [stage, value] of [["Before", trade.emotionBefore], ["During", trade.emotionDuring], ["After", trade.emotionAfter]] as const) { const emotion = clean(value); if (emotion) add(emotionGroups, `${stage}: ${emotion}`, trade); }
  }
  const tags = Array.from(tagGroups.entries()).map(([label, rows]) => metricRow(label, rows)).sort((a, b) => b.sample - a.sample || a.expectancy - b.expectancy || a.label.localeCompare(b.label));
  const emotions = Array.from(emotionGroups.entries()).map(([label, rows]) => metricRow(label, rows)).sort((a, b) => b.sample - a.sample || a.expectancy - b.expectancy || a.label.localeCompare(b.label));
  const activeDates = new Map<string, number>();
  for (const trade of closed) { const date = new Date(dateValue(trade.tradeDate)); const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date); const key = `${parts.find(part => part.type === "year")?.value}-${parts.find(part => part.type === "month")?.value}-${parts.find(part => part.type === "day")?.value}`; activeDates.set(key, (activeDates.get(key) ?? 0) + 1); }
  const counts = Array.from(activeDates.values()); const averageTradesPerActiveDay = counts.length ? counts.reduce((sum, value) => sum + value, 0) / counts.length : 0; const maxTradesInDay = counts.length ? Math.max(...counts) : 0;
  const coverage = { taggedTrades: closed.filter(trade => splitBehaviorTags(trade.mistake).length > 0).length, emotionTaggedTrades: closed.filter(trade => clean(trade.emotionBefore) || clean(trade.emotionDuring) || clean(trade.emotionAfter)).length, patienceRatedTrades: closed.filter(trade => finite(trade.patienceScore) > 0).length, closedTrades: closed.length };
  const limitations = [coverage.taggedTrades < closed.length ? `${closed.length - coverage.taggedTrades} closed trades have no behavior tag.` : "", coverage.emotionTaggedTrades < closed.length ? `${closed.length - coverage.emotionTaggedTrades} closed trades have no emotion field.` : "", coverage.patienceRatedTrades < closed.length ? `${closed.length - coverage.patienceRatedTrades} closed trades have no patience score.` : ""].filter(Boolean);
  return { tags, emotions, activity: { activeDays: counts.length, averageTradesPerActiveDay: round(averageTradesPerActiveDay, 2), maxTradesInDay, concentratedDays: counts.filter(count => count >= Math.max(3, Math.ceil(averageTradesPerActiveDay * 2))).length }, coverage, limitations };
}
function qualityMetrics(trades: AnalysisTrade[]) { const closed = sortedClosed(trades); const fields: Array<[keyof AnalysisTrade, string]> = [["session", "session"], ["timeframe", "timeframe"], ["level", "level"], ["setupQuality", "setup"], ["direction", "direction"], ["risk", "risk"], ["reward", "R:R"], ["notes", "notes"], ["screenshotKey", "screenshots"], ["result", "result"]]; const warnings = fields.map(([field, label]) => { const missing = closed.filter(trade => field === "risk" || field === "reward" ? finite(trade[field]) <= 0 : !clean(trade[field])).length; return { field: label, missing, total: closed.length, percentage: closed.length ? round(missing / closed.length * 100, 1) : 0, message: `${closed.length ? round(missing / closed.length * 100, 1) : 0}% of closed trades have no ${label}.` }; }).filter(item => item.missing > 0); const complete = closed.filter(trade => fields.every(([field]) => field === "risk" || field === "reward" ? finite(trade[field]) > 0 : Boolean(clean(trade[field])))).length; return { complete, incomplete: closed.length - complete, completeness: closed.length ? round(complete / closed.length * 100, 1) : 0, warnings }; }
function conditionalRows(trades: AnalysisTrade[], dimensions: Array<keyof AnalysisTrade>) { return rank(groupBy(trades, dimensions)).filter(row => row.sample >= EDGE_MIN_SAMPLE); }
function edgeDirection(a: MetricRow, b: MetricRow) { if (a.sample < 10 || b.sample < 10) return "INSUFFICIENT DATA" as const; const delta = a.expectancy - b.expectancy; return delta > Math.max(0.05, Math.abs(b.expectancy) * 0.1) ? "IMPROVING" as const : delta < -Math.max(0.05, Math.abs(b.expectancy) * 0.1) ? "DETERIORATING" as const : "STABLE" as const; }

export function filterAnalysisTrades(trades: AnalysisTrade[], filters: AnalysisFilters = {}) {
  const start = filters.startDate ? pktDateToTimestamp(filters.startDate, 0) : 0; const end = filters.endDate ? pktDateToTimestamp(filters.endDate, 0) + 86_400_000 - 1 : Infinity;
  return trades.filter(trade => { const date = dateValue(trade.tradeDate); return (!start || date >= start) && date <= end && (!filters.session || clean(trade.session) === clean(filters.session)) && (!filters.timeframe || clean(trade.timeframe) === clean(filters.timeframe)) && (!filters.level || clean(trade.level) === clean(filters.level)) && (!filters.setup || clean(trade.setupQuality) === clean(filters.setup)) && (!filters.direction || clean(trade.direction) === filters.direction) && (!filters.result || clean(trade.result) === filters.result); });
}

export function buildAnalysis(trades: AnalysisTrade[], filters: AnalysisFilters = {}): AnalysisResult {
  const filtered = filterAnalysisTrades(trades, filters); const closed = sortedClosed(filtered); const overview = metricRow("All closed trades", closed); const quality = qualityMetrics(filtered); const streak = streakStats(closed); const drawdown = equityStats(closed); const allRows = { sessions: rank(groupBy(filtered, ["session"])), timeframes: rank(groupBy(filtered, ["timeframe"])), levels: rank(groupBy(filtered, ["level"])), setups: rank(groupBy(filtered, ["setupQuality"])), directions: rank(groupBy(filtered, ["direction"])), days: rank(groupedDays(filtered)), hours: rank(groupedHours(filtered)), sessionTimeframes: conditionalRows(filtered, ["session", "timeframe"]), levelSessions: conditionalRows(filtered, ["level", "session"]), levelTimeframes: conditionalRows(filtered, ["level", "timeframe"]), sessionTimeframeLevels: conditionalRows(filtered, ["session", "timeframe", "level"]), setupSessions: conditionalRows(filtered, ["setupQuality", "session"]), setupTimeframes: conditionalRows(filtered, ["setupQuality", "timeframe"]), setupLevels: conditionalRows(filtered, ["setupQuality", "level"]) };
  const rolling = [20, 30, 50].map(window => { const row = metricRow(`Last ${window}`, closed.slice(-window)); return { window, sample: row.sample, expectancy: row.expectancy, winRate: row.winRate, profitFactor: row.profitFactor, averageR: row.averageR }; }).filter(row => row.sample >= 5);
  const recent = (window: number) => closed.length >= window ? metricRow(`Recent ${window}`, closed.slice(-window)) : null; const recent10 = recent(10); const recent20 = recent(20); const recent30 = recent(30); const decayBase = recent20 ?? recent10 ?? overview; const decay = { recent10, recent20, recent30, fullHistory: overview, direction: recent20 && overview.sample >= 20 ? edgeDirection(recent20, overview) : "INSUFFICIENT DATA" as const };
  const afterWins = closed.slice(1).filter((_, index) => closed[index].result === "WIN"); const afterLosses = closed.slice(1).filter((_, index) => closed[index].result === "LOSS"); const mfeTrades = closed.filter(trade => trade.mfe != null || trade.mae != null); const mfeValues = mfeTrades.filter(trade => trade.mfe != null).map(trade => ({ ...trade, pnl: trade.mfe })); const maeValues = mfeTrades.filter(trade => trade.mae != null).map(trade => ({ ...trade, pnl: trade.mae }));
  const winLossDimensions = (["session", "timeframe", "level", "setupQuality", "direction"] as const).map(dimension => { const winners = rank(groupBy(closed.filter(trade => trade.result === "WIN"), [dimension])); const losers = rank(groupBy(closed.filter(trade => trade.result === "LOSS"), [dimension])); return { dimension, winnerContext: winners[0]?.label ?? null, loserContext: losers[0]?.label ?? null, winnerSample: winners[0]?.sample ?? 0, loserSample: losers[0]?.sample ?? 0 }; });
  const edgeCandidates = rank([...allRows.sessions, ...allRows.timeframes, ...allRows.levels, ...allRows.setups, ...allRows.sessionTimeframes, ...allRows.levelSessions, ...allRows.levelTimeframes]).filter(row => row.sample >= EDGE_MIN_SAMPLE); const positiveEdgeRows = edgeCandidates.filter(row => row.expectancy >= 0);
  const behavior = behavioralMetrics(filtered); const warnings = [...quality.warnings.filter(item => item.percentage >= 20).map(item => item.message), ...(closed.length < 20 ? ["Evidence is limited: fewer than 20 closed trades are available."] : []), ...(filtered.length > 0 && closed.length !== filtered.length ? ["OPEN trades are excluded from performance metrics."] : []), ...(!mfeTrades.length ? ["MFE/MAE unavailable: no excursion series is stored for these trades."] : []), ...(edgeCandidates.length > 0 && positiveEdgeRows.length === 0 ? ["No context meets the non-negative expectancy threshold for an edge label."] : [])];
  return { version: "analysis-v1", filters, timezone: "Asia/Karachi", period: { start: closed.length ? new Date(dateValue(closed[0].tradeDate)).toISOString() : null, end: closed.length ? new Date(dateValue(closed.at(-1)?.tradeDate)).toISOString() : null, sample: overview.sample }, overview, ...allRows, rolling, decay, streaks: { ...streak, afterWin: afterWins.length ? metricRow("After wins", afterWins) : null, afterLoss: afterLosses.length ? metricRow("After losses", afterLosses) : null }, drawdown: { maximum: drawdown.maxDrawdown, average: drawdown.drawdownCount ? round(drawdown.maxDrawdown / drawdown.drawdownCount, 2) : 0, largest: drawdown.maxDrawdown, count: drawdown.drawdownCount, durationTrades: drawdown.durationTrades, recoveryTrades: drawdown.recoveryTrades },     duration: durationMetrics(filtered), risk: riskMetrics(filtered), winLoss: { winners: metricRow("Winners", closed.filter(trade => trade.result === "WIN")), losers: metricRow("Losers", closed.filter(trade => trade.result === "LOSS")), dimensions: winLossDimensions }, behavior, journalQuality: quality, mfeMae: { available: mfeTrades.length, unavailable: closed.length - mfeTrades.length, message: mfeTrades.length ? "Historical excursion fields were available for this sample." : "MFE/MAE unavailable because the journal does not store price-series excursions.", mfe: mfeValues.length ? metricRow("MFE", mfeValues) : null, mae: maeValues.length ? metricRow("MAE", maeValues) : null }, exitEfficiency: { available: false, message: "Historical exit efficiency is unavailable because achievable intratrade maximums are not stored." }, edgeCards: { top: positiveEdgeRows[0] ?? null, weak: rank([...allRows.sessions, ...allRows.timeframes, ...allRows.levels, ...allRows.setups, ...allRows.sessionTimeframes, ...allRows.levelSessions, ...allRows.levelTimeframes].filter(row => row.sample >= EDGE_MIN_SAMPLE).sort((a, b) => a.edgeScore - b.edgeScore))[0] ?? null, mostConsistent: rank([...allRows.sessions, ...allRows.timeframes, ...allRows.levels].filter(row => row.sample >= 10).sort((a, b) => confidenceRank[b.confidence] - confidenceRank[a.confidence] || b.dataCompleteness - a.dataCompleteness))[0] ?? null, highestExpectancy: [...positiveEdgeRows].sort((a, b) => b.expectancy - a.expectancy || b.sample - a.sample)[0] ?? null, bestR: [...positiveEdgeRows].filter(row => row.expectancyR !== null).sort((a, b) => (b.expectancyR ?? -Infinity) - (a.expectancyR ?? -Infinity))[0] ?? null }, warnings };
}

export function compactAnalysisForAi(analysis: AnalysisResult) {
  const simplify = (row: MetricRow) => ({ label: row.label, sample: row.sample, wins: row.wins, losses: row.losses, breakEven: row.breakEven, winRate: row.winRate, expectancy: row.expectancy, profitFactor: row.profitFactor, averageR: row.averageR, expectancyR: row.expectancyR, maxDrawdown: row.maxDrawdown, evidenceTier: row.evidenceTier, confidence: row.confidence, winRateInterval: row.winRateInterval, edgeScore: row.edgeScore });
  return { version: analysis.version, filters: analysis.filters, period: analysis.period, timezone: analysis.timezone, overview: simplify(analysis.overview), sessions: analysis.sessions.slice(0, 20).map(simplify), timeframes: analysis.timeframes.slice(0, 20).map(simplify), levels: analysis.levels.slice(0, 20).map(simplify), setups: analysis.setups.slice(0, 20).map(simplify), directions: analysis.directions.map(simplify), days: analysis.days.map(simplify), hours: analysis.hours.slice(0, 24).map(simplify), combinations: { sessionTimeframes: analysis.sessionTimeframes.slice(0, 30).map(simplify), levelSessions: analysis.levelSessions.slice(0, 30).map(simplify), levelTimeframes: analysis.levelTimeframes.slice(0, 30).map(simplify) }, rolling: analysis.rolling, decay: { recent10: analysis.decay.recent10 ? simplify(analysis.decay.recent10) : null, recent20: analysis.decay.recent20 ? simplify(analysis.decay.recent20) : null, recent30: analysis.decay.recent30 ? simplify(analysis.decay.recent30) : null, fullHistory: simplify(analysis.decay.fullHistory), direction: analysis.decay.direction }, streaks: analysis.streaks, drawdown: analysis.drawdown, risk: analysis.risk, behavior: { tags: analysis.behavior.tags.slice(0, 20).map(simplify), emotions: analysis.behavior.emotions.slice(0, 20).map(simplify), activity: analysis.behavior.activity, coverage: analysis.behavior.coverage, limitations: analysis.behavior.limitations }, winLoss: { winners: simplify(analysis.winLoss.winners), losers: simplify(analysis.winLoss.losers), dimensions: analysis.winLoss.dimensions }, journalQuality: analysis.journalQuality, mfeMae: analysis.mfeMae, exitEfficiency: analysis.exitEfficiency, warnings: analysis.warnings };
}

export function compareAnalysis(current: AnalysisResult, previous: AnalysisResult) {
  const delta = (a: number, b: number) => round(a - b, 4);
  return { current: current.period, previous: previous.period, overview: { winRate: delta(current.overview.winRate, previous.overview.winRate), expectancy: delta(current.overview.expectancy, previous.overview.expectancy), profitFactor: current.overview.profitFactor === null || previous.overview.profitFactor === null ? null : delta(current.overview.profitFactor, previous.overview.profitFactor), averageR: current.overview.averageR === null || previous.overview.averageR === null ? null : delta(current.overview.averageR, previous.overview.averageR), maxDrawdown: delta(current.overview.maxDrawdown, previous.overview.maxDrawdown) }, sessions: current.sessions.map(row => ({ label: row.label, expectancy: row.expectancy, sample: row.sample })), timeframes: current.timeframes.map(row => ({ label: row.label, expectancy: row.expectancy, sample: row.sample })), levels: current.levels.map(row => ({ label: row.label, expectancy: row.expectancy, sample: row.sample })), setups: current.setups.map(row => ({ label: row.label, expectancy: row.expectancy, sample: row.sample })) };
}
