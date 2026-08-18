import { describe, expect, it } from "vitest";
import { resolveDerivedCashNet, resolveDerivedTradeSummary } from "./goldDb";

describe("journal derived aggregate degradation", () => {
  it("keeps core journal composition alive with a safe cash fallback", () => {
    expect(resolveDerivedCashNet({ status: "rejected", reason: new Error("cash RPC down") })).toEqual({ value: 0, source: "fallback" });
    expect(resolveDerivedCashNet({ status: "fulfilled", value: 125.5 })).toEqual({ value: 125.5, source: "rpc" });
  });

  it("marks trade-summary failure without inventing a successful RPC result", () => {
    expect(resolveDerivedTradeSummary({ status: "rejected", reason: new Error("pnl RPC down") })).toEqual({ total: 0, closed: 0, wins: 0, losses: 0, pnl: 0, source: "fallback" });
    expect(resolveDerivedTradeSummary({ status: "fulfilled", value: { total: 3, closed: 3, wins: 2, losses: 1, pnl: 40, source: "rpc" } })).toMatchObject({ total: 3, pnl: 40, source: "rpc" });
  });
});
