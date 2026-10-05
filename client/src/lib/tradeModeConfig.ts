import type { TradeEnvironment } from "@shared/tradeEnvironment";

/**
 * The behavioral difference set between Live and Testing mode.
 *
 * Every component that differs between modes takes `mode?: TradeModeConfig`
 * and defaults to `LIVE_MODE`, so all existing call sites keep working with
 * zero changes — that default IS the Live-regression guarantee.
 *
 * - LIVE: the current application, unchanged ($ P&L, Psychology/Emotions, MT5).
 * - TESTING: the same Trade Log functionality reused for manual forward
 *   testing (pips P&L, no Psychology/Emotions, MT5 disabled).
 */
export type TradeModeConfig = {
  environment: TradeEnvironment;
  /** Which unit the stored `pnl` number represents. */
  pnlUnit: "money" | "pips";
  /** Live shows the Emotions/Psychology sections; Testing hides them. */
  showPsychology: boolean;
  /** Live may link MT5 tickets; Testing is manual-only. */
  allowMt5: boolean;
  /** Column header text for the result column. */
  pnlColumnLabel: string;
};

export const LIVE_MODE: TradeModeConfig = {
  environment: "LIVE",
  pnlUnit: "money",
  showPsychology: true,
  allowMt5: true,
  pnlColumnLabel: "P&L",
};

export const TESTING_MODE: TradeModeConfig = {
  environment: "TESTING",
  pnlUnit: "pips",
  showPsychology: false,
  allowMt5: false,
  pnlColumnLabel: "Pips",
};

export function modeFor(environment: TradeEnvironment): TradeModeConfig {
  return environment === "TESTING" ? TESTING_MODE : LIVE_MODE;
}

/** localStorage key for the persisted LIVE | TESTING selection. */
export const TRADE_ENV_STORAGE_KEY = "gj:tradeEnv";

/** The currently selected trade environment, read from persisted state. */
export function readTradeEnv(): TradeEnvironment {
  try {
    return window.localStorage.getItem(TRADE_ENV_STORAGE_KEY) === "TESTING" ? "TESTING" : "LIVE";
  } catch {
    return "LIVE";
  }
}

/** The mode config matching the persisted LIVE | TESTING selection. */
export function currentTradeMode(): TradeModeConfig {
  return modeFor(readTradeEnv());
}
