/**
 * Deterministic, broker-aware fixed-fractional risk sizing.
 *
 * This module is pure arithmetic. It never calls a model, never reads a
 * credential, and never guesses a broker value: every broker-sensitive number
 * arrives from the authenticated MT5 connection through the backend, and the
 * backend is the only caller that supplies it.
 *
 * The answer it produces is always the same question:
 * "Given the selected capital basis, risk percentage, entry, stop, and this
 * broker's contract specification, what position size keeps the monetary risk
 * at or below the selected limit?"
 */

export type RiskBasis = "EQUITY" | "BALANCE";
export type TradeDirection = "BUY" | "SELL";

export const RISK_PROFILE_IDS = [
  "CONSERVATIVE",
  "LOW",
  "STANDARD",
  "MODERATE",
  "HIGH",
  "CUSTOM",
] as const;
export type RiskProfileId = (typeof RISK_PROFILE_IDS)[number];

/** Custom risk is bounded so a typo can never request an unbounded loss. */
export const MIN_CUSTOM_RISK_PERCENT = 0.01;
export const MAX_CUSTOM_RISK_PERCENT = 10;

/**
 * Application presets, not universal trading advice. A preset only supplies a
 * risk percentage; it is never chosen for the user and never chosen by AI.
 */
export type RiskProfile = {
  id: RiskProfileId;
  label: string;
  riskPercent: number | null;
  description: string;
};

export const RISK_PROFILES = [
  { id: "CONSERVATIVE", label: "Conservative", riskPercent: 0.5, description: "0.50% per trade" },
  { id: "LOW", label: "Low", riskPercent: 0.75, description: "0.75% per trade" },
  { id: "STANDARD", label: "Standard", riskPercent: 1, description: "1.00% per trade" },
  { id: "MODERATE", label: "Moderate", riskPercent: 1.5, description: "1.50% per trade" },
  { id: "HIGH", label: "High", riskPercent: 2, description: "2.00% per trade" },
  { id: "CUSTOM", label: "Custom", riskPercent: null, description: "Choose your own risk percentage" },
] as const satisfies readonly RiskProfile[];

export function riskProfileById(id: RiskProfileId): RiskProfile | undefined {
  return RISK_PROFILES.find(profile => profile.id === id);
}

export type RiskInput = {
  basis: RiskBasis;
  riskProfile: RiskProfileId;
  riskPercent: number;
  direction: TradeDirection;
  entryPrice: number;
  stopLoss: number;
  takeProfit?: number | null;
};

export type BrokerRiskSpec = {
  symbol: string;
  tickSize: number;
  tickValueLoss: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
};

export type AccountRiskSnapshot = {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  currency: string | null;
};

export type RiskCalculation = {
  /** True only when broker data was usable and the final volume is executable. */
  valid: boolean;
  /** True when both account metrics and broker contract data were available. */
  dataAvailable: boolean;
  basis: RiskBasis;
  direction: TradeDirection;
  riskProfile: RiskProfileId;
  riskProfileLabel: string;
  capital: number;
  riskPercent: number;
  riskAmount: number;
  stopDistance: number;
  stopTicks: number;
  lossPerLot: number;
  rawLots: number;
  lots: number;
  actualRisk: number;
  riskBudgetUtilization: number;
  freeMargin: number;
  freeMarginRiskPercent: number | null;
  takeProfit: number | null;
  rewardDistance: number | null;
  rewardTicks: number | null;
  riskRewardRatio: number | null;
  potentialProfit: number | null;
  /** Calculated size is below the broker's minimum tradable volume. */
  belowBrokerMinimum: boolean;
  /** The final volume had to be capped at the broker's maximum. */
  cappedAtBrokerMaximum: boolean;
  /** Final executable risk is above the requested risk budget. */
  exceedsRequestedRisk: boolean;
  /** The stop sits on the expected side of the entry for this direction. */
  directionAligned: boolean;
  minimumExecutableLots: number;
  minimumExecutableRisk: number;
  symbol: string | null;
  currency: string | null;
  account: AccountRiskSnapshot | null;
  broker: BrokerRiskSpec | null;
  /** Fatal messages: the calculation is not trustworthy while these exist. */
  errors: string[];
  /** Advisory messages: the number is usable, but the trader must know this. */
  warnings: string[];
  verification: string[];
};

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const round = (value: number, decimals = 8) => Number(value.toFixed(decimals));
const percentText = (value: number) => `${Number(value.toFixed(4))}%`;

