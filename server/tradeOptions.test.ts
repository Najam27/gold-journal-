import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRADE_OPTION_CATEGORIES, normalizeTradeOptionValue, tradeOptionSeedKey } from "@shared/tradeOptionCategories";

type Row = {
  id: number;
  userId: number;
  category: string;
  value: string;
  normalizedValue: string;
  isDefault: boolean;
  seedKey: string | null;
  active: boolean;
};

type Filter = { kind: string; column?: string; value?: unknown; parts?: Filter[] };

const store = vi.hoisted(() => ({ rows: [] as Row[], nextId: 1 }));

vi.mock("./db", () => ({ getDb: async () => fakeDatabase() }));

/*
 * In-memory stand-in for the Supabase query adapter. It applies the real
 * `eq`/`and` filter objects so ownership scoping is genuinely exercised, and it
 * enforces the two uniqueness rules the table declares:
 * (userId, category, value) and (userId, seedKey).
 */
function fakeDatabase() {
  const matches = (row: Row, filter?: Filter): boolean => {
    if (!filter) return true;
    if (filter.kind === "and") return (filter.parts ?? []).every(part => matches(row, part));
    if (filter.kind === "or") return (filter.parts ?? []).some(part => matches(row, part));
    if (filter.kind === "eq") {
      const current = (row as any)[filter.column!];
      return filter.value === null ? current == null : String(current) === String(filter.value);
    }
    return true;
  };

  const columnsOf = (orders: any[]) =>
    orders.filter(Boolean).map(order => (typeof order === "string" ? order : order.name ?? order.columnName ?? order.column));

  const sorted = (rows: Row[], orders: any[]) => {
    const columns = columnsOf(orders);
    return [...rows].sort((left, right) => {
      for (const column of columns) {
        const a = String((left as any)[column] ?? "");
        const b = String((right as any)[column] ?? "");
        if (a !== b) return a < b ? -1 : 1;
      }
      return 0;
    });
  };

  const select = () => ({
    from: () => ({
      where: (filter?: Filter) => {
        const rows = () => store.rows.filter(row => matches(row, filter));
        return {
          limit: async (take: number) => rows().slice(0, take),
          orderBy: (...orders: any[]) => ({ limit: async (take: number) => sorted(rows(), orders).slice(0, take) }),
        };
      },
    }),
  });

  const insert = () => ({
    values: (values: Record<string, unknown> | Record<string, unknown>[]) => ({
      onConflictDoNothing: async () => {
        for (const value of Array.isArray(values) ? values : [values]) {
          const clash = store.rows.some(
            row =>
              row.userId === value.userId &&
              ((value.seedKey && row.seedKey === value.seedKey) || (row.category === value.category && row.value === value.value))
          );
          if (clash) continue;
          store.rows.push({ id: store.nextId++, userId: 0, isDefault: false, seedKey: null, active: true, ...(value as object) } as Row);
        }
      },
    }),
  });

  const update = () => ({
    set: (patch: Record<string, unknown>) => ({
      where: async (filter?: Filter) => {
        for (const row of store.rows) if (matches(row, filter)) Object.assign(row, patch);
      },
    }),
  });

  return { select, insert, update };
}

import { ensureDefaultTradeOptions, listOwnedOptions, requireTradeOptionCategory, toTradeOptionView, tradeOptionValueError } from "./tradeOptions";

const expectedDefaultCount = TRADE_OPTION_CATEGORIES.reduce((total, entry) => total + entry.defaults.length, 0);
const rowsFor = (userId: number) => store.rows.filter(row => row.userId === userId);

