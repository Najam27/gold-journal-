import { mt5Connections, mt5LivePositions, trades } from "../drizzle/schema";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";
import { and, eq } from "./supabaseQuery";

type SyncConnection = { active: boolean; lastPing: Date | null; lastHistoryAttempt: Date | null; lastHistorySync: Date | null; lastHistoryStatus: string | null; lastHistoryMessage: string | null; historySyncedCount: number | null };
export function classifyMt5SyncHealth(connection: SyncConnection | null, now = Date.now()) {
  if (!connection) return { state: "UNAVAILABLE" as const, label: "No active MT5 connection", lastContactAgeSeconds: null, historyState: "NOT_STARTED" as const, message: "Create a connection, then attach the Expert Advisor." };
  const age = connection.lastPing ? Math.max(0, Math.floor((now - connection.lastPing.getTime()) / 1_000)) : null;
  const state = age == null ? "WAITING" : age <= 10 ? "LIVE" : age <= 60 ? "IDLE" : "STALE";
  const historyState = connection.lastHistoryStatus === "FAILED" ? "FAILED" : connection.lastHistorySync ? "COMPLETE" : connection.lastHistoryAttempt ? "IN_PROGRESS" : "NOT_STARTED";
  return { state, label: state === "LIVE" ? "Live MT5 sync" : state === "IDLE" ? "MT5 sync idle" : state === "STALE" ? "MT5 sync stale" : "Waiting for MT5", lastContactAgeSeconds: age, historyState, message: historyState === "FAILED" ? (connection.lastHistoryMessage || "History sync failed. Check the EA log and connection.") : historyState === "COMPLETE" ? `${connection.historySyncedCount ?? 0} historical positions synced.` : historyState === "IN_PROGRESS" ? (connection.lastHistoryMessage || "Historical positions are being received.") : "No historical batch received yet." };
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
    ...(health.state === "STALE" ? [{ code: "MT5_STALE", severity: "warning" as const, message: "MT5 has not contacted Gold Journal for over one minute." }] : []),
    ...(health.historyState === "FAILED" ? [{ code: "MT5_HISTORY_FAILED", severity: "error" as const, message: health.message }] : []),
    ...(unjournaledClosedPositions ? [{ code: "MT5_UNJOURNALED_CLOSES", severity: "warning" as const, message: `${unjournaledClosedPositions} closed MT5 position${unjournaledClosedPositions === 1 ? " is" : "s are"} waiting to reach Trade Log.` }] : []),
  ];
  return { health, closedPositions: closed.length, unjournaledClosedPositions, findings };
}
