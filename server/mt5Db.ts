import { and, count, desc, eq, or } from "./supabaseQuery";
import { accounts, mt5Connections, mt5LivePositions, trades } from "../drizzle/schema";
import { getOwnedAccount } from "./goldDb";
import { classifyMt5SyncHealth } from "./mt5Reliability";
import { getDb } from "./db";
import { mt5ApiKeyFingerprint } from "./mt5Security";
import { recordMt5EventFailureAtomic, syncMt5HistoryBatchAtomic, syncMt5OpenBatchAtomic, syncMt5PositionAtomic } from "./atomicOperations";

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

async function canonicalizeMt5ConnectionOwner(database: any, connection: typeof mt5Connections.$inferSelect) {
  const owner = await database.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, connection.accountId)).limit(1);
  if (!owner[0]) throw new Error("MT5 connection refers to an unavailable journal account.");
  if (owner[0].userId === connection.userId) return connection;
  await database.update(mt5Connections).set({ userId: owner[0].userId }).where(eq(mt5Connections.id, connection.id));
  return { ...connection, userId: owner[0].userId };
}

function safePosition(position: typeof mt5LivePositions.$inferSelect, journaledTickets: Set<string>) {
  return {
    ticket: position.ticket.toString(),
    symbol: position.symbol,
    direction: position.direction,
    lots: position.lots,
    openPrice: position.openPrice,
    closePrice: position.closePrice,
    slPrice: position.slPrice,
    tpPrice: position.tpPrice,
    riskUsd: position.riskUsd,
    rewardUsd: position.rewardUsd,
    rrRatio: position.rrRatio,
    floatingPnl: position.floatingPnl,
    realizedPnl: position.realizedPnl,
    result: position.result,
    openTime: position.openTime,
    closeTime: position.closeTime,
    status: position.status,
    updatedAt: position.updatedAt,
    journaled: journaledTickets.has(position.ticket.toString()),
  };
}

export function isMt5PositionAfterJournalReset(
  resetAt: Date | null | undefined,
  position: { status: "OPEN" | "CLOSED"; openTime: Date; closeTime?: Date | null },
) {
  if (!resetAt) return true;
  const effectiveTime = position.status === "CLOSED" ? (position.closeTime ?? position.openTime) : position.openTime;
  return effectiveTime.getTime() > resetAt.getTime();
}

async function getJournalDataResetAt(database: any, accountId: number) {
  const rows = await database.select({ journalDataResetAt: mt5Connections.journalDataResetAt }).from(mt5Connections).where(eq(mt5Connections.accountId, accountId)).limit(1);
  return rows[0]?.journalDataResetAt ?? null;
}

export function pktSession(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find(part => part.type === "minute")?.value ?? "0");
  const pktMinute = hour * 60 + minute;
  if (pktMinute < 3 * 60) return "Post-NY";
  if (pktMinute >= 3 * 60 && pktMinute < 5 * 60) return "Pre-Asian";
  if (pktMinute < 8 * 60) return "Asian";
  if (pktMinute < 10 * 60) return "Post-Asian";
  if (pktMinute < 12 * 60) return "Pre-London";
  if (pktMinute < 14 * 60) return "London";
  if (pktMinute < 16 * 60) return "Post-London";
  if (pktMinute < 17 * 60) return "Pre-NY";
  if (pktMinute < 20 * 60) return "New York";
  return "Post-NY";
}

