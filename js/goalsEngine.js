// Client-side goal progress calculation from trades, cash, and reviews.

import { state } from "./store.js";
import { fmtMoney, fmtPct, fmtNum } from "./ui.js";

export const GOAL_TYPES = {
  max_trades: "Trade Count",
  max_loss_day: "Daily Loss",
  max_loss_week: "Weekly Loss",
  profit_target: "Net P&L",
  win_rate: "Win Rate",
  min_rr: "R:R",
  max_consecutive_losses: "Consecutive Losses",
  setup_quality: "Setup Quality",
  patience_score: "Patience Score",
  no_revenge_trade: "No Revenge Trade",
  log_same_day: "Same-Day Logging",
  screenshot_rate: "Screenshot Rate",
  weekly_review: "Weekly Reviews",
  profit_factor: "Profit Factor",
  drawdown_pct: "Drawdown %",
  custom: "Custom",
};

export const DEFAULT_GOALS = [
  { title: "Max Trades Per Day", type: "max_trades", period: "daily", target_value: 3, comparison: "lte", is_default: true },
  { title: "Max Daily Loss", type: "max_loss_day", period: "daily", target_value: 150, comparison: "lte", is_default: true },
  { title: "No Revenge Trade", type: "no_revenge_trade", period: "daily", target_value: 30, comparison: "gte", is_default: true },
  { title: "Minimum Patience Score", type: "patience_score", period: "daily", target_value: 3, comparison: "gte", is_default: true },
  { title: "Minimum Win Rate", type: "win_rate", period: "weekly", target_value: 50, comparison: "gte", is_default: true },
  { title: "Minimum R:R Achieved", type: "min_rr", period: "weekly", target_value: 1.5, comparison: "gte", is_default: true },
  { title: "Max Weekly Drawdown", type: "max_loss_week", period: "weekly", target_value: 300, comparison: "lte", is_default: true },
  { title: "Setup Quality Discipline", type: "setup_quality", period: "weekly", target_value: 80, comparison: "gte", is_default: true },
  { title: "Screenshot Every Trade", type: "screenshot_rate", period: "weekly", target_value: 100, comparison: "gte", is_default: true },
  { title: "Max Consecutive Losses", type: "max_consecutive_losses", period: "weekly", target_value: 2, comparison: "lte", is_default: true },
  { title: "Monthly Profit Target", type: "profit_target", period: "monthly", target_value: 500, comparison: "gte", is_default: true },
  { title: "Monthly Win Rate", type: "win_rate", period: "monthly", target_value: 55, comparison: "gte", is_default: true },
  { title: "Weekly Review Completion", type: "weekly_review", period: "monthly", target_value: 4, comparison: "gte", is_default: true },
  { title: "Profit Factor", type: "profit_factor", period: "monthly", target_value: 1.5, comparison: "gte", is_default: true },
];

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

export function getPKTDate(date = new Date()) {
  return new Date(date.getTime() + PKT_OFFSET_MS);
}

export function getPKTDateKey(date = new Date()) {
  return getPKTDate(date).toISOString().slice(0, 10);
}

export function getPKTWeekStartKey(date = new Date()) {
  const d = getPKTDate(date);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diffToMon);
  return mon.toISOString().slice(0, 10);
}

export function getPKTMonthKey(date = new Date()) {
  const d = getPKTDate(date);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 7);
}

export function isPKTDateInCurrentPeriod(dateKey, period, now = new Date()) {
  if (!dateKey) return false;
  if (period === "daily") return dateKey === getPKTDateKey(now);
  if (period === "weekly") {
    const weekStart = getPKTWeekStartKey(now);
    const weekEnd = new Date(Date.UTC(
      Number(weekStart.slice(0, 4)),
      Number(weekStart.slice(5, 7)) - 1,
      Number(weekStart.slice(8, 10))
    ));
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    const endKey = weekEnd.toISOString().slice(0, 10);
    return dateKey >= weekStart && dateKey <= endKey;
  }
  if (period === "monthly") {
    return dateKey.slice(0, 7) === getPKTMonthKey(now);
  }
  return false;
}

