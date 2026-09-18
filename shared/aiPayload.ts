/**
 * The single builder for every AI request payload.
 *
 * Design rules enforced here (they are what keep the request inside the model's
 * token allowance):
 *
 *  1. **One canonical representation.** A context row appears exactly once in a
 *     payload, in its evidence shape, and that same object is the manifest the
 *     reply is validated against. The previous payload shipped the whole
 *     aggregate bundle *and* the evidence manifest, which doubled every number.
 *  2. **Complete statistics, representative detail.** Deterministic totals cover
 *     every trade in the selected period and are never truncated. Per-context
 *     rows and individual trades are a deterministic, ranked subset.
 *  3. **A hard, measured budget.** A payload is built, measured, and shrunk by a
 *     fixed ladder until it fits the allowance. Nothing is sent unmeasured.
 *
 * Nothing here reads a credential, and free-text journal notes never enter a
 * payload: only the structured fields listed in `CompactTrade`.
 */
import {
  EDGE_MIN_SAMPLE,
  type AnalysisFilters,
  type AnalysisResult,
  type AnalysisTrade,
  type MetricRow,
} from "./analysisEngine";
import {
  ANALYSIS_CHUNK_RESPONSE_SCHEMA,
  ANALYSIS_CHUNK_SYSTEM_PROMPT,
  ANALYSIS_RESPONSE_SCHEMA,
  ANALYSIS_SYSTEM_PROMPT,
  evidenceObjectFor,
  manifestFromGroups,
  type EvidenceObject,
} from "./aiCore";
import {
  AI_REQUEST_VERSION,
  AI_TOKEN_POLICY,
  estimateRequestTokens,
  estimateTokens,
  estimateValueTokens,
  getAiRequestPolicy,
  measureRequest,
  type AiRequestPolicy,
  type AiRequestStats,
} from "./aiBudget";

/* ------------------------------------------------------------------ *
 * Fixed request overhead
 * ------------------------------------------------------------------ *
 * Every analysis request carries three things besides the dataset: the system
 * prompt, the JSON schema sent as `response_format`, and the instruction header
 * of the user message. Groq charges all of them against the same per-minute
 * allowance as the dataset, and the schema alone is worth a couple of thousand
 * tokens. Measuring the dataset while ignoring them is how a request that
 * "fits" gets refused with 413, so they are measured here once and subtracted
 * from the prompt budget before any journal data is fitted into it.
 */

/** Tokens on every single-request analysis: system prompt + response schema. */
export const ANALYSIS_PROMPT_OVERHEAD_TOKENS = estimateTokens(ANALYSIS_SYSTEM_PROMPT) + estimateValueTokens(ANALYSIS_RESPONSE_SCHEMA);

/** Tokens on every chunk-summarization request: system prompt + chunk schema. */
export const CHUNK_PROMPT_OVERHEAD_TOKENS = estimateTokens(ANALYSIS_CHUNK_SYSTEM_PROMPT) + estimateValueTokens(ANALYSIS_CHUNK_RESPONSE_SCHEMA);

/**
 * Prompt budget left for the dataset once the fixed overhead is paid. Floored at
 * `minPayloadTokens` because the complete deterministic totals are the irreducible
 * core: a request that cannot carry them cannot produce a grounded report at all.
 */
function payloadBudgetFor(promptBudgetTokens: number, overheadTokens: number): number {
  return Math.max(AI_TOKEN_POLICY.minPayloadTokens, promptBudgetTokens - overheadTokens);
}

/* ------------------------------------------------------------------ *
 * Input DTOs
 * ------------------------------------------------------------------ */

/** Structured trade fields only. Free-text notes and screenshot keys are never included. */
export type CompactTrade = {
  ref: number;
  date: string;
  direction: string;
  result: string;
  pnl: number;
  risk: number | null;
  reward: number | null;
  rMultiple: number | null;
  durationMinutes: number | null;
  session: string;
  timeframe: string;
  level: string;
  setup: string;
  mistake: string | null;
  holdQuality: string | null;
  patienceScore: number | null;
};

/** The deterministic, complete-period totals. Never truncated. */
export type CompactTotals = {
  closedTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
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
  expectancyR: number | null;
  rWinRate: number | null;
  maxDrawdown: number;
  drawdownCount: number;
  longestWinStreak: number;
  longestLossStreak: number;
  currentStreak: string;
  dataCompleteness: number;
};

