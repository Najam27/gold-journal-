import { and, count, desc, eq, like, or } from "./supabaseQuery";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { accounts, cashMovements, dailyPlans, goals, mt5Connections, mt5LivePositions, notificationHistory, notificationSettings, optionLists, skippedTrades, traderProfiles, trades } from "../drizzle/schema";
import { ensureAccount, getJournal, getOwnedAccount, ownsTrade } from "./goldDb";
import { getDb } from "./db";
import { normalizeAccountName } from "./accountIdentity";
import { getMt5History, getMt5Workspace, syncStoredMt5PositionsToTradeLog } from "./mt5Db";
import { mt5ApiKeyFingerprint, mt5ConnectionReference } from "./mt5Security";
import { getMt5Integrity } from "./mt5Reliability";
import { calculateAccountMt5Risk } from "./mt5Risk";
import { toSafeAccount, toSafeAccountListItem, toSafeJournalRecord, toSafeTrade } from "./journalPrivacy";
import { protectedProcedure, router } from "./_core/trpc";
import { createPerfTrace } from "./perf";
import { assertOwnedScreenshotPath, hasImageSignature, screenshotObjectKey, screenshotPathPrefix, storageGetSignedUrl, storagePut, storagePutAt, storageRemove, storageRemoveMany } from "./storage";
import { hydrateSignedScreenshots } from "./journalScreenshots";
import { logPersistenceEvent, withPersistenceDiagnostics } from "./persistenceDiagnostics";
import { consumeRateLimit } from "./rateLimit";
import { clearAccountJournalDataAtomic, recordGoalAlertsAtomic, removeAccountAtomic } from "./atomicOperations";
import { getAccountAnalysis } from "./analysisDb";
import { listAiExperiments, listAiReports, persistAiReport, updateAiExperiment } from "./aiReportDb";
import { aiReportSchema } from "@shared/aiCore";
import { MAX_CUSTOM_RISK_PERCENT, MIN_CUSTOM_RISK_PERCENT, RISK_PROFILE_IDS } from "@shared/riskCalculator";
import { compareAnalysis } from "@shared/analysisEngine";
import { getPktDateKey, isPktDateKey, pktDateToTimestamp } from "@shared/pktDate";
import { normalizeTradeOptionValue } from "@shared/tradeOptionCategories";
import {
  OPTION_COLUMNS,
  ensureDefaultTradeOptions,
  findOwnedTradeOption,
  findTradeOptionByNormalizedValue,
  listOwnedOptions,
  requireTradeOptionCategory,
  toTradeOptionView,
  tradeOptionValueError,
  type TradeOptionRow,
} from "./tradeOptions";

const MAX_MONEY = 999_999_999_999.99;
const optionalText = (max = 5000) => z.string().trim().max(max).optional().default("");
// Free-form journal text.
//
// The trade journal stores whatever the trader actually wrote — a long mistake
// explanation, a multi-sentence note, an imported MT5 comment, an emotional
// write-up — so these fields deliberately carry NO character budget. A length
// cap here was the reason editing a trade with a long Mistake/Notes value was
// rejected by the server even though the UI accepted it. `.trim()` is the only
// transformation applied: meaningful user text is never truncated or sliced,
// on the way in or on the way out.
const freeText = z.string().trim().optional().default("");
const money = (min = -MAX_MONEY) => z.number().finite().min(min).max(MAX_MONEY);
const timestampInput = z.number().finite().int().positive().max(8_640_000_000_000_000);
const accountIdInput = z.object({ accountId: z.number().int().positive() });
// The calculator is deterministic and broker-aware. Nothing here is chosen by
// AI: the client sends the user's own profile, direction, and price levels, and
// the backend resolves every broker-sensitive value from the stored MT5
// connection instead of trusting client-supplied contract parameters.
const riskCalculatorInput = accountIdInput.extend({
  basis: z.enum(["EQUITY", "BALANCE"]),
  riskProfile: z.enum(RISK_PROFILE_IDS),
  riskPercent: z.number().finite().min(MIN_CUSTOM_RISK_PERCENT).max(MAX_CUSTOM_RISK_PERCENT),
  direction: z.enum(["BUY", "SELL"]).default("BUY"),
  entryPrice: z.number().finite().positive(),
  stopLoss: z.number().finite().positive(),
  takeProfit: z.number().finite().positive().nullable().optional().default(null),
});
const mt5TicketInput = z.string().regex(/^\d+$/).max(20).optional();
const clientMutationIdInput = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Invalid offline replay id.").optional();
const requiredClientMutationIdInput = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, "Invalid offline replay id.");
const screenshotMimeInput = z.enum(["image/jpeg", "image/png", "image/webp"]);
const screenshotBase64Input = z.string().trim().min(40).max(7_000_000).regex(/^(?:data:image\/(?:jpeg|png|webp);base64,)?[A-Za-z0-9+/]+={0,2}$/, "Invalid base64 image payload");
// A screenshot reference the browser is asking to attach. It must be a private
// object key inside the caller's own account folder (validated below); the
// browser never gets to point a trade at arbitrary storage.
const screenshotKeyInput = z.string().trim().min(1).max(500).nullable().optional();
const screenshotNameInput = z.string().trim().min(1).max(255).nullable().optional();
const pktDateInput = z.string().refine(isPktDateKey, "Use a valid PKT calendar date.");
// Analysis filters echo values the trader already stored on a trade row, so they
// must accept exactly the same text a trade can hold. Bounding them would make a
// trade with a long Level/Setup un-filterable in analysis.
const analysisFiltersInput = z.object({ startDate: pktDateInput.nullable().optional(), endDate: pktDateInput.nullable().optional(), session: z.string().trim().nullable().optional(), timeframe: z.string().trim().nullable().optional(), level: z.string().trim().nullable().optional(), setup: z.string().trim().nullable().optional(), direction: z.enum(["BUY", "SELL"]).nullable().optional(), result: z.enum(["WIN", "LOSS", "BREAK_EVEN", "OPEN"]).nullable().optional() }).default({});
const isFuturePktTimestamp = (timestamp: number, now = new Date()) => getPktDateKey(timestamp) > getPktDateKey(now);
const canonicalPktPlanDate = (timestamp: number) => new Date(pktDateToTimestamp(getPktDateKey(timestamp)));
const analysisInput = z.object({ accountId: z.number().int().positive(), filters: analysisFiltersInput });
const analysisCompareInput = z.object({ accountId: z.number().int().positive(), current: analysisFiltersInput, previous: analysisFiltersInput });
// The daily plan's behavioural close-out — copy provenance, the psychological
// triggers, the objective verdict, and the short post-session review — is
// persisted by `planReview.save` in ./planReviewRouter.ts, on the same
// (userId, accountId, planDate) row this router owns. It lives there so the
// planning payload and the behavioural payload stay separately validatable
// while remaining one plan record.
const lossFloorMetrics = new Set(["daily_loss", "weekly_drawdown"]);
const goalInput = z.object({ accountId: z.number().int().positive(), name: z.string().trim().min(1).max(120), description: optionalText(500), period: z.enum(["DAILY", "WEEKLY", "MONTHLY"]), metric: z.string().trim().min(1).max(80), comparison: z.enum(["GTE", "LTE"]), target: money(-1_000_000), notify: z.boolean().default(true), active: z.boolean().default(true) }).superRefine((value, ctx) => {
  if (lossFloorMetrics.has(value.metric) && value.target >= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "Loss controls use a negative P&L floor, for example -100." });
  if (!lossFloorMetrics.has(value.metric) && value.target < 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "Only loss-floor controls can use a negative threshold." });
});

