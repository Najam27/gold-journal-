/**
 * The cost of indiscipline: planned vs unplanned P&L.
 *
 * Every professional knows the strategy is rarely the problem — the
 * deviation from it is. Trades carry a `planStatus` of PLANNED, UNPLANNED,
 * or NOT_EVALUATED. This module turns that flag into the single most
 * confronting number in the journal: how much money trading outside the
 * plan made or cost.
 *
 * Pure and deterministic. OPEN trades are excluded — unrealized P&L must
 * never judge a decision.
 */

export type DeviationTrade = {
  planStatus?: string | null;
  result?: string | null;
  pnl?: number | string | null;
};

export interface DeviationCost {
  plannedTrades: number;
  plannedPnl: number;
  plannedExpectancy: number | null;
  unplannedTrades: number;
  unplannedPnl: number;
  unplannedExpectancy: number | null;
  unevaluatedTrades: number;
  /** Negative when indiscipline lost money. */
  costOfIndiscipline: number | null;
  /** Plain-language verdict from a mentor's mouth. */
  verdict: string;
}

const toNumber = (value: number | string | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const money = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

export function planDeviationCost(trades: DeviationTrade[]): DeviationCost {
  const closed = trades.filter(trade => String(trade.result ?? "").toUpperCase() !== "OPEN");
  const bucket = (status: string) => closed.filter(trade => String(trade.planStatus ?? "").toUpperCase() === status);
  const summarize = (rows: DeviationTrade[]) => {
    const pnl = rows.reduce((sum, trade) => sum + toNumber(trade.pnl), 0);
    return { count: rows.length, pnl, expectancy: rows.length ? pnl / rows.length : null };
  };

  const planned = summarize(bucket("PLANNED"));
  const unplanned = summarize(bucket("UNPLANNED"));
  const unevaluated = bucket("NOT_EVALUATED").length + closed.filter(trade => {
    const status = String(trade.planStatus ?? "").toUpperCase();
    return status !== "PLANNED" && status !== "UNPLANNED" && status !== "NOT_EVALUATED";
  }).length;

  const costOfIndiscipline = unplanned.count ? unplanned.pnl : null;

  let verdict: string;
  if (!planned.count && !unplanned.count) {
    verdict = "No evaluated trades yet — mark trades as planned or unplanned to measure what discipline is worth.";
  } else if (!unplanned.count) {
    verdict = `All ${planned.count} evaluated trades were planned. Whatever your P&L, your process is clean — fix the strategy, not yourself.`;
  } else if (!planned.count) {
    verdict = `${unplanned.count} unplanned trades and zero planned ones: you're not trading a plan, you're reacting to price. Write tomorrow's plan before the session.`;
  } else if (unplanned.expectancy != null && planned.expectancy != null && unplanned.expectancy < 0 && planned.expectancy > 0) {
    verdict = `Your plan works (${money(planned.expectancy)} avg on ${planned.count} planned trades). You don't (${money(unplanned.expectancy)} avg on ${unplanned.count} unplanned). The strategy isn't broken — the discipline is.`;
  } else if (unplanned.expectancy != null && planned.expectancy != null && unplanned.expectancy < planned.expectancy) {
    verdict = `Planned trades average ${money(planned.expectancy)}; unplanned average ${money(unplanned.expectancy)}. Every deviation is a tax — ${money(Math.abs(unplanned.pnl))} ${unplanned.pnl < 0 ? "lost" : "made"} outside the plan across ${unplanned.count} trades.`;
  } else {
    verdict = `Unplanned trades average ${money(unplanned.expectancy ?? 0)} vs ${money(planned.expectancy ?? 0)} planned. Don't let a lucky streak fool you — unplanned winners are how bad habits get funded.`;
  }

  return {
    plannedTrades: planned.count,
    plannedPnl: planned.pnl,
    plannedExpectancy: planned.expectancy,
    unplannedTrades: unplanned.count,
    unplannedPnl: unplanned.pnl,
    unplannedExpectancy: unplanned.expectancy,
    unevaluatedTrades: unevaluated,
    costOfIndiscipline,
    verdict,
  };
}