/** Minimal summary of a context row used outside the evidence list. */
export type MetricRowSummary = {
  context: string;
  sample: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancy: number;
  profitFactor: number | null;
  averageR: number | null;
  maxDrawdown: number;
  confidence: string;
  evidenceTier: string;
};

/** Everything that is always sent, regardless of journal size. */
export type AiCoreContext = {
  requestVersion: string;
  version: string;
  timezone: string;
  period: { start: string | null; end: string | null; sample: number };
  filters: AnalysisFilters;
  totals: CompactTotals;
  recentWindows: Array<{ window: number; sample: number; winRate: number; expectancy: number; profitFactor: number | null; averageR: number | null }>;
  decayDirection: string;
  streaks: { afterWin: MetricRowSummary | null; afterLoss: MetricRowSummary | null };
  drawdown: { maximum: number; average: number; largest: number; count: number; durationTrades: number; recoveryTrades: number };
  risk: { available: number; average: number | null; median: number | null; consistency: number | null; afterWins: number | null; afterLosses: number | null; duringDrawdown: number | null };
  execution: { averagePlannedR: number | null; averageActualR: number | null; averageTargetCapture: number | null; reachedOrExceededTarget: number; profitableBelowTarget: number; nonPositiveOutcome: number; message: string };
  winLoss: { winners: MetricRowSummary; losers: MetricRowSummary; dimensions: AnalysisResult["winLoss"]["dimensions"] };
  behavior: { tags: MetricRowSummary[]; emotions: MetricRowSummary[]; activity: AnalysisResult["behavior"]["activity"]; coverage: AnalysisResult["behavior"]["coverage"]; limitations: string[] };
  journalQuality: { complete: number; incomplete: number; completeness: number; warnings: string[] };
  mfeMae: { available: number; unavailable: number; message: string };
  exitEfficiency: { available: false; message: string };
  warnings: string[];
};

/** Compact chunk summary attached to a synthesis payload. */
export type CompactChunkSummary = {
  strongestContexts: Array<{ evidenceId: string; note: string }>;
  weakestContexts: Array<{ evidenceId: string; note: string }>;
  cautions: string[];
};

/** The payload shape sent to the provider. */
export type AiAnalysisInput = {
  requestVersion: string;
  version: string;
  timezone: string;
  period: AiCoreContext["period"];
  filters: AnalysisFilters;
  totals: CompactTotals;
  recentWindows: AiCoreContext["recentWindows"];
  decayDirection: string;
  streaks: AiCoreContext["streaks"];
  drawdown: AiCoreContext["drawdown"];
  risk: AiCoreContext["risk"];
  execution: AiCoreContext["execution"];
  winLoss: AiCoreContext["winLoss"];
  behavior: AiCoreContext["behavior"];
  journalQuality: AiCoreContext["journalQuality"];
  mfeMae: AiCoreContext["mfeMae"];
  warnings: string[];
  /** Every row here is also the manifest entry the reply is validated against. */
  evidence: EvidenceObject[];
  /** Deterministic representative trades. */
  trades: CompactTrade[];
  /** Present only on a synthesis request built after chunk summarization. */
  contextSummaries?: CompactChunkSummary[];
  evidenceNote?: string;
};

/** One budgeted slice of context rows, summarized before the final synthesis. */
export type AiContextSlice = {
  requestVersion: string;
  slice: { index: number; total: number };
  totals: CompactTotals;
  evidence: EvidenceObject[];
};

/** A chunk request plus the stats measured for it. */
export type AiChunkRequest = { index: number; total: number; payload: AiContextSlice; stats: AiRequestStats };

/* ------------------------------------------------------------------ *
 * Deterministic helpers
 * ------------------------------------------------------------------ */

const finite = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const clean = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");

/** Highest expectancy first, then larger sample, then label. */
function byExpectancyDesc(a: MetricRow, b: MetricRow) {
  return b.expectancy - a.expectancy || b.sample - a.sample || a.label.localeCompare(b.label);
}
/** Lowest expectancy first, then larger sample, then label. */
function byExpectancyAsc(a: MetricRow, b: MetricRow) {
  return a.expectancy - b.expectancy || b.sample - a.sample || a.label.localeCompare(b.label);
}

function summarizeRow(row: MetricRow): MetricRowSummary {
  return {
    context: clean(row.label),
    sample: row.sample,
    wins: row.wins,
    losses: row.losses,
    winRate: row.winRate,
    expectancy: row.expectancy,
    profitFactor: row.profitFactor,
    averageR: row.averageR,
    maxDrawdown: row.maxDrawdown,
    confidence: row.confidence,
    evidenceTier: row.evidenceTier,
  };
}

