// Testing Mode discriminator for the canonical Trade model.
//
// Every trade row carries exactly one environment. 'LIVE' is the default for
// every existing row and every historical write path, so the Live trade log
// keeps working exactly as before. 'TESTING' marks manually-recorded
// forward-testing trades, which are otherwise the exact same trade model —
// same fields, same form, same log — with results in pips and no
// Psychology/Emotions section.
export const TRADE_ENVIRONMENTS = ["LIVE", "TESTING"] as const;

export type TradeEnvironment = (typeof TRADE_ENVIRONMENTS)[number];

export const DEFAULT_TRADE_ENVIRONMENT: TradeEnvironment = "LIVE";

export function isTradeEnvironment(value: unknown): value is TradeEnvironment {
  return value === "LIVE" || value === "TESTING";
}

/** Server-side default: a write that names no environment lands in Live. */
export function normalizeTradeEnvironment(value: unknown): TradeEnvironment {
  return isTradeEnvironment(value) ? value : DEFAULT_TRADE_ENVIRONMENT;
}