// Behavioural evidence saved with a trade. Both fields stay optional so a
// manual entry, a queued offline write, and an untouched MT5 import all work.
const planChecklistInput = z.array(z.object({ id: z.string().trim().min(1).max(80), label: z.string().trim().max(160).optional(), checked: z.boolean() })).max(20).nullable().optional().default(null);
const planStatusInput = z.enum(["PLANNED", "UNPLANNED", "NOT_EVALUATED"]).nullable().optional().default(null);
const disciplineWeightsInput = z.object({ risk: z.number().min(0).max(100), plan: z.number().min(0).max(100), setup: z.number().min(0).max(100), execution: z.number().min(0).max(100), overtrading: z.number().min(0).max(100), journal: z.number().min(0).max(100), psychology: z.number().min(0).max(100) }).strict();
const behaviorConfigInput = z.object({ maxTradesPerDay: z.number().int().min(1).max(99).nullable(), maxRiskPerTrade: z.number().finite().min(0).max(MAX_MONEY).nullable(), maxDailyLoss: z.number().finite().min(0).max(MAX_MONEY).nullable(), cooldownAfterLosses: z.number().int().min(1).max(10), planAdherenceTarget: z.number().min(0).max(100), focusTarget: z.number().min(0).max(100) }).strict();

const tradeInput = z.object({
  accountId: z.number().int().positive(),
  tradeDate: timestampInput,
  session: z.string().trim().min(1),
  direction: z.enum(["BUY", "SELL"]),
  result: z.enum(["WIN", "LOSS", "BREAK_EVEN", "OPEN"]),
  level: freeText,
  timeframe: freeText,
  setupQuality: freeText,
  executionType: freeText,
  marketCondition: freeText,
  biasAlignment: freeText,
  confirmationType: freeText,
  slPlacement: freeText,
  tpPlacement: freeText,
  mistake: freeText,
  holdQuality: freeText,
  patienceScore: z.number().int().min(1).max(5).nullable(),
  risk: money(0).nullable(),
  reward: money(0).nullable(),
  pnl: money(),
  notes: freeText,
  emotionBefore: freeText,
  emotionDuring: freeText,
  emotionAfter: freeText,
  planStatus: planStatusInput,
  planChecklist: planChecklistInput,
  mt5Ticket: mt5TicketInput,
  clientMutationId: clientMutationIdInput,
  // Screenshot evidence is part of the trade write, not a follow-up request.
  // `screenshotRemoved` is the explicit "clear it" signal; an absent key means
  // "leave whatever is already stored untouched".
  screenshotKey: screenshotKeyInput,
  screenshotName: screenshotNameInput,
  screenshotRemoved: z.boolean().optional().default(false),
});

async function dbOrThrow() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

const screenshotExtension = (mimeType: "image/jpeg" | "image/png" | "image/webp") => (mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg");

/** Size, emptiness, and magic-byte validation shared by every upload path. */
function decodeScreenshotBase64(input: { base64: string; mimeType: "image/jpeg" | "image/png" | "image/webp" }) {
  const base64 = input.base64.includes(",") ? input.base64.split(",")[1] : input.base64;
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.byteLength) throw new Error("Screenshot payload is empty.");
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("Screenshot must be 5MB or smaller.");
  if (!hasImageSignature(bytes, input.mimeType)) throw new Error("Screenshot content does not match its declared image type.");
  return bytes;
}

/**
 * Resolves the screenshot columns for a trade write.
 *
 * `undefined` means "the caller said nothing about the screenshot", which for an
 * update must leave the stored evidence untouched. `null` means "it was removed".
 * A supplied key is refused unless it lives inside the caller's own account
 * folder, so a trade can never adopt another account's object.
 */
function resolveScreenshotForWrite(
  authUid: string,
  accountId: number,
  input: { screenshotKey?: string | null; screenshotName?: string | null; screenshotRemoved?: boolean }
): { key: string | null | undefined; name: string | null | undefined } {
  if (input.screenshotRemoved) return { key: null, name: null };
  const key = typeof input.screenshotKey === "string" ? input.screenshotKey.trim() : "";
  if (!key) return { key: undefined, name: undefined };
  assertOwnedScreenshotPath(key, authUid, accountId);
  const name = typeof input.screenshotName === "string" ? input.screenshotName.trim() : "";
  if (!name) throw new Error("A screenshot must include its original file name.");
  return { key, name: name.slice(0, 255) };
}

/**
 * Resolves the trade a queued update/delete is actually addressing.
 *
 * A trade the browser is still holding optimistically has a negative local id
 * and no database row yet. Using that id directly used to fail input validation
 * forever, which blocked every later queued write for the account. When the id
 * is not a real row, the mutation's originating create id is used to find the
 * row that create produced.
 */
async function resolveOwnedTradeForMutation(userId: number, input: { tradeId: number; originMutationId?: string | null }) {
  if (Number.isInteger(input.tradeId) && input.tradeId > 0) return ownsTrade(userId, input.tradeId);
  if (!input.originMutationId) throw new Error("This change targets a trade that has not reached the server yet.");
  const db = await dbOrThrow();
  const found = await db.select().from(trades).where(and(eq(trades.userId, userId), eq(trades.clientMutationId, input.originMutationId))).limit(1);
  if (!found[0]) throw new Error("This change targets a trade that has not reached the server yet.");
  return found[0];
}

