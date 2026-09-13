import type { Express, Request, Response } from "express";
import { z } from "zod";
import { completeMt5HistorySync, findRevokedMt5Connection, getActiveMt5Connection, getMt5OpenTickets, recordMt5AuthFailure, recordMt5EventFailure, recordMt5EventSuccess, recordMt5HistoryAccepted, recordMt5HistoryAttempt, recordMt5HistoryFailure, recordMt5HistoryRejections, touchMt5Connection, updateMt5AccountSummary, upsertMt5ClosedPosition, upsertMt5ClosedPositionBatch, upsertMt5OpenPosition, upsertMt5OpenPositionBatch } from "./mt5Db";
import { mt5ApiKeyFingerprint, mt5ConnectionReference } from "./mt5Security";
import { supabaseDataSourceReference } from "./supabaseAdmin";
import { consumeRateLimit, rateLimitTestHooks } from "./rateLimit";
import { Mt5TimestampError, normalizeMt5TimestampToUtcPlus5 } from "./mt5Timestamp";

export const MT5_EA_MIN_VERSION = "2.0.0";
export const MT5_PAYLOAD_VERSION = "2";
/** Payload versions this server can still interpret. "1" is the documented
 * legacy shape that 2.x EAs keep sending when a chart still runs an older
 * build; anything else is rejected explicitly instead of being misparsed. */
export const MT5_SUPPORTED_PAYLOAD_VERSIONS = ["1", "2"] as const;
/** Hard bounds for the atomic Supabase RPCs. The current EA chunks its own
 * open-position snapshot to MT5_MAX_OPEN_BATCH, so an oversized batch can only
 * come from an outdated EA build. */
export const MT5_MAX_OPEN_BATCH = 200;
export const MT5_MAX_HISTORY_BATCH = 50;
const MT5_BATCH_HARD_CAP = 1_000;
const MT5_FAILED_RECORD_REPORT_LIMIT = 20;

const numeric = z.coerce.number().finite();
const ticket = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(value => BigInt(value));
const timestamp = z.union([z.string().trim().min(8).max(40), z.number().finite().positive()]);
const direction = z.enum(["Buy", "Sell", "BUY", "SELL"]).transform(value => value.toUpperCase() as "BUY" | "SELL");
const result = z.enum(["Win", "Loss", "Break-even", "WIN", "LOSS", "BREAK_EVEN"]).transform(value => value === "Win" || value === "WIN" ? "WIN" : value === "Loss" || value === "LOSS" ? "LOSS" : "BREAK_EVEN" as const);
const versionFields = { ea_version: z.string().trim().min(1).max(32).default("legacy"), payload_version: z.string().trim().min(1).max(16).default("1"), connection_id: z.string().trim().max(128).optional() };
const versionSchema = z.object(versionFields);

const positionBase = z.object({ ticket, symbol: z.string().trim().min(1).max(32), direction, lots: numeric.min(0), open_price: numeric, sl_price: numeric.optional().default(0), tp_price: numeric.optional().default(0), risk_usd: numeric.min(0), reward_usd: numeric.min(0), rr_ratio: numeric.min(0) });
const base = positionBase.extend({ api_key: z.string().trim().min(24).max(96) }).merge(versionSchema);
const openFields = z.object({ floating_pnl: numeric, open_time: timestamp });
const closedFields = z.object({ close_price: numeric, realized_pnl: numeric, result, close_time: timestamp, open_time: timestamp.optional() });
const closedPosition = positionBase.merge(closedFields);
const openPosition = positionBase.merge(openFields);
const brokerOffsetField = { broker_utc_offset_minutes: z.number().int().min(-720).max(840).optional() };

export type Mt5RejectedRecord = { ticket: string | null; code: string; retryable: boolean };

function rejectedTicket(record: unknown): string | null {
  const raw = (record as { ticket?: unknown } | null)?.ticket;
  const value = typeof raw === "bigint" ? raw.toString() : String(raw ?? "");
  return /^\d+$/.test(value) ? value.slice(0, 20) : null;
}

/**
 * Validates each element of an EA batch on its own. Before this, one malformed
 * trade rejected the entire 50-record history request: the EA retried the same
 * poison record forever and never advanced its cursor, so no other trade could
 * ever be imported. A rejected record is now reported, skipped, and never
 * retried automatically.
 */
