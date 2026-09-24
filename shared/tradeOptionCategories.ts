/**
 * The single canonical registry of reusable Trade Log options.
 *
 * Before this module existed, every dropdown mixed two sources: hard-coded
 * arrays in the Trade dialog and rows in `gj_option_lists`. That made default
 * values impossible to rename, disable, or manage, and it meant a renamed
 * default silently disappeared from the form.
 *
 * Now:
 *   • `defaults` are only SEED definitions. They are written into
 *     `gj_option_lists` once per user (idempotently) and from that moment on the
 *     database row is the authoritative option: editable, disableable, and
 *     renameable like any custom value.
 *   • every UI surface (Trade dialog, Trade Log manager, Options page, server
 *     validation) reads this registry instead of scattering category strings.
 *
 * `category` is the persisted value of `gj_option_lists.category` and matches
 * the strings the journal has always stored, so existing rows keep working.
 */

import { MISTAKE_TAXONOMY } from "./psychologyEngine";

export type TradeOptionCategory = {
  /** Stable code identifier used by the UI and analytics. */
  key: string;
  /** Persisted `gj_option_lists.category` value (historical string). */
  category: string;
  /** Human label rendered in the form and the manager. */
  label: string;
  /** Guided copy for the options manager. */
  description: string;
  /** Seed definitions only — never the runtime source of truth. */
  defaults: readonly string[];
  /** Multi-select fields store a pipe-separated list. */
  multi: boolean;
  /** Trade form field this category feeds, when it feeds one. */
  field: TradeOptionField | null;
};

export type TradeOptionField =
  | "session"
  | "level"
  | "timeframe"
  | "setupQuality"
  | "executionType"
  | "marketCondition"
  | "biasAlignment"
  | "confirmationType"
  | "slPlacement"
  | "tpPlacement"
  | "mistake"
  | "holdQuality";

export const TRADE_OPTION_CATEGORIES: readonly TradeOptionCategory[] = [
  {
    key: "session",
    category: "Session",
    label: "Session",
    description: "Trading sessions you record against a trade.",
    defaults: ["Pre-Asian", "Asian", "Post-Asian", "Pre-London", "London", "Post-London", "Pre-NY", "New York", "Post-NY"],
    multi: false,
    field: "session",
  },
  {
    key: "level",
    category: "Level",
    label: "Level / confluence",
    description: "Levels and confluence models used for entries.",
    defaults: ["SBR/TJL1", "RBS/TJL1", "TJL2", "QML", "FIB", "LVL4", "LVL2"],
    multi: true,
    field: "level",
  },
  {
    key: "timeframe",
    category: "Timeframe",
    label: "Timeframe",
    description: "Chart timeframes you analyse a setup on.",
    defaults: ["1m", "5m", "15m", "H1", "4H"],
    multi: false,
    field: "timeframe",
  },
  {
    key: "setupQuality",
    category: "Setup quality",
    label: "Setup quality",
    description: "Your setup grading scale. Rename A+ to match your own language.",
    defaults: ["A+", "A", "B"],
    multi: false,
    field: "setupQuality",
  },
  {
    key: "executionType",
    category: "Execution type",
    label: "Execution type",
    description: "How the entry was actually executed.",
    defaults: ["Manual Direct", "Limit Order", "Stop Order", "Manual After Confirmation"],
    multi: false,
    field: "executionType",
  },
  {
    key: "marketCondition",
    category: "Market condition",
    label: "Market conditions",
    description: "The market context the trade was taken in.",
    defaults: ["Trending", "Ranging", "Volatile", "News-driven", "Low liquidity"],
    multi: true,
    field: "marketCondition",
  },
  {
    key: "biasAlignment",
    category: "Bias alignment",
    label: "Direction vs bias",
    description: "Whether the trade agreed with your higher-timeframe bias.",
    defaults: ["Aligned", "Counter-trend", "Neutral"],
    multi: false,
    field: "biasAlignment",
  },
  {
    key: "confirmation",
    category: "Confirmation",
    label: "Confirmation signals",
    description: "Confirmation triggers that validated the entry.",
    defaults: ["BOS", "CHoCH", "Liquidity sweep", "Engulfing", "Rejection", "Displacement"],
    multi: true,
    field: "confirmationType",
  },
  {
    key: "slPlacement",
    category: "SL placement",
    label: "SL placement",
    description: "Where the stop loss was placed.",
    defaults: ["Below swing", "Above swing", "Structure", "Fixed points"],
    multi: false,
    field: "slPlacement",
  },
  {
    key: "tpPlacement",
    category: "TP placement",
    label: "TP placement",
    description: "What the target was based on.",
    defaults: ["Prior high", "Prior low", "Liquidity", "R multiple"],
    multi: false,
    field: "tpPlacement",
  },
  {
    key: "mistake",
    category: "Mistake",
    label: "Mistake / rule-break tags",
    description:
      "The behavioural mistake taxonomy. Built-in tags can be renamed or disabled; psychology detection keeps matching their documented aliases.",
    defaults: MISTAKE_TAXONOMY.map(item => item.label),
    multi: true,
    field: "mistake",
  },
  {
    key: "holdQuality",
    category: "Hold quality",
    label: "Hold quality",
    description: "How well the position was managed after entry.",
    defaults: ["Excellent", "Good", "Average", "Poor"],
    multi: false,
    field: "holdQuality",
  },
  {
    key: "tradingRule",
    category: "Trading rule",
    label: "Trading rules",
    description: "Reusable rules used by the Plan & Execution checklists.",
    defaults: [],
    multi: true,
    field: null,
  },
];