/** Dimensions that carry context evidence, most decision-relevant first. */
const DIMENSION_GROUPS: ReadonlyArray<readonly [string, (analysis: AnalysisResult) => MetricRow[]]> = [
  ["session", analysis => analysis.sessions],
  ["setup", analysis => analysis.setups],
  ["level", analysis => analysis.levels],
  ["timeframe", analysis => analysis.timeframes],
  ["direction", analysis => analysis.directions],
  ["day", analysis => analysis.days],
  ["hour", analysis => analysis.hours],
  ["session-timeframe", analysis => analysis.sessionTimeframes],
  ["level-session", analysis => analysis.levelSessions],
  ["level-timeframe", analysis => analysis.levelTimeframes],
];

/** Dropped first when the budget is tight: they restate the single dimensions. */
const COMBINATION_DIMENSIONS = new Set(["session-timeframe", "level-session", "level-timeframe"]);

/** A context row plus the exact evidence id it is represented by. */
export type EvidenceRowRef = { dimension: string; evidenceId: string; row: MetricRow };

export type DimensionCandidates = {
  dimension: string;
  /** Best contexts by expectancy, deterministically ranked. */
  strong: MetricRow[];
  /** Worst contexts by expectancy, deterministically ranked. */
  weak: MetricRow[];
  /** Every row in this dimension carrying enough sample to be evidence. */
  total: number;
};

/**
 * Every context row with enough sample to be evidence, split into a strongest and
 * a weakest ranking. Deterministic: the same journal always yields the same
 * candidates in the same order.
 */
export function collectDimensionCandidates(analysis: AnalysisResult): DimensionCandidates[] {
  return DIMENSION_GROUPS.map(([dimension, read]) => {
    const rows = (read(analysis) ?? []).filter(row => row && row.sample >= EDGE_MIN_SAMPLE);
    return { dimension, strong: [...rows].sort(byExpectancyDesc), weak: [...rows].sort(byExpectancyAsc), total: rows.length };
  });
}

function toRefs(dimension: string, rows: ReadonlyArray<MetricRow>): EvidenceRowRef[] {
  return rows.map(row => ({ dimension, evidenceId: evidenceObjectFor(dimension, row).evidenceId, row }));
}

/** Selects `perDimension` rows per dimension, keeping a strongest and a weakest half. */
function selectEvidenceRefs(candidates: DimensionCandidates[], perDimension: number, includeCombinations: boolean): EvidenceRowRef[] {
  if (perDimension <= 0) return [];
  const strongQuota = Math.ceil(perDimension / 2);
  const weakQuota = Math.floor(perDimension / 2);
  const picked: EvidenceRowRef[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!includeCombinations && COMBINATION_DIMENSIONS.has(candidate.dimension)) continue;
    for (const row of candidate.strong.slice(0, strongQuota)) {
      const ref = toRefs(candidate.dimension, [row])[0];
      if (seen.has(ref.evidenceId)) continue;
      seen.add(ref.evidenceId);
      picked.push(ref);
    }
    for (const row of candidate.weak.slice(0, weakQuota)) {
      const ref = toRefs(candidate.dimension, [row])[0];
      if (seen.has(ref.evidenceId)) continue;
      seen.add(ref.evidenceId);
      picked.push(ref);
    }
  }
  return picked;
}

function manifestFromRefs(refs: EvidenceRowRef[]): EvidenceObject[] {
  return manifestFromGroups(DIMENSION_GROUPS.map(([dimension]) => [dimension, refs.filter(ref => ref.dimension === dimension).map(ref => ref.row)] as const));
}

/** Ref order used when chunking: strongest-per-dimension round-robin, then the rest. */
function flattenRefs(candidates: DimensionCandidates[], includeCombinations: boolean): EvidenceRowRef[] {
  const kept = candidates.filter(candidate => includeCombinations || !COMBINATION_DIMENSIONS.has(candidate.dimension));
  const depth = Math.max(0, ...kept.map(candidate => candidate.strong.length));
  const refs: EvidenceRowRef[] = [];
  const seen = new Set<string>();
  const push = (dimension: string, row: MetricRow) => {
    const ref = toRefs(dimension, [row])[0];
    if (seen.has(ref.evidenceId)) return;
    seen.add(ref.evidenceId);
    refs.push(ref);
  };
  for (let level = 0; level < depth; level++) {
    for (const candidate of kept) {
      const row = candidate.strong[level];
      if (row) push(candidate.dimension, row);
    }
  }
  for (const candidate of kept) for (const row of candidate.weak) push(candidate.dimension, row);
  return refs;
}