async function ownGoal(userId: number, goalId: number) {
  const db = await dbOrThrow();
  const found = await db.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, userId))).limit(1);
  if (!found[0]) throw new Error("That goal is unavailable.");
  return found[0];
}

async function ownMt5Connection(userId: number, accountId: number, connectionId: number) {
  await getOwnedAccount(userId, accountId);
  const db = await dbOrThrow();
  const found = await db.select().from(mt5Connections).where(and(eq(mt5Connections.id, connectionId), eq(mt5Connections.accountId, accountId))).limit(1);
  if (!found[0]) throw new Error("That MT5 connection is unavailable.");
  if (found[0].userId === userId) return found[0];
  await db.update(mt5Connections).set({ userId }).where(eq(mt5Connections.id, found[0].id));
  return { ...found[0], userId };
}

async function issueMt5ConnectionKey(input: { userId: number; accountId: number; label: string; brokerUtcOffsetMinutes: number; replace: boolean }) {
  const account = await getOwnedAccount(input.userId, input.accountId);
  const db = await dbOrThrow();
  const existing = await db.select({ id: mt5Connections.id, userId: mt5Connections.userId, apiKey: mt5Connections.apiKey }).from(mt5Connections).where(eq(mt5Connections.accountId, account.id)).limit(1);
  if (existing[0] && !input.replace) throw new Error("This Gold Journal account already has an MT5 connection. Edit or replace it from MT5 Live.");

  const apiKey = randomBytes(32).toString("base64url");
  const values = {
    userId: input.userId,
    accountId: account.id,
    label: input.label,
    // Keep the outgoing key fingerprint so a terminal still running the old key
    // can be attributed as AUTH_REVOKED instead of reported as offline.
    previousApiKeyHash: existing[0]?.apiKey ?? null,
    previousApiKeyAt: existing[0] ? new Date() : null,
    apiKey: mt5ApiKeyFingerprint(apiKey),
    brokerUtcOffsetMinutes: input.brokerUtcOffsetMinutes,
    active: true,
    lastPing: null,
    lastContactAt: null,
    lastSummaryAt: null,
    lastSummarySuccessAt: null,
    lastSummaryErrorAt: null,
    lastOpenSyncAt: null,
    lastOpenSyncSuccessAt: null,
    lastOpenSyncErrorAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    consecutiveFailures: 0,
    retiredAt: null,
    retiredReason: null,
    mt5Login: null,
    brokerServer: null,
    currency: null,
    balance: null,
    equity: null,
    margin: null,
    freeMargin: null,
    floatingPnl: null,
  };

  if (existing[0]) {
    await db.update(mt5Connections).set(values).where(eq(mt5Connections.id, existing[0].id));
    return { id: existing[0].id, connectionReference: mt5ConnectionReference(values.apiKey), apiKey, replaced: true };
  }

  const inserted = await db.insert(mt5Connections).values(values).returning({ id: mt5Connections.id });
  return { id: inserted[0].id, connectionReference: mt5ConnectionReference(values.apiKey), apiKey, replaced: false };
}

/** How many rows a screenshot purge reads per page, and its hard ceiling. */
const SCREENSHOT_PURGE_PAGE = 500;
const SCREENSHOT_PURGE_MAX_ROWS = 20_000;

/**
 * Removes the stored screenshot objects that belonged to one account's trades.
 *
 * The atomic clear/removal transactions delete the rows that referenced these
 * objects, so without this the images stay readable in the private bucket after
 * the user asked for the journal to be emptied. It runs BEFORE the rows are
 * deleted, while their stored keys are still readable, and it is best-effort:
 * cleanup can never fail or block the destructive operation the user asked for.
 */
async function purgeAccountScreenshots(userId: number, accountId: number) {
  try {
    const db = await dbOrThrow();
    const keys: string[] = [];
    for (let offset = 0; offset < SCREENSHOT_PURGE_MAX_ROWS; offset += SCREENSHOT_PURGE_PAGE) {
      const page = await db.select({ screenshotKey: trades.screenshotKey }).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId))).limit(SCREENSHOT_PURGE_PAGE).offset(offset);
      if (!page.length) break;
      for (const row of page) if (row.screenshotKey) keys.push(row.screenshotKey);
      if (page.length < SCREENSHOT_PURGE_PAGE) break;
    }
    if (keys.length) await storageRemoveMany(keys);
  } catch {
    // Best-effort: an orphaned object must never fail the clear or the removal.
  }
}

async function clearAccountJournalData(userId: number, accountId: number) {
  await getOwnedAccount(userId, accountId);
  // Evidence first, while the keys are still on the rows being deleted.
  await purgeAccountScreenshots(userId, accountId);
  await clearAccountJournalDataAtomic(userId, accountId, new Date());
}

