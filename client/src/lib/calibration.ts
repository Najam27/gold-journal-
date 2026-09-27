/**
 * Calibration between the trader's self-rated plan-following score (1-5 per
 * trade, the `planFollowScore` field) and the journal's computed plan
 * adherence (0-100).
 *
 * The gap between "I thought I followed the plan" and the data is where
 * coaching lives: overconfident self-scores hide the very mistakes that cost
 * money, while underconfident ones punish discipline that actually worked.
 */


export interface CalibrationTradeInput {
  planFollowScore?: number | string | null;
}

export type CalibrationVerdict = "CALIBRATED" | "OVERCONFIDENT" | "UNDERCONFIDENT" | "INSUFFICIENT_DATA";

export interface CalibrationResult {
  /** Trades with a usable 1-5 rating. */
  sample: number;
  /** Average self-score on the 1-5 scale. */
  averageSelfScore: number | null;
  /** averageSelfScore mapped onto 0-100 for comparison (score / 5 * 100). */
  selfAdherencePct: number | null;
  /** Computed adherence passed in (0-100). */
  computedAdherencePct: number | null;
  /** selfAdherencePct - computedAdherencePct. Positive = you rate yourself higher than the data. */
  gapPoints: number | null;
  verdict: CalibrationVerdict;
  /** One honest coaching sentence. */
  message: string;
}

const MIN_SAMPLE = 5;
const CALIBRATED_WITHIN_POINTS = 10;

/** A usable self-rating: a finite number inside the 1-5 scale. */
function parseSelfScore(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(value);
  if (!Number.isFinite(score) || score < 1 || score > 5) return null;
  return score;
}

export function summarizeCalibration(
  trades: CalibrationTradeInput[],
  computedAdherencePct: number | null | undefined,
): CalibrationResult {
  const computed = typeof computedAdherencePct === "number" && Number.isFinite(computedAdherencePct) ? computedAdherencePct : null;

  const scores: number[] = [];
  if (Array.isArray(trades)) {
    for (const trade of trades) {
      const score = parseSelfScore(trade?.planFollowScore);
      if (score !== null) scores.push(score);
    }
  }
  const sample = scores.length;

  if (computed === null) {
    return {
      sample,
      averageSelfScore: null,
      selfAdherencePct: null,
      computedAdherencePct: null,
      gapPoints: null,
      verdict: "INSUFFICIENT_DATA",
      message: "No computed adherence to compare against yet — log trades with plan checks first.",
    };
  }

  if (sample < MIN_SAMPLE) {
    const needed = MIN_SAMPLE - sample;
    return {
      sample,
      averageSelfScore: null,
      selfAdherencePct: null,
      computedAdherencePct: computed,
      gapPoints: null,
      verdict: "INSUFFICIENT_DATA",
      message: `Rate your plan-following on ${needed} more trade${needed === 1 ? "" : "s"} to see how honest your self-scores are.`,
    };
  }

  const averageSelfScore = scores.reduce((sum, score) => sum + score, 0) / sample;
  // 1-5 maps linearly onto 0-100: a 5/5 self-rating means 100% adherence in
  // the trader's own mind, directly comparable to computed adherence.
  const selfAdherencePct = (averageSelfScore / 5) * 100;
  const gapPoints = selfAdherencePct - computed;

  let verdict: CalibrationVerdict;
  let message: string;
  if (Math.abs(gapPoints) <= CALIBRATED_WITHIN_POINTS) {
    verdict = "CALIBRATED";
    message = "Your self-scores line up with the journal's numbers — keep rating yourself this honestly.";
  } else if (gapPoints > 0) {
    verdict = "OVERCONFIDENT";
    message = `You rate yourself ${gapPoints.toFixed(0)} points higher than the journal shows. Either the ratings are generous or the plan has leaks you're not admitting.`;
  } else {
    verdict = "UNDERCONFIDENT";
    message = `You're ${Math.abs(gapPoints).toFixed(0)} points harder on yourself than the journal is. Your execution is better than you think — stop grading on vibes.`;
  }

  return {
    sample,
    averageSelfScore,
    selfAdherencePct,
    computedAdherencePct: computed,
    gapPoints,
    verdict,
    message,
  };
}
