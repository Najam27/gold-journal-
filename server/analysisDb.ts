import { and, asc, eq, gt, gte, lt, or } from "./supabaseQuery";
import { trades } from "../drizzle/schema";
import { buildAnalysis, type AnalysisFilters, type AnalysisResult, type AnalysisTrade } from "@shared/analysisEngine";
import { tradePips } from "@shared/pipMath";
import { normalizeTradeEnvironment } from "@shared/tradeEnvironment";
import { selectRepresentativeTrades, type CompactTrade } from "@shared/aiPayload";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";
import { pktDateToTimestamp } from "@shared/pktDate";

const ANALYSIS_PAGE_SIZE = 1_000;
const ANALYSIS_MAX_TRADES = 10_000;
/**
 * Deterministically selected structured trades handed to the AI payload builder.
 * Free-text notes are excluded here, so raw journal text never leaves the server
 * for an AI request.
 */
export const ANALYSIS_REPRESENTATIVE_TRADES = 12;

const analysisSelection = {
  id: trades.id,
  tradeDate: trades.tradeDate,
  result: trades.result,
  pnl: trades.pnl,
  risk: trades.risk,
  reward: trades.reward,
  session: trades.session,
  timeframe: trades.timeframe,
  level: trades.level,
  setupQuality: trades.setupQuality,
  direction: trades.direction,
  marketCondition: trades.marketCondition,
  executionType: trades.executionType,
  biasAlignment: trades.biasAlignment,
  confirmationType: trades.confirmationType,
  planStatus: trades.planStatus,
  mistake: trades.mistake,
  holdQuality: trades.holdQuality,
  patienceScore: trades.patienceScore,
  emotionBefore: trades.emotionBefore,
  emotionDuring: trades.emotionDuring,
  emotionAfter: trades.emotionAfter,
  notes: trades.notes,
  screenshotKey: trades.screenshotKey,
  openTime: trades.openTime,
  closeTime: trades.closeTime,
  mfe: trades.mfe,
  mae: trades.mae,
  // Needed for Testing-mode pip mapping (pips are derived, never stored).
  environment: trades.environment,
  entryPrice: trades.entryPrice,
  exitPrice: trades.exitPrice,
};

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

function analysisWhere(userId: number, accountId: number, filters: AnalysisFilters) {
  // Environment isolation: analytics can only ever see one environment. An
  // absent filter means LIVE, so every historical caller keeps its old
  // result set exactly.
  const parts = [eq(trades.userId, userId), eq(trades.accountId, accountId), eq(trades.environment, normalizeTradeEnvironment(filters.environment))];
  if (filters.startDate) parts.push(gte(trades.tradeDate, new Date(pktDateToTimestamp(filters.startDate, 0))));
  if (filters.endDate) parts.push(lt(trades.tradeDate, new Date(pktDateToTimestamp(filters.endDate, 0) + 86_400_000)));
  if (filters.session) parts.push(eq(trades.session, filters.session));
  if (filters.timeframe) parts.push(eq(trades.timeframe, filters.timeframe));
  if (filters.level) parts.push(eq(trades.level, filters.level));
  if (filters.setup) parts.push(eq(trades.setupQuality, filters.setup));
  if (filters.direction) parts.push(eq(trades.direction, filters.direction));
  if (filters.result) parts.push(eq(trades.result, filters.result));
  return and(...parts);
}

export type AccountAnalysisResult = AnalysisResult & {
  truncated: boolean;
  sourceTradeCount: number;
  /**
   * A deterministic, bounded subset of structured trade fields for the AI
   * payload. The aggregates above always cover every trade; this is the
   * representative detail that fits inside a provider token budget.
   */
  representativeTrades: CompactTrade[];
};

export async function getAccountAnalysis(userId: number, accountId: number, filters: AnalysisFilters = {}): Promise<AccountAnalysisResult> {
  await getOwnedAccount(userId, accountId);
  const db = await requireDb();
  const rows: AnalysisTrade[] = [];
  let lastTradeDate: Date | null = null;
  let lastTradeId: number | null = null;
  let truncated = false;
  while (rows.length < ANALYSIS_MAX_TRADES) {
    const keyset = lastTradeDate && lastTradeId !== null
      ? or(gt(trades.tradeDate, lastTradeDate), and(eq(trades.tradeDate, lastTradeDate), gt(trades.id, lastTradeId)))
      : undefined;
    const page = await db.select(analysisSelection).from(trades).where(and(analysisWhere(userId, accountId, filters), keyset)).orderBy(asc(trades.tradeDate), asc(trades.id)).limit(Math.min(ANALYSIS_PAGE_SIZE, ANALYSIS_MAX_TRADES - rows.length));
    rows.push(...page as AnalysisTrade[]);
    const last = page.at(-1) as AnalysisTrade | undefined;
    if (!last || page.length < ANALYSIS_PAGE_SIZE) break;
    lastTradeDate = last.tradeDate instanceof Date ? last.tradeDate : new Date(last.tradeDate as string | number);
    lastTradeId = Number(last.id);
  }
  if (rows.length >= ANALYSIS_MAX_TRADES) truncated = true;
  // Testing-mode pip mapping. `buildAnalysis`/`metricRow` are unit-agnostic —
  // they read `pnl` — so Testing analytics is the same engine with pips
  // mapped into the field before it runs. Live rows pass through untouched.
  const isTesting = normalizeTradeEnvironment(filters.environment) === "TESTING";
  const analysisRows: AnalysisTrade[] = isTesting
    ? rows.map((row) => ({ ...row, pnl: tradePips(row as { direction?: string | null; entryPrice?: number | string | null; exitPrice?: number | string | null }) }))
    : rows;
  const analysis = buildAnalysis(analysisRows, filters);
  return { ...analysis, truncated, sourceTradeCount: rows.length, representativeTrades: selectRepresentativeTrades(analysisRows, ANALYSIS_REPRESENTATIVE_TRADES) };
}

export const analysisLimits = { pageSize: ANALYSIS_PAGE_SIZE, maxTrades: ANALYSIS_MAX_TRADES } as const;
