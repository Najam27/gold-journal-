// Pips math for Testing Mode.
//
// UNIT CONVENTION (read this before touching P&L code):
// - The `pnl` column on `gj_trades` stores a UNIT-AGNOSTIC number.
// - For `environment = 'LIVE'` rows it holds dollars ($) — unchanged from
//   before Testing Mode existed.
// - For `environment = 'TESTING'` rows it holds pips, derived from entry and
//   exit prices by the formulas below.
// Presentation code picks `formatMoney` vs `formatPips` by mode; every shared
// calculation (deriveTradeResult, win rate, profit factor, expectancy, drawdown,
// streaks, R multiples) is unit-agnostic and works on both unchanged.
//
// Only LIVE rows write exitPrice as null (unused). The exit leg exists so the
// original entry/exit prices are always preserved and pips are derived, never
// hand-typed.

/**
 * Pip size for a symbol. The journal is gold-only by design, so today there is
 * exactly one real answer: XAUUSD moves in 0.1 steps (2650.00 -> 2652.00 is
 * +20 pips). The map is here so a future symbol does not silently inherit
 * gold's size.
 */
export function pipSizeForSymbol(symbol?: string | null): number {
  const key = (symbol ?? "").trim().toUpperCase();
  if (key === "" || key === "XAUUSD" || key === "GOLD" || key === "XAU") return 0.1;
  // Unknown symbols: refuse to guess quietly would be better, but a trade
  // already validated against a gold-only option list must still render.
  return 0.1;
}

export type PippableTrade = {
  direction?: string | null;
  entryPrice?: number | string | null;
  exitPrice?: number | string | null;
  symbol?: string | null;
};

/**
 * Derived pips for a trade, or null when there is no exit leg yet.
 * BUY:  (exitPrice - entryPrice) / pipSize
 * SELL: (entryPrice - exitPrice) / pipSize
 */
export function tradePips(trade: PippableTrade): number | null {
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) return null;
  if (!(entry > 0) || !(exit > 0)) return null;
  const size = pipSizeForSymbol(trade.symbol);
  if (!(size > 0)) return null;
  const diff = trade.direction === "SELL" ? entry - exit : exit - entry;
  const pips = diff / size;
  return Number.isFinite(pips) ? pips : null;
}

export function formatPips(pips: number | null | undefined): string {
  if (pips == null || !Number.isFinite(pips)) return "—";
  const rounded = Number(pips.toFixed(1));
  return `${rounded > 0 ? "+" : ""}${rounded} pips`;
}