export function partitionMt5Records<T>(records: unknown[], parse: (record: unknown) => T): { accepted: T[]; rejected: Mt5RejectedRecord[]; }
{
  const accepted: T[] = [];
  const rejected: Mt5RejectedRecord[] = [];
  for (const record of records) {
    try {
      accepted.push(parse(record));
    } catch (error) {
      const code = error instanceof z.ZodError ? "PAYLOAD_INVALID" : error instanceof Mt5TimestampError ? error.code : "PAYLOAD_INVALID";
      rejected.push({ ticket: rejectedTicket(record), code, retryable: false });
    }
  }
  return { accepted, rejected };
}

export const mt5Payload = z.discriminatedUnion("event", [
  z.object({ event: z.literal("ping"), api_key: z.string().trim().min(24).max(96) }).merge(versionSchema),
  z.object({ event: z.literal("compat"), api_key: z.string().trim().min(24).max(96), ea_version: z.string().trim().min(1).max(32), payload_version: z.string().trim().min(1).max(16), connection_id: z.string().trim().max(128).optional() }),
  z.object({ event: z.literal("summary"), api_key: z.string().trim().min(24).max(96), mt5_login: ticket, broker_server: z.string().trim().min(1).max(160), currency: z.string().trim().min(1).max(16), balance: numeric, equity: numeric, margin: numeric.min(0), free_margin: numeric, floating_pnl: numeric, risk_symbol: z.string().trim().min(1).max(32).optional(), risk_tick_size: numeric.positive().optional(), risk_tick_value_loss: numeric.positive().optional(), risk_contract_size: numeric.positive().optional(), risk_volume_min: numeric.positive().optional(), risk_volume_max: numeric.positive().optional(), risk_volume_step: numeric.positive().optional() }).merge(versionSchema),
  base.extend({ event: z.literal("open") }).merge(openFields).merge(z.object(brokerOffsetField)),
  z.object({ event: z.literal("open_batch"), api_key: z.string().trim().min(24).max(96), positions: z.array(z.unknown()).max(MT5_BATCH_HARD_CAP), broker_utc_offset_minutes: z.number().int().min(-720).max(840) }).merge(versionSchema),
  base.merge(closedFields).extend({ event: z.literal("close") }).merge(z.object(brokerOffsetField)),
  z.object({ event: z.literal("history_batch"), api_key: z.string().trim().min(24).max(96), positions: z.array(z.unknown()).max(MT5_BATCH_HARD_CAP), complete: z.boolean().default(false), broker_utc_offset_minutes: z.number().int().min(-720).max(840).optional() }).merge(versionSchema),
]);

export const mt5RateLimitTestHooks = { reset: rateLimitTestHooks.reset, size: () => rateLimitTestHooks.size("mt5-ingest") };

function versionBody(payload: z.infer<typeof mt5Payload>) {
  return { eaVersion: payload.ea_version, payloadVersion: payload.payload_version, minimumEaVersion: MT5_EA_MIN_VERSION, supportedPayloadVersion: MT5_PAYLOAD_VERSION, compatible: payload.ea_version !== "legacy" && payload.payload_version === MT5_PAYLOAD_VERSION };
}

function connectionBody(connection: { apiKey: string }) {
  return { connectionReference: mt5ConnectionReference(connection.apiKey), dataSourceReference: supabaseDataSourceReference() };
}

export type Mt5FailureCode = "MIGRATION_REQUIRED_0008" | "DATABASE_RETRYABLE" | "INVALID_SYNC_DATA" | "SYNC_PERMISSION_DENIED" | "INVALID_MT5_TIMESTAMP" | "FUTURE_TRADE" | "SYNC_UNAVAILABLE" | "BATCH_TOO_LARGE" | "UNSUPPORTED_VERSION";
export type Mt5HttpOutcome = { status: number; body: Record<string, unknown> };
type SupabaseWrappedError = Error & { supabaseCode?: string; supabaseDetails?: string; supabaseHint?: string };

function errorText(error: unknown) {
  const wrapped = error as SupabaseWrappedError;
  return [wrapped?.message, wrapped?.supabaseDetails, wrapped?.supabaseHint, wrapped?.supabaseCode].filter(Boolean).join(" ").toLowerCase();
}

