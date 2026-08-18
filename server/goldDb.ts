import { and, desc, eq, gte } from "./supabaseQuery";
import { accounts, cashMovements, dailyPlans, goals, skippedTrades, trades } from "../drizzle/schema";
import { storageGetSignedUrl } from "./storage";
import { getSupabaseAdmin } from "./supabaseAdmin";
import { getDb } from "./db";
import { hydrateSignedScreenshots } from "./journalScreenshots";
import { toSafeAccount, toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

async function getAccountCashNet(userId: number, accountId: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_account_cash_net", { target_user_id: userId, target_account_id: accountId });
  if (error) throw new Error(`Supabase account balance aggregate is unavailable: ${error.message}`);
  const value = Number(data ?? 0);
  return Number.isFinite(value) ? value : 0;
}

async function getAccountTradeSummary(userId: number, accountId: number) {
  const { data, error } = await getSupabaseAdmin().rpc("gj_account_trade_summary", { target_user_id: userId, target_account_id: accountId });
  if (error) throw new Error(`Supabase account trade summary is unavailable: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  const number = (value: unknown) => { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; };
  return { total: number(row?.total_trades), closed: number(row?.closed_trades), wins: number(row?.win_trades), losses: number(row?.loss_trades), pnl: number(row?.pnl) };
}

export async function ensureAccount(userId: number) {
  const db = await requireDb();
  const existing = await db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(accounts).values({ userId, name: "Primary Account", bootstrapKey: "PRIMARY", startingBalance: "0.00" }).onConflictDoUpdate({ target: [accounts.userId, accounts.bootstrapKey], set: { bootstrapKey: "PRIMARY" } });
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
  const [accountList, tradeList, goalTradeList, movementList, goalList, skippedList, planList, cashNet, tradeSummary] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(desc(accounts.createdAt)).limit(1_000),
    db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, activeAccount.id))).orderBy(desc(trades.tradeDate)).limit(500),
    db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, activeAccount.id), gte(trades.tradeDate, goalWindowStart))).orderBy(desc(trades.tradeDate)).limit(10_000),
    db.select().from(cashMovements).where(and(eq(cashMovements.userId, userId), eq(cashMovements.accountId, activeAccount.id))).orderBy(desc(cashMovements.movementDate)).limit(200),
    db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.accountId, activeAccount.id), eq(goals.isCustom, true))).orderBy(goals.period, goals.createdAt).limit(200),
    db.select().from(skippedTrades).where(and(eq(skippedTrades.userId, userId), eq(skippedTrades.accountId, activeAccount.id))).orderBy(desc(skippedTrades.tradeDate)).limit(500),
    db.select().from(dailyPlans).where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.accountId, activeAccount.id))).orderBy(desc(dailyPlans.planDate)).limit(500),
    getAccountCashNet(userId, activeAccount.id),
    getAccountTradeSummary(userId, activeAccount.id),
  ]);
  const ownedTrades = await hydrateSignedScreenshots(tradeList, storageGetSignedUrl);
  return {
    activeAccount: toSafeAccount(activeAccount),
    accounts: accountList.map(toSafeAccount),
    trades: ownedTrades.map(toSafeTrade),
    goalTrades: goalTradeList.map(toSafeTrade),
    cashMovements: movementList.map(toSafeJournalRecord),
    cashNet,
    tradeSummary,
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
