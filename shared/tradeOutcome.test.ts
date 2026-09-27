import { describe, expect, it } from "vitest";
import { deriveTradeResult, outcomeLabel, PNL_RESULT_EPSILON } from "./tradeOutcome";

describe("trade outcome derivation", () => {
  it("derives WIN and LOSS from the sign of realized P&L", () => {
    expect(deriveTradeResult(120, "WIN")).toBe("WIN");
    expect(deriveTradeResult(-120, "LOSS")).toBe("LOSS");
    expect(deriveTradeResult("45.2", "WIN")).toBe("WIN");
  });

  it("corrects a requested result that contradicts the P&L", () => {
    expect(deriveTradeResult(-120, "WIN")).toBe("LOSS");
    expect(deriveTradeResult(120, "LOSS")).toBe("WIN");
    expect(deriveTradeResult(0, "WIN")).toBe("BREAK_EVEN");
    expect(deriveTradeResult(0, "LOSS")).toBe("BREAK_EVEN");
  });

  it("treats dust around zero as break-even, mirroring the MT5 EA", () => {
    expect(deriveTradeResult(PNL_RESULT_EPSILON - 0.0001, "WIN")).toBe("BREAK_EVEN");
    expect(deriveTradeResult(-(PNL_RESULT_EPSILON - 0.0001), "LOSS")).toBe("BREAK_EVEN");
    expect(deriveTradeResult(PNL_RESULT_EPSILON * 2, "BREAK_EVEN")).toBe("WIN");
  });

  it("always preserves OPEN positions regardless of unrealized P&L", () => {
    expect(deriveTradeResult(500, "OPEN")).toBe("OPEN");
    expect(deriveTradeResult(-500, "OPEN")).toBe("OPEN");
    expect(deriveTradeResult(0, "OPEN")).toBe("OPEN");
  });

  it("treats missing or invalid P&L as zero", () => {
    expect(deriveTradeResult(null, "WIN")).toBe("BREAK_EVEN");
    expect(deriveTradeResult(undefined, "LOSS")).toBe("BREAK_EVEN");
    expect(deriveTradeResult("not-a-number", "WIN")).toBe("BREAK_EVEN");
  });

  it("labels outcomes for human-facing copy", () => {
    expect(outcomeLabel("WIN")).toBe("Win");
    expect(outcomeLabel("LOSS")).toBe("Loss");
    expect(outcomeLabel("BREAK_EVEN")).toBe("Break-even");
    expect(outcomeLabel("OPEN")).toBe("Open");
  });
});
