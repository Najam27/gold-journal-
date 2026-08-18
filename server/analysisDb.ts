import { and, asc, eq, gt, gte, lt, or } from "./supabaseQuery";
import { trades } from "../drizzle/schema";
import { buildAnalysis, type AnalysisFilters, type AnalysisResult, type AnalysisTrade } from "@shared/analysisEngine";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";

const ANALYSIS_PAGE_SIZE = 1_000;
const ANALYSIS_MAX_TRADES = 10_000;

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
  notes: trades.notes,
  screenshotKey: trades.screenshotKey,
  openTime: trades.openTime,
  closeTime: trades.closeTime,
  mfe: trades.mfe,
  mae: trades.mae,
};

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

function analysisWhere(userId: number, accountId: number, filters: AnalysisFilters) {
  const parts = [eq(trades.userId, userId), eq(trades.accountId, accountId)];
  if (filters.startDate) parts.push(gte(trades.tradeDate, new Date(`${filters.startDate}T00:00:00.000Z`)));
  if (filters.endDate) parts.push(lt(trades.tradeDate, new Date(`${filters.endDate}T00:00:00.000Z`).getTime() + 86_400_000));
  if (filters.session) parts.push(eq(trades.session, filters.session));
  if (filters.timeframe) parts.push(eq(trades.timeframe, filters.timeframe));
  if (filters.level) parts.push(eq(trades.level, filters.level));
  if (filters.setup) parts.push(eq(trades.setupQuality, filters.setup));
  if (filters.direction) parts.push(eq(trades.direction, filters.direction));
  if (filters.result) parts.push(eq(trades.result, filters.result));
  return and(...parts);
}

export async function getAccountAnalysis(userId: number, accountId: number, filters: AnalysisFilters = {}): Promise<AnalysisResult & { truncated: boolean; sourceTradeCount: number }> {
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
  const analysis = buildAnalysis(rows, filters);
  return { ...analysis, truncated, sourceTradeCount: rows.length };
}

export const analysisLimits = { pageSize: ANALYSIS_PAGE_SIZE, maxTrades: ANALYSIS_MAX_TRADES } as const;
