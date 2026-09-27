/**
 * The pre-trade circuit breaker.
 *
 * Professionals don't rely on willpower after a bad run — they rely on
 * rules that stop them before the next click. This module reads the most
 * recent closed trades and answers one question: should you be trading
 * right now?
 *
 * Levels:
 * - CLEAR: nothing alarming. Trade your plan.
 * - CAUTION: warning signs. One more mistake and you stand down — halve
 *   size, re-read the plan, take 15 minutes.
 * - STAND_DOWN: do not trade. Walk away for at least an hour. The market
 *   will be there tomorrow; your capital might not be.
 *
 * Pure and deterministic. It never diagnoses anyone — it names observable
 * facts (losses in a row, dollars from the daily limit, tags you set
 * yourself) and maps them to the action a mentor would demand.
 */

export type TiltLevel = "CLEAR" | "CAUTION" | "STAND_DOWN";

export interface TiltTrade {
  tradeDate?: number | string | Date | null;
  closeTime?: number | string | Date | null;
  result?: string | null;
  pnl?: number | string | null;
  risk?: number | string | null;
  /** Behaviour tags the trader set themselves (mistake field). */
  behaviors?: string[] | string | null;
}

export interface TiltAssessment {
  level: TiltLevel;
  /** Observable facts, each phrased as one plain sentence. */
  reasons: string[];
  /** Suggested minutes away from the screen. Null when CLEAR. */
  cooldownMinutes: number | null;
  /** One-line mentor verdict. */
  summary: string;
}

export interface TiltOptions {
  /** Max acceptable daily loss in account currency. Enables the limit check. */
  dailyLossLimit?: number | null;
  now?: Date;
}

const toNumber = (value: number | string | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const money = (value: number) => `$${Math.abs(value).toFixed(2)}`;

const timeOf = (trade: TiltTrade): number => {
  const raw = trade.closeTime ?? trade.tradeDate;
  const time = raw instanceof Date ? raw.getTime() : new Date(raw ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
};

const isLoss = (trade: TiltTrade) => String(trade.result ?? "").toUpperCase() === "LOSS";

const REVENGE_TAGS = ["revenge", "overtrading", "oversize", "fomo"];

function tradeBehaviors(trade: TiltTrade): string[] {
  const raw = trade.behaviors;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list.map(item => item.trim().toLowerCase()).filter(Boolean);
}

function dayKeyPkt(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function assessTiltRisk(inputTrades: TiltTrade[], options: TiltOptions = {}): TiltAssessment {
  const now = options.now ?? new Date();
  const trades = [...inputTrades]
    .filter(trade => String(trade.result ?? "").toUpperCase() !== "OPEN")
    .sort((a, b) => timeOf(a) - timeOf(b));

  const reasons: string[] = [];
  let level: TiltLevel = "CLEAR";

  const escalate = (next: TiltLevel, reason: string) => {
    reasons.push(reason);
    if (next === "STAND_DOWN") level = "STAND_DOWN";
    else if (level === "CLEAR") level = next;
  };

  // 1. Consecutive losses — the classic tilt fuel.
  let streak = 0;
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    if (isLoss(trades[i])) streak += 1;
    else break;
  }
  if (streak >= 5) escalate("STAND_DOWN", `${streak} consecutive losses. Nobody makes good decisions on a 5-loss streak — the next trade would be about the streak, not the setup.`);
  else if (streak >= 3) escalate("CAUTION", `${streak} consecutive losses. Losses cluster, and clustered losses change how you see the next chart.`);

  // 2. Daily loss limit proximity — the hard guardrail.
  const limit = options.dailyLossLimit;
  if (limit != null && limit > 0) {
    const today = dayKeyPkt(now);
    const todayPnl = trades
      .filter(trade => dayKeyPkt(new Date(timeOf(trade))) === today)
      .reduce((sum, trade) => sum + toNumber(trade.pnl), 0);
    if (todayPnl <= -limit) escalate("STAND_DOWN", `Today's loss of ${money(todayPnl)} hit your ${money(limit)} daily limit. The day is over — defending the limit is the whole job.`);
    else if (todayPnl <= -limit * 0.8) escalate("CAUTION", `Today's loss of ${money(todayPnl)} is at 80% of your ${money(limit)} daily limit. One more full stop and you're done for the day.`);
  }

  // 3. Self-tagged revenge behaviour in the last 3 trades.
  const recent = trades.slice(-3);
  const revengeHits = recent.filter(trade => tradeBehaviors(trade).some(tag => REVENGE_TAGS.some(key => tag.includes(key))));
  if (revengeHits.length > 0) {
    escalate("CAUTION", `${revengeHits.length} of your last ${recent.length} trades carry revenge/overtrading tags you set yourself. The pattern is active right now, not historical.`);
  }

  // 4. Revenge sizing — risking more while losing.
  const risks = trades.map(trade => toNumber(trade.risk)).filter(value => value > 0);
  if (trades.length >= 4 && risks.length >= 4 && streak >= 2) {
    const sorted = [...risks].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const lastRisk = toNumber(trades[trades.length - 1].risk);
    if (median > 0 && lastRisk > median * 1.5) {
      escalate("CAUTION", `Your last trade risked ${money(lastRisk)} vs a ${money(median)} median — sizing up while on a losing streak is revenge sizing, whatever the setup looked like.`);
    }
  }

  const cooldownMinutes = level === "STAND_DOWN" ? 60 : level === "CAUTION" ? 15 : null;
  const summary =
    level === "STAND_DOWN"
      ? "Stand down. No more trades today — protect the account and come back with a plan."
      : level === "CAUTION"
        ? "Proceed with caution: halve size, re-read your plan, and take 15 minutes before the next entry."
        : "Clear. Nothing in your recent trading demands a stop — trade the plan as written.";

  return { level, reasons, cooldownMinutes, summary };
}
