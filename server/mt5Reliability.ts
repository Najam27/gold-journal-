import { mt5Connections, mt5LivePositions, trades } from "../drizzle/schema";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";
import { and, eq } from "./supabaseQuery";

type SyncConnection = { active: boolean; lastPing: Date | null; lastContactAt?: Date | null; lastSummaryAt?: Date | null; lastSummarySuccessAt?: Date | null; lastSummaryErrorAt?: Date | null; lastOpenSyncAt?: Date | null; lastOpenSyncSuccessAt?: Date | null; lastOpenSyncErrorAt?: Date | null; lastErrorAt?: Date | null; lastErrorCode?: string | null; lastErrorMessage?: string | null; consecutiveFailures?: number | null; lastHistoryAttempt: Date | null; lastHistorySync: Date | null; lastHistoryStatus: string | null; lastHistoryMessage: string | null; historySyncedCount: number | null };
export function classifyMt5SyncHealth(connection: SyncConnection | null, now = Date.now()) {
  if (!connection) return { state: "MISSING" as const, label: "MT5 connection record missing", lastContactAgeSeconds: null, lastSummaryAgeSeconds: null, lastOpenSyncAgeSeconds: null, historyState: "NOT_STARTED" as const, message: "No private MT5 connection record exists for this journal account. Reconnect required." };
  const ageOf = (value?: Date | null) => value ? Math.max(0, Math.floor((now - value.getTime()) / 1_000)) : null;
  const contactAge = ageOf(connection.lastContactAt ?? connection.lastPing);
  const summaryAge = ageOf(connection.lastSummarySuccessAt);
  const openAge = ageOf(connection.lastOpenSyncSuccessAt);
  const summaryFailedAfterSuccess = Boolean(connection.lastSummaryErrorAt && (!connection.lastSummarySuccessAt || connection.lastSummaryErrorAt.getTime() > connection.lastSummarySuccessAt.getTime()));
  const latestError = connection.lastErrorCode ? `${connection.lastErrorCode}${connection.lastErrorMessage ? `: ${connection.lastErrorMessage}` : ""}` : null;
  const state = contactAge == null ? "WAITING" : contactAge > 300 ? "OFFLINE" : contactAge > 60 ? "STALE" : summaryAge == null || summaryAge > 15 || summaryFailedAfterSuccess ? "DEGRADED" : "CONNECTED";
  const historyState = connection.lastHistoryStatus === "FAILED" ? "FAILED" : connection.lastHistorySync ? "COMPLETE" : connection.lastHistoryAttempt ? "IN_PROGRESS" : "NOT_STARTED";
  const message = state === "CONNECTED" ? "Live terminal contact and snapshot are current." : state === "DEGRADED" ? `MT5 contacted Gold Journal, but the live snapshot ${summaryAge == null ? "has not been saved yet" : `has not updated for ${summaryAge}s`}${latestError ? `. ${latestError}` : "."}` : state === "STALE" ? `The last MT5 contact was ${contactAge}s ago. The connection record remains active and will recover when EA communication resumes.` : state === "OFFLINE" ? `The last MT5 contact was ${contactAge}s ago. The connection record remains active; check the terminal, WebRequest permission, and internet connection.` : "Waiting for the first MT5 terminal contact.";
  return { state, label: state === "CONNECTED" ? "MT5 connected" : state === "DEGRADED" ? "MT5 sync degraded" : state === "STALE" ? "MT5 sync stale" : state === "OFFLINE" ? "MT5 offline" : "Waiting for MT5", lastContactAgeSeconds: contactAge, lastSummaryAgeSeconds: summaryAge, lastOpenSyncAgeSeconds: openAge, lastErrorCode: connection.lastErrorCode ?? null, consecutiveFailures: connection.consecutiveFailures ?? 0, historyState, message: historyState === "FAILED" ? (connection.lastHistoryMessage || message) : message };
}

export async function getMt5Integrity(userId: number, accountId: number) {
  await getOwnedAccount(userId, accountId);
  const db = await getDb(); if (!db) throw new Error("Supabase database is unavailable. Please retry shortly.");
  const [connection] = await db.select().from(mt5Connections).where(and(eq(mt5Connections.userId, userId), eq(mt5Connections.accountId, accountId), eq(mt5Connections.active, true))).limit(1);
  const closed = await db.select({ ticket: mt5LivePositions.ticket }).from(mt5LivePositions).where(and(eq(mt5LivePositions.accountId, accountId), eq(mt5LivePositions.status, "CLOSED"))).limit(5_000);
  const tickets = closed.map(row => row.ticket);
  const journaled = tickets.length ? await db.select({ ticket: trades.mt5Ticket }).from(trades).where(and(eq(trades.userId, userId), eq(trades.accountId, accountId))).limit(10_000) : [];
  const closedTickets = new Set(tickets.map(ticket => ticket.toString())); const journaledTickets = new Set(journaled.flatMap(row => row.ticket == null || !closedTickets.has(row.ticket.toString()) ? [] : [row.ticket.toString()]));
  const unjournaledClosedPositions = closed.filter(row => !journaledTickets.has(row.ticket.toString())).length;
  const health = classifyMt5SyncHealth(connection ?? null);
  const findings = [
    ...(health.state === "DEGRADED" ? [{ code: "MT5_DEGRADED", severity: "warning" as const, message: health.message }] : []),
    ...(health.state === "STALE" || health.state === "OFFLINE" ? [{ code: health.state === "OFFLINE" ? "MT5_OFFLINE" : "MT5_STALE", severity: "warning" as const, message: health.message }] : []),
    ...(health.historyState === "FAILED" ? [{ code: "MT5_HISTORY_FAILED", severity: "error" as const, message: health.message }] : []),
    ...(unjournaledClosedPositions ? [{ code: "MT5_UNJOURNALED_CLOSES", severity: "warning" as const, message: `${unjournaledClosedPositions} closed MT5 position${unjournaledClosedPositions === 1 ? " is" : "s are"} waiting to reach Trade Log.` }] : []),
  ];
  return { health, closedPositions: closed.length, unjournaledClosedPositions, findings };
}