/* ------------------------------------------------------------------ *
 * Representative trade selection
 * ------------------------------------------------------------------ */

function durationMinutes(trade: AnalysisTrade): number | null {
  const open = trade.openTime == null ? null : new Date(trade.openTime as string | number).getTime();
  const close = trade.closeTime == null ? null : new Date(trade.closeTime as string | number).getTime();
  if (open == null || close == null || !Number.isFinite(open) || !Number.isFinite(close) || close < open) return null;
  return Math.round((close - open) / 60_000);
}

function toCompactTrade(trade: AnalysisTrade, ref: number): CompactTrade {
  const risk = trade.risk == null ? null : finite(trade.risk);
  const pnl = finite(trade.pnl);
  return {
    ref,
    date: new Date(trade.tradeDate as string | number).toISOString(),
    direction: clean(trade.direction) || "UNTAGGED",
    result: clean(trade.result) || "UNKNOWN",
    pnl,
    risk,
    reward: trade.reward == null ? null : finite(trade.reward),
    rMultiple: risk && risk !== 0 ? Number((pnl / risk).toFixed(2)) : null,
    durationMinutes: durationMinutes(trade),
    session: clean(trade.session) || "UNTAGGED",
    timeframe: clean(trade.timeframe) || "UNTAGGED",
    level: clean(trade.level) || "UNTAGGED",
    setup: clean(trade.setupQuality) || "UNTAGGED",
    mistake: clean(trade.mistake) || null,
    holdQuality: clean(trade.holdQuality) || null,
    patienceScore: trade.patienceScore == null ? null : finite(trade.patienceScore),
  };
}

/**
 * Deterministically selects the trades worth showing the model: the most recent
 * activity, the extremes in both directions, the largest risk, and every tagged
 * mistake. Never random and never simply "the first N rows".
 *
 * The result is returned in **priority order** so a budget-bound caller can trim
 * from the end and keep the most informative trades. Free-text `notes` are
 * deliberately excluded: the product promises that raw journal notes never reach
 * the AI.
 */
export function selectRepresentativeTrades(trades: readonly AnalysisTrade[] | undefined, limit: number): CompactTrade[] {
  const closed = (trades ?? []).filter(trade => trade && clean(trade.result).toUpperCase() !== "OPEN");
  if (!closed.length || limit <= 0) return [];
  const order = new Map<AnalysisTrade, number>();
  closed.forEach((trade, index) => order.set(trade, index));
  const rank = (trade: AnalysisTrade) => order.get(trade) ?? 0;

  const buckets: AnalysisTrade[][] = [
    closed.slice(-Math.max(1, Math.ceil(limit * 0.3))),
    [...closed].sort((a, b) => finite(b.pnl) - finite(a.pnl) || rank(a) - rank(b)).slice(0, Math.max(1, Math.ceil(limit * 0.25))),
    [...closed].sort((a, b) => finite(a.pnl) - finite(b.pnl) || rank(a) - rank(b)).slice(0, Math.max(1, Math.ceil(limit * 0.25))),
    [...closed].sort((a, b) => finite(b.risk) - finite(a.risk) || rank(a) - rank(b)).slice(0, Math.max(1, Math.ceil(limit * 0.2))),
    closed.filter(trade => clean(trade.mistake).length > 0),
  ];

  const picked: number[] = [];
  const seen = new Set<number>();
  for (const bucket of buckets) {
    for (const trade of bucket) {
      if (picked.length >= limit) break;
      const index = rank(trade);
      if (seen.has(index)) continue;
      seen.add(index);
      picked.push(index);
    }
  }
  return picked.slice(0, limit).map(index => toCompactTrade(closed[index], index));
}

/** Trims a priority-ordered trade list to `limit` and returns it chronologically. */
function boundTrades(trades: readonly CompactTrade[] | undefined, limit: number): CompactTrade[] {
  if (!trades?.length || limit <= 0) return [];
  return [...trades].slice(0, limit).sort((a, b) => a.date.localeCompare(b.date) || a.ref - b.ref);
}

/* ------------------------------------------------------------------ *
 * Core context
 * ------------------------------------------------------------------ */

