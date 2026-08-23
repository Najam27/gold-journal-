import { mt5Connections, mt5LivePositions, trades } from "../drizzle/schema";
import { getDb } from "./db";
import { getOwnedAccount } from "./goldDb";
import { and, eq } from "./supabaseQuery";

type TimestampValue = Date | string | null | undefined;

type SyncConnection = {
  active: boolean;
  lastPing: TimestampValue;
  lastContactAt?: TimestampValue;
  lastSummaryAt?: TimestampValue;
  lastSummarySuccessAt?: TimestampValue;
  lastSummaryErrorAt?: TimestampValue;
  lastOpenSyncAt?: TimestampValue;
  lastOpenSyncSuccessAt?: TimestampValue;
  lastOpenSyncErrorAt?: TimestampValue;
  lastErrorAt?: TimestampValue;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  consecutiveFailures?: number | null;
  lastHistoryAttempt: TimestampValue;
  lastHistorySync: TimestampValue;
  lastHistoryStatus: string | null;
  lastHistoryMessage: string | null;
  historySyncedCount: number | null;
};
export function classifyMt5SyncHealth(
  connection: SyncConnection | null,
  now = Date.now()
) {
  if (!connection)
    return {
      state: "MISSING" as const,
      label: "MT5 connection record missing",
      lastContactAgeSeconds: null,
      lastSummaryAgeSeconds: null,
      lastOpenSyncAgeSeconds: null,
      historyState: "NOT_STARTED" as const,
      message:
        "No private MT5 connection record exists for this journal account. Reconnect required.",
    };
  const timestampMs = (value: TimestampValue) => {
    if (!value) return null;
    const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  };
  const ageOf = (value?: TimestampValue) => {
    const milliseconds = timestampMs(value);
    return milliseconds == null ? null : Math.max(0, Math.floor((now - milliseconds) / 1_000));
  };
  const contactAge = ageOf(connection.lastContactAt ?? connection.lastPing);
  const summaryAge = ageOf(connection.lastSummarySuccessAt);
  const openAge = ageOf(connection.lastOpenSyncSuccessAt);
  const summaryFresh = summaryAge != null && summaryAge <= 15;
  const openFresh = openAge != null && openAge <= 15;
  const summaryFailedAfterSuccess = Boolean(
    timestampMs(connection.lastSummaryErrorAt) != null &&
      (timestampMs(connection.lastSummarySuccessAt) == null ||
        timestampMs(connection.lastSummaryErrorAt)! >
          timestampMs(connection.lastSummarySuccessAt)!)
  );
  const openFailedAfterSuccess = Boolean(
    timestampMs(connection.lastOpenSyncErrorAt) != null &&
      (timestampMs(connection.lastOpenSyncSuccessAt) == null ||
        timestampMs(connection.lastOpenSyncErrorAt)! >
          timestampMs(connection.lastOpenSyncSuccessAt)!)
  );
  const latestError = connection.lastErrorCode
    ? `${connection.lastErrorCode}${connection.lastErrorMessage ? `: ${connection.lastErrorMessage}` : ""}`
    : null;
  const state =
    contactAge == null
      ? "WAITING"
      : contactAge > 300
        ? "OFFLINE"
        : contactAge > 60
          ? "STALE"
          : !summaryFresh && !openFresh
            ? "DEGRADED"
            : summaryFailedAfterSuccess || openFailedAfterSuccess
            ? "DEGRADED"
            : "CONNECTED";
  const snapshotState = summaryFailedAfterSuccess
    ? "FAILED"
    : summaryAge == null
      ? "PENDING"
      : summaryFresh
        ? "CURRENT"
        : "STALE";
  const openSyncState = openFailedAfterSuccess
    ? "FAILED"
    : openAge == null
      ? "PENDING"
      : openFresh
        ? "CURRENT"
        : "STALE";
  const historyState =
    connection.lastHistoryStatus === "FAILED"
      ? "FAILED"
      : connection.lastHistorySync
        ? "COMPLETE"
        : connection.lastHistoryAttempt
          ? "IN_PROGRESS"
          : "NOT_STARTED";
  const waitingMessage =
    "Waiting for the first MT5 terminal contact. In MT5, confirm the read-only EA is attached, the exact server origin is allowed under Tools > Options > Expert Advisors > WebRequest, and the one-time API key was pasted into this connection. Auto Trading may remain off.";
  const message =
    state === "CONNECTED"
      ? snapshotState === "CURRENT"
        ? "Live terminal contact and account snapshot are current."
        : "Live terminal contact is current; open-position synchronization is current while the account snapshot is pending."
      : state === "DEGRADED"
        ? `MT5 contacted Gold Journal, but ${snapshotState === "FAILED" ? "the account snapshot failed" : snapshotState === "PENDING" ? "the account snapshot has not been saved yet" : snapshotState === "STALE" ? `the account snapshot has not updated for ${summaryAge}s` : openSyncState === "FAILED" ? "open-position synchronization failed" : openSyncState === "PENDING" ? "open-position synchronization has not been saved yet" : `open-position synchronization has not updated for ${openAge}s`}${latestError ? `. ${latestError}` : "."}`
        : state === "STALE"
          ? `The last MT5 contact was ${contactAge}s ago. The connection record remains active and will recover when EA communication resumes.`
          : state === "OFFLINE"
            ? `The last MT5 contact was ${contactAge}s ago. The connection record remains active; check the terminal, WebRequest permission, and internet connection.`
            : waitingMessage;
  return {
    state,
    label:
      state === "CONNECTED"
        ? "MT5 connected"
        : state === "DEGRADED"
          ? "MT5 sync degraded"
          : state === "STALE"
            ? "MT5 sync stale"
            : state === "OFFLINE"
              ? "MT5 offline"
              : "Waiting for MT5",
    lastContactAgeSeconds: contactAge,
    lastSummaryAgeSeconds: summaryAge,
    lastOpenSyncAgeSeconds: openAge,
    snapshotState,
    openSyncState,
    lastErrorCode: connection.lastErrorCode ?? null,
    consecutiveFailures: connection.consecutiveFailures ?? 0,
    historyState,
    message:
      historyState === "FAILED"
        ? connection.lastHistoryMessage || message
        : message,
  };
}

