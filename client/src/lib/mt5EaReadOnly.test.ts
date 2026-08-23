import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA read-only contract", () => {
  it("contains no imports, includes, trade execution, order management, or position management capability", () => {
    const forbidden = [
      "#include", "#import", "CTrade", "OrderSend", "OrderSendAsync", "PositionClose",
      "PositionModify", "OrderModify", "OrderDelete", "trade.Buy", "trade.Sell",
      "TRADE_ACTION_DEAL", "TRADE_ACTION_PENDING", "TRADE_ACTION_SLTP", "TRADE_ACTION_REMOVE",
    ];
    forbidden.forEach(token => expect(source).not.toContain(token));
  });

  it("uses the trade-transaction event only as a passive close-notification listener", () => {
    expect(source).toContain("void OnTradeTransaction(const MqlTradeTransaction &transaction, const MqlTradeRequest &request, const MqlTradeResult &result)");
    expect(source).toContain("if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT) SendHistory(false);");
    expect(source).not.toMatch(/\b(request|result)\s*\./);
  });

  it("makes its read-only purpose and non-trading permission posture explicit without exposing the API key", () => {
    expect(source).toContain("[MT5 LIVE] READ-ONLY MODE; this EA never opens, closes, modifies, or cancels MT5 orders and positions. Auto Trading is not required for Gold Journal synchronization.");
    expect(source).toContain("WebRequest(\"POST\", Endpoint");
    expect(source).not.toMatch(/Print(?:Format)?\([^\n]*ApiKey/);
  });
});