function toCompactTotals(analysis: AnalysisResult): CompactTotals {
  const overview = analysis.overview;
  return {
    closedTrades: overview.sample,
    wins: overview.wins,
    losses: overview.losses,
    breakEven: overview.breakEven,
    winRate: overview.winRate,
    netPnl: overview.netPnl,
    averagePnl: overview.averagePnl,
    medianPnl: overview.medianPnl,
    averageWinner: overview.averageWinner,
    averageLoser: overview.averageLoser,
    largestWinner: overview.largestWinner,
    largestLoser: overview.largestLoser,
    grossProfit: overview.grossProfit,
    grossLoss: overview.grossLoss,
    profitFactor: overview.profitFactor,
    expectancy: overview.expectancy,
    averageR: overview.averageR,
    expectancyR: overview.expectancyR,
    rWinRate: overview.rWinRate,
    maxDrawdown: overview.maxDrawdown,
    drawdownCount: overview.drawdownCount,
    longestWinStreak: overview.longestWinStreak,
    longestLossStreak: overview.longestLossStreak,
    currentStreak: `${analysis.streaks.current.type} ${analysis.streaks.current.length}`.trim(),
    dataCompleteness: overview.dataCompleteness,
  };
}

/**
 * The always-included context: complete deterministic totals plus the small
 * process, risk, and execution blocks. Its size does not grow with the number of
 * trades, so it always fits.
 */
export function buildCoreContext(analysis: AnalysisResult): AiCoreContext {
  return {
    requestVersion: AI_REQUEST_VERSION,
    version: analysis.version,
    timezone: analysis.timezone,
    period: { start: analysis.period.start, end: analysis.period.end, sample: analysis.period.sample },
    filters: analysis.filters,
    totals: toCompactTotals(analysis),
    recentWindows: analysis.rolling.map(row => ({ window: row.window, sample: row.sample, winRate: row.winRate, expectancy: row.expectancy, profitFactor: row.profitFactor, averageR: row.averageR })),
    decayDirection: analysis.decay.direction,
    streaks: { afterWin: analysis.streaks.afterWin ? summarizeRow(analysis.streaks.afterWin) : null, afterLoss: analysis.streaks.afterLoss ? summarizeRow(analysis.streaks.afterLoss) : null },
    drawdown: { maximum: analysis.drawdown.maximum, average: analysis.drawdown.average, largest: analysis.drawdown.largest, count: analysis.drawdown.count, durationTrades: analysis.drawdown.durationTrades, recoveryTrades: analysis.drawdown.recoveryTrades },
    risk: { available: analysis.risk.available, average: analysis.risk.average, median: analysis.risk.median, consistency: analysis.risk.consistency, afterWins: analysis.risk.afterWins, afterLosses: analysis.risk.afterLosses, duringDrawdown: analysis.risk.duringDrawdown },
    execution: { averagePlannedR: analysis.execution.averagePlannedR, averageActualR: analysis.execution.averageActualR, averageTargetCapture: analysis.execution.averageTargetCapture, reachedOrExceededTarget: analysis.execution.reachedOrExceededTarget, profitableBelowTarget: analysis.execution.profitableBelowTarget, nonPositiveOutcome: analysis.execution.nonPositiveOutcome, message: analysis.execution.message },
    winLoss: { winners: summarizeRow(analysis.winLoss.winners), losers: summarizeRow(analysis.winLoss.losers), dimensions: analysis.winLoss.dimensions },
    behavior: { tags: analysis.behavior.tags.slice(0, 12).map(summarizeRow), emotions: analysis.behavior.emotions.slice(0, 12).map(summarizeRow), activity: analysis.behavior.activity, coverage: analysis.behavior.coverage, limitations: analysis.behavior.limitations },
    journalQuality: { complete: analysis.journalQuality.complete, incomplete: analysis.journalQuality.incomplete, completeness: analysis.journalQuality.completeness, warnings: analysis.journalQuality.warnings.map(warning => warning.message).slice(0, 10) },
    mfeMae: { available: analysis.mfeMae.available, unavailable: analysis.mfeMae.unavailable, message: analysis.mfeMae.message },
    exitEfficiency: { available: false, message: analysis.exitEfficiency.message },
    warnings: analysis.warnings.slice(0, 10),
  };
}

/* ------------------------------------------------------------------ *
 * Payload assembly
 * ------------------------------------------------------------------ */