export async function getMt5Workspace(userId: number, accountId: number) {
  const account = await getOwnedAccount(userId, accountId);
  const db = await requireDb();
  const [connections, openPositions, closedPositions] = await Promise.all([
    db.select().from(mt5Connections).where(eq(mt5Connections.accountId, account.id)).orderBy(desc(mt5Connections.createdAt)).limit(20),
    db.select().from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "OPEN"))).orderBy(desc(mt5LivePositions.updatedAt)).limit(500),
    db.select().from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "CLOSED"))).orderBy(desc(mt5LivePositions.closeTime)).limit(10),
  ]);
  const canonicalConnections = await Promise.all(connections.map(connection => canonicalizeMt5ConnectionOwner(db, connection)));
  const visibleTickets = [...openPositions, ...closedPositions].map(position => position.ticket);
  const journalRows = visibleTickets.length ? await db.select({ mt5Ticket: trades.mt5Ticket }).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId), or(...visibleTickets.map(ticket => eq(trades.mt5Ticket, ticket))))) : [];
  const journaledTickets = new Set(journalRows.flatMap(row => row.mt5Ticket == null ? [] : [row.mt5Ticket.toString()]));
  return {
    connections: canonicalConnections.map(connection => ({ id: connection.id, accountName: account.name, label: connection.label, active: connection.active, retiredAt: connection.retiredAt, retiredReason: connection.retiredReason, brokerUtcOffsetMinutes: (connection as typeof connection & { brokerUtcOffsetMinutes?: number }).brokerUtcOffsetMinutes ?? 180, lastPing: connection.lastPing, lastContactAt: connection.lastContactAt, lastSummaryAt: connection.lastSummaryAt, lastSummarySuccessAt: connection.lastSummarySuccessAt, lastSummaryErrorAt: connection.lastSummaryErrorAt, lastOpenSyncAt: connection.lastOpenSyncAt, lastOpenSyncSuccessAt: connection.lastOpenSyncSuccessAt, lastOpenSyncErrorAt: connection.lastOpenSyncErrorAt, lastErrorAt: connection.lastErrorAt, lastErrorCode: connection.lastErrorCode, lastErrorMessage: connection.lastErrorMessage, consecutiveFailures: connection.consecutiveFailures, mt5Login: connection.mt5Login?.toString() ?? null, brokerServer: connection.brokerServer, currency: connection.currency, balance: connection.balance, equity: connection.equity, margin: connection.margin, freeMargin: connection.freeMargin, floatingPnl: connection.floatingPnl, riskSymbol: connection.riskSymbol, riskTickSize: connection.riskTickSize, riskTickValueLoss: connection.riskTickValueLoss, riskContractSize: connection.riskContractSize, riskVolumeMin: connection.riskVolumeMin, riskVolumeMax: connection.riskVolumeMax, riskVolumeStep: connection.riskVolumeStep, riskSymbolUpdatedAt: connection.riskSymbolUpdatedAt, syncHealth: classifyMt5SyncHealth(connection), lastHistorySync: connection.lastHistorySync, historySyncedCount: connection.historySyncedCount, lastHistoryAttempt: connection.lastHistoryAttempt, lastHistoryStatus: connection.lastHistoryStatus, lastHistoryMessage: connection.lastHistoryMessage, lastHistoryBatchSize: connection.lastHistoryBatchSize, createdAt: connection.createdAt })),
    openPositions: openPositions.map(position => safePosition(position, journaledTickets)),
    closedPositions: closedPositions.map(position => safePosition(position, journaledTickets)),
  };
}

export async function getMt5History(userId: number, accountId: number, page: number, pageSize: number) {
  await getOwnedAccount(userId, accountId);
  const db = await requireDb();
  const where = and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "CLOSED"));
  const totalRows = await db.select({ total: count() }).from(mt5LivePositions).where(where);
  const total = Number(totalRows[0]?.total ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const positions = await db.select().from(mt5LivePositions).where(where).orderBy(desc(mt5LivePositions.closeTime)).limit(pageSize).offset((safePage - 1) * pageSize);
  const visibleTickets = positions.map(position => position.ticket);
  const journalRows = visibleTickets.length ? await db.select({ mt5Ticket: trades.mt5Ticket }).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId), or(...visibleTickets.map(ticket => eq(trades.mt5Ticket, ticket))))) : [];
  const journaledTickets = new Set(journalRows.flatMap(row => row.mt5Ticket == null ? [] : [row.mt5Ticket.toString()]));
  return { positions: positions.map(position => safePosition(position, journaledTickets)), total, page: safePage, pageSize, pageCount };
}

export async function getActiveMt5Connection(apiKey: string) {
  const db = await requireDb();
  const fingerprint = mt5ApiKeyFingerprint(apiKey);
  const hashed = await db.select().from(mt5Connections).where(and(eq(mt5Connections.apiKey, fingerprint), eq(mt5Connections.active, true))).limit(1);
  if (hashed[0]) return canonicalizeMt5ConnectionOwner(db, hashed[0]);
  const legacy = await db.select().from(mt5Connections).where(and(eq(mt5Connections.apiKey, apiKey), eq(mt5Connections.active, true))).limit(1);
  if (!legacy[0]) return null;
  await db.update(mt5Connections).set({ apiKey: fingerprint }).where(eq(mt5Connections.id, legacy[0].id));
  return canonicalizeMt5ConnectionOwner(db, { ...legacy[0], apiKey: fingerprint });
}

