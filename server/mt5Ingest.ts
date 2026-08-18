import type { Express, Request, Response } from "express";
import { z } from "zod";
import { completeMt5HistorySync, getActiveMt5Connection, recordMt5HistoryAccepted, recordMt5HistoryAttempt, recordMt5HistoryFailure, touchMt5Connection, updateMt5AccountSummary, upsertMt5ClosedPosition, upsertMt5OpenPosition } from "./mt5Db";
import { mt5ApiKeyFingerprint } from "./mt5Security";
import { consumeRateLimit, rateLimitTestHooks } from "./rateLimit";
import { Mt5TimestampError, normalizeMt5TimestampToUtcPlus5 } from "./mt5Timestamp";

export const MT5_EA_MIN_VERSION = "2.0.0";
export const MT5_PAYLOAD_VERSION = "2";

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

export const mt5Payload = z.discriminatedUnion("event", [
  z.object({ event: z.literal("ping"), api_key: z.string().trim().min(24).max(96) }).merge(versionSchema),
  z.object({ event: z.literal("compat"), api_key: z.string().trim().min(24).max(96), ea_version: z.string().trim().min(1).max(32), payload_version: z.string().trim().min(1).max(16), connection_id: z.string().trim().max(128).optional() }),
  z.object({ event: z.literal("summary"), api_key: z.string().trim().min(24).max(96), mt5_login: ticket, broker_server: z.string().trim().min(1).max(160), currency: z.string().trim().min(1).max(16), balance: numeric, equity: numeric, margin: numeric.min(0), free_margin: numeric, floating_pnl: numeric }).merge(versionSchema),
  base.extend({ event: z.literal("open") }).merge(openFields),
  base.extend({ event: z.literal("open_batch"), positions: z.array(openPosition).max(200), broker_utc_offset_minutes: z.number().int().min(-720).max(840) }),
  base.merge(closedFields).extend({ event: z.literal("close") }),
  z.object({ event: z.literal("history_batch"), api_key: z.string().trim().min(24).max(96), positions: z.array(closedPosition).max(50), complete: z.boolean().default(false), broker_utc_offset_minutes: z.number().int().min(-720).max(840).optional() }).merge(versionSchema),
]);

export const mt5RateLimitTestHooks = { reset: rateLimitTestHooks.reset, size: () => rateLimitTestHooks.size("mt5-ingest") };

function versionBody(payload: z.infer<typeof mt5Payload>) { return { eaVersion: payload.ea_version, payloadVersion: payload.payload_version, minimumEaVersion: MT5_EA_MIN_VERSION, supportedPayloadVersion: MT5_PAYLOAD_VERSION, compatible: payload.ea_version !== "legacy" && payload.payload_version === MT5_PAYLOAD_VERSION }; }