function assemble(core: AiCoreContext, evidence: EvidenceObject[], trades: CompactTrade[], extra: Partial<Pick<AiAnalysisInput, "contextSummaries" | "evidenceNote">> = {}): AiAnalysisInput {
  return {
    requestVersion: core.requestVersion,
    version: core.version,
    timezone: core.timezone,
    period: core.period,
    filters: core.filters,
    totals: core.totals,
    recentWindows: core.recentWindows,
    decayDirection: core.decayDirection,
    streaks: core.streaks,
    drawdown: core.drawdown,
    risk: core.risk,
    execution: core.execution,
    winLoss: core.winLoss,
    behavior: core.behavior,
    journalQuality: core.journalQuality,
    mfeMae: core.mfeMae,
    warnings: core.warnings,
    evidence,
    trades,
    ...extra,
  };
}

/**
 * The shrink ladder. Every step sends strictly less than the one before it, so
 * the builder always converges. `perDimension: 0` means "complete totals and
 * process context only, no context rows", which is small and constant.
 */
export const SHRINK_LADDER: ReadonlyArray<{ perDimension: number; combinations: boolean; trades: number }> = [
  { perDimension: 4, combinations: true, trades: 12 },
  { perDimension: 3, combinations: true, trades: 10 },
  { perDimension: 2, combinations: true, trades: 8 },
  { perDimension: 2, combinations: false, trades: 6 },
  { perDimension: 1, combinations: false, trades: 4 },
  { perDimension: 0, combinations: false, trades: 0 },
];

export type FittedPayload = {
  payload: AiAnalysisInput;
  stats: AiRequestStats;
  /** Candidate context rows this payload could not carry. */
  droppedRows: number;
  /** Candidate context rows the analysis has at all. */
  candidateRows: number;
  /** Every candidate row in deterministic order, for the chunked strategy. */
  ordered: EvidenceRowRef[];
};

/** Builds the largest payload that fits `maxInputTokens`, stepping down the ladder. */
export function fitSinglePayload(input: {
  core: AiCoreContext;
  candidates: DimensionCandidates[];
  trades: readonly CompactTrade[] | undefined;
  maxInputTokens: number;
  outputTokenBudget: number;
  model: string;
}): FittedPayload {
  const candidateRows = input.candidates.reduce((total, candidate) => total + candidate.total, 0);
  // The dataset is fitted into what is left of the prompt budget after the fixed
  // overhead, never into the whole budget.
  const payloadBudget = payloadBudgetFor(input.maxInputTokens, ANALYSIS_PROMPT_OVERHEAD_TOKENS);
  let result: FittedPayload | null = null;
  for (let index = 0; index < SHRINK_LADDER.length; index += 1) {
    const step = SHRINK_LADDER[index];
    const refs = selectEvidenceRefs(input.candidates, step.perDimension, step.combinations);
    const evidence = manifestFromRefs(refs);
    const trades = boundTrades(input.trades, step.trades);
    const payload = assemble(input.core, evidence, trades);
    const stats = measureRequest({
      model: input.model,
      payload,
      outputTokenBudget: input.outputTokenBudget,
      inputTokenBudget: input.maxInputTokens,
      evidenceRows: evidence.length,
      trades: trades.length,
      journalTrades: input.core.totals.closedTrades,
      trimmed: false,
      overheadTokens: ANALYSIS_PROMPT_OVERHEAD_TOKENS,
    });
    result = {
      payload,
      stats,
      droppedRows: Math.max(0, candidateRows - evidence.length),
      candidateRows,
      ordered: flattenRefs(input.candidates, step.combinations),
    };
    // Stop once the dataset fits, or once it is already at the irreducible floor
    // (the complete totals) and shrinking further would drop context for nothing.
    if (stats.estimatedInputTokens - ANALYSIS_PROMPT_OVERHEAD_TOKENS <= payloadBudget || index === SHRINK_LADDER.length - 1) break;
  }
  const fitted = result!;
  fitted.stats.trimmed = fitted.droppedRows > 0;
  return fitted;
}

/** Builds one context slice for the chunked strategy. */
export function buildChunkSlice(core: AiCoreContext, refs: EvidenceRowRef[], index: number, total: number): AiContextSlice {
  return { requestVersion: core.requestVersion, slice: { index, total }, totals: core.totals, evidence: manifestFromRefs(refs) };
}

/**
 * Packs the ordered candidate rows into at most `maxChunks` slices, each under
 * `chunkInputBudget`. Deterministic: the same journal always packs identically.
 */
