/**
 * Funded account guard: prop-firm drawdown math in percentages, not dollars.
 *
 * Two separate clocks (FTMO and most major firms):
 * - Daily drawdown: 5% of the DAY'S STARTING equity (higher of balance or
 *   equity at the firm's server midnight). Resets every day — it moves up or
 *   down with wherever the account opens the day. Includes floating P&L.
 *   Breach = account gone.
 * - Maximum drawdown: 10% overall.
 *   - static: pinned to the STARTING balance forever — the floor never moves,
 *     profit banks permanent buffer.
 *   - trailing: measured from PEAK equity, ratcheting up with new highs.
 * - Single-trade guidance: never risk more than 30% of the daily allowance
 *   on one trade — three full stops should never end the day.
 *
 * This is pure arithmetic over the trader's own inputs. It never claims to
 * enforce anything broker-side; it is a journal-side guardrail.
 */

export type DrawdownType = "static" | "trailing";

export interface FundedGuardConfig {
  /** Starting account balance (the firm's reference point for static max DD). */
  accountSize: number;
  /**
   * Equity at the start of the trading day — the reference for the daily
   * limit. Firms reset this at server midnight from the higher of balance or
   * equity. Falls back to accountSize when unknown.
   */
  dayStartEquity?: number | null;
  /** Daily drawdown limit as a percent, e.g. 5 for 5%. */
  dailyDrawdownPct: number;
  /** Maximum drawdown as a percent, e.g. 10 for 10%. */
  maxDrawdownPct: number;
  /** How the max-drawdown floor is measured. */
  drawdownType: DrawdownType;
  /** Peak equity seen (only used when drawdownType is "trailing"). */
  peakEquity?: number | null;
}

export type GuardLevel = "clear" | "caution" | "danger" | "breached";

export interface FundedGuardEvaluation {
  /** Equity at the start of the trading day (daily reference). */
  dayStartEquity: number;
  /** Daily loss limit in account currency. */
  dailyLossLimit: number;
  /** Equity must not print below this intraday. */
  dailyFloor: number;
  /** Maximum total loss in account currency. */
  maxLossLimit: number;
  /** Equity must never print below this. */
  maxDrawdownFloor: number;
  /** Percent of the daily limit already used (0–100+). */
  dailyUsedPct: number;
  /** Dollars of daily allowance remaining (can go negative past breach). */
  dailyRemaining: number;
  /** Recommended ceiling per trade: 30% of the daily allowance. */
  maxRiskPerTrade: number;
  /** Whole full-stops at the per-trade risk before the daily limit breaks. */
  stopsBeforeDailyBreach: number;
  level: GuardLevel;
  /** Human-readable status line. */
  message: string;
}

export const DEFAULT_DAILY_DRAWDOWN_PCT = 5;
export const DEFAULT_MAX_DRAWDOWN_PCT = 10;
/** Never risk more than this share of the daily allowance on one trade. */
export const MAX_SINGLE_TRADE_SHARE_OF_DAILY = 0.3;

const clampPct = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function evaluateFundedGuard(
  config: FundedGuardConfig,
  /** Today's realized P&L (negative = losing day). Defaults to 0. */
  todayPnl = 0,
  /** Per-trade risk in account currency, for the stops-before-breach count. */
  riskPerTrade?: number | null,
): FundedGuardEvaluation {
  const accountSize = Math.max(0, config.accountSize || 0);
  const dailyPct = clampPct(config.dailyDrawdownPct, 0.5, 20);
  const maxPct = clampPct(config.maxDrawdownPct, 1, 50);

  // Daily drawdown is measured from the day's STARTING equity — it resets
  // every day at the firm's server midnight (higher of balance or equity),
  // so it moves up or down with wherever the account opens the day.
  const dayStartEquity =
    config.dayStartEquity != null && Number.isFinite(config.dayStartEquity) && config.dayStartEquity > 0
      ? config.dayStartEquity
      : accountSize;
  const dailyLossLimit = (dayStartEquity * dailyPct) / 100;
  const dailyFloor = dayStartEquity - dailyLossLimit;

  // Maximum drawdown depends on the model:
  // - static: pinned to the STARTING balance forever. Profit banks buffer;
  //   the floor never moves.
  // - trailing: measured from PEAK equity, so the max-loss dollar amount and
  //   the floor both ratchet up as equity makes new highs.
  const isTrailing = config.drawdownType === "trailing";
  const maxReference =
    isTrailing
      ? Math.max(accountSize, config.peakEquity ?? accountSize)
      : accountSize;
  const maxLossLimit = (maxReference * maxPct) / 100;
  const maxDrawdownFloor = maxReference - maxLossLimit;

  const lossToday = Math.max(0, -(todayPnl || 0));
  const dailyUsedPct = dailyLossLimit > 0 ? (lossToday / dailyLossLimit) * 100 : 0;
  const dailyRemaining = dailyLossLimit - lossToday;

  const maxRiskPerTrade = dailyLossLimit * MAX_SINGLE_TRADE_SHARE_OF_DAILY;
  const risk = riskPerTrade != null && riskPerTrade > 0 ? riskPerTrade : maxRiskPerTrade;
  const stopsBeforeDailyBreach = risk > 0 ? Math.floor(dailyLossLimit / risk) : 0;

  let level: GuardLevel = "clear";
  if (dailyUsedPct >= 100) level = "breached";
  else if (dailyUsedPct >= 90) level = "danger";
  else if (dailyUsedPct >= 70) level = "caution";

  const message =
    level === "breached"
      ? `Daily drawdown breached — ${dailyUsedPct.toFixed(0)}% of the ${dailyPct}% limit used. A prop firm would terminate the account here.`
      : level === "danger"
        ? `At ${dailyUsedPct.toFixed(0)}% of today's ${dailyPct}% limit — one more full stop likely ends the day.`
        : level === "caution"
          ? `At ${dailyUsedPct.toFixed(0)}% of today's ${dailyPct}% limit — tighten up or stop.`
          : todayPnl < 0
            ? `Down ${dailyUsedPct.toFixed(0)}% of today's ${dailyPct}% allowance.`
            : `Daily allowance intact — ${dailyPct}% of day-start $${dayStartEquity.toLocaleString("en-US", { maximumFractionDigits: 2 })} = $${dailyLossLimit.toLocaleString("en-US", { maximumFractionDigits: 2 })} max loss today.`;

  return {
    dayStartEquity,
    dailyLossLimit,
    dailyFloor,
    maxLossLimit,
    maxDrawdownFloor,
    dailyUsedPct,
    dailyRemaining,
    maxRiskPerTrade,
    stopsBeforeDailyBreach,
    level,
    message,
  };
}