export const TRADE_OPTION_CATEGORY_BY_KEY: Record<string, TradeOptionCategory> = Object.fromEntries(
  TRADE_OPTION_CATEGORIES.map(entry => [entry.key, entry])
);

export const TRADE_OPTION_CATEGORY_BY_CATEGORY: Record<string, TradeOptionCategory> = Object.fromEntries(
  TRADE_OPTION_CATEGORIES.map(entry => [entry.category, entry])
);

/** Resolves a category by its stable key or its persisted label. */
export function tradeOptionCategory(identifier: string): TradeOptionCategory | undefined {
  return TRADE_OPTION_CATEGORY_BY_KEY[identifier] ?? TRADE_OPTION_CATEGORY_BY_CATEGORY[identifier];
}

/** Category keys that back a Trade Log dropdown, in form order. */
export const TRADE_FORM_OPTION_CATEGORIES: readonly TradeOptionCategory[] = TRADE_OPTION_CATEGORIES.filter(
  entry => entry.field !== null
);

/**
 * Normalised comparison form. Used for duplicate prevention so "A", "a",
 * " A " and "A  " can never become separate options in the same category.
 */
export function normalizeTradeOptionValue(value: string): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Deterministic 32-bit FNV-1a digest, used to keep seed keys collision-free. */
function seedDigest(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Deterministic seed key. It is derived from the category plus the original
 * default label, but it is stored, so renaming the option never re-creates the
 * original default on the next seed pass.
 *
 * The digest is not decoration: a slug alone maps both "A+" and "A" to "a",
 * which would make two distinct defaults share one seed key and silently drop
 * the second one on a unique-key conflict.
 */
export function tradeOptionSeedKey(category: string, value: string): string {
  const normalizedValue = normalizeTradeOptionValue(value);
  const slug = normalizedValue
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const categorySlug = normalizeTradeOptionValue(category)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `default:${categorySlug}:${slug || "value"}:${seedDigest(`${categorySlug}:${normalizedValue}`)}`;
}

/** Seed definitions for one category, by persisted category label. */
export function tradeOptionDefaults(category: string): readonly string[] {
  return TRADE_OPTION_CATEGORY_BY_CATEGORY[category]?.defaults ?? [];
}

/**
 * Validates a value for a category, returning a helpful error or null.
 *
 * Only emptiness is rejected. An option label is free text — a trader may name a
 * setup, a mistake, or a rule at whatever length the idea needs — so there is no
 * character budget here. Duplicate detection (case/whitespace-insensitive, via
 * `normalizeTradeOptionValue`) still runs, and the category must exist in the
 * registry, so no invalid category can be injected.
 */
export function validateTradeOptionValue(category: string, value: string): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "Enter a name for this option.";
  if (!TRADE_OPTION_CATEGORY_BY_CATEGORY[category]) {
    return `“${category}” is not a manageable Trade Log option category.`;
  }
  return null;
}
