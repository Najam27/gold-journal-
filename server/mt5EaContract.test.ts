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
});