export function packChunks(core: AiCoreContext, ordered: EvidenceRowRef[], maxChunks: number, chunkInputBudget: number): EvidenceRowRef[][] {
  if (!ordered.length || maxChunks <= 0) return [];
  const perChunk = Math.max(1, Math.ceil(ordered.length / maxChunks));
  const slices: EvidenceRowRef[][] = [];
  let current: EvidenceRowRef[] = [];
  for (const ref of ordered) {
    const next = [...current, ref];
    // Charged as the provider charges it: slice + this request's fixed overhead.
    const tokens = estimateValueTokens(buildChunkSlice(core, next, slices.length + 1, maxChunks)) + CHUNK_PROMPT_OVERHEAD_TOKENS;
    if (current.length && (tokens > chunkInputBudget || current.length >= perChunk)) {
      slices.push(current);
      current = [];
    }
    current.push(ref);
  }
  if (current.length) slices.push(current);
  return slices.slice(0, maxChunks);
}

/**
 * The final synthesis payload for the chunked strategy: complete totals, the
 * compact chunk summaries, and the full evidence rows those summaries cited. The
 * model can therefore only cite contexts the app supplied, and every number it
 * writes is present in this payload.
 */
export function buildSynthesisPayload(input: {
  core: AiCoreContext;
  summaries: CompactChunkSummary[];
  ordered: EvidenceRowRef[];
  trades: readonly CompactTrade[] | undefined;
  maxEvidenceRows: number;
  tradeLimit: number;
  inputTokenBudget: number;
  outputTokenBudget: number;
  model: string;
}): FittedPayload {
  const cited = new Set(input.summaries.flatMap(summary => [...summary.strongestContexts, ...summary.weakestContexts].map(item => item.evidenceId)));
  const citedRows = input.ordered.filter(ref => cited.has(ref.evidenceId));
  const wanted = citedRows.length ? citedRows : input.ordered;
  const maxLimit = Math.max(0, Math.min(wanted.length, input.maxEvidenceRows));
  const trades = boundTrades(input.trades, input.tradeLimit);
  // The synthesis request pays the same fixed overhead as any other analysis, so
  // it is measured the same way and its cited evidence rows are reduced (never the
  // totals, never the chunk summaries) until the whole request fits the budget.
  const build = (limit: number) => {
    const evidence = manifestFromRefs(wanted.slice(0, limit));
    const payload = assemble(input.core, evidence, trades, {
      contextSummaries: input.summaries,
      evidenceNote: "Only cite evidenceIds listed in `evidence`; each entry is the exact object to reproduce.",
    });
    const stats = measureRequest({
      model: input.model,
      payload,
      outputTokenBudget: input.outputTokenBudget,
      inputTokenBudget: input.inputTokenBudget,
      evidenceRows: evidence.length,
      trades: trades.length,
      journalTrades: input.core.totals.closedTrades,
      trimmed: wanted.length > limit,
      overheadTokens: ANALYSIS_PROMPT_OVERHEAD_TOKENS,
    });
    return { payload, stats };
  };
  let limit = maxLimit;
  let built = build(limit);
  while (limit > 0 && built.stats.estimatedInputTokens > input.inputTokenBudget) {
    limit = Math.floor(limit * 0.5);
    built = build(limit);
  }
  return { payload: built.payload, stats: built.stats, droppedRows: Math.max(0, wanted.length - limit), candidateRows: input.ordered.length, ordered: [] };
}

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

export type AiRequestPlan = {
  mode: "single" | "chunked";
  policy: AiRequestPolicy;
  core: AiCoreContext;
  /** Present when `mode === "single"`. */
  payload?: AiAnalysisInput;
  stats: AiRequestStats;
  /** Present when `mode === "chunked"`: slices to summarize before synthesis. */
  chunks: AiChunkRequest[];
  /** Every candidate row in deterministic order. */
  evidenceRows: EvidenceRowRef[];
  candidateRows: number;
  droppedRows: number;
};

/**
 * Plans the chunk budgets — or returns null when this account cannot afford a
 * chunked analysis at all.
 *
 * TPM is a *shared per-minute* budget: every request an analysis makes is charged
 * against the same allowance, so the chunk count and the prompt budget per chunk
 * are derived by dividing that allowance (chunks + the synthesis request share
 * one window). Reusing the single-request budget here would be self-defeating —
 * N requests of that size can never fit one minute, which is precisely how a 413
 * turns into a 429 storm.
 *
 * A plan is returned only when the account can afford *at least two full-size
 * requests inside one minute*. On a tight tier (for example
 * `openai/gpt-oss-120b`'s 8K TPM, where one full request already spends the whole
 * minute) a batch plan would be throttled part-way through, so the app sends one
 * bounded aggregate request instead — aggregation is what cures the 413, and on
 * that tier it also carries more context per request than several small slices.
 */
