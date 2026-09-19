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

  it("never includes another account's trade, whatever the date range", () => {
    const selected = selectBulkPdfTrades(trades, 3);
    expect(selected.every(trade => trade.accountId === 3)).toBe(true);
    expect(selectBulkPdfTrades(trades, 3, "2026-08-01", "2026-08-31").map(trade => trade.id)).toEqual([1, 2]);
  });

  it("summarizes the selected period independently of excluded account rows", () => {
    expect(summarizeBulkPdfTrades(selectBulkPdfTrades(trades, 3))).toMatchObject({ total: 2, pnl: 10, wins: 1, losses: 1, breakEven: 0, open: 0, winRate: 50 });
  });

  it("counts break-even and open trades separately from wins and losses", () => {
    const summary = summarizeBulkPdfTrades([
      { id: 1, accountId: 3, tradeDate: new Date("2026-08-01T12:00:00Z"), pnl: "15", result: "WIN" },
      { id: 2, accountId: 3, tradeDate: new Date("2026-08-02T12:00:00Z"), pnl: "0", result: "BREAK_EVEN" },
      { id: 3, accountId: 3, tradeDate: new Date("2026-08-03T12:00:00Z"), pnl: "40", result: "OPEN" },
    ]);
    expect(summary).toMatchObject({ total: 3, pnl: 55, wins: 1, losses: 0, breakEven: 1, open: 1 });
  });

  it("keeps safe browser rows selected by the server’s active-account scope and filters dates in PKT", () => {
    expect(selectBulkPdfTrades([{ id: 4, tradeDate: new Date("2026-08-31T20:30:00Z"), pnl: "5", result: "WIN" }], 3, "2026-09-01", "2026-09-01")).toHaveLength(1);
  });

  it("loads every paginated page only when a report is explicitly requested", async () => {
    const fetchPage = vi.fn(async (page: number) => ({ trades: [`trade-${page}`], pageCount: 3 }));
    await expect(fetchAllTradePages(fetchPage)).resolves.toEqual(["trade-1", "trade-2", "trade-3"]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("exports every trade exactly once when a row shifts between pages mid-export", async () => {
    const pages: Record<number, { trades: { id: number }[]; pageCount: number; total: number }> = {
      1: { trades: [{ id: 1 }, { id: 2 }], pageCount: 2, total: 3 },
      2: { trades: [{ id: 2 }, { id: 3 }], pageCount: 2, total: 3 },
    };
    const rows = await fetchAllTradePages(async page => pages[page]);
    expect(rows.map(row => row.id)).toEqual([1, 2, 3]);
  });

  it("refuses to return a short list instead of silently stopping early", async () => {
    await expect(fetchAllTradePages(async () => ({ trades: [{ id: 1 }], pageCount: 1, total: 25 }))).rejects.toThrow(/before every trade was retrieved/i);
    // A page count that shrinks mid-export cannot end the loop early either.
    const rows = await fetchAllTradePages(async page => (page === 1 ? { trades: [{ id: 1 }], pageCount: 2, total: 2 } : { trades: [{ id: 2 }], pageCount: 1, total: 2 }));
    expect(rows.map(row => row.id)).toEqual([1, 2]);
    await expect(fetchAllTradePages(async () => ({ trades: [], pageCount: 0 }))).rejects.toThrow(/invalid pagination metadata/i);
  });
});