describe("Trade Log option seeding", () => {
  beforeEach(() => {
    store.rows.length = 0;
    store.nextId = 1;
  });

  it("seeds every Gold Journal default exactly once with a stable seed key", async () => {
    await ensureDefaultTradeOptions(101);
    const seeded = rowsFor(101);

    expect(seeded).toHaveLength(expectedDefaultCount);
    expect(seeded.every(row => row.isDefault)).toBe(true);
    expect(seeded.every(row => row.active)).toBe(true);
    expect(new Set(seeded.map(row => row.seedKey)).size).toBe(expectedDefaultCount);
    expect(seeded.find(row => row.category === "Setup quality" && row.value === "A+")?.seedKey).toBe(tradeOptionSeedKey("Setup quality", "A+"));

    // A retried or repeated request never duplicates the defaults.
    await ensureDefaultTradeOptions(101);
    expect(rowsFor(101)).toHaveLength(expectedDefaultCount);
  });

  it("leaves an already seeded account untouched, so a renamed default is never re-created", async () => {
    store.rows.push({
      id: store.nextId++,
      userId: 102,
      category: "Setup quality",
      value: "A+ Institutional",
      normalizedValue: normalizeTradeOptionValue("A+ Institutional"),
      isDefault: true,
      seedKey: tradeOptionSeedKey("Setup quality", "A+"),
      active: true,
    });

    await ensureDefaultTradeOptions(102);

    const seeded = rowsFor(102);
    expect(seeded).toHaveLength(1);
    expect(seeded[0].value).toBe("A+ Institutional");
  });

  it("adopts a value the trader already created instead of duplicating it, and preserves its disabled state", async () => {
    store.rows.push({
      id: store.nextId++,
      userId: 103,
      category: "Session",
      value: "London",
      normalizedValue: normalizeTradeOptionValue("London"),
      isDefault: false,
      seedKey: null,
      active: false,
    });

    await ensureDefaultTradeOptions(103);

    const london = rowsFor(103).filter(row => row.category === "Session" && normalizeTradeOptionValue(row.value) === "london");
    expect(london).toHaveLength(1);
    expect(london[0]).toMatchObject({ isDefault: true, active: false, seedKey: tradeOptionSeedKey("Session", "London") });
    expect(rowsFor(103)).toHaveLength(expectedDefaultCount);
  });

  it("ignores case and padding differences so a seed can never become a second option", async () => {
    store.rows.push({
      id: store.nextId++,
      userId: 106,
      category: "Setup quality",
      value: " a+ ",
      normalizedValue: normalizeTradeOptionValue("A+"),
      isDefault: false,
      seedKey: null,
      active: true,
    });

    await ensureDefaultTradeOptions(106);

    const graded = rowsFor(106).filter(row => row.category === "Setup quality" && normalizeTradeOptionValue(row.value) === "a+");
    expect(graded).toHaveLength(1);
    expect(rowsFor(106)).toHaveLength(expectedDefaultCount);
  });

  it("lists only the trader's own options, ready for the manager UI", async () => {
    await ensureDefaultTradeOptions(104);
    store.rows.push({
      id: store.nextId++,
      userId: 999,
      category: "Setup quality",
      value: "Another trader's grade",
      normalizedValue: normalizeTradeOptionValue("Another trader's grade"),
      isDefault: false,
      seedKey: null,
      active: true,
    });

    const mine = await listOwnedOptions(104);
    expect(mine).toHaveLength(expectedDefaultCount);
    expect(mine.some(row => row.value === "Another trader's grade")).toBe(false);
    expect((await listOwnedOptions(104, "Timeframe")).every(row => row.category === "Timeframe")).toBe(true);
  });

  it("exposes the editable option view without leaking internal seed metadata", async () => {
    await ensureDefaultTradeOptions(105);
    const row = (await listOwnedOptions(105)).find(item => item.value === "A+")!;
    const view = toTradeOptionView(row);

    expect(view).toEqual({ id: row.id, category: "Setup quality", value: "A+", active: true, isDefault: true });
    expect(Object.keys(view)).toEqual(["id", "category", "value", "active", "isDefault"]);
  });

  it("rejects an unknown category and validates option names against the registry", () => {
    expect(requireTradeOptionCategory("Setup quality").key).toBe("setupQuality");
    expect(requireTradeOptionCategory("setupQuality").category).toBe("Setup quality");
    expect(() => requireTradeOptionCategory("Investment thesis")).toThrow(/not a manageable Trade Log option category/);
    expect(tradeOptionValueError("Setup quality", "   ")).toBe("Enter a name for this option.");
    expect(tradeOptionValueError("Setup quality", "A+ Institutional")).toBeNull();
  });
});
