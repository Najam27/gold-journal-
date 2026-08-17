import { and, count, desc, eq, like, or } from "./supabaseQuery";
import { randomBytes } from "crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { accounts, cashMovements, dailyPlans, goals, mt5Connections, mt5LivePositions, notificationHistory, notificationSettings, optionLists, skippedTrades, trades } from "../drizzle/schema";
import { ensureAccount, getJournal, getOwnedAccount, ownsTrade } from "./goldDb";
import { getDb } from "./db";
import { getMt5History, getMt5Workspace, syncStoredMt5PositionsToTradeLog } from "./mt5Db";
import { mt5ApiKeyFingerprint } from "./mt5Security";
import { toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";
import { protectedProcedure, router } from "./_core/trpc";
import { storageGetSignedUrl, storagePut } from "./storage";

const MAX_MONEY = 999_999_999_999.99;
const optionalText = (max = 5000) => z.string().trim().max(max).optional().default("");
const money = (min = -MAX_MONEY) => z.number().finite().min(min).max(MAX_MONEY);
const timestampInput = z.number().finite().int().positive().max(8_640_000_000_000_000);
const accountIdInput = z.object({ accountId: z.number().int().positive() });
const mt5TicketInput = z.string().regex(/^\d+$/).max(20).optional();
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
  const db = await dbOrThrow();
  const resetAt = new Date();
  await db.transaction(async tx => {
    await tx.update(mt5Connections).set({ journalDataResetAt: resetAt, historySyncedCount: 0, lastHistorySync: null, lastHistoryStatus: "RESET", lastHistoryMessage: "Journal data was cleared; awaiting post-reset MT5 events." }).where(and(eq(mt5Connections.userId, userId), eq(mt5Connections.accountId, accountId)));
    await tx.delete(notificationHistory).where(and(eq(notificationHistory.userId, userId), eq(notificationHistory.accountId, accountId)));
    await tx.delete(dailyPlans).where(and(eq(dailyPlans.userId, userId), eq(dailyPlans.accountId, accountId)));
    await tx.delete(skippedTrades).where(and(eq(skippedTrades.userId, userId), eq(skippedTrades.accountId, accountId)));
    await tx.delete(cashMovements).where(and(eq(cashMovements.userId, userId), eq(cashMovements.accountId, accountId)));
    await tx.delete(mt5LivePositions).where(eq(mt5LivePositions.accountId, accountId));
    await tx.delete(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId)));
  });
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
      const db = await dbOrThrow();
      return db.transaction(async tx => {
        const ownedAccounts = await tx.select().from(accounts).where(eq(accounts.userId, ctx.user.id));
        if (ownedAccounts.length < 2) throw new Error("Create another account before removing your only account.");
        const replacement = ownedAccounts.find(account => account.id !== input.accountId);
        if (!replacement) throw new Error("A replacement account could not be selected.");
        await tx.delete(notificationHistory).where(and(eq(notificationHistory.userId, ctx.user.id), eq(notificationHistory.accountId, input.accountId)));
        await tx.delete(dailyPlans).where(and(eq(dailyPlans.userId, ctx.user.id), eq(dailyPlans.accountId, input.accountId)));
        await tx.delete(skippedTrades).where(and(eq(skippedTrades.userId, ctx.user.id), eq(skippedTrades.accountId, input.accountId)));
        await tx.delete(cashMovements).where(and(eq(cashMovements.userId, ctx.user.id), eq(cashMovements.accountId, input.accountId)));
        await tx.delete(goals).where(and(eq(goals.userId, ctx.user.id), eq(goals.accountId, input.accountId)));
        await tx.delete(mt5LivePositions).where(eq(mt5LivePositions.accountId, input.accountId));
        await tx.delete(mt5Connections).where(and(eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId)));
        await tx.delete(trades).where(and(eq(trades.userId, ctx.user.id), eq(trades.accountId, input.accountId)));
        await tx.delete(accounts).where(and(eq(accounts.userId, ctx.user.id), eq(accounts.id, input.accountId)));
        return { success: true, replacementAccountId: replacement.id };
      });
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
      const trade = await ownsTrade(ctx.user.id, input.tradeId);
      const base64 = input.base64.includes(",") ? input.base64.split(",")[1] : input.base64;
      const bytes = Buffer.from(base64, "base64");
      if (!bytes.byteLength) throw new Error("Screenshot payload is empty.");
      if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Screenshot must be 5MB or smaller.");
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
      const rows = await db.select().from(optionLists).where(eq(optionLists.userId, ctx.user.id)).orderBy(optionLists.category, optionLists.value);
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
    get: protectedProcedure.query(async ({ ctx }) => {
      const db = await dbOrThrow();
      const [settings] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, ctx.user.id)).limit(1);
      const history = await db.select().from(notificationHistory).where(eq(notificationHistory.userId, ctx.user.id)).orderBy(desc(notificationHistory.createdAt)).limit(50);
      return { settings: settings ? toSafeJournalRecord(settings) : { goalAlerts: true, emailAlerts: false }, history: history.map(toSafeJournalRecord) };
    }),
    updateSettings: protectedProcedure.input(z.object({ goalAlerts: z.boolean(), emailAlerts: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      await db.insert(notificationSettings).values({ userId: ctx.user.id, ...input }).onConflictDoUpdate({ target: notificationSettings.userId, set: input });
      return { success: true };
    }),
    recordGoalAlerts: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), alerts: z.array(z.object({ goalId: z.number().int().positive(), status: z.enum(["AT_RISK", "BREACHED", "MET"]), cycleKey: z.string().min(4).max(24), message: z.string().trim().min(1).max(800) })).max(20) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const [settings] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, ctx.user.id)).limit(1);
      if (settings && !settings.goalAlerts) return { recorded: 0 };
      let recorded = 0;
      for (const alert of input.alerts) {
        const goal = await ownGoal(ctx.user.id, alert.goalId);
        if (!goal.active || !goal.notify || goal.accountId !== input.accountId) continue;
        const type = `GOAL_${alert.status}_${goal.id}_${alert.cycleKey}`;
        const existing = await db.select({ id: notificationHistory.id }).from(notificationHistory).where(and(eq(notificationHistory.userId, ctx.user.id), eq(notificationHistory.type, type))).limit(1);
        if (existing[0]) continue;
        await db.insert(notificationHistory).values({ userId: ctx.user.id, accountId: input.accountId, type, message: alert.message });
        recorded += 1;
      }
      return { recorded };
    }),
    markRead: protectedProcedure.input(z.object({ notificationId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      await db.update(notificationHistory).set({ readAt: new Date() }).where(and(eq(notificationHistory.id, input.notificationId), eq(notificationHistory.userId, ctx.user.id)));
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
