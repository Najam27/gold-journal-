import { tradePips } from "@shared/pipMath";
import { PNL_RESULT_EPSILON } from "@shared/tradeOutcome";

export type PipStats = {
  total: number;
  closed: number;
  wins: number;
  losses: number;
  /** Net pips across all trades with a computable exit leg. */
  pnl: number;
  winRate: number;
};

/**
 * Testing-mode header stats, computed client-side from the environment-scoped
 * trade list. Mirrors the shape of the Live `tradeSummary` RPC (total, closed,
 * wins, losses, pnl) but `pnl` is net pips derived from entry/exit prices, so
 * dollars and pips are never blended.
 */
export function journalPipStats(trades: Array<{ result?: string | null; entryPrice?: number | string | null; exitPrice?: number | string | null; direction?: string | null }>): PipStats {
  const total = trades.length;
  const closed = trades.filter((t) => (t.result ?? "").toUpperCase() !== "OPEN");
  const wins = closed.filter((t) => (t.result ?? "").toUpperCase() === "WIN").length;
  const losses = closed.filter((t) => (t.result ?? "").toUpperCase() === "LOSS").length;
  const pips = closed
    .map((t) => tradePips(t))
    .filter((p): p is number => p !== null && Number.isFinite(p));
  // Trades without an exit leg contribute nothing (same treatment as the
  // analysis engine's `finite()` helper: missing data is 0, never a gap).
  const pnl = pips.reduce((sum, value) => sum + value, 0);
  const winRate = closed.length ? (wins / closed.length) * 100 : 0;
  return {
    total,
    closed: closed.length,
    wins,
    losses,
    pnl: Math.abs(pnl) < PNL_RESULT_EPSILON ? 0 : pnl,
    winRate,
  };
}
