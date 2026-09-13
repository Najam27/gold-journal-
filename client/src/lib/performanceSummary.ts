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

export type DayTradeSummary<T extends PerformanceTrade = PerformanceTrade> = {
  /** Pakistan-local calendar day (YYYY-MM-DD) this summary describes. */
  day: string;
  /** Every trade whose Pakistan-local date key equals `day`. */
  trades: T[];
  count: number;
  pnl: number;
  wins: number;
  losses: number;
  breakEven: number;
  open: number;
  /** Unrealized P&L already counted inside `pnl` because the app includes open trades. */
  openPnl: number;
  /** wins / trades, the exact figure the calendar day card prints. */
  winRate: number;
  totalRisk: number;
  totalReward: number;
  riskTrades: number;
  rewardTrades: number;
  averagePnl: number;
  averageR: number | null;
  tone: "positive" | "negative" | "neutral";
};

/** Groups trades by their Pakistan-local calendar day in a single pass. */
export function groupTradesByPktDay<T extends PerformanceTrade>(trades: T[]) {
  const grouped = new Map<string, T[]>();
  for (const trade of trades) {
    const key = getPktDateInput(trade.tradeDate);
    if (!key) continue;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(trade);
    else grouped.set(key, [trade]);
  }
  return grouped;
}

/**
 * The single source of truth for a day's numbers. The P&L calendar card and the
 * daily trade drill-down dialog both render this result, so the totals they show
 * can never drift apart. Every value is derived from the trade rows passed in;
 * nothing is invented or fetched.
 */
export function summarizeTradeRows<T extends PerformanceTrade>(rows: T[], day: string): DayTradeSummary<T> {
  const resultOf = (trade: T) => String(trade.result || "OPEN");
  const pnl = rows.reduce((total, trade) => total + toNumber(trade.pnl), 0);
  const wins = rows.filter(trade => resultOf(trade) === "WIN").length;
  const losses = rows.filter(trade => resultOf(trade) === "LOSS").length;
  const breakEven = rows.filter(trade => resultOf(trade) === "BREAK_EVEN").length;
  const openRows = rows.filter(trade => resultOf(trade) === "OPEN");
  const riskRows = rows.filter(trade => toNumber(trade.risk) > 0);
  const rMultiples = riskRows.map(trade => toNumber(trade.pnl) / toNumber(trade.risk));
  return {
    day,
    trades: rows,
    count: rows.length,
    pnl,
    wins,
    losses,
    breakEven,
    open: openRows.length,
    openPnl: openRows.reduce((total, trade) => total + toNumber(trade.pnl), 0),
    winRate: rows.length ? wins / rows.length * 100 : 0,
    totalRisk: riskRows.reduce((total, trade) => total + toNumber(trade.risk), 0),
    totalReward: rows.reduce((total, trade) => total + toNumber(trade.reward), 0),
    riskTrades: riskRows.length,
    rewardTrades: rows.filter(trade => toNumber(trade.reward) > 0).length,
    averagePnl: rows.length ? pnl / rows.length : 0,
    averageR: rMultiples.length ? rMultiples.reduce((total, value) => total + value, 0) / rMultiples.length : null,
    tone: pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral",
  };
}

/** Filters the full trade list down to one Pakistan-local day and summarizes it. */
export function summarizeDayTrades<T extends PerformanceTrade>(trades: T[], day: string): DayTradeSummary<T> {
  return summarizeTradeRows(trades.filter(trade => getPktDateInput(trade.tradeDate) === day), day);
}