function planChunkBudgets(input: {
  allowanceTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}): { chunks: number; chunkInputBudget: number } | null {
  const fullRequest = estimateRequestTokens(input.maxInputTokens, input.maxOutputTokens);
  if (input.allowanceTokens < fullRequest * 2) return null;
  for (let chunks = AI_TOKEN_POLICY.maxChunkRequests; chunks >= 2; chunks -= 1) {
    const perRequest = input.allowanceTokens / (chunks + 1);
    // The chunk request pays its own system prompt and schema, so those are part
    // of the per-request cost before any slice is packed into it.
    const requestBudget = Math.floor(perRequest / AI_TOKEN_POLICY.safetyMargin) - AI_TOKEN_POLICY.chunkOutputTokens;
    const promptBudget = Math.min(input.maxInputTokens, requestBudget - CHUNK_PROMPT_OVERHEAD_TOKENS);
    if (promptBudget < AI_TOKEN_POLICY.minPayloadTokens) continue;
    return { chunks, chunkInputBudget: promptBudget };
  }
  return null;
}

/**
 * Chooses between one aggregated request and a chunked summarize-then-synthesize
 * plan.
 *
 * Chunking is only *useful* when the account has room for several requests in one
 * minute, so the number of chunks is derived from the measured token allowance
 * instead of being fixed. A tight tier gets one bounded request — aggregation
 * alone is what cures the 413 — while a roomier tier gets full context coverage.
 */
export function planAiRequest(input: {
  analysis: AnalysisResult;
  /** Compact representative trades, already selected by `selectRepresentativeTrades`. */
  trades?: readonly CompactTrade[];
  model: string;
  allowanceTokens: number;
}): AiRequestPlan {
  // The policy is derived from the allowance the plan is being built for, so the
  // single-request budget and the shared per-minute batch budget can never
  // disagree about how much room this account has.
  const policy = getAiRequestPolicy(input.model, input.allowanceTokens);
  const core = buildCoreContext(input.analysis);
  const candidates = collectDimensionCandidates(input.analysis);
  const fitted = fitSinglePayload({
    core,
    candidates,
    trades: input.trades,
    maxInputTokens: policy.maxInputTokens,
    outputTokenBudget: policy.maxOutputTokens,
    model: policy.model,
  });

  const chunkPlan = planChunkBudgets({
    allowanceTokens: policy.allowanceTokens,
    maxInputTokens: policy.maxInputTokens,
    maxOutputTokens: policy.maxOutputTokens,
  });
  // A single request is only worth splitting when it actually had to drop rows.
  const neededChunks = Math.max(2, Math.ceil(fitted.candidateRows / Math.max(1, fitted.stats.evidenceRows)));
  const slices = fitted.droppedRows > 0 && chunkPlan
    ? packChunks(core, fitted.ordered, Math.min(chunkPlan.chunks, neededChunks), chunkPlan.chunkInputBudget)
    : [];
  const covered = slices.reduce((total, slice) => total + slice.length, 0);

  // Batching costs extra requests, so it is only used when it genuinely carries
  // more of the journal than the one aggregated request already does.
  if (!chunkPlan || slices.length < 2 || covered <= fitted.stats.evidenceRows) {
    return {
      mode: "single",
      policy,
      core,
      payload: fitted.payload,
      stats: fitted.stats,
      chunks: [],
      evidenceRows: fitted.ordered,
      candidateRows: fitted.candidateRows,
      droppedRows: fitted.droppedRows,
    };
  }

  const chunks: AiChunkRequest[] = slices.map((refs, index) => {
    const payload = buildChunkSlice(core, refs, index + 1, slices.length);
    return {
      index: index + 1,
      total: slices.length,
      payload,
      stats: measureRequest({
        model: policy.model,
        payload,
        outputTokenBudget: AI_TOKEN_POLICY.chunkOutputTokens,
        inputTokenBudget: chunkPlan.chunkInputBudget,
        evidenceRows: payload.evidence.length,
        trades: 0,
        journalTrades: core.totals.closedTrades,
        trimmed: false,
        overheadTokens: CHUNK_PROMPT_OVERHEAD_TOKENS,
      }),
    };
  });
  return {
    mode: "chunked",
    policy,
    core,
    stats: { ...fitted.stats, trimmed: covered < fitted.candidateRows },
    chunks,
    evidenceRows: fitted.ordered,
    candidateRows: fitted.candidateRows,
    droppedRows: Math.max(0, fitted.candidateRows - covered),
  };
}