export function syncFailureDiagnostic(error: unknown) {
  if (error instanceof Mt5TimestampError) {
    return error.code === "FUTURE_TRADE" ? "MT5 history contains a timestamp in the future; verify the broker clock and UTC offset." : "MT5 history contains an invalid timestamp.";
  }
  const wrapped = error as SupabaseWrappedError;
  const providerCode = String(wrapped?.supabaseCode || "").toUpperCase();
  const text = errorText(error);
  if (providerCode === "PGRST202" || providerCode === "42601" || /schema cache|could not find the function|function .*gj_sync_mt5_(position|open_batch)|function .*gj_record_mt5_event_failure|column .* does not exist|relation .* does not exist|migration|position_payload|syntax error|insert has more target columns/.test(text)) return "Supabase MT5 RPC migration is invalid or stale; apply migration 0016 and reload the PostgREST schema (Supabase dashboard → SQL → 'Reload schema cache' or run NOTIFY pgrst, 'reload schema').";
  if (providerCode === "22P02" || providerCode === "22007" || /invalid input syntax|date\/time field|numeric value out of range/.test(text)) return "MT5 history contains an invalid timestamp or numeric value.";
  if (providerCode === "42501" || /permission denied|account unavailable|not authorized/.test(text)) return "Supabase rejected the MT5 account or service-role operation.";
  if (/supabase database is unavailable|server configuration is unavailable|fetch failed|econnreset|enotfound/.test(text)) return "The server could not reach Supabase or its server configuration is incomplete.";
  if (/deadlock|timeout|timed out|lock not available|temporarily unavailable/.test(text)) return "Supabase was temporarily unavailable or the account row was locked; retry history.";
  if (providerCode) return `Supabase returned provider code ${providerCode}; check the API deployment logs (wrangler tail on Cloudflare Workers) for the redacted details.`;
  return "Check the API deployment logs (wrangler tail on Cloudflare Workers) for the redacted Supabase error metadata.";
}

export function classifySyncFailure(error: unknown): Mt5FailureCode {
  if (error instanceof Mt5TimestampError) return error.code;
  const wrapped = error as SupabaseWrappedError;
  const providerCode = String(wrapped?.supabaseCode || "").toUpperCase();
  const message = errorText(error);
  if (providerCode === "PGRST202" || providerCode === "42601" || /schema cache|could not find the function|function .*gj_sync_mt5_(position|open_batch)|function .*gj_record_mt5_event_failure|column .* does not exist|relation .* does not exist|migration|position_payload|syntax error|insert has more target columns/.test(message)) return "MIGRATION_REQUIRED_0008";
  if (providerCode === "22P02" || providerCode === "22007" || /invalid input syntax|date\/time field|numeric value out of range/.test(message)) return "INVALID_SYNC_DATA";
  if (providerCode === "42501" || /permission denied|account unavailable|not authorized/.test(message)) return "SYNC_PERMISSION_DENIED";
  if (/deadlock|timeout|timed out|lock not available|temporarily unavailable/.test(message)) return "DATABASE_RETRYABLE";
  return "SYNC_UNAVAILABLE";
}

function operationFor(payload: z.infer<typeof mt5Payload>): "summary" | "open_batch" | "history_batch" | null {
  if (payload.event === "summary") return "summary";
  if (payload.event === "open" || payload.event === "open_batch") return "open_batch";
  if (payload.event === "close" || payload.event === "history_batch") return "history_batch";
  return null;
}

function mt5Log(connection: { id: number; accountId: number }, operation: string, startedAt: number, result: "success" | "failed", details: Record<string, unknown> = {}) {
  console.info("[MT5]", JSON.stringify({ connectionId: connection.id, accountId: connection.accountId, operation, durationMs: Date.now() - startedAt, result, ...details }));
}

async function persistFailureDiagnostic(connection: { id: number; accountId: number }, payload: z.infer<typeof mt5Payload>, code: Mt5FailureCode, error: unknown, startedAt: number, diagnosticOverride?: string) {
  const operation = operationFor(payload); const diagnostic = diagnosticOverride ?? syncFailureDiagnostic(error);
  if (operation) {
    try { await recordMt5EventFailure(connection.id, operation, code, diagnostic); }
    catch (recordError) { console.error("[MT5] diagnostic persistence failed", JSON.stringify({ connectionId: connection.id, accountId: connection.accountId, operation, diagnostic: syncFailureDiagnostic(recordError) })); }
  }
  mt5Log(connection, operation ?? payload.event, startedAt, "failed", { code, diagnostic, ...(payload.event === "history_batch" ? { batchSize: payload.positions.length } : {}), ...(payload.event === "open_batch" ? { positionCount: payload.positions.length } : {}) });
  return diagnostic;
}