export async function touchMt5Connection(connectionId: number) {
  const db = await requireDb();
  const now = new Date();
  await db.update(mt5Connections).set({ lastPing: now, lastContactAt: now }).where(eq(mt5Connections.id, connectionId));
}

export type Mt5EventOperation = "summary" | "open_batch" | "history_batch";

export async function recordMt5EventSuccess(connectionId: number, operation: Mt5EventOperation) {
  const db = await requireDb(); const now = new Date();
  await db.update(mt5Connections).set({
    lastPing: now, lastContactAt: now, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    ...(operation === "open_batch" ? { lastOpenSyncAt: now, lastOpenSyncSuccessAt: now } : {}),
  }).where(eq(mt5Connections.id, connectionId));
}

export async function recordMt5EventFailure(connectionId: number, operation: Mt5EventOperation, code: string, message: string) {
  const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 255);
  await recordMt5EventFailureAtomic(connectionId, operation, code.slice(0, 64), safeMessage);
}

type AccountSummary = { mt5Login: bigint; brokerServer: string; currency: string; balance: number; equity: number; margin: number; freeMargin: number; floatingPnl: number; riskSymbol?: string; riskTickSize?: number; riskTickValueLoss?: number; riskContractSize?: number; riskVolumeMin?: number; riskVolumeMax?: number; riskVolumeStep?: number };

export async function updateMt5AccountSummary(connectionId: number, value: AccountSummary) {
  const db = await requireDb();
  const now = new Date();
  await db.update(mt5Connections).set({ mt5Login: value.mt5Login, brokerServer: value.brokerServer, currency: value.currency, balance: value.balance.toFixed(2), equity: value.equity.toFixed(2), margin: value.margin.toFixed(2), freeMargin: value.freeMargin.toFixed(2), floatingPnl: value.floatingPnl.toFixed(2), ...(value.riskSymbol ? { riskSymbol: value.riskSymbol, riskTickSize: value.riskTickSize!.toFixed(8), riskTickValueLoss: value.riskTickValueLoss!.toFixed(8), riskContractSize: value.riskContractSize!.toFixed(8), riskVolumeMin: value.riskVolumeMin!.toFixed(8), riskVolumeMax: value.riskVolumeMax!.toFixed(8), riskVolumeStep: value.riskVolumeStep!.toFixed(8), riskSymbolUpdatedAt: now } : {}), lastPing: now, lastContactAt: now, lastSummaryAt: now, lastSummarySuccessAt: now, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 }).where(eq(mt5Connections.id, connectionId));
}

export async function completeMt5HistorySync(connectionId: number, accountId: number) {
  const db = await requireDb();
  const rows = await db.select({ total: count() }).from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "CLOSED")));
  await db.update(mt5Connections).set({ lastHistorySync: new Date(), historySyncedCount: Number(rows[0]?.total ?? 0), lastHistoryAttempt: new Date(), lastHistoryStatus: "COMPLETED", lastHistoryMessage: "Historical position scan completed.", lastHistoryBatchSize: 0 }).where(eq(mt5Connections.id, connectionId));
}

export async function recordMt5HistoryAttempt(connectionId: number, batchSize: number) {
  const db = await requireDb();
  await db.update(mt5Connections).set({ lastHistoryAttempt: new Date(), lastHistoryStatus: "RECEIVED", lastHistoryMessage: `Received ${batchSize} historical position${batchSize === 1 ? "" : "s"}.`, lastHistoryBatchSize: batchSize }).where(eq(mt5Connections.id, connectionId));
}

export async function recordMt5HistoryAccepted(connectionId: number, batchSize: number, complete: boolean) {
  const db = await requireDb();
  const now = new Date();
  await db.update(mt5Connections).set({ lastPing: now, lastContactAt: now, lastHistoryAttempt: now, lastHistoryStatus: complete ? "COMPLETING" : "ACCEPTED", lastHistoryMessage: complete ? `Accepted final batch of ${batchSize} historical position${batchSize === 1 ? "" : "s"}.` : `Accepted ${batchSize} historical position${batchSize === 1 ? "" : "s"}.`, lastHistoryBatchSize: batchSize, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 }).where(eq(mt5Connections.id, connectionId));
}

export async function recordMt5HistoryFailure(connectionId: number, message: string) {
  const db = await requireDb();
  await db.update(mt5Connections).set({ lastHistoryAttempt: new Date(), lastHistoryStatus: "FAILED", lastHistoryMessage: message.slice(0, 255) }).where(eq(mt5Connections.id, connectionId));
}

