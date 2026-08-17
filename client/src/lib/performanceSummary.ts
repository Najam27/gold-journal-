import { toNumber } from "@/lib/gold";
import { getPktDateInput } from "@/lib/gold";

export type PerformanceTrade = { tradeDate: Date | string | number; result: string; pnl: string | number | null; risk?: string | number | null; reward?: string | number | null };

export function monthKey(date: Date | string | number) { return getPktDateInput(date).slice(0, 7); }
export function monthKeys(trades: PerformanceTrade[]) { const current = monthKey(new Date()); return Array.from(new Set([current, ...trades.map(trade => monthKey(trade.tradeDate))])).sort((a, b) => b.localeCompare(a)); }
export function monthlyOverview(trades: PerformanceTrade[], key: string) {
  const rows = trades.filter(trade => monthKey(trade.tradeDate) === key); const wins = rows.filter(trade => trade.result === "WIN").length; const losses = rows.filter(trade => trade.result === "LOSS").length; const breakEven = rows.filter(trade => trade.result === "BREAK_EVEN").length; const open = rows.filter(trade => trade.result === "OPEN").length; const closed = wins + losses + breakEven;
  const riskRows = rows.filter(trade => toNumber(trade.risk) > 0); const avgRr = riskRows.length ? riskRows.reduce((total, trade) => total + toNumber(trade.reward) / toNumber(trade.risk), 0) / riskRows.length : 0;
  return { rows, trades: rows.length, wins, losses, breakEven, open, closed, pnl: rows.reduce((total, trade) => total + toNumber(trade.pnl), 0), winRate: closed ? wins / closed * 100 : 0, avgRr };
}
export function weeklyPnl(trades: PerformanceTrade[], start: Date, end: Date) { const startKey = getPktDateInput(start); const endKey = getPktDateInput(end); return trades.filter(trade => { const key = getPktDateInput(trade.tradeDate); return key >= startKey && key <= endKey; }).reduce((total, trade) => total + toNumber(trade.pnl), 0); }
