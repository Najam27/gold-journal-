import { describe, expect, it } from "vitest";
import { buildRunningBalances, paginateRows } from "./tradeLedger";

describe("Trade Log ledger helpers", () => {
  it("builds a chronological running balance without depending on display order", () => {
    const ledger = buildRunningBalances([{ id: 2, tradeDate: 2_000, pnl: -5 }, { id: 1, tradeDate: 1_000, pnl: 12 }], 100);
    expect(ledger.map(row => [row.id, row.runningBalance])).toEqual([[1, 112], [2, 107]]);
  });

  it("clamps pages and returns an empty-safe final page", () => {
    expect(paginateRows([1, 2, 3], 5, 2)).toEqual({ rows: [3], currentPage: 2, pageCount: 2 });
  });
});
