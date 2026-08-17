export type GoalComparison = "GTE" | "LTE";
export type GoalStatus = "PENDING" | "AT RISK" | "MET" | "BREACHED";

// The canonical, PKT-aware trader-control calculations are in
// client/src/lib/traderGoals.ts. This compatibility helper intentionally stays
// narrow for server notification code; do not add divergent formulas here.

export function evaluateGoal(input: { value: number; target: number; comparison: GoalComparison; hasActivity: boolean }) {
  const { value, target, comparison, hasActivity } = input;
  const percentage = target > 0 ? Math.min(100, (value / target) * 100) : 0;

  if (!hasActivity) return { status: "PENDING" as GoalStatus, percentage };
  if (comparison === "GTE") {
    return { status: value >= target ? "MET" as GoalStatus : value >= target * 0.8 ? "AT RISK" as GoalStatus : "PENDING" as GoalStatus, percentage };
  }
  return { status: value > target ? "BREACHED" as GoalStatus : value >= target * 0.8 ? "AT RISK" as GoalStatus : "MET" as GoalStatus, percentage };
}
