import { and, count, desc, eq, like, or } from "./supabaseQuery";
import { randomBytes } from "crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { accounts, cashMovements, dailyPlans, goals, mt5Connections, mt5LivePositions, notificationHistory, notificationSettings, optionLists, skippedTrades, trades } from "../drizzle/schema";
import { ensureAccount, getJournal, getOwnedAccount, ownsTrade } from "./goldDb";
import { getDb } from "./db";
import { getMt5History, getMt5Workspace, syncStoredMt5PositionsToTradeLog } from "./mt5Db";
import { mt5ApiKeyFingerprint } from "./mt5Security";
import { toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";
import { protectedProcedure, router } from "./_core/trpc";
import { hasImageSignature, storageGetSignedUrl, storagePut } from "./storage";
import { consumeRateLimit } from "./rateLimit";
import { clearAccountJournalDataAtomic, recordGoalAlertsAtomic, removeAccountAtomic } from "./atomicOperations";
import { getAccountAnalysis } from "./analysisDb";
import { analyzeWithOpenRouter } from "./analysisAi";
import { compareAnalysis } from "@shared/analysisEngine";

const MAX_MONEY = 999_999_999_999.99;
const optionalText = (max = 5000) => z.string().trim().max(max).optional().default("");
const money = (min = -MAX_MONEY) => z.number().finite().min(min).max(MAX_MONEY);
const timestampInput = z.number().finite().int().positive().max(8_640_000_000_000_000);
const accountIdInput = z.object({ accountId: z.number().int().positive() });
const mt5TicketInput = z.string().regex(/^\d+$/).max(20).optional();
const analysisFiltersInput = z.object({ startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), session: z.string().trim().max(40).nullable().optional(), timeframe: z.string().trim().max(20).nullable().optional(), level: z.string().trim().max(100).nullable().optional(), setup: z.string().trim().max(40).nullable().optional(), direction: z.enum(["BUY", "SELL"]).nullable().optional(), result: z.enum(["WIN", "LOSS", "BREAK_EVEN", "OPEN"]).nullable().optional() }).default({});
const analysisInput = z.object({ accountId: z.number().int().positive(), filters: analysisFiltersInput });
const analysisCompareInput = z.object({ accountId: z.number().int().positive(), current: analysisFiltersInput, previous: analysisFiltersInput });
const lossFloorMetrics = new Set(["daily_loss", "weekly_drawdown"]);
const goalInput = z.object({ accountId: z.number().int().positive(), name: z.string().trim().min(1).max(120), description: optionalText(500), period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]), metric: z.string().trim().min(1).max(80), comparison: z.enum(["GTE", "LTE"]), target: money(-1_000_000), notify: z.boolean().default(true), active: z.boolean().default(true) }).superRefine((value, ctx) => {
  if (lossFloorMetrics.has(value.metric) && value.target >= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "Loss controls use a negative P&L floor, for example -100." });
  if (!lossFloorMetrics.has(value.metric) && value.target < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "Only loss-floor controls can use a negative threshold." });
});

const tradeInput = z.object({
  accountId: z.number().int().positive(),
  tradeDate: timestampInput,
  session: z.string().min(1).max(40),
  direction: z.enum(["BUY", "SELL"]),
  result: z.enum(["WIN", "LOSS", "BREAK_EVEN", "OPEN"]),
  level: optionalText(100),
  timeframe: optionalText(20),
  setupQuality: optionalText(40),
  executionType: optionalText(80),
  marketCondition: optionalText(40),
  biasAlignment: optionalText(40),
  confirmationType: optionalText(60),
  slPlacement: optionalText(60),
  tpPlacement: optionalText(60),
  mistake: optionalText(80),
  holdQuality: optionalText(60),
  patienceScore: z.number().int().min(1).max(5).nullable(),
  risk: money(0).nullable(),
  reward: money(0).nullable(),
  pnl: money(),
  notes: optionalText(6000),
  emotionBefore: optionalText(2000),
  emotionDuring: optionalText(2000),
  emotionAfter: optionalText(2000),
  mt5Ticket: mt5TicketInput,
});

async function dbOrThrow() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

async function ownGoal(userId: number, goalId: number) {
  const db = await dbOrThrow();
  const found = await db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId))).limit(1);
  if (!found[0]) throw new Error("That goal is unavailable.");
  return found[0];
}

