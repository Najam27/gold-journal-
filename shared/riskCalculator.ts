export type RiskBasis = "EQUITY" | "BALANCE";
export type RiskInput = { riskPercent: number; entryPrice: number; stopLoss: number; basis: RiskBasis };
export type BrokerRiskSpec = { symbol: string; tickSize: number; tickValueLoss: number; contractSize: number; volumeMin: number; volumeMax: number; volumeStep: number };
export type AccountRiskSnapshot = { balance: number; equity: number; margin: number; freeMargin: number; currency: string | null };
export type RiskCalculation = { valid: boolean; basis: RiskBasis; capital: number; freeMargin: number; riskPercent: number; riskAmount: number; stopDistance: number; stopTicks: number; lossPerLot: number; rawLots: number; lots: number; actualRisk: number; riskBudgetUtilization: number; freeMarginRiskPercent: number | null; symbol: string | null; currency: string | null; warnings: string[]; verification: string[] };

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const floorToStep = (value: number, step: number) => Math.floor((value + Number.EPSILON * 16) / step) * step;
const round = (value: number, decimals = 8) => Number(value.toFixed(decimals));

export function calculateRisk(input: RiskInput, account: AccountRiskSnapshot | null, spec: BrokerRiskSpec | null): RiskCalculation {
  const warnings: string[] = []; const verification = ["Confirm the selected MT5 symbol and contract values in your terminal before placing any order.", "This calculator does not check broker order-margin requirements or place a trade."];
  const capital = account ? (input.basis === "EQUITY" ? account.equity : account.balance) : 0;
  const base = { valid: false, basis: input.basis, capital: round(capital, 2), freeMargin: round(account?.freeMargin ?? 0, 2), riskPercent: round(input.riskPercent, 4), riskAmount: 0, stopDistance: 0, stopTicks: 0, lossPerLot: 0, rawLots: 0, lots: 0, actualRisk: 0, riskBudgetUtilization: 0, freeMarginRiskPercent: null as number | null, symbol: spec?.symbol ?? null, currency: account?.currency ?? null, warnings, verification };
  if (!account) { warnings.push("Live MT5 account metrics are unavailable. Wait for the EA summary event."); return base; }
  if (!spec) { warnings.push("Broker symbol specifications are unavailable. Update the Gold Journal EA v2.3 and keep its selected RiskSymbol visible in MT5."); return base; }
  if (!finitePositive(capital)) { warnings.push("Selected account capital must be positive."); return base; }
  if (!finitePositive(input.riskPercent) || input.riskPercent > 10) { warnings.push("Risk percentage must be greater than 0% and no higher than 10%."); return base; }
  if (!finitePositive(input.entryPrice) || !finitePositive(input.stopLoss) || input.entryPrice === input.stopLoss) { warnings.push("Enter a valid entry and a different stop-loss price."); return base; }
  if (![spec.tickSize, spec.tickValueLoss, spec.contractSize, spec.volumeMin, spec.volumeMax, spec.volumeStep].every(finitePositive) || spec.volumeMax < spec.volumeMin) { warnings.push("MT5 reported incomplete or invalid broker symbol constraints."); return base; }
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss); const stopTicks = stopDistance / spec.tickSize; const lossPerLot = stopTicks * spec.tickValueLoss; const riskAmount = capital * input.riskPercent / 100;
  if (!finitePositive(lossPerLot) || !finitePositive(riskAmount)) { warnings.push("Risk amount or loss-per-lot could not be calculated."); return base; }
  const rawLots = riskAmount / lossPerLot;
  if (rawLots < spec.volumeMin) { warnings.push(`The calculated volume is below this broker's minimum of ${spec.volumeMin}. Reduce stop distance or use a smaller risk amount only after reviewing your plan.`); return { ...base, riskAmount: round(riskAmount, 2), stopDistance: round(stopDistance), stopTicks: round(stopTicks), lossPerLot: round(lossPerLot, 4), rawLots: round(rawLots) }; }
  const lots = Math.min(spec.volumeMax, floorToStep(rawLots, spec.volumeStep)); const actualRisk = lots * lossPerLot;
  if (account.freeMargin <= 0) warnings.push("Free margin is not positive. Do not rely on this result until the broker account state is reviewed.");
  if (lots < spec.volumeMin) warnings.push("Rounding to the broker volume step made the volume too small for this broker.");
  if (rawLots > spec.volumeMax) warnings.push(`The requested risk exceeds the broker's maximum volume of ${spec.volumeMax}; output is capped at that maximum.`);
  return { ...base, valid: lots >= spec.volumeMin && warnings.length === 0, riskAmount: round(riskAmount, 2), stopDistance: round(stopDistance), stopTicks: round(stopTicks), lossPerLot: round(lossPerLot, 4), rawLots: round(rawLots), lots: round(lots), actualRisk: round(actualRisk, 2), riskBudgetUtilization: round(actualRisk / riskAmount * 100, 2), freeMarginRiskPercent: account.freeMargin > 0 ? round(actualRisk / account.freeMargin * 100, 2) : null };
}
