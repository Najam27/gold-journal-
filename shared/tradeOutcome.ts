/**
 * Single source of truth for how a trade's outcome label is derived from its
 * P&L. The server enforces this on every trade write and the trade form
 * previews it live, so a journal row can never claim WIN with a negative P&L
 * (or LOSS with a positive one) and poison win-rate vs expectancy comparisons.
 *
 * The ±$0.005 dust threshold mirrors the MT5 EA's classification, so manually
 * journaled trades and MT5-imported trades agree on what counts as break-even.
 * OPEN trades are always preserved: an open position has no realized outcome.
 */
export const PNL_RESULT_EPSILON = 0.005;

export type TradeOutcome = "WIN" | "LOSS" | "BREAK_EVEN" | "OPEN";

export function deriveTradeResult(pnl: number | string | null | undefined, requested: string): TradeOutcome {
  if (requested === "OPEN") return "OPEN";
  const raw = Number(pnl ?? 0);
  const value = Number.isFinite(raw) ? raw : 0;
  if (value > PNL_RESULT_EPSILON) return "WIN";
  if (value < -PNL_RESULT_EPSILON) return "LOSS";
  return "BREAK_EVEN";
}

/** Human label for the mentor-facing outcome explanations. */
export function outcomeLabel(outcome: TradeOutcome): string {
  return outcome === "BREAK_EVEN" ? "Break-even" : outcome === "OPEN" ? "Open" : outcome === "WIN" ? "Win" : "Loss";
}
