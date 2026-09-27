/**
 * Guided weekly review ritual — one-week trade summary.
 *
 * Trading rationale: professional traders improve through structured review,
 * not raw screen time. A weekly ritual (stats, biggest win/loss, top mistakes,
 * plan adherence) forces the trader to confront the gap between their plan and
 * their behaviour while the week is still fresh. Everything here is pure so the
 * same summary can be rendered in the app, exported to the PDF report, or
 * consumed by an AI coach without re-fetching data.
 *
 * PKT week convention: Monday 00:00 → Sunday 23:59:59.999 in Asia/Karachi.
 */

import { getPktDateInput, toNumber } from "@/lib/gold";

export interface WeeklyReviewTradeInput {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
  mistake?: string | null;
  risk?: number | string | null;
  planStatus?: string | null;
}

export interface WeeklyReviewPlanInput {
  planDate: string | number | Date;
}

export interface WeeklyReviewSummary {
  /** ISO instant of the PKT Monday 00:00 week bound. */
  weekStartIso: string;
  /** ISO instant of the PKT Sunday 23:59:59.999 week bound. */
  weekEndIso: string;
  /** e.g. "22 – 28 Sep 2026" (en-GB day numbers + short month). */
  weekLabel: string;
  /** All trades whose tradeDate falls inside the week. */
  tradeCount: number;
  /** Trades with result !== "OPEN". Open trades are noise for win-rate/PF math. */
  closedCount: number;
  /** Wins / closed (WIN only). Null when there is nothing to measure. */
  winRate: number | null;
  netPnl: number;
  /**
   * Mean(pnl / risk) over closed trades with risk > 0.
   * Zero-risk trades (unknown or unmodelled risk) would distort the number, so
   * they are excluded rather than counted as zero.
   */
  avgR: number | null;
  /**
   * Gross profit / gross loss (closed trades). Null when gross loss is 0 —
   * a week with no losers has no meaningful profit factor (it is unbounded).
   */
  profitFactor: number | null;
  biggestWin: { pnl: number; date: string } | null;
  /** Most negative pnl. Null when the week had no losing trade. */
  biggestLoss: { pnl: number; date: string } | null;
  /** Top 5 non-empty mistake strings by frequency, most common first. */
  topMistakes: Array<{ mistake: string; count: number }>;
  /** % of closed trades with planStatus === "PLANNED". Null when closedCount == 0. */
  plannedPct: number | null;
  /** Distinct PKT days with at least one trade. */
  daysTraded: number;
  /** Plans whose planDate falls inside the week. */
  plansLogged: number;
}

const MS_PER_DAY = 86_400_000;
/** Asia/Karachi has no daylight saving since 2009 — a fixed +05:00 offset is safe. */
const PKT_OFFSET_MS = 5 * 3_600_000;

/**
 * PKT calendar parts for an instant, using Intl so the result is correct even
 * when the caller's machine is in another timezone.
 */
function pktParts(ref: Date | string | number): { year: number; month: number; day: number; weekday: number } {
  const instant = new Date(ref);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const weekdayName = parts.find((p) => p.type === "weekday")?.value ?? "";
  // Monday-first index; avoids locale differences in week start.
  const weekday = (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const).indexOf(weekdayName as never) + 1;
  return { year: get("year"), month: get("month"), day: get("day"), weekday };
}

/**
 * Return the PKT week [start, end] as real Date instants.
 *
 * Approach: read the ref's PKT calendar date via Intl, walk back to Monday,
 * then express Monday 00:00 PKT as a UTC instant (subtracting the fixed +5h
 * offset — valid because Asia/Karachi has no DST). The week end is start +
 * 7 days − 1 ms, i.e. Sunday 23:59:59.999 PKT.
 *
 * `offsetWeeks = 0` → week containing ref; `-1` → previous week.
 */
export function pktWeekRange(ref: Date | string | number, offsetWeeks = 0): { start: Date; end: Date } {
  const { year, month, day, weekday } = pktParts(ref);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || weekday < 1) {
    throw new Error("pktWeekRange: invalid reference date");
  }
  // Walk back from the ref's PKT date to that week's Monday (weekday 1 = Monday),
  // then shift by whole weeks. offsetWeeks = 0 → the week containing ref.
  const mondayBack = (weekday - 1) - offsetWeeks * 7;
  const mondayUtcNoon = Date.UTC(year, month - 1, day) - mondayBack * MS_PER_DAY;
  const monday = new Date(mondayUtcNoon);
  const mondayY = monday.getUTCFullYear();
  const mondayM = monday.getUTCMonth();
  const mondayD = monday.getUTCDate();
  const start = new Date(Date.UTC(mondayY, mondayM, mondayD, 0, 0, 0, 0) - PKT_OFFSET_MS);
  const end = new Date(start.getTime() + 7 * MS_PER_DAY - 1);
  return { start, end };
}

