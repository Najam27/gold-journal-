/**
 * Funded-account guard mode — pure evaluation logic.
 *
 * Trading rationale: a prop-firm (funded) account does not die from a bad
 * strategy first; it dies from a rule breach — daily loss limit, maximum
 * drawdown, or max trades per day. Those limits are denominated in realized
 * numbers at the end of the day, so this module evaluates *today's realized
 * usage* against the configured limits and reports one of four states:
 * OFF (guard not configured), CLEAR, WARNING (>=80% of a limit used), or
 * BREACHED (>=100% of a limit used).
 *
 * Deliberate choices, documented so future callers do not "fix" them:
 * - `dayPnl` counts only CLOSED trades (WIN/LOSS/BREAK_EVEN). An OPEN trade's
 *   floating P&L is not a realized breach — flagging it would lock the trader
 *   out mid-trade or, worse, cry wolf so often the guard gets ignored.
 * - `dayTrades` counts every trade taken today, OPEN included: the position
 *   was still opened, and funded rules count opened trades.
 * - Equity curve applies cash movements (deposits/withdrawals) and CLOSED
 *   trade P&L in chronological order. `peakEquity` is the running high-water
 *   mark; `drawdown = peakEquity - currentEquity` (floored at 0). This matches
 *   how funded accounts track trailing drawdown against the highest balance.
 * - Percentages are on a 0–100 scale (80 means 80%), not 0–1.
 * - Limits that are null, 0, or negative are treated as "not configured" and
 *   skipped — a misconfigured zero limit must never insta-breach the account.
 */

import { getPktDateInput, toNumber } from "@/lib/gold";

export interface GuardConfig {
  enabled: boolean;
  accountSize: number | null;
  dailyLossLimit: number | null;
  maxDrawdownLimit: number | null;
  maxTradesPerDay: number | null;
}

export interface GuardModeTradeInput {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
}

export interface GuardModeCashInput {
  movementDate: string | number | Date;
  amount: number | string;
  type: "DEPOSIT" | "WITHDRAW";
}

export type GuardStatus = "OFF" | "CLEAR" | "WARNING" | "BREACHED";

export interface GuardEvaluation {
  status: GuardStatus;
  dayPnl: number;
  dayTrades: number;
  dayLossUsedPct: number | null; // |dayPnl| / dailyLossLimit, as a percent, when dayPnl < 0
  peakEquity: number;
  currentEquity: number;
  drawdown: number;
  drawdownUsedPct: number | null; // drawdown / maxDrawdownLimit, as a percent
  tradesUsedPct: number | null; // dayTrades / maxTradesPerDay, as a percent
  breached: string[]; // human-readable breach reasons
  warned: string[]; // >=80% usage warnings
  message: string; // one-line status for the banner
}

/** Closed results — the only ones that move realized P&L / equity. */
const CLOSED_RESULTS = new Set(["WIN", "LOSS", "BREAK_EVEN"]);

function isClosed(result: string | null | undefined): boolean {
  return CLOSED_RESULTS.has(String(result ?? "").toUpperCase());
}