/**
 * Decimal places actually expressed by a volume step. Handles both `0.001`
 * and the exponential form a very small step stringifies to.
 */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  const exponentAt = text.indexOf("e-");
  if (exponentAt >= 0) {
    const exponent = Number(text.slice(exponentAt + 2));
    const mantissa = text.slice(0, exponentAt);
    const dot = mantissa.indexOf(".");
    const fraction = dot < 0 ? 0 : mantissa.length - dot - 1;
    return Number.isFinite(exponent) ? exponent + fraction : 0;
  }
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * Rounds a raw volume **down** to the broker's volume step.
 *
 * Integer arithmetic on the step's own precision replaces the usual
 * `value + Number.EPSILON` fudge, so 0.037 / 0.01 floors to 0.03 and
 * 0.29 / 0.01 floors to 0.29 rather than drifting to 0.28. Rounding up is
 * never allowed here: it would silently exceed the requested risk.
 */
export function floorLotsToStep(rawLots: number, volumeStep: number): number {
  if (!finitePositive(rawLots) || !finitePositive(volumeStep)) return 0;
  const decimals = Math.min(12, decimalPlaces(volumeStep));
  const scale = 10 ** decimals;
  const stepUnits = Math.round(volumeStep * scale);
  if (!Number.isFinite(stepUnits) || stepUnits <= 0) return 0;
  const rawUnits = Math.floor(rawLots * scale + 1e-9);
  const units = Math.floor(rawUnits / stepUnits) * stepUnits;
  if (!Number.isFinite(units) || units <= 0) return 0;
  return round(units / scale, decimals);
}