export async function processMt5Payload(body: unknown) {
  const payload = mt5Payload.parse(body);
  if (!(await consumeRateLimit("mt5-ingest", mt5ApiKeyFingerprint(payload.api_key), 5, 1_000))) return { status: 429, body: { ok: false, code: "RATE_LIMITED" } };
  const connection = await getActiveMt5Connection(payload.api_key);
  if (!connection) return { status: 401, body: { ok: false, code: "UNAUTHORIZED" } };
  if (payload.connection_id && payload.connection_id !== String(connection.id)) return { status: 401, body: { ok: false, code: "CONNECTION_MISMATCH" } };
  await touchMt5Connection(connection.id);
  if (payload.event === "compat") return { status: 200, body: { ok: true, event: "compat", ...versionBody(payload) } };
  const connectionOffset = (connection as typeof connection & { brokerUtcOffsetMinutes?: number }).brokerUtcOffsetMinutes ?? 180;
  const normalize = (value: z.infer<typeof timestamp>, offset = connectionOffset) => normalizeMt5TimestampToUtcPlus5(value, offset);
  if (payload.event === "ping") return { status: 200, body: { ok: true, event: "ping", ...versionBody(payload) } };
  if (payload.event === "summary") {
    await updateMt5AccountSummary(connection.id, { mt5Login: payload.mt5_login, brokerServer: payload.broker_server, currency: payload.currency, balance: payload.balance, equity: payload.equity, margin: payload.margin, freeMargin: payload.free_margin, floatingPnl: payload.floating_pnl });
    return { status: 200, body: { ok: true, event: "summary", ...versionBody(payload) } };
  }
  try {
    if (payload.event === "history_batch") {
      await recordMt5HistoryAttempt(connection.id, payload.positions.length);
      const offset = payload.broker_utc_offset_minutes ?? connectionOffset;
      await Promise.all(payload.positions.map(position => upsertMt5ClosedPosition(connection.userId, connection.accountId, { ticket: position.ticket, symbol: position.symbol, direction: position.direction, lots: position.lots, openPrice: position.open_price, closePrice: position.close_price, slPrice: position.sl_price > 0 ? position.sl_price : null, tpPrice: position.tp_price > 0 ? position.tp_price : null, riskUsd: position.risk_usd, rewardUsd: position.reward_usd, rrRatio: position.rr_ratio, realizedPnl: position.realized_pnl, result: position.result, closeTime: normalize(position.close_time, offset), openTime: normalize(position.open_time ?? position.close_time, offset) })));
      await recordMt5HistoryAccepted(connection.id, payload.positions.length, payload.complete);
      if (payload.complete) await completeMt5HistorySync(connection.id, connection.accountId);
      return { status: 200, body: { ok: true, event: "history_batch", synced: payload.positions.length, complete: payload.complete, ...versionBody(payload) } };
    }
    if (payload.event === "open_batch") {
      await Promise.all(payload.positions.map(position => upsertMt5OpenPosition(connection.userId, connection.accountId, { ticket: position.ticket, symbol: position.symbol, direction: position.direction, lots: position.lots, openPrice: position.open_price, slPrice: position.sl_price > 0 ? position.sl_price : null, tpPrice: position.tp_price > 0 ? position.tp_price : null, riskUsd: position.risk_usd, rewardUsd: position.reward_usd, rrRatio: position.rr_ratio, floatingPnl: position.floating_pnl, openTime: normalize(position.open_time, payload.broker_utc_offset_minutes) })));
      return { status: 200, body: { ok: true, event: "open_batch", synced: payload.positions.length, ...versionBody(payload) } };
    }
    const shared = { ticket: payload.ticket, symbol: payload.symbol, direction: payload.direction, lots: payload.lots, openPrice: payload.open_price, slPrice: payload.sl_price > 0 ? payload.sl_price : null, tpPrice: payload.tp_price > 0 ? payload.tp_price : null, riskUsd: payload.risk_usd, rewardUsd: payload.reward_usd, rrRatio: payload.rr_ratio };
    if (payload.event === "open") {
      const openPayload = payload as typeof payload & { event: "open"; floating_pnl: number; open_time: z.infer<typeof timestamp> };
      await upsertMt5OpenPosition(connection.userId, connection.accountId, { ...shared, floatingPnl: openPayload.floating_pnl, openTime: normalize(openPayload.open_time) });
      return { status: 200, body: { ok: true, event: "open", ...versionBody(payload) } };
    }
    await upsertMt5ClosedPosition(connection.userId, connection.accountId, { ...shared, closePrice: payload.close_price, realizedPnl: payload.realized_pnl, result: payload.result, closeTime: normalize(payload.close_time), openTime: normalize(payload.open_time ?? payload.close_time) });
    return { status: 200, body: { ok: true, event: "close", ...versionBody(payload) } };
  } catch (error) {
    const code = error instanceof Mt5TimestampError ? error.code : "SYNC_UNAVAILABLE";
    if (payload.event === "history_batch") await recordMt5HistoryFailure(connection.id, code);
    if (code !== "SYNC_UNAVAILABLE") return { status: 422, body: { ok: false, code } };
    throw error;
  }
}

export function registerMt5Ingest(app: Express, paths: string[] = ["/api/mt5"]) {
  for (const path of paths) app.post(path, async (req: Request, res: Response) => {
    try {
      const outcome = await processMt5Payload(req.body);
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.issues.slice(0, 4).map(issue => `${issue.path.join(".") || "payload"}: ${issue.message}`);
        const apiKey = typeof req.body?.api_key === "string" ? req.body.api_key : "";
        if (req.body?.event === "history_batch" && apiKey) {
          try { const connection = await getActiveMt5Connection(apiKey); if (connection) await recordMt5HistoryFailure(connection.id, `Invalid history payload — ${details.join("; ")}`); } catch { /* preserve the validation response */ }
        }
        res.status(400).json({ ok: false, code: "INVALID_PAYLOAD", details });
        return;
      }
      console.error("[MT5] ingest failed", error);
      res.status(503).json({ ok: false, code: "SYNC_UNAVAILABLE" });
    }
  });
}

export function registerMt5Compatibility(app: Express, path = "/api/mt5/compat") {
  app.get(path, (_req: Request, res: Response) => res.status(200).json({ ok: true, service: "gold-journal-mt5", minimumEaVersion: MT5_EA_MIN_VERSION, supportedPayloadVersion: MT5_PAYLOAD_VERSION }));
}