/** A limit only counts when it is a positive finite number. */
function activeLimit(value: number | null | undefined): number | null {
  const numeric = toNumber(value);
  return numeric > 0 ? numeric : null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function fmtMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

/** "$1,234.56" for gains, "-$1,234.56" for losses — keeps the currency sign. */
function fmtSigned(value: number): string {
  const abs = fmtMoney(Math.abs(value));
  return value < 0 ? `-${abs}` : abs;
}

function dayKeyOf(value: Date | string | number): string {
  return getPktDateInput(value);
}

function timeOf(value: Date | string | number): number | null {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

const WARN_PCT = 80;
const BREACH_PCT = 100;

function offEvaluation(): GuardEvaluation {
  return {
    status: "OFF",
    dayPnl: 0,
    dayTrades: 0,
    dayLossUsedPct: null,
    peakEquity: 0,
    currentEquity: 0,
    drawdown: 0,
    drawdownUsedPct: null,
    tradesUsedPct: null,
    breached: [],
    warned: [],
    message: "Guard mode is off.",
  };
}

export function evaluateGuardMode(opts: {
  trades: GuardModeTradeInput[];
  cashMovements?: GuardModeCashInput[];
  startingBalance: number;
  config: GuardConfig | null | undefined;
  today?: Date | string | number;
}): GuardEvaluation {
  const { trades, cashMovements = [], startingBalance, config } = opts;
  if (!config || config.enabled !== true) return offEvaluation();

  const todayKey = dayKeyOf(opts.today ?? new Date());
  const startEquity = toNumber(startingBalance);

  const dailyLossLimit = activeLimit(config.dailyLossLimit);
  const maxDrawdownLimit = activeLimit(config.maxDrawdownLimit);
  const maxTradesPerDay = activeLimit(config.maxTradesPerDay);

  // --- Today's usage -------------------------------------------------------
  let dayPnl = 0;
  let dayTrades = 0;
  for (const trade of trades) {
    if (dayKeyOf(trade.tradeDate) !== todayKey) continue;
    dayTrades += 1; // every opened trade counts toward the daily trade cap
    if (isClosed(trade.result)) dayPnl += toNumber(trade.pnl); // realized only
  }
  dayPnl = round2(dayPnl);

  // --- Equity curve: cash movements + closed trade P&L, chronological --------
  interface EquityEvent {
    time: number;
    delta: number;
  }
  const events: EquityEvent[] = [];
  for (const trade of trades) {
    if (!isClosed(trade.result)) continue; // OPEN trades are floating, not equity
    const time = timeOf(trade.tradeDate);
    if (time === null) continue;
    events.push({ time, delta: toNumber(trade.pnl) });
  }
  for (const movement of cashMovements) {
    const time = timeOf(movement.movementDate);
    if (time === null) continue;
    const signed = movement.type === "WITHDRAW" ? -toNumber(movement.amount) : toNumber(movement.amount);
    events.push({ time, delta: signed });
  }
  events.sort((a, b) => a.time - b.time);

  let equity = startEquity;
  let peakEquity = startEquity;
  for (const event of events) {
    equity += event.delta;
    if (equity > peakEquity) peakEquity = equity;
  }
  const currentEquity = equity;
  const drawdown = round2(Math.max(0, peakEquity - currentEquity));
  peakEquity = round2(peakEquity);

  // --- Limit usage ----------------------------------------------------------
  // Thresholds are evaluated on the raw (unrounded) ratios so that a value
  // like 99.9995% does not round up to a breach; the reported percentages are
  // rounded for display only.
  const dayLoss = dayPnl < 0 ? -dayPnl : 0;
  const dayLossRatio = dailyLossLimit !== null && dayLoss > 0 ? dayLoss / dailyLossLimit : null;
  const drawdownRatio = maxDrawdownLimit !== null ? drawdown / maxDrawdownLimit : null;
  const dayLossUsedPct = dayLossRatio !== null ? round2(dayLossRatio * 100) : null;
  const drawdownUsedPct = drawdownRatio !== null ? round2(drawdownRatio * 100) : null;
  const tradesUsedPct = maxTradesPerDay !== null ? round2((dayTrades / maxTradesPerDay) * 100) : null;

  const breached: string[] = [];
  const warned: string[] = [];

  if (dayLossRatio !== null) {
    if (dayLossRatio >= BREACH_PCT / 100) {
      breached.push(`Daily loss limit hit (${fmtSigned(-dayLoss)} of ${fmtMoney(dailyLossLimit as number)} limit)`);
    } else if (dayLossRatio >= WARN_PCT / 100) {
      warned.push(`Daily loss near limit (${fmtSigned(-dayLoss)} of ${fmtMoney(dailyLossLimit as number)} limit)`);
    }
  }

  if (drawdownRatio !== null && drawdown > 0) {
    if (drawdownRatio >= BREACH_PCT / 100) {
      breached.push(`Max drawdown limit hit (${fmtMoney(drawdown)} of ${fmtMoney(maxDrawdownLimit as number)} limit)`);
    } else if (drawdownRatio >= WARN_PCT / 100) {
      warned.push(`Max drawdown near limit (${fmtMoney(drawdown)} of ${fmtMoney(maxDrawdownLimit as number)} limit)`);
    }
  }

  if (maxTradesPerDay !== null && dayTrades > 0) {
    // Trade count is discrete: breached only when strictly over the cap.
    // Warned when at or above the 80% rung (rounded up) but still within the cap.
    if (dayTrades > maxTradesPerDay) {
      breached.push(`Max trades per day exceeded (${dayTrades} of ${maxTradesPerDay} allowed)`);
    } else if (dayTrades >= Math.ceil(maxTradesPerDay * (WARN_PCT / 100))) {
      warned.push(`Trade count near limit (${dayTrades} of ${maxTradesPerDay} allowed)`);
    }
  }

  const status: GuardStatus = breached.length > 0 ? "BREACHED" : warned.length > 0 ? "WARNING" : "CLEAR";
  const message =
    status === "BREACHED"
      ? `Guard breached — ${breached[0]}`
      : status === "WARNING"
        ? `Guard warning — ${warned[0]}`
        : "Guard clear — all limits within range.";

  return {
    status,
    dayPnl,
    dayTrades,
    dayLossUsedPct,
    peakEquity,
    currentEquity: round2(currentEquity),
    drawdown,
    drawdownUsedPct,
    tradesUsedPct,
    breached,
    warned,
    message,
  };
}