/** "22 – 28 Sep 2026"; month is repeated on the left side when it differs. */
function formatWeekLabel(start: Date, end: Date): string {
  const tz = "Asia/Karachi";
  const fmt = (d: Date, withYear: boolean) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" as const } : {}),
    })
      .format(d)
      // Node's en-GB short September is "Sept"; keep a consistent 3-letter month.
      .replace("Sept", "Sep");
  const startPart = fmt(start, false);
  const endPart = fmt(end, true);
  const sameMonth = startPart.split(" ")[1] === endPart.split(" ")[1];
  const left = sameMonth ? startPart.split(" ")[0] : startPart;
  return `${left} – ${endPart}`;
}

function toInstant(value: string | number | Date): Date | null {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWin(result: string | null | undefined): boolean {
  return String(result ?? "").trim().toUpperCase() === "WIN";
}

function isClosed(result: string | null | undefined): boolean {
  return String(result ?? "").trim().toUpperCase() !== "OPEN";
}

function isPlanned(planStatus: string | null | undefined): boolean {
  return String(planStatus ?? "").trim().toUpperCase() === "PLANNED";
}

/**
 * Summarise one PKT calendar week for the guided weekly review ritual.
 *
 * A trade belongs to the week when its instant is within [weekStart, weekEnd]
 * (inclusive). Invalid tradeDates are ignored. Open trades count toward
 * activity (tradeCount, daysTraded) but not toward outcome statistics
 * (winRate, avgR, profitFactor), because an open trade has no realised outcome.
 */
export function summarizeWeek(
  trades: WeeklyReviewTradeInput[],
  plans: WeeklyReviewPlanInput[],
  weekStart: Date,
  weekEnd: Date,
): WeeklyReviewSummary {
  const startMs = weekStart.getTime();
  const endMs = weekEnd.getTime();

  const inWeek = trades.filter((t) => {
    const instant = toInstant(t.tradeDate);
    return instant !== null && instant.getTime() >= startMs && instant.getTime() <= endMs;
  });

  const closed = inWeek.filter((t) => isClosed(t.result));
  const closedCount = closed.length;

  const wins = closed.filter((t) => isWin(t.result)).length;

  const netPnl = closed.reduce((sum, t) => sum + toNumber(t.pnl), 0);

  const rMultiples = closed
    .map((t) => {
      const risk = toNumber(t.risk);
      return risk > 0 ? toNumber(t.pnl) / risk : null;
    })
    .filter((r): r is number => r !== null);
  const avgR = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : null;

  const grossProfit = closed.reduce((sum, t) => sum + Math.max(0, toNumber(t.pnl)), 0);
  const grossLoss = closed.reduce((sum, t) => sum + Math.max(0, -toNumber(t.pnl)), 0);
  const profitFactor = grossLoss === 0 ? null : grossProfit / grossLoss;

  let biggestWin: WeeklyReviewSummary["biggestWin"] = null;
  let biggestLoss: WeeklyReviewSummary["biggestLoss"] = null;
  for (const t of closed) {
    const pnl = toNumber(t.pnl);
    const date = getPktDateInput(t.tradeDate);
    if (pnl > 0 && (biggestWin === null || pnl > biggestWin.pnl)) biggestWin = { pnl, date };
    if (pnl < 0 && (biggestLoss === null || pnl < biggestLoss.pnl)) biggestLoss = { pnl, date };
  }

  const mistakeCounts = new Map<string, number>();
  for (const t of closed) {
    const mistake = String(t.mistake ?? "").trim();
    if (mistake) mistakeCounts.set(mistake, (mistakeCounts.get(mistake) ?? 0) + 1);
  }
  const topMistakes = Array.from(mistakeCounts.entries())
    .map(([mistake, count]) => ({ mistake, count }))
    .sort((a, b) => b.count - a.count || a.mistake.localeCompare(b.mistake))
    .slice(0, 5);

  const plannedPct =
    closedCount === 0 ? null : (closed.filter((t) => isPlanned(t.planStatus)).length / closedCount) * 100;

  const daysTraded = new Set(inWeek.map((t) => getPktDateInput(t.tradeDate))).size;

  const plansLogged = plans.filter((p) => {
    const instant = toInstant(p.planDate);
    return instant !== null && instant.getTime() >= startMs && instant.getTime() <= endMs;
  }).length;

  return {
    weekStartIso: weekStart.toISOString(),
    weekEndIso: weekEnd.toISOString(),
    weekLabel: formatWeekLabel(weekStart, weekEnd),
    tradeCount: inWeek.length,
    closedCount,
    winRate: closedCount === 0 ? null : wins / closedCount,
    netPnl,
    avgR,
    profitFactor,
    biggestWin,
    biggestLoss,
    topMistakes,
    plannedPct,
    daysTraded,
    plansLogged,
  };
}
