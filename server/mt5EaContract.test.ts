import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const eaSource = readFileSync(new URL("../client/public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal EA history contract", () => {
  it("reconstructs original direction from entry history rather than the closing deal", () => {
    expect(eaSource).toContain("HistorySelectByPosition(position_id)");
    expect(eaSource).toContain('direction = entry == DEAL_ENTRY_INOUT ? OppositeDirection(deal_type) : DealDirection(deal_type);');
    expect(eaSource).not.toContain('string direction = DealDirection(deal_type);');
  });

  it("preserves historical deal SL/TP and fee-inclusive realized P&L when available", () => {
    expect(eaSource).toContain("HistoryDealGetDouble(deal, DEAL_SL)");
    expect(eaSource).toContain("HistoryDealGetDouble(deal, DEAL_TP)");
    expect(eaSource).toContain("HistoryDealGetDouble(deal, DEAL_FEE)");
    expect(eaSource).toContain("OrderCalcProfit(order_type, symbol, lots, open_price, sl, risk)");
  });

  it("does not silently discard an unreconstructable position", () => {
    expect(eaSource).toContain("Gold Journal could not reconstruct history for position");
    expect(eaSource).toContain("if(item == \"\") {");
    expect(eaSource).toContain("return;\n         }");
  });

  it("aggregates by position ID, batches bounded records, and handles empty history", () => {
    expect(eaSource).toContain("CollectClosedPositionIds");
    expect(eaSource).toContain("const int HISTORY_BATCH_SIZE = 50;");
    expect(eaSource).toContain('\\"positions\\":[],\\"complete\\":true');
  });

  it("sends broker-local timestamp strings so the configured broker UTC offset can derive fixed PKT sessions", () => {
    expect(eaSource).toContain("string BrokerTimestamp(datetime value)");
    expect(eaSource).toContain("TimeToString(value, TIME_DATE | TIME_SECONDS)");
    expect(eaSource).toContain("BrokerTimestamp(open_time)");
    expect(eaSource).toContain("BrokerTimestamp(close_time)");
  });

  it("uses an explicit full-history retry interval and prints safe server diagnostics on failure", () => {
    expect(eaSource).toContain("const int FULL_HISTORY_RETRY_SECONDS = 24 * 60 * 60;");
    expect(eaSource).toContain("input int HistoryDays = 3650;");
    expect(eaSource).toContain("g_last_history_sync >= FULL_HISTORY_RETRY_SECONDS");
    expect(eaSource).toContain("const int MAX_RETRY_BACKOFF_SECONDS = 60;");
    expect(eaSource).toContain("bool IsTransientStatus(int status)");
    expect(eaSource).toContain("rejected HTTP=%d; fix the EA key, endpoint, or payload, then restart the EA");
  });
});
