import React, { useMemo } from "react";
import { AlertTriangle, OctagonX, ShieldCheck } from "lucide-react";
import { evaluateGuardMode, type GuardConfig } from "@/lib/guardMode";

interface GuardTradeLike {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
}

/**
 * Live guard banner: CLEAR / WARNING / BREACHED from today's realized trades.
 * Shown on the Trade Log and anywhere else guard mode is relevant. Silence
 * when the guard is off or no limits are configured.
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
  const evaluation = useMemo(
    () => evaluateGuardMode({ trades, startingBalance, config: guardConfig }),
    [trades, startingBalance, guardConfig],
  );

  if (evaluation.status === "OFF" || evaluation.status === "CLEAR") return null;

  const breached = evaluation.status === "BREACHED";
  const reasons = [...evaluation.breached, ...evaluation.warned];
  const Icon = breached ? OctagonX : evaluation.status === "WARNING" ? AlertTriangle : ShieldCheck;

  return (
    <div className={`guard-banner ${breached ? "breached" : "warning"}`} role="alert">
      <Icon size={16} />
      <div>
        <strong>{breached ? "Guard breached — stop trading." : "Guard warning."}</strong>
        <span>{evaluation.message}</span>
        {reasons.length > 0 && (
          <ul>
            {reasons.map(reason => <li key={reason}>{reason}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}