type LiveBase = { ticket: bigint; symbol: string; direction: "BUY" | "SELL"; lots: number; openPrice: number; slPrice: number | null; tpPrice: number | null; riskUsd: number; rewardUsd: number; rrRatio: number; openTime: Date };

type SyncedMt5Position = LiveBase & { pnl: number; result: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN"; tradeTime: Date; closeTime?: Date | null };

async function upsertTradeRecord(db: any, record: any) {
  const query = db.insert(trades).values(record) as any;
  if (typeof query.onConflictDoUpdate === "function") return query.onConflictDoUpdate({ target: [trades.accountId, trades.mt5Ticket], set: { tradeDate: record.tradeDate, session: record.session, direction: record.direction, result: record.result, risk: record.risk, reward: record.reward, pnl: record.pnl, openTime: record.openTime, closeTime: record.closeTime } });
  return query.onDuplicateKeyUpdate({ set: { tradeDate: record.tradeDate, session: record.session, direction: record.direction, result: record.result, risk: record.risk, reward: record.reward, pnl: record.pnl, openTime: record.openTime, closeTime: record.closeTime } });
}

async function syncMt5PositionToTradeLog(userId: number, accountId: number, position: SyncedMt5Position, database?: any) {
  const db = database ?? await requireDb();
  const record = {
    userId,
    accountId,
    tradeDate: position.tradeTime,
    session: pktSession(position.tradeTime),
    direction: position.direction,
    result: position.result,
    level: "",
    timeframe: "",
    setupQuality: "",
    executionType: "",
    marketCondition: "",
    biasAlignment: "",
    confirmationType: "",
    slPlacement: "",
    tpPlacement: "",
    mistake: "",
    holdQuality: "",
    patienceScore: null,
    risk: position.riskUsd.toFixed(2),
    reward: position.rewardUsd.toFixed(2),
    pnl: position.pnl.toFixed(2),
    openTime: position.openTime,
    closeTime: position.closeTime ?? null,
    notes: "",
    emotionBefore: "",
    emotionDuring: "",
    emotionAfter: "",
    mt5Ticket: position.ticket,
  };
  await upsertTradeRecord(db, record);
}

export async function syncStoredMt5PositionsToTradeLog(userId: number, accountId: number) {
  const db = await requireDb();
  const [positions, resetAt] = await Promise.all([
    db.select().from(mt5LivePositions).where(eq(mt5LivePositions.accountId, accountId)).orderBy(desc(mt5LivePositions.updatedAt)).limit(500),
    getJournalDataResetAt(db, accountId),
  ]);
  let synchronized = 0;
  for (const position of positions) {
    if (!isMt5PositionAfterJournalReset(resetAt, position as { status: "OPEN" | "CLOSED"; openTime: Date; closeTime?: Date | null })) continue;
    await syncMt5PositionToTradeLog(userId, accountId, {
      ticket: position.ticket,
      symbol: position.symbol,
      direction: position.direction as "BUY" | "SELL",
      lots: Number(position.lots),
      openPrice: Number(position.openPrice),
      slPrice: position.slPrice == null ? null : Number(position.slPrice),
      tpPrice: position.tpPrice == null ? null : Number(position.tpPrice),
      riskUsd: Number(position.riskUsd),
      rewardUsd: Number(position.rewardUsd),
      rrRatio: Number(position.rrRatio),
      openTime: position.openTime,
      pnl: position.status === "OPEN" ? Number(position.floatingPnl) : Number(position.realizedPnl),
      result: position.status === "OPEN" ? "OPEN" : ((position.result as "WIN" | "LOSS" | "BREAK_EVEN" | null) ?? "BREAK_EVEN"),
      tradeTime: position.status === "OPEN" ? position.openTime : (position.closeTime ?? position.openTime),
      closeTime: position.status === "OPEN" ? null : position.closeTime,
    });
    synchronized += 1;
  }
  return synchronized;
}

export async function upsertMt5OpenPosition(userId: number, accountId: number, value: LiveBase & { floatingPnl: number }) {
  return upsertMt5OpenPositionBatch(userId, accountId, [value]);
}

export async function upsertMt5OpenPositionBatch(userId: number, accountId: number, values: Array<LiveBase & { floatingPnl: number }>) {
  const db = await requireDb();
  const resetAt = await getJournalDataResetAt(db, accountId);
  const payloads = values.filter(value => isMt5PositionAfterJournalReset(resetAt, { status: "OPEN", openTime: value.openTime })).map(value => ({
    ticket: value.ticket.toString(), symbol: value.symbol, direction: value.direction,
    lots: value.lots.toFixed(2), openPrice: value.openPrice.toFixed(6),
    closePrice: null, slPrice: value.slPrice?.toFixed(6) ?? null, tpPrice: value.tpPrice?.toFixed(6) ?? null,
    riskUsd: value.riskUsd.toFixed(2), rewardUsd: value.rewardUsd.toFixed(2), rrRatio: value.rrRatio.toFixed(2),
    floatingPnl: value.floatingPnl.toFixed(2), realizedPnl: null, result: "OPEN",
    openTime: value.openTime.toISOString(), closeTime: null, status: "OPEN",
    session: pktSession(value.openTime), tradeTime: value.openTime.toISOString(), pnl: value.floatingPnl.toFixed(2),
  }));
  if (!payloads.length) return 0;
  return syncMt5OpenBatchAtomic(userId, accountId, payloads);
}

export async function upsertMt5ClosedPosition(userId: number, accountId: number, value: LiveBase & { closePrice: number; realizedPnl: number; result: "WIN" | "LOSS" | "BREAK_EVEN"; closeTime: Date }) {
  const db = await requireDb();
  const resetAt = await getJournalDataResetAt(db, accountId);
  if (!isMt5PositionAfterJournalReset(resetAt, { status: "CLOSED", openTime: value.openTime, closeTime: value.closeTime })) return;
  await syncMt5PositionAtomic(userId, accountId, {
    ticket: value.ticket.toString(), symbol: value.symbol, direction: value.direction,
    lots: value.lots.toFixed(2), openPrice: value.openPrice.toFixed(6),
    closePrice: value.closePrice.toFixed(6), slPrice: value.slPrice?.toFixed(6) ?? null, tpPrice: value.tpPrice?.toFixed(6) ?? null,
    riskUsd: value.riskUsd.toFixed(2), rewardUsd: value.rewardUsd.toFixed(2), rrRatio: value.rrRatio.toFixed(2),
    floatingPnl: "0.00", realizedPnl: value.realizedPnl.toFixed(2), result: value.result,
    openTime: value.openTime.toISOString(), closeTime: value.closeTime.toISOString(), status: "CLOSED",
    session: pktSession(value.closeTime), tradeTime: value.closeTime.toISOString(), pnl: value.realizedPnl.toFixed(2),
  });
}

type ClosedMt5Position = LiveBase & {
  closePrice: number;
  realizedPnl: number;
  result: "WIN" | "LOSS" | "BREAK_EVEN";
  closeTime: Date;
};

function closedPositionPayload(value: ClosedMt5Position) {
  return {
    ticket: value.ticket.toString(), symbol: value.symbol, direction: value.direction,
    lots: value.lots.toFixed(2), openPrice: value.openPrice.toFixed(6),
    closePrice: value.closePrice.toFixed(6), slPrice: value.slPrice?.toFixed(6) ?? null, tpPrice: value.tpPrice?.toFixed(6) ?? null,
    riskUsd: value.riskUsd.toFixed(2), rewardUsd: value.rewardUsd.toFixed(2), rrRatio: value.rrRatio.toFixed(2),
    floatingPnl: "0.00", realizedPnl: value.realizedPnl.toFixed(2), result: value.result,
    openTime: value.openTime.toISOString(), closeTime: value.closeTime.toISOString(), status: "CLOSED",
    session: pktSession(value.closeTime), tradeTime: value.closeTime.toISOString(), pnl: value.realizedPnl.toFixed(2),
  };
}

/**
 * Preserves terminal CLOSE semantics while syncing one EA history batch in a single
 * Supabase RPC/transaction. This avoids one serverless round-trip per historic ticket.
 */
export async function upsertMt5ClosedPositionBatch(userId: number, accountId: number, values: ClosedMt5Position[]) {
  const db = await requireDb();
  const resetAt = await getJournalDataResetAt(db, accountId);
  const payloads = values
    .filter(value => isMt5PositionAfterJournalReset(resetAt, { status: "CLOSED", openTime: value.openTime, closeTime: value.closeTime }))
    .map(closedPositionPayload);
  if (!payloads.length) return 0;
  return syncMt5HistoryBatchAtomic(userId, accountId, payloads);
}
