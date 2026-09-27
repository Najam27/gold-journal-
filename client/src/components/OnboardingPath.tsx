import React, { useMemo } from "react";
import { Footprints, X } from "lucide-react";
import { onboardingProgress, type OnboardingTradeInput } from "@/lib/onboarding";

/**
 * "First 30 trades" onboarding path. Three phases:
 * 1. Just log — 10 trades, speed over detail.
 * 2. Add the why — 10 detailed trades (mistake, note, feeling, plan score).
 * 3. Review & plan — one weekly review + one trading plan.
 * Compact, dismissible once complete.
 */
export function OnboardingPath({
  trades,
  weeklyReviewCount,
  planCount,
}: {
  trades: OnboardingTradeInput[];
  weeklyReviewCount: number;
  planCount: number;
}) {
  const [dismissed, setDismissed] = React.useState(false);
  const progress = useMemo(
    () => onboardingProgress({ trades, weeklyReviewCount, planCount }),
    [trades, weeklyReviewCount, planCount],
  );

  if (dismissed || progress.complete) return null;

  return (
    <div className="onboarding-path" role="region" aria-label="First 30 trades">
      <header>
        <span><Footprints size={15} /> Your first 30 trades</span>
        <button type="button" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X size={14} />
        </button>
      </header>
      <div className="onboarding-phases">
        {progress.phases.map(phase => (
          <div key={phase.id} className={`onboarding-phase${phase.complete ? " complete" : ""}`}>
            <div className="onboarding-bar">
              <i style={{ width: `${phase.target > 0 ? Math.min(100, (phase.done / phase.target) * 100) : 0}%` }} />
            </div>
            <strong>{phase.title}</strong>
            <span>{phase.done}/{phase.target} · {phase.description}</span>
          </div>
        ))}
      </div>
      <p className="onboarding-next">{progress.nextAction}</p>
    </div>
  );
}
