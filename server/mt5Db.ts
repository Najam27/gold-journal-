import { and, count, desc, eq, or } from "./supabaseQuery";
import { accounts, mt5Connections, mt5LivePositions, trades } from "../drizzle/schema";
import { getOwnedAccount } from "./goldDb";
import { classifyMt5SyncHealth } from "./mt5Reliability";
import { getDb } from "./db";
import { mt5ApiKeyFingerprint, mt5ConnectionReference } from "./mt5Security";
import { supabaseDataSourceReference } from "./supabaseAdmin";
import { recordMt5EventFailureAtomic, syncMt5HistoryBatchAtomic, syncMt5OpenBatchAtomic, syncMt5PositionAtomic, touchMt5ConnectionAtomic, updateMt5AccountSummaryAtomic } from "./atomicOperations";

async function requireDb() { const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly."); return db; }

/** PostgREST filter URLs stay small; 100 numeric tickets per OR chunk is safe. */
const MT5_TICKET_FILTER_CHUNK = 100;

/**
 * One Supabase round-trip per reconciled position, so a single pass is bounded.
 * 20 keeps a reconciliation request comfortably inside the client budget while
 * still draining a large first-time backfill in a few seconds of polling.
 */
export const MT5_RECONCILE_BATCH_LIMIT = 20;
export const MT5_RECONCILE_BATCH_MAX = 200;

/**
 * Splits a ticket list into bounded OR-filter chunks. A single OR filter with
 * hundreds of tickets (a large open-position snapshot) produced a URL long
 * enough for the gateway to reject with 414, which broke the whole MT5 Live
 * workspace poll for large accounts.
 */
export function chunkMt5TicketFilters(tickets: string[], chunkSize = MT5_TICKET_FILTER_CHUNK) {
  const unique = Array.from(new Set(tickets.filter(ticket => /^\d+$/.test(ticket))));
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += chunkSize) chunks.push(unique.slice(index, index + chunkSize));
  return chunks;
}

async function journaledTicketSet(database: any, userId: number, accountId: number, tickets: string[]) {
  const chunks = chunkMt5TicketFilters(tickets);
  if (!chunks.length) return new Set<string>();
  const rows = await Promise.all(chunks.map(chunk => database.select({ mt5Ticket: trades.mt5Ticket }).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId), or(...chunk.map(ticket => eq(trades.mt5Ticket, BigInt(ticket))))))));
  return new Set(rows.flat().flatMap((row: { mt5Ticket: bigint | null }) => row.mt5Ticket == null ? [] : [row.mt5Ticket.toString()]));
}

async function canonicalizeMt5ConnectionOwner(database: any, connection: typeof mt5Connections.$inferSelect) {
  const owner = await database.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, connection.accountId)).limit(1);
  if (!owner[0]) throw new Error("MT5 connection refers to an unavailable journal account.");
  if (owner[0].userId === connection.userId) return connection;
  await database.update(mt5Connections).set({ userId: owner[0].userId }).where(eq(mt5Connections.id, connection.id));
  return { ...connection, userId: owner[0].userId };
}

function isMissingMt5WriteConfirmationProcedure(error: unknown) {
  const wrapped = error as Error & { supabaseCode?: string };
  return wrapped?.supabaseCode === "PGRST202" || /gj_(touch_mt5_connection|update_mt5_connection_summary).*could not find|could not find.*gj_(touch_mt5_connection|update_mt5_connection_summary)/i.test(wrapped?.message ?? "");
}