export function calculateRisk(
  input: RiskInput,
  account: AccountRiskSnapshot | null,
  spec: BrokerRiskSpec | null
): RiskCalculation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const verification = [
    "Confirm the selected MT5 symbol and contract values in your terminal before placing any order.",
    "Risk is your stop-loss exposure. Margin is capital reserved to hold the position — they are not the same number.",
    "This calculator does not check broker order-margin requirements, send MT5 commands, or place a trade.",
  ];

  const direction: TradeDirection = input.direction === "SELL" ? "SELL" : "BUY";
  const profile = riskProfileById(input.riskProfile);
  let riskPercent = Number(input.riskPercent);

  if (!profile) {
    errors.push("Select a valid risk profile before calculating a position size.");
  } else if (profile.riskPercent != null) {
    // Server-authoritative: a preset always resolves to its own percentage, so
    // a mismatched client value can never widen the risk budget.
    if (Number.isFinite(riskPercent) && Math.abs(riskPercent - profile.riskPercent) > 1e-9) {
      warnings.push(
        `The ${profile.label} profile stores ${percentText(profile.riskPercent)}. That profile value was used instead of the requested ${percentText(riskPercent)}.`
      );
    }
    riskPercent = profile.riskPercent;
  } else if (
    !Number.isFinite(riskPercent) ||
    riskPercent < MIN_CUSTOM_RISK_PERCENT ||
    riskPercent > MAX_CUSTOM_RISK_PERCENT
  ) {
    errors.push(
      `Custom risk must be between ${MIN_CUSTOM_RISK_PERCENT}% and ${MAX_CUSTOM_RISK_PERCENT}%.`
    );
    riskPercent = 0;
  }

  const capital = account ? (input.basis === "EQUITY" ? account.equity : account.balance) : 0;
  const takeProfitInput =
    input.takeProfit == null || !Number.isFinite(Number(input.takeProfit)) ? null : Number(input.takeProfit);

  const result: RiskCalculation = {
    valid: false,
    dataAvailable: Boolean(account && spec),
    basis: input.basis,
    direction,
    riskProfile: profile?.id ?? "CUSTOM",
    riskProfileLabel: profile?.label ?? "Custom",
    capital: round(capital, 2),
    riskPercent: round(riskPercent, 4),
    riskAmount: 0,
    stopDistance: 0,
    stopTicks: 0,
    lossPerLot: 0,
    rawLots: 0,
    lots: 0,
    actualRisk: 0,
    riskBudgetUtilization: 0,
    freeMargin: round(account?.freeMargin ?? 0, 2),
    freeMarginRiskPercent: null,
    takeProfit: takeProfitInput,
    rewardDistance: null,
    rewardTicks: null,
    riskRewardRatio: null,
    potentialProfit: null,
    belowBrokerMinimum: false,
    cappedAtBrokerMaximum: false,
    exceedsRequestedRisk: false,
    directionAligned: false,
    minimumExecutableLots: spec ? round(spec.volumeMin, 8) : 0,
    minimumExecutableRisk: 0,
    symbol: spec?.symbol ?? null,
    currency: account?.currency ?? null,
    account: account
      ? {
          balance: round(account.balance, 2),
          equity: round(account.equity, 2),
          margin: round(account.margin, 2),
          freeMargin: round(account.freeMargin, 2),
          currency: account.currency,
        }
      : null,
    broker: spec ? { ...spec } : null,
    errors,
    warnings,
    verification,
  };

  if (!account) {
    errors.push("Broker risk data unavailable. Connect MT5 to calculate broker-accurate position size.");
    return result;
  }
  if (!spec) {
    errors.push(
      "Broker symbol specifications are unavailable. Keep the MT5 EA running until its summary event reports the risk symbol."
    );
    return result;
  }
  if (!finitePositive(capital)) {
    errors.push(`The selected capital basis (${input.basis === "EQUITY" ? "equity" : "balance"}) must be positive.`);
    return result;
  }
  if (!finitePositive(input.entryPrice) || !finitePositive(input.stopLoss)) {
    errors.push("Enter a valid entry price and stop loss above zero.");
    return result;
  }
  if (input.entryPrice === input.stopLoss) {
    errors.push("Entry price and stop loss cannot be identical — the stop distance would be zero.");
    return result;
  }
  if (
    ![spec.tickSize, spec.tickValueLoss, spec.contractSize, spec.volumeMin, spec.volumeMax, spec.volumeStep].every(
      finitePositive
    ) ||
    spec.volumeMax < spec.volumeMin
  ) {
    errors.push("MT5 reported incomplete or invalid broker symbol constraints.");
    return result;
  }

  // ------------------------------------------------------------------
  // Stop distance and direction
  // ------------------------------------------------------------------
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  const expectedStopSide = direction === "BUY" ? input.stopLoss < input.entryPrice : input.stopLoss > input.entryPrice;
  result.directionAligned = expectedStopSide;
  if (!expectedStopSide) {
    warnings.push(
      direction === "BUY"
        ? "This is a BUY, but the stop loss is above the entry price. Check the direction and the stop."
        : "This is a SELL, but the stop loss is below the entry price. Check the direction and the stop."
    );
  }

  const stopTicks = stopDistance / spec.tickSize;
  const lossPerLot = stopTicks * spec.tickValueLoss;
  const riskAmount = (capital * riskPercent) / 100;

  result.stopDistance = round(stopDistance, 8);
  result.stopTicks = round(stopTicks, 6);
  result.lossPerLot = round(lossPerLot, 4);
  result.riskAmount = round(riskAmount, 2);
  result.minimumExecutableLots = round(spec.volumeMin, 8);
  result.minimumExecutableRisk = round(spec.volumeMin * lossPerLot, 2);

  if (!finitePositive(lossPerLot) || !finitePositive(riskAmount)) {
    errors.push("Risk amount or loss per lot could not be calculated from the supplied inputs.");
    return result;
  }

  // ------------------------------------------------------------------
  // Broker-aware position sizing
  // ------------------------------------------------------------------
  const rawLots = riskAmount / lossPerLot;
  result.rawLots = round(rawLots, 8);

  if (rawLots < spec.volumeMin) {
    // Never silently raise the position to the broker minimum: that would spend
    // more than the requested risk budget without the trader agreeing to it.
    result.belowBrokerMinimum = true;
    result.minimumExecutableRisk = round(spec.volumeMin * lossPerLot, 2);
    errors.push(`Calculated size: ${rawLots.toFixed(3)} lots`);
    errors.push(`Broker minimum: ${spec.volumeMin} lots`);
    errors.push(
      "Broker minimum volume is higher than your calculated risk size. Minimum broker volume would exceed your selected risk."
    );
    return result;
  }

  const steppedLots = floorLotsToStep(rawLots, spec.volumeStep);
  if (steppedLots <= 0) {
    errors.push(
      `Rounding down to this broker's volume step of ${spec.volumeStep} left no tradable volume for the requested risk.`
    );
    return result;
  }

  let lots = steppedLots;
  if (rawLots > spec.volumeMax) {
    lots = spec.volumeMax;
    result.cappedAtBrokerMaximum = true;
    warnings.push("Broker maximum volume reached.");
    warnings.push(
      `The requested risk needs more than this broker's maximum volume of ${spec.volumeMax}; the output is capped at that maximum.`
    );
  } else if (lots > spec.volumeMax) {
    lots = spec.volumeMax;
    result.cappedAtBrokerMaximum = true;
    warnings.push("Broker maximum volume reached.");
  }

  const actualRisk = lots * lossPerLot;
  result.lots = round(lots, Math.min(8, decimalPlaces(spec.volumeStep)));
  result.actualRisk = round(actualRisk, 2);
  result.riskBudgetUtilization = round((actualRisk / riskAmount) * 100, 2);
  if (account.freeMargin > 0) {
    result.freeMarginRiskPercent = round((actualRisk / account.freeMargin) * 100, 2);
  } else {
    warnings.push(
      "Free margin is not positive. Risk and margin are different things, but review the broker account state before acting."
    );
  }

  if (actualRisk > riskAmount + 1e-9) {
    result.exceedsRequestedRisk = true;
    warnings.push(
      `Actual risk ${actualRisk.toFixed(2)} ${account.currency ?? ""}`.trim() +
        ` is above the requested ${riskAmount.toFixed(2)} ${account.currency ?? ""}`.trim() +
        ". Reduce the position or widen the stop before acting."
    );
  }

  // ------------------------------------------------------------------
  // Optional take profit — never changes the risk amount
  // ------------------------------------------------------------------
  if (takeProfitInput != null) {
    if (!finitePositive(takeProfitInput)) {
      warnings.push("Take profit must be above zero. Reward metrics were skipped.");
    } else if (takeProfitInput === input.entryPrice) {
      warnings.push("Take profit equals the entry price, so reward metrics were skipped.");
    } else {
      const expectedTargetSide =
        direction === "BUY" ? takeProfitInput > input.entryPrice : takeProfitInput < input.entryPrice;
      if (!expectedTargetSide) {
        warnings.push(
          direction === "BUY"
            ? "This is a BUY, but the take profit is below the entry price. Check the target."
            : "This is a SELL, but the take profit is above the entry price. Check the target."
        );
      }
      const rewardDistance = Math.abs(takeProfitInput - input.entryPrice);
      const rewardTicks = rewardDistance / spec.tickSize;
      result.rewardDistance = round(rewardDistance, 8);
      result.rewardTicks = round(rewardTicks, 6);
      result.riskRewardRatio = round(rewardDistance / stopDistance, 4);
      result.potentialProfit = round(result.lots * rewardTicks * spec.tickValueLoss, 2);
    }
  }

  result.valid = errors.length === 0 && result.lots >= spec.volumeMin;
  return result;
}
