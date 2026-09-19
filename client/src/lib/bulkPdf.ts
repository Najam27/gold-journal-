import { getPktDateInput, toNumber } from "./gold";

export type PdfTrade = { id: number; accountId?: number; tradeDate: number | Date; pnl: number | string | null; result: string; session?: string };

export type BulkPdfSummary = { total: number; pnl: number; wins: number; losses: number; breakEven: number; open: number; winRate: number };

export function selectBulkPdfTrades(trades: PdfTrade[], accountId: number, from?: string, to?: string) {
  return trades.filter(trade => (trade.accountId == null || trade.accountId === accountId) && (!from || getPktDateInput(trade.tradeDate) >= from) && (!to || getPktDateInput(trade.tradeDate) <= to)).sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());
}

/**
 * The report's only summary calculation, used for both the summary page and the
 * review prompts so no second, inconsistent set of numbers can exist. Closed
 * trades are split into wins, losses, and break-even; open positions are counted
 * separately and never inflate the win rate.
 */
export function summarizeBulkPdfTrades(trades: PdfTrade[]): BulkPdfSummary {
  const pnl = trades.reduce((sum, trade) => sum + toNumber(trade.pnl), 0);
  const count = (result: string) => trades.filter(trade => String(trade.result || "").toUpperCase() === result).length;
  const wins = count("WIN");
  const losses = count("LOSS");
  const breakEven = count("BREAK_EVEN");
  const open = count("OPEN");
  return { total: trades.length, pnl, wins, losses, breakEven, open, winRate: trades.length ? wins / trades.length * 100 : 0 };
}

/**
 * Reads EVERY page of the paginated trade list for one report.
 *
 * The export must never come back quietly short, so this:
 *   • follows the server's page count and refuses to stop before the count the
 *     first page reported (a shrinking count cannot end the loop early);
 *   • de-duplicates by trade id, so a row moving between pages while the export
 *     runs is not exported twice;
 *   • throws when fewer unique rows arrive than the server said exist, instead
 *     of producing an incomplete report.
 */
export async function fetchAllTradePages<T>(fetchPage: (page: number) => Promise<{ trades: T[]; pageCount: number; total?: number }>) {
  const rows: T[] = [];
  const seen = new Set<string>();
  const maxPages = 1000;
  let page = 1;
  let pageCount = 1;
  let expectedTotal: number | null = null;
  while (page <= pageCount) {
    if (page > maxPages) throw new Error("The export is too large to build safely in this browser.");
    const result = await fetchPage(page);
    if (!Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > maxPages) throw new Error("The trade list returned invalid pagination metadata.");
    if (expectedTotal == null && Number.isFinite(Number(result.total))) expectedTotal = Number(result.total);
    if (result.pageCount > pageCount) pageCount = result.pageCount;
    for (const row of result.trades ?? []) {
      const id = (row as { id?: unknown } | null)?.id;
      if (id == null) { rows.push(row); continue; }
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
    page += 1;
  }
  if (expectedTotal != null && rows.length < expectedTotal) throw new Error("The trade list ended before every trade was retrieved. Please retry the export.");
  return rows;
}
