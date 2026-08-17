import { getPktDateInput } from "./gold";

export type PdfTrade = { id: number; accountId?: number; tradeDate: number | Date; pnl: number | string | null; result: string; session?: string };

export function selectBulkPdfTrades(trades: PdfTrade[], accountId: number, from?: string, to?: string) {
  return trades.filter(trade => (trade.accountId == null || trade.accountId === accountId) && (!from || getPktDateInput(trade.tradeDate) >= from) && (!to || getPktDateInput(trade.tradeDate) <= to)).sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime());
}

export function summarizeBulkPdfTrades(trades: PdfTrade[]) {
  const pnl = trades.reduce((sum, trade) => sum + Number(trade.pnl || 0), 0);
  const wins = trades.filter(trade => trade.result === "WIN").length;
  return { total: trades.length, pnl, wins, losses: trades.filter(trade => trade.result === "LOSS").length, winRate: trades.length ? wins / trades.length * 100 : 0 };
}

export async function fetchAllTradePages<T>(fetchPage: (page: number) => Promise<{ trades: T[]; pageCount: number }>) {
  const rows: T[] = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const result = await fetchPage(page);
    rows.push(...result.trades);
    pageCount = result.pageCount;
    page += 1;
  }
  return rows;
}
