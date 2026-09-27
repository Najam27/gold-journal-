/**
 * Habit streaks for the journal.
 *
 * New traders respond to streaks better than to dashboards: a journaling streak
 * rewards the act of showing up, a green-day streak rewards process quality,
 * and "days since" counters make revenge trades and overtrading feel costly
 * to restart. All streaks are computed from journal trades alone — no extra
 * tracking, no network, no UI.
 */
import { addPktDays, isPktDateKey, pktDateToTimestamp } from "@shared/pktDate";
import { getPktDateInput, toNumber } from "@/lib/gold";

export interface StreakTradeInput {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
  mistake?: string | null;
}

export interface StreakInfo {
  /** Streak still alive right now. */
  current: number;
  /** Longest streak anywhere in the journal. */
  best: number;
}

export interface StreaksResult {
  /** Consecutive PKT days with >= 1 trade. */
  journaling: StreakInfo;
  /**
   * Consecutive calendar days where every day had >= 1 trade AND net pnl > 0.
   * A non-trading day breaks the run: you cannot be "on a green-day streak"
   * without trading. This is deliberately strict — a streak that survives
   * days off inflates and stops meaning anything.
   */
  greenDay: StreakInfo;
  /**
   * Whole days since the most recent revenge/FOMO trade's PKT day (0 = today).
   * When no revenge trade is on record, this returns the whole days between
   * the first journaled day and today: you have been revenge-free for your
   * entire recorded history. Empty journal -> 0.
   */
  revengeFreeDays: number;
  /**
   * Whole days since the most recent day where trade count exceeded
   * maxTradesPerDay (0 = today). When no limit is configured
   * (maxTradesPerDay null/undefined), nothing can be breached, so this
   * returns the whole days between the first journaled day and today.
   * Empty journal -> 0.
   */
  disciplinedDays: number;
}

export interface ComputeStreaksOptions {
  /** Daily trade cap from the trader's plan; null/undefined = no cap. */
  maxTradesPerDay?: number | null;
  /** Override "today" (tests); defaults to now. */
  today?: Date | string | number;
}

const REVENGE_PATTERN = /revenge|fomo/i;

interface DayBucket {
  count: number;
  pnl: number;
  revenge: boolean;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/** Whole calendar days between two PKT date keys (YYYY-MM-DD). */
function daysBetweenPktKeys(from: string, to: string): number {
  return Math.round((pktDateToTimestamp(to, 12) - pktDateToTimestamp(from, 12)) / MILLISECONDS_PER_DAY);
}

/**
 * Walk back from `startDay` counting consecutive days that satisfy `qualifies`.
 * The first day that fails stops the walk — a streak is only as strong as its
 * weakest day.
 */
function countRunBack(dayIndex: Map<string, DayBucket>, startDay: string, qualifies: (day: DayBucket) => boolean): number {
  let run = 0;
  let day = startDay;
  for (;;) {
    const bucket = dayIndex.get(day);
    if (!bucket || !qualifies(bucket)) return run;
    run += 1;
    day = addPktDays(day, -1);
  }
}

/** Longest run of consecutive calendar days anywhere in the journal where `qualifies`. */
function longestRun(dayIndex: Map<string, DayBucket>, firstDay: string, lastDay: string, qualifies: (day: DayBucket) => boolean): number {
  let best = 0;
  let run = 0;
  let day = firstDay;
  while (day <= lastDay) {
    const bucket = dayIndex.get(day);
    if (bucket && qualifies(bucket)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
    day = addPktDays(day, 1);
  }
  return best;
}

export function computeStreaks(trades: StreakTradeInput[], opts: ComputeStreaksOptions = {}): StreaksResult {
  const empty: StreaksResult = {
    journaling: { current: 0, best: 0 },
    greenDay: { current: 0, best: 0 },
    revengeFreeDays: 0,
    disciplinedDays: 0,
  };
  if (!Array.isArray(trades) || trades.length === 0) return empty;

  const today = getPktDateInput(opts.today ?? new Date());
  if (!isPktDateKey(today)) return empty;

  // Group trades into PKT-day buckets, ignoring unparseable dates entirely.
  const dayIndex = new Map<string, DayBucket>();
  for (const trade of trades) {
    if (!trade || trade.tradeDate === null || trade.tradeDate === undefined) continue;
    const key = getPktDateInput(trade.tradeDate);
    if (!isPktDateKey(key)) continue;
    let bucket = dayIndex.get(key);
    if (!bucket) {
      bucket = { count: 0, pnl: 0, revenge: false };
      dayIndex.set(key, bucket);
    }
    bucket.count += 1;
    bucket.pnl += toNumber(trade.pnl);
    if (typeof trade.mistake === "string" && REVENGE_PATTERN.test(trade.mistake)) bucket.revenge = true;
  }
  if (dayIndex.size === 0) return empty;

  const days = Array.from(dayIndex.keys()).sort();
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  // A trader who hasn't traded yet today hasn't broken the streak, so both
  // walk-backs start from yesterday when today has no trades.
  const walkStart = dayIndex.has(today) ? today : addPktDays(today, -1);

  const journalingQualifies = () => true; // every bucket holds >= 1 trade by construction
  const greenQualifies = (bucket: DayBucket) => bucket.pnl > 0; // strictly positive: break-even breaks the run

  const journaling: StreakInfo = {
    current: countRunBack(dayIndex, walkStart, journalingQualifies),
    best: longestRun(dayIndex, firstDay, lastDay, journalingQualifies),
  };
  const greenDay: StreakInfo = {
    current: countRunBack(dayIndex, walkStart, greenQualifies),
    best: longestRun(dayIndex, firstDay, lastDay, greenQualifies),
  };

  // "Days since" counters: the most recent offending day, or the first
  // journaled day when nothing was ever breached (streak bounded by the data).
  let lastRevengeDay: string | null = null;
  let lastBreachDay: string | null = null;
  const maxTrades = typeof opts.maxTradesPerDay === "number" && Number.isFinite(opts.maxTradesPerDay) ? opts.maxTradesPerDay : null;
  dayIndex.forEach((bucket, day) => {
    if (bucket.revenge && (lastRevengeDay === null || day > lastRevengeDay)) lastRevengeDay = day;
    if (maxTrades !== null && bucket.count > maxTrades && (lastBreachDay === null || day > lastBreachDay)) lastBreachDay = day;
  });

  return {
    journaling,
    greenDay,
    revengeFreeDays: daysBetweenPktKeys(lastRevengeDay ?? firstDay, today),
    disciplinedDays: daysBetweenPktKeys(lastBreachDay ?? firstDay, today),
  };
}
