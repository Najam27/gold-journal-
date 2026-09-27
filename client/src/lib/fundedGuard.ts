/**
 * Funded account guard: prop-firm drawdown math in percentages, not dollars.
 *
 * Research-backed defaults (FTMO and most major firms):
 * - Daily drawdown: 5% of the day's starting balance/equity. Resets at the
 *   firm's server midnight. Includes floating P&L. Breach = account gone.
 * - Maximum drawdown: 10% overall. Static (from initial balance, FTMO-style)
 *   or trailing (locks in from peak equity).
 * - Single-trade guidance: never risk more than 30% of the daily allowance
 *   on one trade — three full stops should never end the day.
 *
 * This is pure arithmetic over the trader's own inputs. It never claims to
 * enforce anything broker-side; it is a journal-side guardrail.
 */

export type DrawdownType = "static" | "trailing";

export interface FundedGuardConfig {
  /** Starting account balance (the firm's reference point). */
  accountSize: number;
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
  /** Daily loss limit in account currency. */
  dailyLossLimit: number;
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

  const dailyLossLimit = (accountSize * dailyPct) / 100;
  const maxLossLimit = (accountSize * maxPct) / 100;

  // Trailing locks the floor to peak equity; static pins it to the start.
  const reference = config.drawdownType === "trailing"
    ? Math.max(accountSize, config.peakEquity ?? accountSize)
    : accountSize;
  const maxDrawdownFloor = reference - maxLossLimit;

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
            : `Daily allowance intact — ${dailyPct}% of $${accountSize.toLocaleString("en-US")} = $${dailyLossLimit.toLocaleString("en-US", { maximumFractionDigits: 2 })} max loss today.`;

  return {
    dailyLossLimit,
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
