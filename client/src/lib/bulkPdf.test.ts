import { describe, expect, it, vi } from "vitest";
import { fetchAllTradePages, selectBulkPdfTrades, summarizeBulkPdfTrades } from "./bulkPdf";

describe("bulk PDF report selection", () => {
  const trades = [
    { id: 1, accountId: 3, tradeDate: new Date("2026-08-01T12:00:00Z"), pnl: "15", result: "WIN" },
    { id: 2, accountId: 3, tradeDate: new Date("2026-08-10T12:00:00Z"), pnl: "-5", result: "LOSS" },
    { id: 3, accountId: 9, tradeDate: new Date("2026-08-10T12:00:00Z"), pnl: "200", result: "WIN" },
  ];

  it("keeps the active account isolated while selecting an inclusive date range", () => {
    expect(selectBulkPdfTrades(trades, 3, "2026-08-02", "2026-08-10").map(trade => trade.id)).toEqual([2]);
  });

  it("summarizes the selected period independently of excluded account rows", () => {
    expect(summarizeBulkPdfTrades(selectBulkPdfTrades(trades, 3))).toMatchObject({ total: 2, pnl: 10, wins: 1, losses: 1, winRate: 50 });
  });

  it("keeps safe browser rows selected by the server’s active-account scope and filters dates in PKT", () => {
    expect(selectBulkPdfTrades([{ id: 4, tradeDate: new Date("2026-08-31T20:30:00Z"), pnl: "5", result: "WIN" }], 3, "2026-09-01", "2026-09-01")).toHaveLength(1);
  });

  it("loads every paginated page only when a report is explicitly requested", async () => {
    const fetchPage = vi.fn(async (page: number) => ({ trades: [`trade-${page}`], pageCount: 3 }));
    await expect(fetchAllTradePages(fetchPage)).resolves.toEqual(["trade-1", "trade-2", "trade-3"]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });
});
