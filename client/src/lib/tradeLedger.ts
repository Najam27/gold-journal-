export type LedgerTrade = { id: number; tradeDate: number | Date; pnl: number | string | null };
import { toNumber } from "./gold";

export function buildRunningBalances<T extends LedgerTrade>(trades: T[], openingBalance: number) {
  let balance = openingBalance;
  return [...trades].sort((a, b) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime()).map(trade => {
    balance += toNumber(trade.pnl);
    return { ...trade, runningBalance: balance };
  });
}

export function paginateRows<T>(rows: T[], page: number, pageSize: number) {
  const safeSize = Math.max(1, pageSize);
  const pageCount = Math.max(1, Math.ceil(rows.length / safeSize));
  const currentPage = Math.min(Math.max(1, page), pageCount);
  return { rows: rows.slice((currentPage - 1) * safeSize, currentPage * safeSize), currentPage, pageCount };
}