async function requireConfirmedMt5ConnectionUpdate(database: any, connectionId: number, values: Record<string, unknown>) {
  const updated = await database.update(mt5Connections).set(values).where(eq(mt5Connections.id, connectionId)).returning({ id: mt5Connections.id });
  if (updated.length !== 1 || Number(updated[0]?.id) !== connectionId) {
    throw new Error("Supabase MT5 connection update did not affect the authenticated connection.");
  }
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
  resetAt: Date | string | null | undefined,
  position: { status: "OPEN" | "CLOSED"; openTime: Date; closeTime?: Date | null },
) {
  if (!resetAt) return true;
  const resetAtMilliseconds = resetAt instanceof Date ? resetAt.getTime() : Date.parse(resetAt);
  if (!Number.isFinite(resetAtMilliseconds)) return true;
  const effectiveTime = position.status === "CLOSED" ? (position.closeTime ?? position.openTime) : position.openTime;
  return effectiveTime.getTime() > resetAtMilliseconds;
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
  const [connections, openPositions, closedPositions, liveConnections, ownedAccounts] = await Promise.all([
    db.select().from(mt5Connections).where(eq(mt5Connections.accountId, account.id)).orderBy(desc(mt5Connections.createdAt)).limit(20),
    db.select().from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "OPEN"))).orderBy(desc(mt5LivePositions.updatedAt)).limit(500),
    db.select().from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "CLOSED"))).orderBy(desc(mt5LivePositions.closeTime)).limit(10),
    db.select().from(mt5Connections).where(and(eq(mt5Connections.userId, userId), eq(mt5Connections.active, true))).orderBy(desc(mt5Connections.lastContactAt)).limit(100),
    db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.userId, userId)).limit(1_000),
  ]);
  // One owner lookup for every visible connection instead of one query per
  // connection (this workspace poll now runs every 2.5 s from the browser).
  const connectionAccountIds = Array.from(new Set(connections.map(connection => connection.accountId)));
  const ownerRows = connectionAccountIds.length
    ? await db.select({ id: accounts.id, userId: accounts.userId }).from(accounts).where(or(...connectionAccountIds.map(id => eq(accounts.id, id))))
    : [];
  const ownerByAccount = new Map(ownerRows.map(row => [row.id, row.userId]));
  const canonicalConnections = await Promise.all(connections.map(connection => {
    const ownerUserId = ownerByAccount.get(connection.accountId);
    if (ownerUserId == null) throw new Error("MT5 connection refers to an unavailable journal account.");
    if (ownerUserId === connection.userId) return connection;
    return db.update(mt5Connections).set({ userId: ownerUserId }).where(eq(mt5Connections.id, connection.id)).then(() => ({ ...connection, userId: ownerUserId }));
  }));
  const accountNames = new Map(ownedAccounts.map(item => [item.id, item.name]));
  const liveElsewhere = liveConnections
    .filter(connection => connection.accountId !== account.id && !connection.retiredAt && (connection.lastContactAt ?? connection.lastPing))
    .map(connection => ({
      accountId: connection.accountId,
      accountName: accountNames.get(connection.accountId) ?? "Another journal account",
      connectionReference: mt5ConnectionReference(connection.apiKey),
      lastContactAt: connection.lastContactAt ?? connection.lastPing,
      lastSummaryAt: connection.lastSummarySuccessAt,
    }));
  const journaledTickets = await journaledTicketSet(db, userId, accountId, [...openPositions, ...closedPositions].map(position => position.ticket.toString()));
  return {
    dataSourceReference: supabaseDataSourceReference(),
    liveElsewhere,
    connections: canonicalConnections.map(connection => ({ id: connection.id, connectionReference: mt5ConnectionReference(connection.apiKey), accountName: account.name, label: connection.label, active: connection.active, retiredAt: connection.retiredAt, retiredReason: connection.retiredReason, brokerUtcOffsetMinutes: (connection as typeof connection & { brokerUtcOffsetMinutes?: number }).brokerUtcOffsetMinutes ?? 180, lastPing: connection.lastPing, lastContactAt: connection.lastContactAt, lastSummaryAt: connection.lastSummaryAt, lastSummarySuccessAt: connection.lastSummarySuccessAt, lastSummaryErrorAt: connection.lastSummaryErrorAt, lastOpenSyncAt: connection.lastOpenSyncAt, lastOpenSyncSuccessAt: connection.lastOpenSyncSuccessAt, lastOpenSyncErrorAt: connection.lastOpenSyncErrorAt, lastErrorCode: connection.lastErrorCode, lastErrorMessage: connection.lastErrorMessage, consecutiveFailures: connection.consecutiveFailures, mt5Login: connection.mt5Login?.toString() ?? null, brokerServer: connection.brokerServer, currency: connection.currency, balance: connection.balance, equity: connection.equity, margin: connection.margin, freeMargin: connection.freeMargin, floatingPnl: connection.floatingPnl, riskSymbol: connection.riskSymbol, riskTickSize: connection.riskTickSize, riskTickValueLoss: connection.riskTickValueLoss, riskContractSize: connection.riskContractSize, riskVolumeMin: connection.riskVolumeMin, riskVolumeMax: connection.riskVolumeMax, riskVolumeStep: connection.riskVolumeStep, riskSymbolUpdatedAt: connection.riskSymbolUpdatedAt, syncHealth: classifyMt5SyncHealth(connection), lastHistorySync: connection.lastHistorySync, historySyncedCount: connection.historySyncedCount, lastHistoryAttempt: connection.lastHistoryAttempt, lastHistoryStatus: connection.lastHistoryStatus, lastHistoryMessage: connection.lastHistoryMessage, lastHistoryBatchSize: connection.lastHistoryBatchSize, createdAt: connection.createdAt })),
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
  const journaledTickets = await journaledTicketSet(db, userId, accountId, positions.map(position => position.ticket.toString()));
  return { positions: positions.map(position => safePosition(position, journaledTickets)), total, page: safePage, pageSize, pageCount };
}