async function ownMt5Connection(userId: number, accountId: number, connectionId: number) {
  await getOwnedAccount(userId, accountId);
  const db = await dbOrThrow();
  const found = await db.select().from(mt5Connections).where(and(eq(mt5Connections.id, connectionId), eq(mt5Connections.userId, userId), eq(mt5Connections.accountId, accountId))).limit(1);
  if (!found[0]) throw new Error("That MT5 connection is unavailable.");
  return found[0];
}

async function clearAccountJournalData(userId: number, accountId: number) {
  await getOwnedAccount(userId, accountId);
  await clearAccountJournalDataAtomic(userId, accountId, new Date());
}

export const goldRouter = router({
  journal: router({
    bootstrap: protectedProcedure.query(({ ctx }) => ensureAccount(ctx.user.id)),
    get: protectedProcedure.input(z.object({ accountId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
      const account = await getOwnedAccount(ctx.user.id, input.accountId);
      await syncStoredMt5PositionsToTradeLog(ctx.user.id, account.id);
      return getJournal(ctx.user.id, account.id);
    }),
  }),
  analysis: router({
    get: protectedProcedure.input(analysisInput).query(({ ctx, input }) => getAccountAnalysis(ctx.user.id, input.accountId, input.filters)),
    ai: protectedProcedure.input(analysisInput).mutation(async ({ ctx, input }) => {
      if (!consumeRateLimit("analysis-ai", ctx.user.id, 3, 10 * 60_000)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "AI analysis limit reached. Please retry later." });
      const deterministic = await getAccountAnalysis(ctx.user.id, input.accountId, input.filters);
      const ai = await analyzeWithOpenRouter(ctx.user.id, input.accountId, deterministic);
      return { ...deterministic, ai };
    }),
    compare: protectedProcedure.input(analysisCompareInput).query(async ({ ctx, input }) => {
      const [current, previous] = await Promise.all([getAccountAnalysis(ctx.user.id, input.accountId, input.current), getAccountAnalysis(ctx.user.id, input.accountId, input.previous)]);
      return { current, previous, delta: compareAnalysis(current, previous) };
    }),
  }),
  accounts: router({
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(100), startingBalance: money(0).default(0) })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const inserted = await db.insert(accounts).values({ userId: ctx.user.id, name: input.name, startingBalance: input.startingBalance.toFixed(2) }).returning({ id: accounts.id });
      return { id: inserted[0].id };
    }),
    rename: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), name: z.string().trim().min(1).max(100) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      await db.update(accounts).set({ name: input.name }).where(and(eq(accounts.id, input.accountId), eq(accounts.userId, ctx.user.id)));
      return { success: true };
    }),
    remove: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      return removeAccountAtomic(ctx.user.id, input.accountId);
    }),
  }),
  mt5: router({
    workspace: protectedProcedure.input(accountIdInput).query(({ ctx, input }) => getMt5Workspace(ctx.user.id, input.accountId)),
    history: protectedProcedure.input(accountIdInput.extend({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(20) })).query(({ ctx, input }) => getMt5History(ctx.user.id, input.accountId, input.page, input.pageSize)),
    syncTradeLog: protectedProcedure.input(accountIdInput).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const connection = await dbOrThrow().then(db => db.select({ id: mt5Connections.id }).from(mt5Connections).where(and(eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId), eq(mt5Connections.active, true))).limit(1));
      if (!connection[0]) throw new Error("No active MT5 connection is available for this journal account.");
      const synchronized = await syncStoredMt5PositionsToTradeLog(ctx.user.id, input.accountId);
      return { synchronized };
    }),
    createConnection: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), label: z.string().trim().min(1).max(120), brokerUtcOffsetMinutes: z.number().int().min(-12 * 60).max(14 * 60).default(180) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const existing = await db.select({ id: mt5Connections.id }).from(mt5Connections).where(and(eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId))).limit(1);
      if (existing[0]) throw new Error("This Gold Journal account already has an MT5 connection. Edit or replace it from MT5 Live.");
      const apiKey = randomBytes(32).toString("base64url");
      const inserted = await db.insert(mt5Connections).values({ userId: ctx.user.id, accountId: input.accountId, label: input.label, apiKey: mt5ApiKeyFingerprint(apiKey), brokerUtcOffsetMinutes: input.brokerUtcOffsetMinutes, active: true }).returning({ id: mt5Connections.id });
      return { id: inserted[0].id, apiKey };
    }),
    updateConnectionOffset: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), brokerUtcOffsetMinutes: z.number().int().min(-12 * 60).max(14 * 60) })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      const db = await dbOrThrow();
      await db.update(mt5Connections).set({ brokerUtcOffsetMinutes: input.brokerUtcOffsetMinutes }).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId)));
      return { success: true };
    }),
    setConnectionActive: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      const db = await dbOrThrow();
      await db.update(mt5Connections).set({ active: input.active }).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id)));
      return { success: true };
    }),
    deleteConnection: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      const db = await dbOrThrow();
      await db.delete(mt5Connections).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id)));
      return { success: true };
    }),
  }),
  trades: router({
    list: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(12), search: z.string().trim().max(160).optional().default(""), result: z.enum(["WIN", "LOSS", "BREAK_EVEN", "OPEN"]).optional() })).query(async ({ ctx, input }) => {
      const account = await getOwnedAccount(ctx.user.id, input.accountId);
      await syncStoredMt5PositionsToTradeLog(ctx.user.id, account.id);
      const db = await dbOrThrow();
      let where = and(eq(trades.userId, ctx.user.id), eq(trades.accountId, account.id));
      if (input.result) where = and(where, eq(trades.result, input.result));
      if (input.search) {
        const needle = `%${input.search}%`;
        where = and(where, or(like(trades.session, needle), like(trades.level, needle), like(trades.notes, needle)));
      }
      const totalRows = await db.select({ total: count() }).from(trades).where(where);
      const total = Number(totalRows[0]?.total ?? 0);
      const pageCount = Math.max(1, Math.ceil(total / input.pageSize));
      const page = Math.min(input.page, pageCount);
      const rows = await db.select().from(trades).where(where).orderBy(desc(trades.tradeDate), desc(trades.id)).limit(input.pageSize).offset((page - 1) * input.pageSize);
      const hydratedRows = await Promise.all(rows.map(async trade => ({ ...trade, screenshotUrl: trade.screenshotKey ? await storageGetSignedUrl(trade.screenshotKey).catch(() => null) : null })));
      return { trades: hydratedRows.map(toSafeTrade), total, page, pageSize: input.pageSize, pageCount };
    }),
    create: protectedProcedure.input(tradeInput).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      if (input.mt5Ticket) {
        const linked = await db.select({ id: mt5LivePositions.id }).from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, input.accountId), eq(mt5LivePositions.ticket, BigInt(input.mt5Ticket)), eq(mt5LivePositions.status, "CLOSED"))).limit(1);
        if (!linked[0]) throw new Error("The selected MT5 ticket is not an unjournaled closed position for this account.");
      }
      const inserted = await db.insert(trades).values({
        userId: ctx.user.id, accountId: input.accountId, tradeDate: new Date(input.tradeDate), session: input.session,
        direction: input.direction, result: input.result, level: input.level, timeframe: input.timeframe,
        setupQuality: input.setupQuality, executionType: input.executionType, marketCondition: input.marketCondition,
        biasAlignment: input.biasAlignment, confirmationType: input.confirmationType, slPlacement: input.slPlacement,
        tpPlacement: input.tpPlacement, mistake: input.mistake, holdQuality: input.holdQuality, patienceScore: input.patienceScore,
        risk: input.risk?.toFixed(2) ?? null, reward: input.reward?.toFixed(2) ?? null, pnl: input.pnl.toFixed(2),
        notes: input.notes, emotionBefore: input.emotionBefore, emotionDuring: input.emotionDuring, emotionAfter: input.emotionAfter,
        mt5Ticket: input.mt5Ticket ? BigInt(input.mt5Ticket) : null,
      }).returning({ id: trades.id });
      return { id: inserted[0].id };
    }),
    update: protectedProcedure.input(tradeInput.extend({ tradeId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const current = await ownsTrade(ctx.user.id, input.tradeId);
      if (current.accountId !== input.accountId) throw new Error("A trade cannot be moved between journal accounts.");
      const nextTicket = input.mt5Ticket ? BigInt(input.mt5Ticket) : current.mt5Ticket;
      if (input.mt5Ticket && input.mt5Ticket !== current.mt5Ticket?.toString()) {
        const db = await dbOrThrow();
        const linked = await db.select({ id: mt5LivePositions.id }).from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, current.accountId), eq(mt5LivePositions.ticket, nextTicket), eq(mt5LivePositions.status, "CLOSED"))).limit(1);
        if (!linked[0]) throw new Error("The selected MT5 ticket is not an unjournaled closed position for this account.");
        const alreadyJournaled = await db.select({ id: trades.id }).from(trades).where(and(eq(trades.accountId, current.accountId), eq(trades.mt5Ticket, nextTicket))).limit(1);
        if (alreadyJournaled[0] && alreadyJournaled[0].id !== current.id) throw new Error("That MT5 ticket is already linked to another journal trade.");
      }
      const db = await dbOrThrow();
      await db.update(trades).set({
        tradeDate: new Date(input.tradeDate), session: input.session, direction: input.direction, result: input.result,
        level: input.level, timeframe: input.timeframe, setupQuality: input.setupQuality, executionType: input.executionType,
        marketCondition: input.marketCondition, biasAlignment: input.biasAlignment, confirmationType: input.confirmationType,
        slPlacement: input.slPlacement, tpPlacement: input.tpPlacement, mistake: input.mistake, holdQuality: input.holdQuality,
        patienceScore: input.patienceScore, risk: input.risk?.toFixed(2) ?? null, reward: input.reward?.toFixed(2) ?? null,
        pnl: input.pnl.toFixed(2), notes: input.notes, emotionBefore: input.emotionBefore, emotionDuring: input.emotionDuring, emotionAfter: input.emotionAfter,
        mt5Ticket: nextTicket,
      }).where(and(eq(trades.id, current.id), eq(trades.userId, ctx.user.id)));
      return { success: true };
    }),
    delete: protectedProcedure.input(z.object({ tradeId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const current = await ownsTrade(ctx.user.id, input.tradeId);
      const db = await dbOrThrow();
      await db.delete(trades).where(and(eq(trades.id, current.id), eq(trades.userId, ctx.user.id)));
      return { success: true };
    }),
    clearAll: protectedProcedure.input(accountIdInput.extend({ confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      await clearAccountJournalData(ctx.user.id, input.accountId);
      return { success: true };
    }),
    uploadScreenshot: protectedProcedure.input(z.object({ tradeId: z.number().int().positive(), fileName: z.string().trim().min(1).max(255), mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]), base64: z.string().trim().min(40).max(7_000_000).regex(/^(?:data:image\/(?:jpeg|png|webp);base64,)?[A-Za-z0-9+/]+={0,2}$/, "Invalid base64 image payload") })).mutation(async ({ ctx, input }) => {
      if (!consumeRateLimit("screenshot", ctx.user.id, 20, 60_000)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Screenshot upload limit reached. Please try again shortly." });
      const trade = await ownsTrade(ctx.user.id, input.tradeId);
      const base64 = input.base64.includes(",") ? input.base64.split(",")[1] : input.base64;
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.byteLength) throw new Error("Screenshot payload is empty.");
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Screenshot must be 5MB or smaller.");
      if (!hasImageSignature(bytes, input.mimeType)) throw new Error("Screenshot content does not match its declared image type.");
      const extension = input.mimeType === "image/png" ? "png" : input.mimeType === "image/webp" ? "webp" : "jpg";
      const stored = await storagePut(`gold-journal/${ctx.user.openId}/trades/${trade.id}-${nanoid()}.${extension}`, bytes, input.mimeType);
      const db = await dbOrThrow();
      await db.update(trades).set({ screenshotKey: stored.key, screenshotName: input.fileName }).where(and(eq(trades.id, trade.id), eq(trades.userId, ctx.user.id)));
      return { url: stored.url };
    }),
  }),
  cash: router({
    create: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), movementDate: timestampInput, type: z.enum(["DEPOSIT", "WITHDRAW"]), amount: money(0.01), note: optionalText(1000) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      await db.insert(cashMovements).values({ userId: ctx.user.id, accountId: input.accountId, movementDate: new Date(input.movementDate), type: input.type, amount: input.amount.toFixed(2), note: input.note });
      return { success: true };
    }),
  }),
  goals: router({
    create: protectedProcedure.input(goalInput).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const inserted = await db.insert(goals).values({ ...input, userId: ctx.user.id, target: input.target.toFixed(2), isCustom: true }).returning({ id: goals.id });
      return { success: true, id: inserted[0].id };
    }),
    update: protectedProcedure.input(goalInput.safeExtend({ goalId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const existing = await ownGoal(ctx.user.id, input.goalId);
      await getOwnedAccount(ctx.user.id, input.accountId);
      if (existing.accountId !== input.accountId) throw new Error("Goals cannot be moved between accounts. Create the goal in the destination account instead.");
      const db = await dbOrThrow();
      await db.update(goals).set({ name: input.name, description: input.description, period: input.period, metric: input.metric, comparison: input.comparison, target: input.target.toFixed(2), notify: input.notify, active: input.active, isCustom: true }).where(and(eq(goals.id, input.goalId), eq(goals.userId, ctx.user.id)));
      return { success: true };
    }),
    delete: protectedProcedure.input(z.object({ goalId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      await ownGoal(ctx.user.id, input.goalId);
      const db = await dbOrThrow();
      await db.delete(goals).where(and(eq(goals.id, input.goalId), eq(goals.userId, ctx.user.id)));
      return { success: true };
    }),
    clearAll: protectedProcedure.input(accountIdInput.extend({ confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      await db.delete(goals).where(and(eq(goals.userId, ctx.user.id), eq(goals.accountId, input.accountId)));
      return { success: true };
    }),
  }),
  optionLists: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await dbOrThrow();
      const rows = await db.select().from(optionLists).where(eq(optionLists.userId, ctx.user.id)).orderBy(optionLists.category, optionLists.value).limit(500);
      return rows.map(toSafeJournalRecord);
    }),
    add: protectedProcedure.input(z.object({ category: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(160) })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      await db.insert(optionLists).values({ userId: ctx.user.id, category: input.category, value: input.value }).onConflictDoUpdate({ target: [optionLists.userId, optionLists.category, optionLists.value], set: { active: true } });
      return { success: true };
    }),
    setActive: protectedProcedure.input(z.object({ optionId: z.number().int().positive(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      await db.update(optionLists).set({ active: input.active }).where(and(eq(optionLists.id, input.optionId), eq(optionLists.userId, ctx.user.id)));
      return { success: true };
    }),
  }),
  notifications: router({
    get: protectedProcedure.input(z.object({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(50) }).optional()).query(async ({ ctx, input }) => {
      const { page: requestedPage, pageSize } = input ?? { page: 1, pageSize: 50 };
      const db = await dbOrThrow();
      const where = eq(notificationHistory.userId, ctx.user.id);
      const [settingsRows, totalRows] = await Promise.all([
        db.select().from(notificationSettings).where(eq(notificationSettings.userId, ctx.user.id)).limit(1),
        db.select({ total: count() }).from(notificationHistory).where(where),
      ]);
      const total = Number(totalRows[0]?.total ?? 0);
      const pageCount = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(requestedPage, pageCount);
      const history = await db.select().from(notificationHistory).where(where).orderBy(desc(notificationHistory.createdAt)).limit(pageSize).offset((page - 1) * pageSize);
      return { settings: settingsRows[0] ? toSafeJournalRecord(settingsRows[0]) : { goalAlerts: true, emailAlerts: false }, history: history.map(toSafeJournalRecord), total, page, pageSize, pageCount };
    }),
    updateSettings: protectedProcedure.input(z.object({ goalAlerts: z.boolean(), emailAlerts: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      await db.insert(notificationSettings).values({ userId: ctx.user.id, ...input }).onConflictDoUpdate({ target: notificationSettings.userId, set: input });
      return { success: true };
    }),
    recordGoalAlerts: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), alerts: z.array(z.object({ goalId: z.number().int().positive(), status: z.enum(["AT_RISK", "BREACHED", "MET"]), cycleKey: z.string().min(4).max(24), message: z.string().trim().min(1).max(800) })).max(20) })).mutation(async ({ ctx, input }) => {
      if (!consumeRateLimit("goal-alerts", ctx.user.id, 30, 60_000)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Notification write limit reached. Please try again shortly." });
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const [settings] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, ctx.user.id)).limit(1);
      if (settings && !settings.goalAlerts) return { recorded: 0 };
      const alerts = input.alerts.map(alert => ({ goalId: alert.goalId, type: `GOAL_${alert.status}_${alert.goalId}_${alert.cycleKey}`, message: alert.message }));
      return { recorded: await recordGoalAlertsAtomic(ctx.user.id, input.accountId, alerts) };
    }),
    markRead: protectedProcedure.input(z.object({ notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      await db.update(notificationHistory).set({ readAt: new Date() }).where(and(eq(notificationHistory.id, input.notificationId), eq(notificationHistory.userId, ctx.user.id)));
      return { success: true };
    }),
    markAllRead: protectedProcedure.mutation(async ({ ctx }) => {
      const db = await dbOrThrow();
      await db.update(notificationHistory).set({ readAt: new Date() }).where(and(eq(notificationHistory.userId, ctx.user.id), eq(notificationHistory.readAt, null)));
      return { success: true };
    }),
  }),
  skipped: router({
    create: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), tradeDate: timestampInput, session: z.string().min(1).max(40), level: optionalText(100), timeframe: optionalText(20), direction: z.enum(["BUY", "SELL"]), skipReason: z.string().min(1).max(120), confidence: z.number().int().min(1).max(5), outcome: z.string().trim().min(1).max(80), estimatedMissed: money(), notes: optionalText(3000) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      await db.insert(skippedTrades).values({ ...input, userId: ctx.user.id, tradeDate: new Date(input.tradeDate), estimatedMissed: input.estimatedMissed.toFixed(2) });
      return { success: true };
    }),
  }),
  plans: router({
    save: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), planDate: timestampInput, preBias: optionalText(40), marketContext: optionalText(3000), keyLevels: optionalText(3000), sessionFocus: z.array(z.string().trim().max(120)).max(9), eventRisk: optionalText(1500), longScenario: optionalText(3000), shortScenario: optionalText(3000), noTradeCondition: optionalText(2000), invalidationLevel: optionalText(1000), riskLimit: optionalText(40), maxTrades: z.number().int().min(1).max(99).nullable(), sizingPlan: optionalText(2000), planNotes: optionalText(5000), rulesPlanned: z.array(z.object({ id: z.string().trim().min(1).max(80), text: z.string().trim().max(500), checked: z.boolean() })).max(30), emotionStart: z.array(z.string().trim().max(80)).max(20), emotionEnd: z.array(z.string().trim().max(80)).max(20), executionScore: z.number().int().min(1).max(5).nullable(), rulesFollowed: z.array(z.object({ id: z.string().trim().min(1).max(80), yes: z.boolean() })).max(30), whatWentWell: optionalText(5000), whatWentWrong: optionalText(5000), executionNotes: optionalText(5000), planDeviation: optionalText(5000), lessons: optionalText(2000), tomorrowFocus: optionalText(2000), overallRating: z.number().int().min(1).max(5).nullable() })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const record = { userId: ctx.user.id, accountId: input.accountId, planDate: new Date(input.planDate), preBias: input.preBias, marketContext: input.marketContext, keyLevels: input.keyLevels, sessionFocus: input.sessionFocus, eventRisk: input.eventRisk, longScenario: input.longScenario, shortScenario: input.shortScenario, noTradeCondition: input.noTradeCondition, invalidationLevel: input.invalidationLevel, riskLimit: input.riskLimit, maxTrades: input.maxTrades, sizingPlan: input.sizingPlan, planNotes: input.planNotes, rulesPlanned: input.rulesPlanned, emotionStart: input.emotionStart.join("|"), emotionEnd: input.emotionEnd.join("|"), executionScore: input.executionScore, rulesFollowed: input.rulesFollowed, whatWentWell: input.whatWentWell, whatWentWrong: input.whatWentWrong, executionNotes: input.executionNotes, planDeviation: input.planDeviation, lessons: input.lessons, tomorrowFocus: input.tomorrowFocus, overallRating: input.overallRating };
      await db.insert(dailyPlans).values(record).onConflictDoUpdate({ target: [dailyPlans.userId, dailyPlans.accountId, dailyPlans.planDate], set: record });
      return { success: true };
    }),
    remove: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), planId: z.number().int().positive(), confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      await db.delete(dailyPlans).where(and(eq(dailyPlans.id, input.planId), eq(dailyPlans.userId, ctx.user.id), eq(dailyPlans.accountId, input.accountId)));
      return { success: true };
    }),
  }),
});
