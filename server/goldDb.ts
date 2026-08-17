import { and, desc, eq } from "./supabaseQuery";
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
  const [accountList, tradeList, movementList, goalList, skippedList, planList, cashNet] = await Promise.all([
    db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(desc(accounts.createdAt)).limit(1_000),
    db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, activeAccount.id))).orderBy(desc(trades.tradeDate)).limit(500),
    db.select().from(cashMovements).where(and(eq(cashMovements.userId, userId), eq(cashMovements.accountId, activeAccount.id))).orderBy(desc(cashMovements.movementDate)).limit(200),
    db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.accountId, activeAccount.id), eq(goals.isCustom, true))).orderBy(goals.period, goals.createdAt).limit(200),
    db.select().from(skippedTrades).where(and(eq(skippedTrades.userId, userId), eq(skippedTrades.accountId, activeAccount.id))).orderBy(desc(skippedTrades.tradeDate)).limit(500),
    db.select().from(dailyPlans).where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.accountId, activeAccount.id))).orderBy(desc(dailyPlans.planDate)).limit(500),
    getAccountCashNet(userId, activeAccount.id),
  ]);
  const ownedTrades = await hydrateSignedScreenshots(tradeList, storageGetSignedUrl);
  return {
    activeAccount: toSafeAccount(activeAccount),
    accounts: accountList.map(toSafeAccount),
    trades: ownedTrades.map(toSafeTrade),
    cashMovements: movementList.map(toSafeJournalRecord),
    cashNet,
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