export async function getActiveMt5Connection(apiKey: string) {
  const db = await requireDb();
  const fingerprint = mt5ApiKeyFingerprint(apiKey);
  const hashed = await db.select().from(mt5Connections).where(and(eq(mt5Connections.apiKey, fingerprint), eq(mt5Connections.active, true), eq(mt5Connections.retiredAt, null))).limit(1);
  if (hashed[0]) return canonicalizeMt5ConnectionOwner(db, hashed[0]);
  const legacy = await db.select().from(mt5Connections).where(and(eq(mt5Connections.apiKey, apiKey), eq(mt5Connections.active, true), eq(mt5Connections.retiredAt, null))).limit(1);
  if (!legacy[0]) return null;
  await db.update(mt5Connections).set({ apiKey: fingerprint }).where(eq(mt5Connections.id, legacy[0].id));
  return canonicalizeMt5ConnectionOwner(db, { ...legacy[0], apiKey: fingerprint });
}

export async function touchMt5Connection(connectionId: number) {
  try {
    await touchMt5ConnectionAtomic(connectionId);
  } catch (error) {
    if (!isMissingMt5WriteConfirmationProcedure(error)) throw error;
    const db = await requireDb();
    const now = new Date();
    await requireConfirmedMt5ConnectionUpdate(db, connectionId, { lastPing: now, lastContactAt: now });
  }
}

/**
 * Every open ticket this account currently believes is live. The EA receives
 * this list with each heartbeat and reconciles it against its own terminal
 * state, so a close that MT5 never reported (offline close, missed
 * transaction event, terminal restart) is still resolved from authoritative
 * history instead of staying OPEN until the next 24-hour replay.
 */
export async function getMt5OpenTickets(accountId: number, limit = 2_000) {
  const db = await requireDb();
  const rows = await db
    .select({ ticket: mt5LivePositions.ticket })
    .from(mt5LivePositions)
    .where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "OPEN")))
    .orderBy(desc(mt5LivePositions.updatedAt))
    .limit(limit + 1);
  const truncated = rows.length > limit;
  const tickets = rows.slice(0, limit).map(row => row.ticket.toString());
  return { tickets, count: tickets.length, truncated };
}

/**
 * Finds the connection that a rejected key belongs to: it either matches the
 * retired connection's current key hash or the outgoing key hash recorded when
 * the key was rotated/replaced. This is used only to explain the failure in the
 * UI; it never grants write access.
 */
export async function findRevokedMt5Connection(apiKey: string) {
  const db = await requireDb();
  const fingerprint = mt5ApiKeyFingerprint(apiKey);
  const rows = await db
    .select()
    .from(mt5Connections)
    .where(or(eq(mt5Connections.apiKey, fingerprint), eq(mt5Connections.previousApiKeyHash, fingerprint)))
    .limit(2);
  return (
    rows.find(row => row.previousApiKeyHash === fingerprint) ??
    rows.find(row => row.active === false || row.retiredAt != null) ??
    null
  );
}

/**
 * Records a rejected/retired EA key on the owning connection so health reads
 * "EA key retired" instead of "MT5 offline". Deliberately does NOT advance
 * lastContactAt: the terminal is not authenticated, so it must not look live.
 */
export async function recordMt5AuthFailure(connectionId: number, code: "AUTH_REVOKED" | "AUTH_INVALID", message: string) {
  const db = await requireDb();
  const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 255);
  const rows = await db.select({ consecutiveFailures: mt5Connections.consecutiveFailures }).from(mt5Connections).where(eq(mt5Connections.id, connectionId)).limit(1);
  const previousFailures = Number(rows[0]?.consecutiveFailures ?? 0);
  await requireConfirmedMt5ConnectionUpdate(db, connectionId, {
    lastErrorAt: new Date(),
    lastErrorCode: code.slice(0, 64),
    lastErrorMessage: safeMessage,
    consecutiveFailures: Number.isFinite(previousFailures) ? previousFailures + 1 : 1,
  });
}

