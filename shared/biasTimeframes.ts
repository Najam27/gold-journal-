// Multi-timeframe Bias for the Trade Log.
//
// Replaces the old free-text "Direction vs bias" (biasAlignment) concept.
// Bias is market context only: five fixed timeframes, each Bull or Bear.
// It never changes trade Direction and carries no percentages, neutrals,
// strength ratings, or strategy interpretation.
//
// Storage: gj_trades.biasTimeframes (jsonb, nullable). The legacy
// biasAlignment text column is preserved untouched for history and is never
// reinterpreted as per-timeframe bias.
export const BIAS_TIMEFRAMES = ["D1", "H4", "H1", "M15", "M5"] as const;

export type BiasTimeframe = (typeof BIAS_TIMEFRAMES)[number];

export const BIAS_SIDES = ["Bull", "Bear"] as const;

export type BiasSide = (typeof BIAS_SIDES)[number];

/** Structured bias: each timeframe maps to Bull, Bear, or null (unset). */
export type BiasTimeframes = Record<BiasTimeframe, BiasSide | null>;

export function emptyBiasTimeframes(): BiasTimeframes {
  return { D1: null, H4: null, H1: null, M15: null, M5: null };
}

export function isBiasTimeframe(value: unknown): value is BiasTimeframe {
  return (BIAS_TIMEFRAMES as readonly string[]).includes(value as string);
}

export function isBiasSide(value: unknown): value is BiasSide {
  return value === "Bull" || value === "Bear";
}

/**
 * Normalize unknown input (DB jsonb, API payload, form state) into a
 * BiasTimeframes object. Unknown keys are dropped; invalid sides become
 * null. Never throws — returns an empty structure for anything unshaped.
 */
export function normalizeBiasTimeframes(value: unknown): BiasTimeframes {
  const out = emptyBiasTimeframes();
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const record = value as Record<string, unknown>;
  for (const tf of BIAS_TIMEFRAMES) {
    const side = record[tf];
    out[tf] = isBiasSide(side) ? side : null;
  }
  return out;
}

/** True when at least one timeframe has a side set. */
export function hasBias(bias: BiasTimeframes): boolean {
  return BIAS_TIMEFRAMES.some(tf => bias[tf] !== null);
}

/**
 * Compact display for tables and cards: "D1 Bull · H4 Bear · M5 Bull".
 * Returns null when nothing is set (caller renders the missing marker).
 */
export function formatBiasCompact(bias: BiasTimeframes): string | null {
  const parts = BIAS_TIMEFRAMES.filter(tf => bias[tf] !== null).map(
    tf => `${tf} ${bias[tf]}`
  );
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Full display for View/PDF/Share parity: one "D1: Bull" entry per set
 * timeframe, in D1 → M5 order.
 */
export function formatBiasLines(bias: BiasTimeframes): string[] {
  return BIAS_TIMEFRAMES.filter(tf => bias[tf] !== null).map(
    tf => `${tf}: ${bias[tf]}`
  );
}
