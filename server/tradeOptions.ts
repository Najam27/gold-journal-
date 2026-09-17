/**
 * Server-side option store for the Trade Log.
 *
 * The canonical source of selectable Trade Log values is `gj_option_lists`.
 * This module owns the two things the router must never improvise:
 *
 *   1. idempotent seeding of the Gold Journal defaults, and
 *   2. normalisation / duplicate detection for values.
 *
 * Seeding is deliberately non-destructive:
 *   • a row is identified by a stored deterministic `seedKey`, so renaming a
 *     default does NOT re-create the original label on the next pass;
 *   • a default whose normalised value already exists for the category is
 *     adopted instead of duplicated;
 *   • `onConflictDoNothing` plus a per-row fallback keeps concurrent requests
 *     from producing duplicates in the `gj_option_list_unique` index.
 */

import { and, eq } from "./supabaseQuery";
import { getDb } from "./db";
import { optionLists } from "../drizzle/schema";
import {
  TRADE_OPTION_CATEGORIES,
  normalizeTradeOptionValue,
  tradeOptionCategory,
  tradeOptionSeedKey,
  validateTradeOptionValue,
  type TradeOptionCategory,
} from "@shared/tradeOptionCategories";

export type TradeOptionRow = {
  id: number;
  category: string;
  value: string;
  active: boolean;
  isDefault?: boolean;
  normalizedValue?: string | null;
  seedKey?: string | null;
};

export type TradeOptionView = {
  id: number;
  category: string;
  value: string;
  active: boolean;
  isDefault: boolean;
};

/** Public shape sent to the browser. Internal seed metadata never leaves the server. */
export function toTradeOptionView(row: TradeOptionRow): TradeOptionView {
  return {
    id: Number(row.id),
    category: String(row.category),
    value: String(row.value),
    active: Boolean(row.active),
    isDefault: Boolean(row.isDefault),
  };
}

/** Resolves the registry entry for a category, or throws a user-facing error. */
export function requireTradeOptionCategory(category: string): TradeOptionCategory {
  const normalized = String(category ?? "").trim();
  const definition = tradeOptionCategory(normalized);
  if (!definition) throw new Error(`“${normalized || "Unknown"}” is not a manageable Trade Log option category.`);
  return definition;
}

/** Validates a value against its category, returning a message or null. */
export function tradeOptionValueError(category: string, value: string): string | null {
  return validateTradeOptionValue(category, value);
}

async function db() {
  const database = await getDb();
  if (!database) throw new Error("Supabase database is unavailable. Please retry shortly.");
  return database;
}

const OPTION_COLUMNS = {
  id: optionLists.id,
  category: optionLists.category,
  value: optionLists.value,
  active: optionLists.active,
  isDefault: optionLists.isDefault,
  normalizedValue: optionLists.normalizedValue,
  seedKey: optionLists.seedKey,
};

async function listOwnedOptions(userId: number, category?: string): Promise<TradeOptionRow[]> {
  const database = await db();
  const filter = category ? and(eq(optionLists.userId, userId), eq(optionLists.category, category)) : eq(optionLists.userId, userId);
  const rows = await database.select(OPTION_COLUMNS).from(optionLists).where(filter).orderBy(optionLists.category, optionLists.value).limit(1000);
  return rows as TradeOptionRow[];
}

/**
 * Users already seeded in this process. The database check is still the source
 * of truth; this only removes a repeat round-trip on every Trade Log open.
 */
const seededUsers = new Set<number>();

/**
 * Seeds the Gold Journal defaults for one user exactly once.
 *
 * Safe to call on every read: if any seeded row already exists the function
 * returns after a single query, and a fully-seeded user costs one query per
 * process lifetime.
 */
export async function ensureDefaultTradeOptions(userId: number): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) return;
  if (seededUsers.has(userId)) return;
  const database = await db();
  const existing = (await database.select(OPTION_COLUMNS).from(optionLists).where(eq(optionLists.userId, userId)).limit(1000)) as TradeOptionRow[];
  if (existing.some(row => row.isDefault)) {
    seededUsers.add(userId);
    return;
  }

  const knownSeedKeys = new Set(existing.map(row => row.seedKey).filter((key): key is string => Boolean(key)));

  for (const definition of TRADE_OPTION_CATEGORIES) {
    if (!definition.defaults.length) continue;
    const pending: Record<string, unknown>[] = [];
    for (const value of definition.defaults) {
      const normalizedValue = normalizeTradeOptionValue(value);
      const seedKey = tradeOptionSeedKey(definition.category, value);
      if (knownSeedKeys.has(seedKey)) continue;
      // A value the trader already created (or that an earlier release stored)
      // is ADOPTED as the Gold Journal default instead of being duplicated. Its
      // `active` flag is left exactly as it was, so a value the trader had
      // already disabled can never be silently re-enabled by a seed pass.
      const adopted = existing.find(
        row => row.category === definition.category && (row.normalizedValue ?? normalizeTradeOptionValue(row.value)) === normalizedValue
      );
      if (adopted) {
        knownSeedKeys.add(seedKey);
        if (!adopted.isDefault || adopted.seedKey !== seedKey) {
          await database
            .update(optionLists)
            .set({ isDefault: true, seedKey })
            .where(and(eq(optionLists.id, adopted.id), eq(optionLists.userId, userId)));
        }
        continue;
      }
      pending.push({ userId, category: definition.category, value, normalizedValue, isDefault: true, seedKey, active: true });
    }
    if (!pending.length) continue;
    try {
      await database.insert(optionLists).values(pending).onConflictDoNothing({ target: [optionLists.userId, optionLists.category, optionLists.value] });
    } catch {
      // A concurrent request (or a pre-existing row with another unique index)
      // rejected the batch: retry row by row so one collision cannot lose the
      // rest of the defaults. Every failure here means "already present".
      for (const row of pending) {
        try {
          await database.insert(optionLists).values(row).onConflictDoNothing({ target: [optionLists.userId, optionLists.category, optionLists.value] });
        } catch {
          // Already created elsewhere; the canonical row exists.
        }
      }
    }
  }
  seededUsers.add(userId);
}

/**
 * Finds an option in the same category whose normalised value matches.
 * Comparison runs in application code so a single query covers every row of the
 * category regardless of case, whitespace, or locale.
 */
export async function findTradeOptionByNormalizedValue(
  userId: number,
  category: string,
  normalizedValue: string,
  excludeOptionId?: number
): Promise<TradeOptionRow | undefined> {
  const rows = await listOwnedOptions(userId, category);
  return rows.find(
    row => (row.normalizedValue ?? normalizeTradeOptionValue(row.value)) === normalizedValue && Number(row.id) !== Number(excludeOptionId ?? 0)
  );
}

/** Loads one option, enforcing ownership on the server. */
export async function findOwnedTradeOption(userId: number, optionId: number): Promise<TradeOptionRow | undefined> {
  const database = await db();
  const rows = await database.select(OPTION_COLUMNS).from(optionLists).where(and(eq(optionLists.id, optionId), eq(optionLists.userId, userId))).limit(1);
  return (rows as TradeOptionRow[])[0];
}

export { OPTION_COLUMNS, listOwnedOptions };
