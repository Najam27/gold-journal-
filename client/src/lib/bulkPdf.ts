import { getPktDateInput, toNumber } from "./gold";

export type PdfTrade = { id: number; accountId?: number; tradeDate: number | Date; pnl: number | string | null; result: string; session?: string };

export function selectBulkPdfTrades(trades: PdfTrade[], accountId: number, from?: string, to?: string) {
  return trades.filter(trade => (trade.accountId == null || trade.accountId === accountId) && (!from || getPktDateInput(trade.tradeDate) >= from) && (!to || getPktDateInput(trade.tradeDate) <= to)).sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());
}

export function summarizeBulkPdfTrades(trades: PdfTrade[]) {
  const pnl = trades.reduce((sum, trade) => sum + toNumber(trade.pnl), 0);
  const wins = trades.filter(trade => trade.result === "WIN").length;
  return { total: trades.length, pnl, wins, losses: trades.filter(trade => trade.result === "LOSS").length, winRate: trades.length ? wins / trades.length * 100 : 0 };
}

export async function fetchAllTradePages<T>(fetchPage: (page: number) => Promise<{ trades: T[]; pageCount: number }>) {
  const rows: T[] = [];
  const maxPages = 1000;
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    if (page > maxPages) throw new Error("The export is too large to build safely in this browser.");
    const result = await fetchPage(page);
    if (!Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > maxPages) throw new Error("The trade list returned invalid pagination metadata.");
    rows.push(...result.trades);
    pageCount = result.pageCount;
    page += 1;
  }
  return rows;
}