const toISO = (d) => d.toISOString().slice(0, 10);

export function periodRange(period, refDate = new Date()) {
  const d = getPKTDate(refDate);
  d.setUTCHours(0, 0, 0, 0);
  if (period === "daily") {
    const iso = toISO(d);
    return { start: iso, end: iso };
  }
  if (period === "weekly") {
    const day = d.getUTCDay();
    const diffToMon = day === 0 ? -6 : 1 - day;
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() + diffToMon);
    const sun = new Date(mon);
    sun.setUTCDate(mon.getUTCDate() + 6);
    return { start: toISO(mon), end: toISO(sun) };
  }
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { start: toISO(first), end: toISO(last) };
}

export function monthRange(year, month) {
  const first = new Date(Date.UTC(year, month, 1));
  const last = new Date(Date.UTC(year, month + 1, 0));
  return { start: toISO(first), end: toISO(last) };
}

function inRange(dateStr, range) {
  return dateStr >= range.start && dateStr <= range.end;
}

function tradesInRange(range) {
  return state.trades.filter((t) => inRange(t.trade_date, range));
}

function reviewsInRange(range) {
  return state.reviews.filter((r) => inRange(r.week_of, range));
}

function tradeTs(t) {
  return new Date(t.created_at || t.trade_date).getTime();
}

function longestLossStreak(trades) {
  const sorted = trades.slice().sort((a, b) => tradeTs(a) - tradeTs(b));
  let max = 0;
  let cur = 0;
  for (const t of sorted) {
    if (t.result === "Loss") {
      cur++;
      if (cur > max) max = cur;
    } else cur = 0;
  }
  return max;
}

function revengeBreach(trades, minMinutes) {
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, []);
    byDay.get(t.trade_date).push(t);
  }
  let minGap = Infinity;
  let breached = false;
  for (const dayTrades of byDay.values()) {
    const sorted = dayTrades.slice().sort((a, b) => tradeTs(a) - tradeTs(b));
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].result !== "Loss") continue;
      const gapMin = (tradeTs(sorted[i + 1]) - tradeTs(sorted[i])) / 60000;
      if (gapMin < minMinutes) breached = true;
      if (gapMin < minGap) minGap = gapMin;
    }
  }
  return { breached, minGap: minGap === Infinity ? null : minGap };
}