export type Mt5EventOperation = "summary" | "open_batch" | "history_batch";

export async function recordMt5EventSuccess(connectionId: number, operation: Mt5EventOperation) {
  await touchMt5Connection(connectionId);
  const db = await requireDb(); const now = new Date();
  await requireConfirmedMt5ConnectionUpdate(db, connectionId, {
    lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0,
    ...(operation === "open_batch" ? { lastOpenSyncAt: now, lastOpenSyncSuccessAt: now } : {}),
  });
}

export async function recordMt5EventFailure(connectionId: number, operation: Mt5EventOperation, code: string, message: string) {
  const safeMessage = message.replace(/[\r\n]+/g, " ").slice(0, 255);
  await recordMt5EventFailureAtomic(connectionId, operation, code.slice(0, 64), safeMessage);
}

type AccountSummary = { mt5Login: bigint; brokerServer: string; currency: string; balance: number; equity: number; margin: number; freeMargin: number; floatingPnl: number; riskSymbol?: string; riskTickSize?: number; riskTickValueLoss?: number; riskContractSize?: number; riskVolumeMin?: number; riskVolumeMax?: number; riskVolumeStep?: number };

export async function updateMt5AccountSummary(connectionId: number, value: AccountSummary) {
  try {
    await updateMt5AccountSummaryAtomic(connectionId, value);
  } catch (error) {
    if (!isMissingMt5WriteConfirmationProcedure(error)) throw error;
    const db = await requireDb();
    const now = new Date();
    await requireConfirmedMt5ConnectionUpdate(db, connectionId, {
      mt5Login: value.mt5Login,
      brokerServer: value.brokerServer,
      currency: value.currency,
      balance: value.balance.toFixed(2),
      equity: value.equity.toFixed(2),
      margin: value.margin.toFixed(2),
      freeMargin: value.freeMargin.toFixed(2),
      floatingPnl: value.floatingPnl.toFixed(2),
      ...(value.riskSymbol ? { riskSymbol: value.riskSymbol, riskTickSize: value.riskTickSize!.toFixed(8), riskTickValueLoss: value.riskTickValueLoss!.toFixed(8), riskContractSize: value.riskContractSize!.toFixed(8), riskVolumeMin: value.riskVolumeMin!.toFixed(8), riskVolumeMax: value.riskVolumeMax!.toFixed(8), riskVolumeStep: value.riskVolumeStep!.toFixed(8), riskSymbolUpdatedAt: now } : {}),
      lastPing: now,
      lastContactAt: now,
      lastSummaryAt: now,
      lastSummarySuccessAt: now,
      lastErrorAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      consecutiveFailures: 0,
    });
  }
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
  await touchMt5Connection(connectionId);
  const db = await requireDb();
  const now = new Date();
  await requireConfirmedMt5ConnectionUpdate(db, connectionId, { lastHistoryAttempt: now, lastHistoryStatus: complete ? "COMPLETING" : "ACCEPTED", lastHistoryMessage: complete ? `Accepted final batch of ${batchSize} historical position${batchSize === 1 ? "" : "s"}.` : `Accepted ${batchSize} historical position${batchSize === 1 ? "" : "s"}.`, lastHistoryBatchSize: batchSize, lastErrorAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0 });
}

export async function recordMt5HistoryFailure(connectionId: number, message: string) {
  const db = await requireDb();
  await db.update(mt5Connections).set({ lastHistoryAttempt: new Date(), lastHistoryStatus: "FAILED", lastHistoryMessage: message.slice(0, 255) }).where(eq(mt5Connections.id, connectionId));
}

/**
 * Records the individual records the ingest layer rejected. The batch itself
 * was accepted, so the EA advances its history cursor instead of re-sending a
 * malformed trade forever (a poison record must not block the whole history).
 */
