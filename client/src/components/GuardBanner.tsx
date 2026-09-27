import React, { useMemo } from "react";
import { AlertTriangle, OctagonX } from "lucide-react";
import { getPktDateKey } from "@shared/pktDate";
import { toNumber } from "@/lib/gold";
import { evaluateFundedGuard } from "@/lib/fundedGuard";
import type { GuardConfig } from "@/lib/guardMode";

interface GuardTradeLike {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
}

const isClosed = (result: string | null | undefined) => {
  const r = String(result ?? "").toUpperCase();
  return r === "WIN" || r === "LOSS" || r === "BREAK_EVEN";
};

/**
 * Live funded-guard banner for the Trade Log.
 *
 * Driven by the funded guard configured in the Risk Calculator
 * (percentage-based prop-firm drawdown): daily limit from the day's starting
 * equity, max drawdown static from the starting balance or trailing from
 * peak equity. Warns at 70% (caution), 90% (danger), 100% (breached) of the
 * daily allowance. Silent when the funded guard is not configured.
 *
 * Journal-side estimate: day-start equity = starting balance + all-time
 * realized P&L − today's realized P&L. It cannot see floating P&L, so it
 * warns early rather than claiming broker precision.
 */
export function GuardBanner({
  guardConfig,
  trades,
  startingBalance,
}: {
  guardConfig: GuardConfig | null | undefined;
  trades: GuardTradeLike[];
  startingBalance: number;
}) {
  const evaluation = useMemo(() => {
    const funded = guardConfig?.funded;
    if (!funded?.enabled) return null;

    const todayKey = getPktDateKey(new Date());
    let todayPnl = 0;
    let allTimePnl = 0;
    for (const trade of trades ?? []) {
      if (!isClosed(trade.result)) continue;
      const pnl = toNumber(trade.pnl);
      if (!Number.isFinite(pnl)) continue;
      allTimePnl += pnl;
      if (getPktDateKey(trade.tradeDate) === todayKey) todayPnl += pnl;
    }

    // Prefer the MT5 snapshot saved by the Risk Calculator (same PKT day);
    // fall back to the journal-side derivation when MT5 is not connected.
    const snapshotToday =
      funded.snapshotAt != null && getPktDateKey(funded.snapshotAt) === todayKey;
    const snapshotEquity = snapshotToday ? funded.mt5Equity : null;
    const snapshotBalance = snapshotToday ? funded.mt5Balance : null;

    // Starting balance: the trader's manual entry wins (the funded account's
    // true initial balance), then today's MT5 snapshot balance, then the
    // journal account's starting balance.
    const overrideStart = Number(funded.startingBalanceOverride);
    const base =
      (funded.startingBalanceOverride.trim() !== "" && Number.isFinite(overrideStart) && overrideStart > 0
        ? overrideStart
        : null) ??
      (snapshotBalance != null && snapshotBalance > 0 ? snapshotBalance : null) ??
      (Number.isFinite(startingBalance) && startingBalance > 0 ? startingBalance : 0);
    const journalEquity = base + allTimePnl;
    const currentEquity =
      snapshotEquity != null && snapshotEquity > 0 ? snapshotEquity : journalEquity;

    const accountSize =
      funded.sizeMode === "manual" && funded.accountSize != null && funded.accountSize > 0
        ? funded.accountSize
        : base;
    if (!(accountSize > 0)) return null;

    const override = Number(funded.dayStartOverride);
    const dayStartEquity =
      funded.dayStartOverride.trim() !== "" && Number.isFinite(override) && override > 0
        ? override
        : currentEquity - todayPnl;
    if (!(dayStartEquity > 0)) return null;

    const peak = Number(funded.peakEquity);
    return evaluateFundedGuard(
      {
        accountSize,
        dayStartEquity,
        dailyDrawdownPct: funded.dailyDrawdownPct,
        maxDrawdownPct: funded.maxDrawdownPct,
        drawdownType: funded.drawdownType,
        peakEquity:
          funded.drawdownType === "trailing" && Number.isFinite(peak) && peak > 0 ? peak : null,
      },
      todayPnl,
    );
  }, [guardConfig, trades, startingBalance]);

  if (!evaluation || evaluation.level === "clear") return null;

  const breached = evaluation.level === "breached";
  const Icon = breached ? OctagonX : AlertTriangle;

  return (
    <div className={`guard-banner ${breached ? "breached" : "warning"}`} role="alert">
      <Icon size={16} />
      <div>
        <strong>
          {breached
            ? "Funded guard breached — stop trading."
            : evaluation.level === "danger"
              ? "Funded guard danger — daily limit almost gone."
              : "Funded guard caution."}
        </strong>
        <span>{evaluation.message}</span>
        <span className="guard-banner-sub">
          Daily: ${evaluation.dailyLossLimit.toLocaleString("en-US", { maximumFractionDigits: 2 })} limit ·{" "}
          ${evaluation.dailyRemaining.toLocaleString("en-US", { maximumFractionDigits: 2 })} left ·{" "}
          Max DD floor: ${evaluation.maxDrawdownFloor.toLocaleString("en-US", { maximumFractionDigits: 2 })}
        </span>
      </div>
    </div>
  );
}