export async function getMt5Integrity(userId: number, accountId: number) {
  await getOwnedAccount(userId, accountId);
  const db = await getDb();
  if (!db)
    throw new Error("Supabase database is unavailable. Please retry shortly.");
  const [connection] = await db
    .select()
    .from(mt5Connections)
    .where(
      and(
        eq(mt5Connections.accountId, accountId),
        eq(mt5Connections.active, true),
        eq(mt5Connections.retiredAt, null)
      )
    )
    .limit(1);
  let canonicalConnection = connection;
  if (connection && connection.userId !== userId) {
    await db
      .update(mt5Connections)
      .set({ userId })
      .where(eq(mt5Connections.id, connection.id));
    canonicalConnection = { ...connection, userId };
  }
  const closed = await db
    .select({ ticket: mt5LivePositions.ticket })
    .from(mt5LivePositions)
    .where(
      and(
        eq(mt5LivePositions.accountId, accountId),
        eq(mt5LivePositions.status, "CLOSED")
      )
    )
    .limit(5_000);
  const tickets = closed.map(row => row.ticket);
  const journaled = tickets.length
    ? await db
        .select({ ticket: trades.mt5Ticket })
        .from(trades)
        .where(and(eq(trades.userId, userId), eq(trades.accountId, accountId)))
        .limit(10_000)
    : [];
  const closedTickets = new Set(tickets.map(ticket => ticket.toString()));
  const journaledTickets = new Set(
    journaled.flatMap(row =>
      row.ticket == null || !closedTickets.has(row.ticket.toString())
        ? []
        : [row.ticket.toString()]
    )
  );
  const unjournaledClosedPositions = closed.filter(
    row => !journaledTickets.has(row.ticket.toString())
  ).length;
  const health = classifyMt5SyncHealth(canonicalConnection ?? null);
  const findings = [
    ...(health.state === "DEGRADED"
      ? [
          {
            code: "MT5_DEGRADED",
            severity: "warning" as const,
            message: health.message,
          },
        ]
      : []),
    ...(health.state === "STALE" || health.state === "OFFLINE"
      ? [
          {
            code: health.state === "OFFLINE" ? "MT5_OFFLINE" : "MT5_STALE",
            severity: "warning" as const,
            message: health.message,
          },
        ]
      : []),
    ...(health.historyState === "FAILED"
      ? [
          {
            code: "MT5_HISTORY_FAILED",
            severity: "error" as const,
            message: health.message,
          },
        ]
      : []),
    ...(unjournaledClosedPositions
      ? [
          {
            code: "MT5_UNJOURNALED_CLOSES",
            severity: "warning" as const,
            message: `${unjournaledClosedPositions} closed MT5 position${unjournaledClosedPositions === 1 ? " is" : "s are"} waiting to reach Trade Log.`,
          },
        ]
      : []),
  ];
  return {
    health,
    closedPositions: closed.length,
    unjournaledClosedPositions,
    findings,
  };
}
