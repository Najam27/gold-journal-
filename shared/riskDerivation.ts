// Pure risk derivations shared by client and server.
//
// Two concepts are kept strictly separate:
// - Price-distance risk/reward: derivable from direction + entry/SL/TP alone.
//   Always non-negative; direction only decides which side of entry SL/TP sit on.
// - Dollar risk/reward: requires real position size and instrument specs.
//   NEVER derived from price distance alone — absence is reported, not invented.

export type TradeDirection = "BUY" | "SELL";

export interface RiskDistances {
  /** absolute(Entry - SL): null when entry or SL is missing */
  riskDistance: number | null;
  /** absolute(TP - Entry): null when entry or TP is missing */
  rewardDistance: number | null;
  /** rewardDistance / riskDistance: null unless both are positive */
  rrRatio: number | null;
  /** SL on the wrong side of entry for the direction (or entry missing) */
  slValid: boolean;
  /** TP on the wrong side of entry for the direction (or entry missing) */
  tpValid: boolean;
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive price-distance risk/reward from direction + entry/SL/TP.
 * BUY:  risk = Entry - SL,   reward = TP - Entry
 * SELL: risk = SL - Entry,    reward = Entry - TP
 * Distances are absolute so SELL never yields a negative risk/reward.
 */
export function deriveRiskDistances(
  direction: unknown,
  entry: unknown,
  sl: unknown,
  tp: unknown
): RiskDistances {
  const dir: TradeDirection | null =
    direction === "BUY" ? "BUY" : direction === "SELL" ? "SELL" : null;
  const e = toNum(entry);
  const s = toNum(sl);
  const t = toNum(tp);

  let riskDistance: number | null = null;
  let rewardDistance: number | null = null;
  let slValid = true;
  let tpValid = true;

  if (dir && e !== null) {
    if (s !== null) {
      const raw = dir === "BUY" ? e - s : s - e;
      // Wrong side (or exactly at entry): distance is still reported as an
      // absolute magnitude, but the side is flagged invalid.
      if (raw <= 0) slValid = false;
      riskDistance = Math.abs(raw);
    }
    if (t !== null) {
      const raw = dir === "BUY" ? t - e : e - t;
      if (raw <= 0) tpValid = false;
      rewardDistance = Math.abs(raw);
    }
  } else {
    // Without direction + entry there is no frame of reference at all.
    if (dir === null || e === null) {
      slValid = s === null;
      tpValid = t === null;
    }
  }

  const rrRatio =
    riskDistance !== null &&
    rewardDistance !== null &&
    riskDistance > 0 &&
    rewardDistance > 0
      ? rewardDistance / riskDistance
      : null;

  return { riskDistance, rewardDistance, rrRatio, slValid, tpValid };
}

/** "1 : 2.00" style; null when the ratio cannot be computed. */
export function formatDerivedRr(rrRatio: number | null): string | null {
  if (rrRatio === null || !Number.isFinite(rrRatio) || rrRatio <= 0) return null;
  return `1 : ${rrRatio.toFixed(2)}`;
}

/**
 * Normalize a tracked excursion into a positive magnitude for display and
 * storage. MT5 tracks signed extremes (mfeUsd = max floating P&L, maeUsd =
 * min floating P&L). Display convention is magnitudes: MFE $250, MAE $180.
 * - MFE: highest gain reached; a position that never went positive has $0 gain.
 * - MAE: worst loss experienced; a position that never went negative has $0 loss.
 * - null (never tracked): stays null — never fabricated.
 */
export function normalizeMfe(mfeUsd: unknown): number | null {
  const n = toNum(mfeUsd);
  if (n === null) return null;
  return Math.max(0, n);
}

export function normalizeMae(maeUsd: unknown): number | null {
  const n = toNum(maeUsd);
  if (n === null) return null;
  return Math.abs(Math.min(0, n));
}

/** Positive-magnitude money: "$180.00". Null/blank → null. */
export function formatMagnitude(value: unknown): string | null {
  const n = toNum(value);
  if (n === null) return null;
  const magnitude = Math.abs(n);
  return `$${magnitude.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** MFE magnitude with explicit gain sign: "+$250.00". */
export function formatMfe(value: unknown): string | null {
  const formatted = formatMagnitude(value);
  return formatted ? `+${formatted}` : null;
}