export async function recordMt5HistoryRejections(connectionId: number, rejected: Array<{ ticket: string | null; code: string }>) {
  const db = await requireDb();
  const codes = Array.from(new Set(rejected.map(item => item.code))).slice(0, 3).join(", ");
  const message = `Accepted this batch and skipped ${rejected.length} record${rejected.length === 1 ? "" : "s"} (${codes}). Skipped tickets do not block the remaining history; re-download the current EA if they persist.`;
  await db.update(mt5Connections).set({ lastHistoryMessage: message.slice(0, 255) }).where(eq(mt5Connections.id, connectionId));
}

type LiveBase = { ticket: bigint; symbol: string; direction: "BUY" | "SELL"; lots: number; openPrice: number; slPrice: number | null; tpPrice: number | null; riskUsd: number; rewardUsd: number; rrRatio: number; openTime: Date };

type SyncedMt5Position = LiveBase & { pnl: number; result: "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN"; tradeTime: Date; closeTime?: Date | null };

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
  // Insert-or-update keeps the RPC-created Trade Log row consistent with the
  // authoritative terminal row while never overwriting manual journal context.
  // On Supabase (PostgreSQL) the conflict target is (accountId, mt5Ticket); the
  // MySQL branch is retained for source-compatible unit harnesses only.
  const query = db.insert(trades).values(record) as any;
  const set = { tradeDate: record.tradeDate, session: record.session, direction: record.direction, result: record.result, risk: record.risk, reward: record.reward, pnl: record.pnl, openTime: record.openTime, closeTime: record.closeTime };
  if (typeof query.onConflictDoUpdate === "function") await query.onConflictDoUpdate({ target: [trades.accountId, trades.mt5Ticket], set });
  else await query.onDuplicateKeyUpdate({ set });
}

/**
 * Reconciles stored MT5 positions into the Trade Log.
 *
 * This is a WRITE path: every position that needs journaling costs one Supabase
 * round-trip. It therefore never runs inside a read request any more (that is
 * what produced the account-switch request timeout) and it is bounded per call,
 * so callers drain a large backlog over several invocations instead of holding
 * one request open. `remaining` reports whether another pass is needed.
 */
export async function syncStoredMt5PositionsToTradeLog(userId: number, accountId: number, options: { limit?: number } = {}) {
  const db = await requireDb();
  const [positions, resetAt] = await Promise.all([
    db.select().from(mt5LivePositions).where(eq(mt5LivePositions.accountId, accountId)).orderBy(desc(mt5LivePositions.updatedAt)).limit(500),
    getJournalDataResetAt(db, accountId),
  ]);
  // Skip journal rows that already reflect the terminal row. The previous
  // implementation re-upserted every stored position on every journal/trades
  // poll (every 2.5 s in the Trade Log view), issuing one Supabase HTTP
  // round-trip per position; with hundreds of MT5 rows that exceeded the
  // client request timeout and produced the "MT5 pre-sync degraded" storm.
  // Match journaled rows by an OR over the stored tickets (chunked to keep the
  // PostgREST filter URL bounded). This must be OR, not AND: an AND over N ticket
  // equalities can only ever match when exactly one position is stored, silently
  // disabling the pre-filter and re-upserting every position on every poll.
  const ticketChunks = chunkMt5TicketFilters(positions.map(position => position.ticket.toString()));
  const journaledRows = await Promise.all(ticketChunks.map(chunk => db.select({ mt5Ticket: trades.mt5Ticket, result: trades.result, pnl: trades.pnl }).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId), or(...chunk.map(ticket => eq(trades.mt5Ticket, BigInt(ticket))))))));
  const journaled = journaledRows.flat();
  const journaledByTicket = new Map(journaled.map(row => [row.mt5Ticket?.toString(), row]));
  const needsJournal = positions.filter(position => {
    if (!isMt5PositionAfterJournalReset(resetAt, position as { status: "OPEN" | "CLOSED"; openTime: Date; closeTime?: Date | null })) return false;
    const existing = journaledByTicket.get(position.ticket.toString());
    if (!existing) return true;
    if (existing.result !== position.status) return true;
    if (position.status === "CLOSED") return Number(existing.pnl ?? 0) !== Number(position.realizedPnl ?? 0);
    return Number(existing.pnl ?? 0) !== Number(position.floatingPnl ?? 0);
  });
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? MT5_RECONCILE_BATCH_LIMIT)), MT5_RECONCILE_BATCH_MAX);
  let synchronized = 0;
  for (const position of needsJournal.slice(0, limit)) {
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
  return { synchronized, remaining: Math.max(0, needsJournal.length - synchronized) };
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
