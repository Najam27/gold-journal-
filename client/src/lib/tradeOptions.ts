/**
 * Client helpers for the canonical Trade Log option store.
 *
 * The server is the single source of truth (`optionLists.list`). Everything the
 * Trade dialog, the Trade Log manager, and the Options page need is derived from
 * that one cached query, so a rename or a new option appears everywhere without
 * a page reload and without a request per dropdown.
 *
 * Historical/compatibility rules implemented here:
 *   • a recorded value with no matching option is never hidden or blanked — it
 *     is rendered as "<value> — Archived" so an old trade stays editable;
 *   • archived (disabled) options are excluded from NEW selections but stay
 *     selectable when a trade already carries them;
 *   • multi-select fields keep the existing pipe-separated storage format.
 */

import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { normalizeTradeOptionValue, tradeOptionDefaults } from "@shared/tradeOptionCategories";

export type JournalOption = {
  id: number;
  category: string;
  value: string;
  active: boolean;
  isDefault: boolean;
};

export type TradeOptionStore = {
  options: JournalOption[];
  isLoading: boolean;
  isError: boolean;
  /** True once the canonical store answered for this session. */
  isReady: boolean;
};

/** Shape of the row the server sends (defensive: the query is untyped here). */
function toJournalOption(row: any): JournalOption {
  return {
    id: Number(row?.id ?? 0),
    category: String(row?.category ?? ""),
    value: String(row?.value ?? ""),
    active: row?.active !== false,
    isDefault: Boolean(row?.isDefault),
  };
}

/**
 * One cached query for the whole session. Every dropdown derives its choices
 * from this array instead of issuing its own request.
 */
export function useTradeOptionStore(enabled = true): TradeOptionStore {
  const query = trpc.optionLists.list.useQuery(undefined, { enabled });
  const options = useMemo<JournalOption[]>(() => (query.data ?? []).map(toJournalOption), [query.data]);
  return {
    options,
    isLoading: Boolean((query as { isLoading?: boolean }).isLoading),
    isError: Boolean((query as { error?: unknown }).error),
    isReady: Array.isArray(query.data),
  };
}

/** Options of one category, defaults first, then custom values alphabetically. */
export function optionRowsForCategory(options: readonly JournalOption[], category: string): JournalOption[] {
  return options
    .filter(option => option.category === category)
    .sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      return left.value.localeCompare(right.value, undefined, { sensitivity: "base" });
    });
}

/**
 * The values a NEW selection may offer.
 *
 * `gj_option_lists` is authoritative the moment a category has been seeded:
 * only its active rows are selectable, so a rename or a disable takes effect
 * immediately and a disabled option is never resurrected.
 *
 * The registry defaults are used ONLY for a category that has not been seeded
 * yet (a brand-new category, or a store that could not be reached), so a
 * dropdown is never empty and an offline trader can still journal. Because the
 * fallback needs zero seeded rows, disabling every default keeps them hidden.
 */
export function activeOptionValues(store: TradeOptionStore, category: string): string[] {
  const rows = store.options.filter(option => option.category === category);
  if (store.isReady && rows.some(option => option.isDefault)) {
    return rows.filter(option => option.active).map(option => option.value);
  }
  const seen = new Set<string>();
  const values: string[] = [];
  const push = (value: string) => {
    const key = normalizeTradeOptionValue(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    values.push(value);
  };
  for (const value of tradeOptionDefaults(category)) push(value);
  rows
    .filter(option => option.active)
    .sort((left, right) => left.value.localeCompare(right.value, undefined, { sensitivity: "base" }))
    .forEach(option => push(option.value));
  return values;
}

/** Splits a stored value into tokens (legacy comma/semicolon separators included). */
export function splitTradeOptionValue(value: string | null | undefined): string[] {
  return String(value ?? "")
    .split(/[|,;]+/)
    .map(token => token.trim())
    .filter(token => token && token.toLowerCase() !== "none");
}

export function joinTradeOptionValues(tokens: readonly string[]): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const token of tokens) {
    const trimmed = String(token ?? "").trim();
    if (!trimmed) continue;
    const key = normalizeTradeOptionValue(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(trimmed);
  }
  return ordered.join(" | ");
}

export function toggleTradeOptionValue(value: string, token: string): string {
  const tokens = splitTradeOptionValue(value);
  const key = normalizeTradeOptionValue(token);
  const next = tokens.some(item => normalizeTradeOptionValue(item) === key)
    ? tokens.filter(item => normalizeTradeOptionValue(item) !== key)
    : [...tokens, token];
  return joinTradeOptionValues(next);
}

export type TradeOptionChoice = { value: string; archived: boolean; selected: boolean };

/**
 * Chip/option list for a multi-select field: every active option, plus any value
 * the current trade already carries that is no longer active ("— Archived").
 */
export function tradeOptionChoices(activeValues: readonly string[], value: string | null | undefined): TradeOptionChoice[] {
  const selected = splitTradeOptionValue(value);
  const selectedKeys = new Set(selected.map(normalizeTradeOptionValue));
  const choices: TradeOptionChoice[] = activeValues.map(item => ({ value: item, archived: false, selected: selectedKeys.has(normalizeTradeOptionValue(item)) }));
  const activeKeys = new Set(activeValues.map(normalizeTradeOptionValue));
  for (const token of selected) {
    if (activeKeys.has(normalizeTradeOptionValue(token))) continue;
    choices.push({ value: token, archived: true, selected: true });
  }
  return choices;
}

/** Options for a single-value dropdown, keeping an unmanaged recorded value visible. */
export function tradeOptionSelectChoices(activeValues: readonly string[], value: string | null | undefined): TradeOptionChoice[] {
  const current = String(value ?? "").trim();
  const choices: TradeOptionChoice[] = activeValues.map(item => ({ value: item, archived: false, selected: item === current }));
  const known = current !== "" && activeValues.some(item => normalizeTradeOptionValue(item) === normalizeTradeOptionValue(current));
  if (current !== "" && !known) choices.push({ value: current, archived: true, selected: true });
  return choices;
}

/** Adds "— Archived" to a label that is displayed for a non-active value. */
export function archivedOptionLabel(value: string): string {
  return `${value} — Archived`;
}

/** Client-side guard mirroring the server validation (fast feedback). */
export function duplicateOptionMessage(options: readonly JournalOption[], category: string, value: string): string | null {
  const key = normalizeTradeOptionValue(value);
  if (!key) return "Enter a name for this option.";
  const clash = options.find(option => option.category === category && normalizeTradeOptionValue(option.value) === key);
  return clash ? `“${clash.value}” already exists in ${category}.` : null;
}