export const goldRouter = router({
  journal: router({
    bootstrap: protectedProcedure.query(async ({ ctx }) => toSafeAccountListItem(await ensureAccount(ctx.user.id))),
    get: protectedProcedure.input(z.object({ accountId: z.number().int().positive().optional() })).query(async ({ ctx, input }) => {
      // READ-ONLY by design. This procedure previously ran the MT5 -> Trade Log
      // reconciliation (a write path with one Supabase round-trip per stored MT5
      // position) before its first read, which is what made account switches and
      // Trade Log polls slow enough to hit the 15 s client timeout. MT5
      // reconciliation now runs through mt5.syncTradeLog, independently.
      const trace = createPerfTrace("journal.get.request", { userId: ctx.user.id, accountId: input.accountId });
      const account = await trace.stage("account authorization", () => getOwnedAccount(ctx.user.id, input.accountId));
      const journal = await getJournal(ctx.user.id, account.id, account);
      trace.done();
      return journal;
    }),
  }),
  analysis: router({
    get: protectedProcedure.input(analysisInput).query(({ ctx, input }) => getAccountAnalysis(ctx.user.id, input.accountId, input.filters)),
    // AI inference runs in the user's browser. The server only stores the
    // finished report so history keeps working; no credential ever arrives
    // here and no AI provider is called server-side.
    saveAiReport: protectedProcedure.input(analysisInput.extend({ model: z.string().trim().min(1).max(160), report: aiReportSchema })).mutation(async ({ ctx, input }) => {
      const analysis = await getAccountAnalysis(ctx.user.id, input.accountId, input.filters);
      const persisted = await persistAiReport(ctx.user.id, input.accountId, analysis, input.model, input.report);
      return { success: true, reportId: persisted.reportId, persisted: persisted.persisted };
    }),
    history: protectedProcedure.input(accountIdInput.extend({ limit: z.number().int().min(1).max(50).default(20) })).query(async ({ ctx, input }) => { await getOwnedAccount(ctx.user.id, input.accountId); return listAiReports(ctx.user.id, input.accountId, input.limit); }),
    experiments: protectedProcedure.input(accountIdInput.extend({ limit: z.number().int().min(1).max(100).default(50) })).query(async ({ ctx, input }) => { await getOwnedAccount(ctx.user.id, input.accountId); return listAiExperiments(ctx.user.id, input.accountId, input.limit); }),
    updateExperiment: protectedProcedure.input(accountIdInput.extend({ experimentId: z.number().int().positive(), status: z.enum(["PLANNED", "RUNNING", "COMPLETED", "CANCELLED"]), outcome: optionalText(2_000).nullable() })).mutation(({ ctx, input }) => updateAiExperiment(ctx.user.id, input.accountId, input.experimentId, input.status, input.outcome)),
    compare: protectedProcedure.input(analysisCompareInput).query(async ({ ctx, input }) => {
      const [current, previous] = await Promise.all([getAccountAnalysis(ctx.user.id, input.accountId, input.current), getAccountAnalysis(ctx.user.id, input.accountId, input.previous)]);
      return { current, previous, delta: compareAnalysis(current, previous) };
    }),
  }),

  accounts: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const db = await dbOrThrow();
      const rows = await db.select().from(accounts).where(eq(accounts.userId, ctx.user.id)).orderBy(desc(accounts.createdAt)).limit(1_000);
      return rows.map(toSafeAccountListItem);
    }),
    create: protectedProcedure.input(z.object({ name: z.string().trim().min(1).max(100), startingBalance: money(0).default(0) })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const normalizedName = normalizeAccountName(input.name);
      const duplicate = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, ctx.user.id), eq(accounts.normalizedName, normalizedName))).limit(1);
      if (duplicate[0]) throw new TRPCError({ code: "CONFLICT", message: "A journal account with this name already exists. Rename the existing account or choose a distinct name before linking MT5." });
      const inserted = await db.insert(accounts).values({ userId: ctx.user.id, name: input.name, normalizedName, startingBalance: input.startingBalance.toFixed(2) }).returning({ id: accounts.id });
      return { id: inserted[0].id };
    }),
    rename: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), name: z.string().trim().min(1).max(100) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const normalizedName = normalizeAccountName(input.name);
      const duplicate = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.userId, ctx.user.id), eq(accounts.normalizedName, normalizedName))).limit(1);
      if (duplicate[0] && duplicate[0].id !== input.accountId) throw new TRPCError({ code: "CONFLICT", message: "A journal account with this name already exists. Choose a distinct name." });
      await db.update(accounts).set({ name: input.name, normalizedName }).where(and(eq(accounts.id, input.accountId), eq(accounts.userId, ctx.user.id)));
      return { success: true };
    }),
    remove: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      // Deleting the account cascades its trades away; their evidence must go
      // with them instead of staying readable in private storage.
      await purgeAccountScreenshots(ctx.user.id, input.accountId);
      return removeAccountAtomic(ctx.user.id, input.accountId);
    }),
  }),
  mt5: router({
    workspace: protectedProcedure.input(accountIdInput).query(({ ctx, input }) => getMt5Workspace(ctx.user.id, input.accountId)),
    integrity: protectedProcedure.input(accountIdInput).query(({ ctx, input }) => getMt5Integrity(ctx.user.id, input.accountId)),
    risk: protectedProcedure.input(riskCalculatorInput).query(({ ctx, input }) => calculateAccountMt5Risk(ctx.user.id, input.accountId, input)),
    history: protectedProcedure.input(accountIdInput.extend({ page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(20) })).query(({ ctx, input }) => getMt5History(ctx.user.id, input.accountId, input.page, input.pageSize)),
    syncTradeLog: protectedProcedure.input(accountIdInput.extend({ limit: z.number().int().min(1).max(200).optional() })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const connection = await dbOrThrow().then(db => db.select({ id: mt5Connections.id }).from(mt5Connections).where(and(eq(mt5Connections.accountId, input.accountId), eq(mt5Connections.active, true))).limit(1));
      if (!connection[0]) throw new Error("No active MT5 connection is available for this journal account.");
      // Bounded per call: the client repeats this while `remaining > 0`, so a
      // first-time backfill of hundreds of positions never blocks a request.
      return syncStoredMt5PositionsToTradeLog(ctx.user.id, input.accountId, { limit: input.limit });
    }),
    createConnection: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), label: z.string().trim().min(1).max(120), brokerUtcOffsetMinutes: z.number().int().min(-12 * 60).max(14 * 60).default(180) })).mutation(async ({ ctx, input }) => {
      return issueMt5ConnectionKey({ userId: ctx.user.id, accountId: input.accountId, label: input.label, brokerUtcOffsetMinutes: input.brokerUtcOffsetMinutes, replace: false });
    }),
    replaceConnection: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), label: z.string().trim().min(1).max(120), brokerUtcOffsetMinutes: z.number().int().min(-12 * 60).max(14 * 60).default(180) })).mutation(async ({ ctx, input }) => {
      return issueMt5ConnectionKey({ userId: ctx.user.id, accountId: input.accountId, label: input.label, brokerUtcOffsetMinutes: input.brokerUtcOffsetMinutes, replace: true });
    }),
    updateConnectionOffset: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), brokerUtcOffsetMinutes: z.number().int().min(-12 * 60).max(14 * 60) })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      const db = await dbOrThrow();
      await db.update(mt5Connections).set({ brokerUtcOffsetMinutes: input.brokerUtcOffsetMinutes }).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId)));
      return { success: true };
    }),
    rotateConnectionKey: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      const db = await dbOrThrow();
      const apiKey = randomBytes(32).toString("base64url");
      await db.update(mt5Connections).set({
        apiKey: mt5ApiKeyFingerprint(apiKey),
        previousApiKeyHash: connection.apiKey,
        previousApiKeyAt: new Date(),
        active: true,
        lastPing: null, lastContactAt: null, lastSummaryAt: null, lastSummarySuccessAt: null, lastSummaryErrorAt: null,
        lastOpenSyncAt: null, lastOpenSyncSuccessAt: null, lastOpenSyncErrorAt: null,
        lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
      }).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId)));
      return { apiKey, connectionReference: mt5ConnectionReference(mt5ApiKeyFingerprint(apiKey)) };
    }),
    setConnectionActive: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), active: z.boolean() })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      if (input.active && connection.retiredAt) throw new Error("This connection was retired. Issue a replacement key before reactivating MT5 Live.");
      const db = await dbOrThrow();
      await db.update(mt5Connections).set({ active: input.active }).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id)));
      return { success: true };
    }),
    deleteConnection: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), connectionId: z.number().int().positive(), confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      const connection = await ownMt5Connection(ctx.user.id, input.accountId, input.connectionId);
      const db = await dbOrThrow();
      await db.update(mt5Connections).set({ active: false, retiredAt: new Date(), retiredReason: "USER_RETIRED" }).where(and(eq(mt5Connections.id, connection.id), eq(mt5Connections.userId, ctx.user.id), eq(mt5Connections.accountId, input.accountId)));
      return { success: true, retired: true };
    }),
  }),
  trades: router({
    list: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(50).default(12), search: z.string().trim().optional().default(""), result: z.enum(["WIN", "LOSS", "BREAK_EVEN", "OPEN"]).optional() })).query(async ({ ctx, input }) => {
      // Pure read: the Trade Log must render from the paginated trade list alone,
      // without waiting for MT5 reconciliation, analysis, or notifications.
      const account = await getOwnedAccount(ctx.user.id, input.accountId);
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
      // A signed URL is minted per read, with bounded concurrency and a hard
      // time box: one stalled storage call can no longer hold the entire Trade
      // Log open, and the expiring URL is never the persisted source of truth
      // (the stable object key in `screenshotKey` is).
      const hydratedRows = await hydrateSignedScreenshots(rows, storageGetSignedUrl);
      return { trades: hydratedRows.map(toSafeTrade), total, page, pageSize: input.pageSize, pageCount };
    }),
    create: protectedProcedure.input(tradeInput).mutation(async ({ ctx, input }) => {
      return withPersistenceDiagnostics({ stage: "trade.create", userId: ctx.user.id, accountId: input.accountId, mutationId: input.clientMutationId }, async () => {
        if (isFuturePktTimestamp(input.tradeDate)) throw new TRPCError({ code: "BAD_REQUEST", message: "Future trade dates are not allowed." });
        await getOwnedAccount(ctx.user.id, input.accountId);
        const db = await dbOrThrow();
        if (input.clientMutationId) {
          const existing = await db.select().from(trades).where(and(eq(trades.userId, ctx.user.id), eq(trades.accountId, input.accountId), eq(trades.clientMutationId, input.clientMutationId))).limit(1);
          // Replay of a mutation that is already stored. The canonical row is
          // returned (not just its id) so a browser holding an optimistic
          // placeholder can adopt the real database identity, which is what a
          // later edit or delete has to address.
          if (existing[0]) return { id: existing[0].id, replayed: true, trade: toSafeTrade(existing[0]) };
        }
        if (input.mt5Ticket) {
          const linked = await db.select({ id: mt5LivePositions.id }).from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, input.accountId), eq(mt5LivePositions.ticket, BigInt(input.mt5Ticket)), eq(mt5LivePositions.status, "CLOSED"))).limit(1);
          if (!linked[0]) throw new Error("The selected MT5 ticket is not an unjournaled closed position for this account.");
        }
        const screenshot = resolveScreenshotForWrite(ctx.user.openId, input.accountId, input);
        const inserted = await db.insert(trades).values({
          userId: ctx.user.id, accountId: input.accountId, tradeDate: new Date(input.tradeDate), session: input.session,
          direction: input.direction, result: input.result, level: input.level, timeframe: input.timeframe,
          setupQuality: input.setupQuality, executionType: input.executionType, marketCondition: input.marketCondition,
          biasAlignment: input.biasAlignment, confirmationType: input.confirmationType, slPlacement: input.slPlacement,
          tpPlacement: input.tpPlacement, mistake: input.mistake, holdQuality: input.holdQuality, patienceScore: input.patienceScore,
          risk: input.risk?.toFixed(2) ?? null, reward: input.reward?.toFixed(2) ?? null, pnl: input.pnl.toFixed(2),
          notes: input.notes, emotionBefore: input.emotionBefore, emotionDuring: input.emotionDuring, emotionAfter: input.emotionAfter,
          planStatus: input.planStatus, planChecklist: input.planChecklist,
          // The trade row and its evidence are committed by this one write, so a
          // screenshot can never be half-attached.
          screenshotKey: screenshot.key ?? null, screenshotName: screenshot.name ?? null,
          mt5Ticket: input.mt5Ticket ? BigInt(input.mt5Ticket) : null, clientMutationId: input.clientMutationId ?? null,
        }).returning({ id: trades.id });
        const id = inserted[0].id;
        const created = (await db.select().from(trades).where(and(eq(trades.id, id), eq(trades.userId, ctx.user.id))).limit(1))[0];
        logPersistenceEvent("trade.create.persisted", { stage: "trade.create", userId: ctx.user.id, accountId: input.accountId, mutationId: input.clientMutationId ?? null, tradeId: id });
        return { id, replayed: false, trade: created ? toSafeTrade(created) : { id, hasScreenshot: Boolean(screenshot.key) } };
      });
    }),
    update: protectedProcedure.input(tradeInput.extend({
      // A locally-queued trade has no database id yet, so it carries a negative
      // placeholder. `originMutationId` names the create it belongs to, which is
      // how the target row is found instead of failing input validation forever.
      tradeId: z.number().int(),
      originMutationId: clientMutationIdInput,
    })).mutation(async ({ ctx, input }) => {
      return withPersistenceDiagnostics({ stage: "trade.update", userId: ctx.user.id, accountId: input.accountId, mutationId: input.clientMutationId, tradeId: input.tradeId }, async () => {
        const current = await resolveOwnedTradeForMutation(ctx.user.id, input);
        if (current.accountId !== input.accountId) throw new Error("A trade cannot be moved between journal accounts.");
        const nextTicket = input.mt5Ticket ? BigInt(input.mt5Ticket) : current.mt5Ticket;
        if (input.mt5Ticket && input.mt5Ticket !== current.mt5Ticket?.toString()) {
          const db = await dbOrThrow();
          const linked = await db.select({ id: mt5LivePositions.id }).from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, current.accountId), eq(mt5LivePositions.ticket, nextTicket), eq(mt5LivePositions.status, "CLOSED"))).limit(1);
          if (!linked[0]) throw new Error("The selected MT5 ticket is not an unjournaled closed position for this account.");
          const alreadyJournaled = await db.select({ id: trades.id }).from(trades).where(and(eq(trades.accountId, current.accountId), eq(trades.mt5Ticket, nextTicket))).limit(1);
          if (alreadyJournaled[0] && alreadyJournaled[0].id !== current.id) throw new Error("That MT5 ticket is already linked to another journal trade.");
        }
        const screenshot = resolveScreenshotForWrite(ctx.user.openId, current.accountId, input);
        const db = await dbOrThrow();
        await db.update(trades).set({
          tradeDate: new Date(input.tradeDate), session: input.session, direction: input.direction, result: input.result,
          level: input.level, timeframe: input.timeframe, setupQuality: input.setupQuality, executionType: input.executionType,
          marketCondition: input.marketCondition, biasAlignment: input.biasAlignment, confirmationType: input.confirmationType,
          slPlacement: input.slPlacement, tpPlacement: input.tpPlacement, mistake: input.mistake, holdQuality: input.holdQuality,
          patienceScore: input.patienceScore, risk: input.risk?.toFixed(2) ?? null, reward: input.reward?.toFixed(2) ?? null,
          pnl: input.pnl.toFixed(2), notes: input.notes, emotionBefore: input.emotionBefore, emotionDuring: input.emotionDuring, emotionAfter: input.emotionAfter,
          planStatus: input.planStatus, planChecklist: input.planChecklist,
          mt5Ticket: nextTicket,
          // Omitted entirely when the caller said nothing about the screenshot,
          // so an ordinary field edit can never silently drop the evidence.
          ...(screenshot.key === undefined ? {} : { screenshotKey: screenshot.key, screenshotName: screenshot.name }),
        }).where(and(eq(trades.id, current.id), eq(trades.userId, ctx.user.id)));
        // The replaced object is now unreachable. Removal is best-effort and can
        // never fail the write that already succeeded (storageRemove swallows
        // its own errors), but it is awaited so the swap is deterministic.
        if (screenshot.key !== undefined && current.screenshotKey && current.screenshotKey !== screenshot.key) await storageRemove(current.screenshotKey);
        const saved = (await db.select().from(trades).where(and(eq(trades.id, current.id), eq(trades.userId, ctx.user.id))).limit(1))[0];
        return { success: true, trade: saved ? toSafeTrade(saved) : undefined, screenshotCleared: screenshot.key === null };
      });
    }),
    delete: protectedProcedure.input(z.object({
      tradeId: z.number().int(),
      originMutationId: clientMutationIdInput,
      clientMutationId: clientMutationIdInput,
    })).mutation(async ({ ctx, input }) => {
      return withPersistenceDiagnostics({ stage: "trade.delete", userId: ctx.user.id, mutationId: input.clientMutationId, tradeId: input.tradeId }, async () => {
        const db = await dbOrThrow();
        let found: { id: number; accountId: number; screenshotKey: string | null } | undefined;
        if (Number.isInteger(input.tradeId) && input.tradeId > 0) {
          found = (await db.select().from(trades).where(and(eq(trades.id, input.tradeId), eq(trades.userId, ctx.user.id))).limit(1))[0];
        } else if (input.originMutationId) {
          found = (await db.select().from(trades).where(and(eq(trades.userId, ctx.user.id), eq(trades.clientMutationId, input.originMutationId))).limit(1))[0];
        }
        if (!found) {
          // Idempotent replay. A queued delete whose response was lost (or whose
          // request timed out after the server committed) is retried, and the
          // row can never come back — so reporting failure here would block the
          // durable queue permanently. The response is identical for a row that
          // was never this user's, so nothing about other accounts is revealed.
          logPersistenceEvent("trade.delete.replayed", { stage: "trade.delete", userId: ctx.user.id, tradeId: input.tradeId > 0 ? input.tradeId : null, mutationId: input.clientMutationId ?? null });
          return { success: true, deleted: false, replayed: true };
        }
        await db.delete(trades).where(and(eq(trades.id, found.id), eq(trades.userId, ctx.user.id)));
        // Deleting a trade must not leave its evidence readable in storage. This
        // is best-effort and cannot fail the delete (storageRemove swallows its
        // own errors), but it is awaited so the cleanup is deterministic.
        if (found.screenshotKey) await storageRemove(found.screenshotKey);
        return { success: true, deleted: true, replayed: false };
      });
    }),
    clearAll: protectedProcedure.input(accountIdInput.extend({ confirmed: z.literal(true) })).mutation(async ({ ctx, input }) => {
      await clearAccountJournalData(ctx.user.id, input.accountId);
      return { success: true };
    }),
    uploadScreenshot: protectedProcedure.input(z.object({ tradeId: z.number().int().positive(), fileName: z.string().trim().min(1).max(255), mimeType: screenshotMimeInput, base64: screenshotBase64Input })).mutation(async ({ ctx, input }) => {
      return withPersistenceDiagnostics({ stage: "trade.screenshot.upload", userId: ctx.user.id, tradeId: input.tradeId }, async () => {
        if (!(await consumeRateLimit("screenshot", ctx.user.id, 20, 60_000))) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Screenshot upload limit reached. Please try again shortly." });
        const trade = await ownsTrade(ctx.user.id, input.tradeId);
        const bytes = decodeScreenshotBase64(input);
        const key = `${screenshotPathPrefix(ctx.user.openId, trade.accountId)}${trade.id}/${nanoid()}.${screenshotExtension(input.mimeType)}`;
        const stored = await storagePut(key, bytes, input.mimeType);
        const db = await dbOrThrow();
        await db.update(trades).set({ screenshotKey: stored.key, screenshotName: input.fileName }).where(and(eq(trades.id, trade.id), eq(trades.userId, ctx.user.id)));
        // Replacing an image must not leave the previous object readable forever.
        if (trade.screenshotKey && trade.screenshotKey !== stored.key) void storageRemove(trade.screenshotKey);
        // The private object key stays server-side; the browser only ever
        // receives the short-lived signed URL it may render.
        return { url: stored.url };
      });
    }),
    /**
     * Uploads the screenshot binary BEFORE the trade row exists.
     *
     * This is what makes screenshot evidence durable. The browser uploads the
     * bytes, receives the stable private object key, and then sends that key
     * inside the trade create/update payload — so the row and its image are
     * committed by a single database write. If that write fails, the queued
     * local trade already holds the key and the object is already in storage,
     * so the retry completes the pair instead of losing the picture.
     *
     * Keyed by `clientMutationId` (a draft folder) because there is no trade id
     * yet; the path is still fully scoped to the authenticated identity and the
     * authorized account.
     */
    uploadScreenshotDraft: protectedProcedure.input(z.object({
      accountId: z.number().int().positive(),
      clientMutationId: requiredClientMutationIdInput,
      fileName: z.string().trim().min(1).max(255),
      mimeType: screenshotMimeInput,
      base64: screenshotBase64Input,
    })).mutation(async ({ ctx, input }) => {
      return withPersistenceDiagnostics({ stage: "trade.screenshot.upload", userId: ctx.user.id, accountId: input.accountId, mutationId: input.clientMutationId }, async () => {
        if (!(await consumeRateLimit("screenshot", ctx.user.id, 20, 60_000))) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Screenshot upload limit reached. Please try again shortly." });
        // Ownership is proven before anything is written to storage.
        await getOwnedAccount(ctx.user.id, input.accountId);
        const bytes = decodeScreenshotBase64(input);
        const stored = await storagePutAt(screenshotObjectKey({
          authUid: ctx.user.openId,
          accountId: input.accountId,
          tradeRef: input.clientMutationId,
          extension: screenshotExtension(input.mimeType),
          draft: true,
        }), bytes, input.mimeType);
        // `key` is what the trade write must carry and persist. `url` is only a
        // preview for the open dialog and is never stored.
        return { key: stored.key, name: input.fileName, url: stored.url };
      });
    }),
  }),
  cash: router({
    create: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), movementDate: timestampInput, type: z.enum(["DEPOSIT", "WITHDRAW"]), amount: money(0.01), note: optionalText(1000), clientMutationId: clientMutationIdInput })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      if (input.clientMutationId) {
        const existing = await db.select({ id: cashMovements.id }).from(cashMovements).where(and(eq(cashMovements.userId, ctx.user.id), eq(cashMovements.accountId, input.accountId), eq(cashMovements.clientMutationId, input.clientMutationId))).limit(1);
        if (existing[0]) return { success: true, replayed: true };
      }
      await db.insert(cashMovements).values({ userId: ctx.user.id, accountId: input.accountId, movementDate: new Date(input.movementDate), type: input.type, amount: input.amount.toFixed(2), note: input.note, clientMutationId: input.clientMutationId ?? null });
      return { success: true, replayed: false };
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
  // Behavioural configuration: one row per user holding the identity statement,
  // the configurable discipline-score weights, and the cooldown thresholds.
  profile: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const db = await dbOrThrow();
      const rows = await db.select().from(traderProfiles).where(eq(traderProfiles.userId, ctx.user.id)).limit(1);
      const row = rows[0] as { identityStatement?: string | null; disciplineWeights?: unknown; behaviorConfig?: unknown } | undefined;
      return {
        identityStatement: row?.identityStatement ?? "",
        disciplineWeights: (row?.disciplineWeights ?? null) as Record<string, number> | null,
        behaviorConfig: (row?.behaviorConfig ?? null) as Record<string, number | null> | null,
      };
    }),
    save: protectedProcedure.input(z.object({ identityStatement: optionalText(400), disciplineWeights: disciplineWeightsInput.nullable().optional().default(null), behaviorConfig: behaviorConfigInput.nullable().optional().default(null) })).mutation(async ({ ctx, input }) => {
      const db = await dbOrThrow();
      const values = { userId: ctx.user.id, identityStatement: input.identityStatement, disciplineWeights: input.disciplineWeights, behaviorConfig: input.behaviorConfig };
      await db.insert(traderProfiles).values(values).onConflictDoUpdate({ target: traderProfiles.userId, set: { identityStatement: input.identityStatement, disciplineWeights: input.disciplineWeights, behaviorConfig: input.behaviorConfig, updatedAt: new Date() } });
      return { success: true };
    }),
  }),
  // Canonical Trade Log option store.
  //
  // Every reusable dropdown value lives here: the Gold Journal defaults (seeded
  // once per user, and fully editable afterwards) plus the user's own options.
  // Nothing is ever hard-deleted — `setActive` archives an option so a historical
  // trade keeps its recorded label and can still be displayed and re-edited.
  optionLists: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      await ensureDefaultTradeOptions(ctx.user.id);
      const rows = await listOwnedOptions(ctx.user.id);
      return rows.map(toTradeOptionView);
    }),
    add: protectedProcedure
      .input(z.object({ category: z.string().trim().min(1).max(80), value: z.string().trim().min(1), active: z.boolean().optional().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const definition = requireTradeOptionCategory(input.category);
        const value = input.value.trim();
        const invalid = tradeOptionValueError(definition.category, value);
        if (invalid) throw new TRPCError({ code: "BAD_REQUEST", message: invalid });
        await ensureDefaultTradeOptions(ctx.user.id);
        const normalizedValue = normalizeTradeOptionValue(value);
        const existing = await findTradeOptionByNormalizedValue(ctx.user.id, definition.category, normalizedValue);
        const db = await dbOrThrow();
        if (existing) {
          if (existing.active) {
            throw new TRPCError({ code: "CONFLICT", message: `“${existing.value}” is already an active ${definition.label} option.` });
          }
          // Re-enable the archived option instead of creating a case-variant twin.
          const restored = (await db.update(optionLists).set({ active: input.active, updatedAt: new Date() }).where(and(eq(optionLists.id, existing.id), eq(optionLists.userId, ctx.user.id))).returning(OPTION_COLUMNS)) as TradeOptionRow[];
          return { success: true, option: toTradeOptionView(restored[0] ?? { ...existing, active: input.active }) };
        }
        const inserted = (await db
          .insert(optionLists)
          .values({ userId: ctx.user.id, category: definition.category, value, normalizedValue, isDefault: false, active: input.active })
          .onConflictDoUpdate({ target: [optionLists.userId, optionLists.category, optionLists.value], set: { active: input.active, normalizedValue, updatedAt: new Date() } })
          .returning(OPTION_COLUMNS)) as TradeOptionRow[];
        const row = inserted[0] ?? { id: 0, category: definition.category, value, active: input.active, isDefault: false };
        return { success: true, option: toTradeOptionView(row) };
      }),
    rename: protectedProcedure
      .input(z.object({ optionId: z.number().int().positive(), value: z.string().trim().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const existing = await findOwnedTradeOption(ctx.user.id, input.optionId);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "That option is no longer available. Reload the list and try again." });
        const value = input.value.trim();
        const invalid = tradeOptionValueError(existing.category, value);
        if (invalid) throw new TRPCError({ code: "BAD_REQUEST", message: invalid });
        const normalizedValue = normalizeTradeOptionValue(value);
        const clash = await findTradeOptionByNormalizedValue(ctx.user.id, existing.category, normalizedValue, existing.id);
        if (clash) throw new TRPCError({ code: "CONFLICT", message: `“${clash.value}” already uses that name in ${existing.category}.` });
        const db = await dbOrThrow();
        // Only the option label changes. Historical trades keep the label they
        // were recorded with, and the Trade Log renders a recorded value that no
        // longer matches an option as “<value> — Archived”, so old data is never
        // rewritten or blanked by a rename.
        const updated = (await db
          .update(optionLists)
          .set({ value, normalizedValue, updatedAt: new Date() })
          .where(and(eq(optionLists.id, existing.id), eq(optionLists.userId, ctx.user.id)))
          .returning(OPTION_COLUMNS)) as TradeOptionRow[];
        return { success: true, option: toTradeOptionView(updated[0] ?? { ...existing, value }) };
      }),
    setActive: protectedProcedure
      .input(z.object({ optionId: z.number().int().positive(), active: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const existing = await findOwnedTradeOption(ctx.user.id, input.optionId);
        if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: "That option is no longer available. Reload the list and try again." });
        const db = await dbOrThrow();
        const updated = (await db
          .update(optionLists)
          .set({ active: input.active, updatedAt: new Date() })
          .where(and(eq(optionLists.id, existing.id), eq(optionLists.userId, ctx.user.id)))
          .returning(OPTION_COLUMNS)) as TradeOptionRow[];
        return { success: true, option: toTradeOptionView(updated[0] ?? { ...existing, active: input.active }) };
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
      if (!(await consumeRateLimit("goal-alerts", ctx.user.id, 30, 60_000))) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Notification write limit reached. Please try again shortly." });
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
      if (isFuturePktTimestamp(input.tradeDate)) throw new TRPCError({ code: "BAD_REQUEST", message: "Future skipped-trade dates are not allowed." });
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      await db.insert(skippedTrades).values({ ...input, userId: ctx.user.id, tradeDate: new Date(input.tradeDate), estimatedMissed: input.estimatedMissed.toFixed(2) });
      return { success: true };
    }),
  }),
  // The daily plan router. Planning fields, the pre-session check-in, the
  // post-session review, and copy provenance are one record.
  plans: router({
    save: protectedProcedure.input(z.object({ accountId: z.number().int().positive(), planDate: timestampInput, preBias: optionalText(40), marketContext: optionalText(3000), keyLevels: optionalText(3000), sessionFocus: z.array(z.string().trim().max(120)).max(9), eventRisk: optionalText(1500), longScenario: optionalText(3000), shortScenario: optionalText(3000), noTradeCondition: optionalText(2000), invalidationLevel: optionalText(1000), riskLimit: optionalText(40), maxTrades: z.number().int().min(1).max(99).nullable(), sizingPlan: optionalText(2000), planNotes: optionalText(5000), rulesPlanned: z.array(z.object({ id: z.string().trim().min(1).max(80), text: z.string().trim().max(500), checked: z.boolean() })).max(30), emotionalState: z.enum(["", "Calm", "Neutral", "Anxious", "Frustrated", "Overconfident", "Tired"]).optional().default(""), energyLevel: z.number().int().min(1).max(5).nullable().optional().default(null), focusLevel: z.number().int().min(1).max(5).nullable().optional().default(null), confidenceLevel: z.number().int().min(1).max(5).nullable().optional().default(null), stressLevel: z.number().int().min(1).max(5).nullable().optional().default(null), behavioralFocus: optionalText(80), psychologyRisk: optionalText(1000), emotionStart: z.array(z.string().trim().max(80)).max(20), emotionEnd: z.array(z.string().trim().max(80)).max(20), executionScore: z.number().int().min(1).max(5).nullable(), rulesFollowed: z.array(z.object({ id: z.string().trim().min(1).max(80), yes: z.boolean() })).max(30), whatWentWell: optionalText(5000), whatWentWrong: optionalText(5000), executionNotes: optionalText(5000), planDeviation: optionalText(5000), lessons: optionalText(2000), tomorrowFocus: optionalText(2000), overallRating: z.number().int().min(1).max(5).nullable() })).mutation(async ({ ctx, input }) => {
      await getOwnedAccount(ctx.user.id, input.accountId);
      const db = await dbOrThrow();
      const record = { userId: ctx.user.id, accountId: input.accountId, planDate: canonicalPktPlanDate(input.planDate), preBias: input.preBias, marketContext: input.marketContext, keyLevels: input.keyLevels, sessionFocus: input.sessionFocus, eventRisk: input.eventRisk, longScenario: input.longScenario, shortScenario: input.shortScenario, noTradeCondition: input.noTradeCondition, invalidationLevel: input.invalidationLevel, riskLimit: input.riskLimit, maxTrades: input.maxTrades, sizingPlan: input.sizingPlan, planNotes: input.planNotes, rulesPlanned: input.rulesPlanned, emotionalState: input.emotionalState || null, energyLevel: input.energyLevel, focusLevel: input.focusLevel, confidenceLevel: input.confidenceLevel, stressLevel: input.stressLevel, behavioralFocus: input.behavioralFocus, psychologyRisk: input.psychologyRisk, emotionStart: input.emotionStart.join("|"), emotionEnd: input.emotionEnd.join("|"), executionScore: input.executionScore, rulesFollowed: input.rulesFollowed, whatWentWell: input.whatWentWell, whatWentWrong: input.whatWentWrong, executionNotes: input.executionNotes, planDeviation: input.planDeviation, lessons: input.lessons, tomorrowFocus: input.tomorrowFocus, overallRating: input.overallRating };
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
