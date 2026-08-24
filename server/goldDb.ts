import { and, desc, eq, gte } from "./supabaseQuery";
import { accounts, cashMovements, dailyPlans, goals, skippedTrades, trades } from "../drizzle/schema";
import { storageGetSignedUrl } from "./storage";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { getDb } from "./db";
import { toSafeAccount, toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";
import { normalizeAccountName } from "./accountIdentity";

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

async function getAccountCashNet(userId: number, accountId: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_account_cash_net", { target_user_id: userId, target_account_id: accountId });
  if (error) throw new Error(`Supabase account balance aggregate is unavailable: ${error.message}`);
  const value = Number(data ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export type TradeSummary = { total: number; closed: number; wins: number; losses: number; pnl: number; source: "rpc" | "fallback" };
const TRADE_SUMMARY_FALLBACK: TradeSummary = { total: 0, closed: 0, wins: 0, losses: 0, pnl: 0, source: "fallback" };
const CASH_NET_FALLBACK = { value: 0, source: "fallback" as const };
export function resolveDerivedCashNet(result: PromiseSettledResult<number>) { return result.status === "fulfilled" ? { value: result.value, source: "rpc" as const } : CASH_NET_FALLBACK; }
export function resolveDerivedTradeSummary(result: PromiseSettledResult<TradeSummary>) { return result.status === "fulfilled" ? result.value : TRADE_SUMMARY_FALLBACK; }

async function getAccountTradeSummary(userId: number, accountId: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_account_trade_summary", { target_user_id: userId, target_account_id: accountId });
  if (error) throw new Error(`Supabase account trade summary is unavailable: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const number = (value: unknown) => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
  return { total: number(row?.total_trades), closed: number(row?.closed_trades), wins: number(row?.win_trades), losses: number(row?.loss_trades), pnl: number(row?.pnl), source: "rpc" as const };
}

export async function ensureAccount(userId: number) {
  const db = await requireDb();
  const existing = await db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(accounts).values({ userId, name: "Primary Account", normalizedName: normalizeAccountName("Primary Account"), bootstrapKey: "PRIMARY", startingBalance: "0.00" }).onConflictDoUpdate({ target: [accounts.userId, accounts.bootstrapKey], set: { bootstrapKey: "PRIMARY" } });
  const created = await db.select().from(accounts).where(and(eq(accounts.userId, userId), eq(accounts.bootstrapKey, "PRIMARY"))).limit(1);
  if (created[0]) return created[0];
  const fallback = await db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
  return fallback[0]!;
}

export async function getOwnedAccount(userId: number, accountId?: number) {
  const fallback = await ensureAccount(userId);
  if (!accountId) return fallback;
  const db = await requireDb();
  const found = await db.select().from(accounts).where(and(eq(accounts.id, accountId), eq(accounts.userId, userId))).limit(1);
  if (!found[0]) throw new Error("That trading account is unavailable.");
  return found[0];
}

export async function getJournal(userId: number, accountId?: number) {
  const db = await requireDb();
  const activeAccount = await getOwnedAccount(userId, accountId);
  const goalWindowStart = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
  const [accountList, tradeList, goalTradeList, movementList, goalList, skippedList, planList] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(desc(accounts.createdAt)).limit(1_000),
    db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, activeAccount.id))).orderBy(desc(trades.tradeDate)).limit(500),
    db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, activeAccount.id), gte(trades.tradeDate, goalWindowStart))).orderBy(desc(trades.tradeDate)).limit(10_000),
    db.select().from(cashMovements).where(and(eq(cashMovements.userId, userId), eq(cashMovements.accountId, activeAccount.id))).orderBy(desc(cashMovements.movementDate)).limit(200),
    db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.accountId, activeAccount.id), eq(goals.isCustom, true))).orderBy(goals.period, goals.createdAt).limit(200),
    db.select().from(skippedTrades).where(and(eq(skippedTrades.userId, userId), eq(skippedTrades.accountId, activeAccount.id))).orderBy(desc(skippedTrades.tradeDate)).limit(500),
    db.select().from(dailyPlans).where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.accountId, activeAccount.id))).orderBy(desc(dailyPlans.planDate)).limit(500),
  ]);
  const [cashResult, tradeSummaryResult] = await Promise.allSettled([getAccountCashNet(userId, activeAccount.id), getAccountTradeSummary(userId, activeAccount.id)]);
  const cashNet = resolveDerivedCashNet(cashResult);
  const cashNetValue = cashNet.source === "rpc" ? cashNet.value : movementList.reduce((total, movement) => total + (movement.type === "DEPOSIT" ? Number(movement.amount ?? 0) : -Number(movement.amount ?? 0)), 0);
  const tradeSummary = resolveDerivedTradeSummary(tradeSummaryResult);
  return {
    activeAccount: toSafeAccount(activeAccount),
    accounts: accountList.map(toSafeAccount),
    // Trade Log retrieves only its visible page with signed screenshots through
    // trades.list. Journal-wide calendar, goal, and summary consumers need no
    // signed object URL for every historical row.
    trades: tradeList.map(toSafeTrade),
    goalTrades: goalTradeList.map(toSafeTrade),
    cashMovements: movementList.map(toSafeJournalRecord),
    cashNet: Number.isFinite(cashNetValue) ? cashNetValue : 0,
    cashNetStatus: { source: cashNet.source },
    cashNetError: cashNet.source === "fallback" ? { code: "CASH_NET_UNAVAILABLE", message: "Account balance aggregate temporarily unavailable." } : null,
    tradeSummary,
    tradeSummaryStatus: { source: tradeSummary.source },
    tradeSummaryError: tradeSummary.source === "fallback" ? { code: "TRADE_SUMMARY_UNAVAILABLE", message: "Trade summary temporarily unavailable." } : null,
    goals: goalList.map(toSafeJournalRecord),
    skippedTrades: skippedList.map(toSafeJournalRecord),
    dailyPlans: planList.map(toSafeJournalRecord),
  };
}

export async function ownsTrade(userId: number, tradeId: number) {
  const db = await requireDb();
  const result = await db.select().from(trades).where(and(eq(trades.id, tradeId), eq(trades.userId, userId))).limit(1);
  if (!result[0]) throw new Error("That trade is unavailable.");
  return result[0];
}