function computeDrawdownPct(trades) {
  if (!trades.length) return 0;
  const sorted = trades.slice().sort((a, b) => {
    if (a.trade_date !== b.trade_date) return a.trade_date.localeCompare(b.trade_date);
    return tradeTs(a) - tradeTs(b);
  });
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const t of sorted) {
    cum += Number(t.pnl || 0);
    if (cum > peak) peak = cum;
    const dd = peak > 0 ? ((peak - cum) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

export function computeGoalValue(goal, range) {
  const trades = tradesInRange(range);
  const target = Number(goal.target_value);
  const type = goal.type;

  if (type === "custom") return { value: null, pending: true };

  if (type === "max_trades") return { value: trades.length };
  if (type === "max_loss_day" || type === "max_loss_week") {
    const loss = trades.filter((t) => t.result === "Loss").reduce((s, t) => s + Number(t.pnl || 0), 0);
    return { value: Math.abs(loss) };
  }
  if (type === "profit_target") {
    return { value: trades.reduce((s, t) => s + Number(t.pnl || 0), 0) };
  }
  if (type === "win_rate") {
    const wins = trades.filter((t) => t.result === "Win").length;
    const losses = trades.filter((t) => t.result === "Loss").length;
    const decided = wins + losses;
    if (!decided) return { value: null, pending: true };
    return { value: (wins / decided) * 100 };
  }
  if (type === "min_rr") {
    const rrTrades = trades.filter((t) => Number(t.risk_amount) > 0);
    if (!rrTrades.length) return { value: null, pending: true };
    const avg = rrTrades.reduce((s, t) => s + Number(t.reward_amount || 0) / Number(t.risk_amount), 0) / rrTrades.length;
    return { value: avg };
  }
  if (type === "max_consecutive_losses") {
    if (!trades.length) return { value: null, pending: true };
    return { value: longestLossStreak(trades) };
  }
  if (type === "setup_quality") {
    if (!trades.length) return { value: null, pending: true };
    const good = trades.filter((t) => t.setup_quality === "A" || t.setup_quality === "A+").length;
    return { value: (good / trades.length) * 100 };
  }
  if (type === "patience_score") {
    const scored = trades.filter((t) => t.patience_score != null);
    if (!scored.length) return { value: null, pending: true };
    return { value: scored.reduce((s, t) => s + Number(t.patience_score), 0) / scored.length };
  }
  if (type === "no_revenge_trade") {
    if (!trades.length) return { value: null, pending: true };
    const { breached, minGap } = revengeBreach(trades, target);
    return { value: minGap, breached, booleanGoal: true };
  }
  if (type === "screenshot_rate") {
    if (!trades.length) return { value: null, pending: true };
    const withShot = trades.filter((t) => t.screenshot_path).length;
    return { value: (withShot / trades.length) * 100 };
  }
  if (type === "weekly_review") {
    return { value: reviewsInRange(range).length };
  }
  if (type === "profit_factor") {
    const wins = trades.filter((t) => Number(t.pnl) > 0).reduce((s, t) => s + Number(t.pnl), 0);
    const losses = trades.filter((t) => Number(t.pnl) < 0).reduce((s, t) => s + Number(t.pnl), 0);
    if (!losses) return { value: wins > 0 ? 999 : null, pending: !wins };
    return { value: wins / Math.abs(losses) };
  }
  if (type === "drawdown_pct") {
    if (!trades.length) return { value: null, pending: true };
    return { value: computeDrawdownPct(trades) };
  }
  if (type === "log_same_day") {
    if (!trades.length) return { value: null, pending: true };
    const sameDay = trades.filter((t) => t.trade_date === toISO(new Date(t.created_at))).length;
    return { value: (sameDay / trades.length) * 100 };
  }

  return { value: null, pending: true };
}

function isMet(value, target, comparison, booleanBreach) {
  if (booleanBreach) return !booleanBreach;
  if (value == null) return false;
  if (comparison === "gte") return value >= target;
  if (comparison === "lte") return value <= target;
  return Math.abs(value - target) < 0.001;
}

function isBreached(value, target, comparison, booleanBreach) {
  if (booleanBreach) return booleanBreach;
  if (value == null) return false;
  if (comparison === "gte") return value < target;
  if (comparison === "lte") return value > target;
  return Math.abs(value - target) >= 0.001;
}

function isAtRisk(value, target, comparison) {
  if (value == null || target == null) return false;
  if (comparison === "lte") {
    const threshold = target * 0.8;
    if (value >= threshold && value <= target) return true;
    if (Number.isInteger(target) && target <= 10 && value >= target - 1 && value < target) return true;
    return false;
  }
  if (comparison === "gte") {
    return value < target && value >= target * 0.8;
  }
  return false;
}

export function evaluateGoal(goal, refDate = new Date()) {
  const range = periodRange(goal.period, refDate);
  const raw = computeGoalValue(goal, range);
  const target = Number(goal.target_value);
  const value = raw.value;
  const comparison = goal.comparison || "gte";

  let status = "PENDING";
  if (raw.pending || (value == null && !raw.booleanGoal)) {
    status = "PENDING";
  } else if (isBreached(value, target, comparison, raw.breached)) {
    status = "BREACHED";
  } else if (isMet(value, target, comparison, raw.breached)) {
    status = "MET";
  } else if (isAtRisk(value, target, comparison)) {
    status = "AT_RISK";
  } else {
    status = goal.comparison === "gte" ? "AT_RISK" : "MET";
  }

  const progress = progressPct(value, target, comparison, status);
  return {
    goal,
    range,
    value,
    target,
    status,
    progress,
    displayCurrent: formatValue(goal.type, value, raw),
    displayTarget: formatValue(goal.type, target),
    message: breachMessage(goal, value, target),
  };
}

function progressPct(value, target, comparison, status) {
  if (value == null || !target) return status === "MET" ? 100 : 0;
  if (comparison === "gte") {
    const pct = Math.min(100, Math.max(0, (value / target) * 100));
    return status === "MET" ? 100 : pct;
  }
  const pct = Math.min(100, Math.max(0, (value / target) * 100));
  return status === "BREACHED" ? 100 : pct;
}

function formatValue(type, val, raw) {
  if (val == null) return "—";
  if (type === "win_rate" || type === "setup_quality" || type === "screenshot_rate" || type === "drawdown_pct" || type === "log_same_day") {
    return fmtPct(val);
  }
  if (type === "profit_target" || type === "max_loss_day" || type === "max_loss_week") return fmtMoney(val);
  if (type === "min_rr" || type === "profit_factor" || type === "patience_score") return fmtNum(val, type === "min_rr" || type === "profit_factor" ? 2 : 1);
  if (type === "no_revenge_trade") {
    if (raw?.breached) return "Revenge detected";
    return val != null ? `${Math.round(val)}m gap` : "OK";
  }
  if (type === "max_trades" || type === "max_consecutive_losses" || type === "weekly_review") return String(Math.round(val));
  return fmtNum(val);
}

function breachMessage(goal, value, target) {
  const cur = formatValue(goal.type, value, { breached: true });
  const tgt = formatValue(goal.type, target);
  return `${goal.title} exceeded (${cur}/${tgt}). Consider stopping for today.`;
}

export function evaluateAllGoals(goals, refDate = new Date()) {
  return goals
    .filter((g) => g.is_active)
    .map((g) => evaluateGoal(g, refDate));
}

export function evaluateAllGoalsIncludingInactive(goals, refDate = new Date()) {
  return goals.map((g) => ({ ...evaluateGoal(g, refDate), inactive: !g.is_active }));
}

export function monthHistory(goals, year, month) {
  const range = monthRange(year, month);
  const ref = new Date(year, month, 15);
  const active = goals.filter((g) => g.is_active !== false);
  const tradeCount = state.trades.filter((t) => inRange(t.trade_date, range)).length;
  const reviewCount = reviewsInRange(range).length;

  if (tradeCount === 0 && reviewCount === 0) {
    return { year, month, results: [], met: 0, total: 0, noData: true };
  }

  const results = active.map((g) => {
    const ev = evaluateGoal(g, ref);
    const trades = tradesInRange(periodRange(g.period, ref));
    const hasData = g.type === "weekly_review"
      ? reviewsInRange(range).length > 0
      : trades.length > 0 || g.type === "weekly_review";
    if (!hasData && ev.status === "PENDING") return { goal: g, status: "PENDING" };
    return { goal: g, status: ev.status === "PENDING" && hasData ? "BREACHED" : ev.status };
  });
  const met = results.filter((r) => r.status === "MET").length;
  const total = results.filter((r) => r.status !== "PENDING").length;
  return { year, month, results, met, total: total || active.length };
}

export function listPastMonths(count = 6) {
  const months = [];
  const now = new Date();
  for (let i = 1; i <= count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() });
  }
  return months;
}

export function customTrackToType(track, period) {
  const map = {
    pnl: "profit_target",
    count: "max_trades",
    win_rate: "win_rate",
    rr: "min_rr",
    loss: period === "weekly" ? "max_loss_week" : "max_loss_day",
    patience: "patience_score",
    drawdown: "drawdown_pct",
    custom: "custom",
  };
  return map[track] || "custom";
}

export function comparisonFromDirection(dir) {
  if (dir === "above") return "gte";
  if (dir === "below") return "lte";
  return "eq";
}
