import { and, asc, eq } from "./supabaseQuery";
import { trades } from "../drizzle/schema";
import { buildAnalysis, type AnalysisFilters, type AnalysisResult, type AnalysisTrade } from "@shared/analysisEngine";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";

const ANALYSIS_PAGE_SIZE = 1_000;
const ANALYSIS_MAX_TRADES = 100_000;

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
};

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

export async function getAccountAnalysis(userId: number, accountId: number, filters: AnalysisFilters = {}): Promise<AnalysisResult & { truncated: boolean; sourceTradeCount: number }> {
  await getOwnedAccount(userId, accountId);
  const db = await requireDb();
  const rows: AnalysisTrade[] = [];
  let offset = 0;
  let truncated = false;
  while (offset < ANALYSIS_MAX_TRADES) {
    const page = await db.select(analysisSelection).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId))).orderBy(asc(trades.tradeDate), asc(trades.id)).limit(Math.min(ANALYSIS_PAGE_SIZE, ANALYSIS_MAX_TRADES - offset)).offset(offset);
    rows.push(...page as AnalysisTrade[]);
    if (page.length < ANALYSIS_PAGE_SIZE) break;
    offset += page.length;
  }
  if (rows.length >= ANALYSIS_MAX_TRADES) truncated = true;
  const analysis = buildAnalysis(rows, filters);
  return { ...analysis, truncated, sourceTradeCount: rows.length };
}

export const analysisLimits = { pageSize: ANALYSIS_PAGE_SIZE, maxTrades: ANALYSIS_MAX_TRADES } as const;