/**
 * Reconciliation feed for the EA. The heartbeat response carries every ticket
 * this account currently believes is OPEN, so the terminal can verify it
 * against its own live positions and resolve a close that MT5 never reported.
 * It is a compact CSV string because the EA's payload parser is deliberately
 * primitive. A failed lookup simply omits the field, and the EA then keeps its
 * previous reconciliation state instead of assuming an empty account.
 */
async function reconciliationFields(accountId: number) {
  try {
    const open = await getMt5OpenTickets(accountId);
    return { openTicketFormat: "csv", openTickets: open.tickets.join(","), openTicketCount: open.count, openTicketsTruncated: open.truncated };
  } catch (error) {
    console.error("[MT5] open-ticket reconciliation lookup failed", JSON.stringify({ accountId, reason: error instanceof Error ? error.message : "unknown" }));
    return {};
  }
}

/**
 * A rejected key that belongs to a retired/rotated connection is attributed to
 * that connection so MT5 Live can say "EA key retired" instead of "MT5
 * offline". The HTTP response stays the same opaque 401 so key probing learns
 * nothing, and the attribution never grants write access.
 */
async function attributeRejectedKey(apiKey: string) {
  try {
    const revoked = await findRevokedMt5Connection(apiKey);
    if (!revoked) return;
    const rotated = revoked.previousApiKeyHash === mt5ApiKeyFingerprint(apiKey);
    await recordMt5AuthFailure(
      revoked.id,
      "AUTH_REVOKED",
      rotated
        ? "The EA is still sending a rotated MT5 key. Paste the replacement key from MT5 Live into the EA inputs and apply, or download the current EA."
        : "The EA key belongs to a paused or retired MT5 connection. Issue a replacement key in MT5 Live, paste it into the EA inputs, and apply.",
    );
  } catch (error) {
    console.error("[MT5] rejected-key attribution failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function processMt5Payload(body: unknown) {
  const startedAt = Date.now();
  const payload = mt5Payload.parse(body);
  if (!(await consumeRateLimit("mt5-ingest", mt5ApiKeyFingerprint(payload.api_key), 5, 1_000))) return { status: 429, body: { ok: false, code: "RATE_LIMITED" } };
  const connection = await getActiveMt5Connection(payload.api_key);
  if (!connection) {
    await attributeRejectedKey(payload.api_key);
    return { status: 401, body: { ok: false, code: "UNAUTHORIZED" } };
  }
  // The opaque API key is the sole credential and account-routing authority. Older EA builds
  // may retain a stale optional connection_id after a user recreates or rotates a connection;
  // rejecting an otherwise valid key would prevent the first live heartbeat without improving
  // authorization, because the key already resolves the exact server-owned connection.
  await touchMt5Connection(connection.id);
  const supportedPayloadVersion = (MT5_SUPPORTED_PAYLOAD_VERSIONS as readonly string[]).includes(payload.payload_version);
  if (!supportedPayloadVersion && payload.event !== "compat" && payload.event !== "ping") {
    const diagnostic = `This EA sends payload version ${payload.payload_version}, which this server cannot interpret (supported: ${MT5_SUPPORTED_PAYLOAD_VERSIONS.join(", ")}). Download the current EA from MT5 Live and replace the copy on the chart.`;
    const operation = operationFor(payload);
    if (operation) {
      try { await recordMt5EventFailure(connection.id, operation, "UNSUPPORTED_VERSION", diagnostic); }
      catch (recordError) { console.error("[MT5] unsupported-version diagnostic persistence failed", recordError instanceof Error ? recordError.message : "unknown error"); }
    }
    mt5Log(connection, operationFor(payload) ?? payload.event, startedAt, "failed", { code: "UNSUPPORTED_VERSION", eaVersion: payload.ea_version, payloadVersion: payload.payload_version });
    return { status: 400, body: { ok: false, code: "UNSUPPORTED_VERSION", supportedPayloadVersion: MT5_PAYLOAD_VERSION, minimumEaVersion: MT5_EA_MIN_VERSION, diagnostic } };
  }
  const reconciliation = payload.event === "compat" || payload.event === "ping" ? await reconciliationFields(connection.accountId) : {};
  if (payload.event === "compat") return { status: 200, body: { ok: true, event: "compat", ...connectionBody(connection), ...versionBody(payload), ...reconciliation } };
  const connectionOffset = (connection as typeof connection & { brokerUtcOffsetMinutes?: number }).brokerUtcOffsetMinutes ?? 180;
  const normalize = (value: z.infer<typeof timestamp>, offset = connectionOffset) => normalizeMt5TimestampToUtcPlus5(value, offset);
  if (payload.event === "ping") return { status: 200, body: { ok: true, event: "ping", ...connectionBody(connection), ...versionBody(payload), ...reconciliation } };
  if (payload.event === "summary") {
    try {
      const hasRiskSpec = Boolean(payload.risk_symbol && payload.risk_tick_size && payload.risk_tick_value_loss && payload.risk_contract_size && payload.risk_volume_min && payload.risk_volume_max && payload.risk_volume_step && payload.risk_volume_max >= payload.risk_volume_min);
      await updateMt5AccountSummary(connection.id, { mt5Login: payload.mt5_login, brokerServer: payload.broker_server, currency: payload.currency, balance: payload.balance, equity: payload.equity, margin: payload.margin, freeMargin: payload.free_margin, floatingPnl: payload.floating_pnl, ...(hasRiskSpec ? { riskSymbol: payload.risk_symbol!, riskTickSize: payload.risk_tick_size!, riskTickValueLoss: payload.risk_tick_value_loss!, riskContractSize: payload.risk_contract_size!, riskVolumeMin: payload.risk_volume_min!, riskVolumeMax: payload.risk_volume_max!, riskVolumeStep: payload.risk_volume_step! } : {}) });
      mt5Log(connection, "summary", startedAt, "success");
      return { status: 200, body: { ok: true, event: "summary", ...connectionBody(connection), ...versionBody(payload) } };
    } catch (error) {
      const code = classifySyncFailure(error); const diagnostic = await persistFailureDiagnostic(connection, payload, code, error, startedAt);
      if (code === "INVALID_SYNC_DATA" || code === "SYNC_PERMISSION_DENIED") return { status: 422, body: { ok: false, code, diagnostic } };
      throw error;
    }
  }
  try {
    if (payload.event === "history_batch") {
      await recordMt5HistoryAttempt(connection.id, payload.positions.length);
      const offset = payload.broker_utc_offset_minutes ?? connectionOffset;
      const records = partitionMt5Records(payload.positions, record => {
        const position = closedPosition.parse(record);
        return {
          ticket: position.ticket, symbol: position.symbol, direction: position.direction, lots: position.lots,
          openPrice: position.open_price, closePrice: position.close_price,
          slPrice: position.sl_price > 0 ? position.sl_price : null, tpPrice: position.tp_price > 0 ? position.tp_price : null,
          riskUsd: position.risk_usd, rewardUsd: position.reward_usd, rrRatio: position.rr_ratio,
          realizedPnl: position.realized_pnl, result: position.result as "WIN" | "LOSS" | "BREAK_EVEN",
          closeTime: normalize(position.close_time, offset), openTime: normalize(position.open_time ?? position.close_time, offset),
        };
      });
      if (!records.accepted.length && records.rejected.length) {
        const diagnostic = "Every historical record in this batch was rejected as malformed; nothing was imported. Re-download the current EA from MT5 Live.";
        await persistFailureDiagnostic(connection, payload, "INVALID_SYNC_DATA", new Error(diagnostic), startedAt, diagnostic);
        return { status: 422, body: { ok: false, code: "SYNC_PARTIAL", diagnostic, rejected: records.rejected.length, failed: records.rejected.slice(0, MT5_FAILED_RECORD_REPORT_LIMIT) } };
      }
      const stored = await upsertMt5ClosedPositionBatch(connection.userId, connection.accountId, records.accepted);
      await recordMt5HistoryAccepted(connection.id, records.accepted.length, payload.complete);
      if (payload.complete) await completeMt5HistorySync(connection.id, connection.accountId);
      if (records.rejected.length) {
        try { await recordMt5HistoryRejections(connection.id, records.rejected); }
        catch (rejectionError) { console.error("[MT5] failed to record rejected history records", rejectionError instanceof Error ? rejectionError.message : "unknown error"); }
      }
      mt5Log(connection, "history_batch", startedAt, "success", { batchSize: payload.positions.length, acceptedCount: records.accepted.length, rejectedCount: records.rejected.length, stored, complete: payload.complete });
      return { status: 200, body: { ok: true, event: "history_batch", synced: records.accepted.length, accepted: records.accepted.length, rejected: records.rejected.length, stored, failed: records.rejected.slice(0, MT5_FAILED_RECORD_REPORT_LIMIT), complete: payload.complete, ...connectionBody(connection), ...versionBody(payload) } };
    }
    if (payload.event === "open_batch") {
      if (payload.positions.length > MT5_MAX_OPEN_BATCH) {
        const diagnostic = `The EA sent ${payload.positions.length} open positions in one request; the server accepts at most ${MT5_MAX_OPEN_BATCH} per batch. Download the current EA from MT5 Live: it splits large accounts into independently retryable batches.`;
        await persistFailureDiagnostic(connection, payload, "BATCH_TOO_LARGE", new Error(diagnostic), startedAt, diagnostic);
        return { status: 400, body: { ok: false, code: "BATCH_TOO_LARGE", maxPositionsPerBatch: MT5_MAX_OPEN_BATCH, diagnostic } };
      }
      const records = partitionMt5Records(payload.positions, record => {
        const position = openPosition.parse(record);
        return {
          ticket: position.ticket, symbol: position.symbol, direction: position.direction, lots: position.lots,
          openPrice: position.open_price, slPrice: position.sl_price > 0 ? position.sl_price : null, tpPrice: position.tp_price > 0 ? position.tp_price : null,
          riskUsd: position.risk_usd, rewardUsd: position.reward_usd, rrRatio: position.rr_ratio,
          floatingPnl: position.floating_pnl, openTime: normalize(position.open_time, payload.broker_utc_offset_minutes),
        };
      });
      if (!records.accepted.length && records.rejected.length) {
        const diagnostic = "Every open position in this snapshot was rejected as malformed; no live position could be stored.";
        await persistFailureDiagnostic(connection, payload, "INVALID_SYNC_DATA", new Error(diagnostic), startedAt, diagnostic);
        return { status: 422, body: { ok: false, code: "SYNC_PARTIAL", diagnostic, rejected: records.rejected.length, failed: records.rejected.slice(0, MT5_FAILED_RECORD_REPORT_LIMIT) } };
      }
      const synchronized = await upsertMt5OpenPositionBatch(connection.userId, connection.accountId, records.accepted);
      await recordMt5EventSuccess(connection.id, "open_batch");
      mt5Log(connection, "open_batch", startedAt, "success", { positionCount: payload.positions.length, acceptedCount: records.accepted.length, rejectedCount: records.rejected.length, synchronized });
      return { status: 200, body: { ok: true, event: "open_batch", synced: synchronized, accepted: records.accepted.length, rejected: records.rejected.length, failed: records.rejected.slice(0, MT5_FAILED_RECORD_REPORT_LIMIT), ...connectionBody(connection), ...versionBody(payload) } };
    }
    const shared = { ticket: payload.ticket, symbol: payload.symbol, direction: payload.direction, lots: payload.lots, openPrice: payload.open_price, slPrice: payload.sl_price > 0 ? payload.sl_price : null, tpPrice: payload.tp_price > 0 ? payload.tp_price : null, riskUsd: payload.risk_usd, rewardUsd: payload.reward_usd, rrRatio: payload.rr_ratio };
    const eventOffset = (payload as { broker_utc_offset_minutes?: number }).broker_utc_offset_minutes ?? connectionOffset;
    if (payload.event === "open") {
      const openPayload = payload as typeof payload & { event: "open"; floating_pnl: number; open_time: z.infer<typeof timestamp> };
      await upsertMt5OpenPosition(connection.userId, connection.accountId, { ...shared, floatingPnl: openPayload.floating_pnl, openTime: normalize(openPayload.open_time, eventOffset) });
      await recordMt5EventSuccess(connection.id, "open_batch");
      mt5Log(connection, "open_batch", startedAt, "success", { positionCount: 1 });
      return { status: 200, body: { ok: true, event: "open", ...connectionBody(connection), ...versionBody(payload) } };
    }
    await upsertMt5ClosedPosition(connection.userId, connection.accountId, { ...shared, closePrice: payload.close_price, realizedPnl: payload.realized_pnl, result: payload.result, closeTime: normalize(payload.close_time, eventOffset), openTime: normalize(payload.open_time ?? payload.close_time, eventOffset) });
    mt5Log(connection, "history_batch", startedAt, "success", { batchSize: 1, acceptedCount: 1 });
    return { status: 200, body: { ok: true, event: "close", ...connectionBody(connection), ...versionBody(payload) } };
  } catch (error) {
    const code = classifySyncFailure(error);
    if (payload.event === "history_batch") {
      try { await recordMt5HistoryFailure(connection.id, `${code}: ${syncFailureDiagnostic(error)}`); }
      catch (statusError) { console.error("[MT5] failed to record history failure status", statusError instanceof Error ? statusError.message : "unknown error"); }
    }
    const diagnostic = await persistFailureDiagnostic(connection, payload, code, error, startedAt);
    if (code === "INVALID_SYNC_DATA" || code === "SYNC_PERMISSION_DENIED" || code === "INVALID_MT5_TIMESTAMP" || code === "FUTURE_TRADE") return { status: 422, body: { ok: false, code, diagnostic } };
    throw error;
  }
}

export function registerMt5Ingest(app: Express, paths: string[] = ["/api/mt5"]) {
  for (const path of paths) app.post(path, async (req: Request, res: Response) => {
    const outcome = await mt5PayloadOutcome(req.body);
    res.status(outcome.status).json(outcome.body);
  });
}

/**
 * Single-source outcome builder shared by the Express dev server and the
 * Cloudflare Worker entry: runs validation + processing and maps every error
 * (Zod payload errors, timestamp/data rejections, Supabase failures) to the
 * same HTTP response contract the EA has always received.
 */
export async function mt5PayloadOutcome(body: unknown): Promise<Mt5HttpOutcome> {
  try {
    const outcome = await processMt5Payload(body);
    return { status: outcome.status, body: outcome.body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues.slice(0, 4).map(issue => `${issue.path.join(".") || "payload"}: ${issue.message}`);
      const apiKey = typeof (body as { api_key?: unknown } | null)?.api_key === "string" ? (body as { api_key: string }).api_key : "";
      if ((body as { event?: string } | null)?.event === "history_batch" && apiKey) {
        try { const connection = await getActiveMt5Connection(apiKey); if (connection) await recordMt5HistoryFailure(connection.id, `Invalid history payload — ${details.join("; ")}`); } catch { /* preserve the validation response */ }
      }
      return { status: 400, body: { ok: false, code: "INVALID_PAYLOAD", details } };
    }
    const code = classifySyncFailure(error);
    console.error("[MT5] ingest failed", code, syncFailureDiagnostic(error), error instanceof Error ? error.message : "unknown error");
    const status = code === "INVALID_SYNC_DATA" || code === "SYNC_PERMISSION_DENIED" || code === "INVALID_MT5_TIMESTAMP" || code === "FUTURE_TRADE" ? 422 : 503;
    return { status, body: { ok: false, code, diagnostic: syncFailureDiagnostic(error) } };
  }
}

/**
 * Raw-text ingestion used by the Cloudflare Worker: mirrors the Express
 * raw-body adapter (MQL5 StringToCharArray appends a NUL byte) plus the JSON
 * parser error contract, without requiring Node Buffer or Express.
 */
export function parseMt5JsonBodyText(rawText: string): unknown {
  const normalized = rawText.replace(/\u0000+$/g, "").trim();
  if (!normalized) return {};
  return JSON.parse(normalized);
}

export async function ingestMt5Text(rawText: string): Promise<Mt5HttpOutcome> {
  let payload: unknown;
  try {
    payload = parseMt5JsonBodyText(rawText);
  } catch {
    const apiKey = rawText.match(/"api_key"\s*:\s*"([^"\\]{24,96})"/)?.[1];
    if (apiKey) {
      try {
        const connection = await getActiveMt5Connection(apiKey);
        if (connection) await recordMt5HistoryFailure(connection.id, "Malformed JSON request body.");
      } catch {
        /* return the parser response */
      }
    }
    return { status: 400, body: { ok: false, code: "INVALID_JSON", details: ["Malformed JSON request body."] } };
  }
  return mt5PayloadOutcome(payload);
}

export function registerMt5Compatibility(app: Express, path = "/api/mt5/compat") {
  app.get(path, (_req, res) => res.status(200).json({ ok: true, service: "gold-journal-mt5", minimumEaVersion: MT5_EA_MIN_VERSION, supportedPayloadVersion: MT5_PAYLOAD_VERSION }));
}
