import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the "free-form trade text is unbounded" contract across every layer a
 * long journal value must pass through:
 *
 *   frontend input  -> no maxLength on trade/option text (asserted by the
 *                      absence of the attribute in the dialog)
 *   server Zod      -> tradeInput uses the unbounded `freeText` validator
 *   Drizzle model   -> the eleven trade columns and the option label columns are
 *                      declared `text`, never `varchar(n)`
 *   deployed schema -> migration 0027 converts those columns with `type text`
 *
 * A regression in any single layer re-introduces the original bug (a save that
 * fails because the trader wrote too much), so all four are checked here.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const TRADE_TEXT_FIELDS = [
  "session",
  "level",
  "timeframe",
  "setupQuality",
  "executionType",
  "marketCondition",
  "biasAlignment",
  "confirmationType",
  "slPlacement",
  "tpPlacement",
  "mistake",
  "holdQuality",
] as const;

const schema = read("drizzle/schema.ts");
const goldRouter = read("server/goldRouter.ts");
const migration = read("supabase/migrations/0027_unbounded_trade_text_fields.sql");
const dialog = read("client/src/components/TradeDialogWithCustomOptions.tsx");
const optionManager = read("client/src/components/TradeOptionManager.tsx");
const optionRegistry = read("shared/tradeOptionCategories.ts");

/** The canonical tradeInput block, isolated from the rest of the router. */
const tradeInputBlock = (() => {
  const start = goldRouter.indexOf("const tradeInput = z.object({");
  const end = goldRouter.indexOf("});", start);
  return goldRouter.slice(start, end);
})();

/**
 * The `gj_trades` Drizzle table, isolated from the rest of the schema.
 * `gj_skipped_trades` still declares its own bounded `level`/`timeframe`
 * columns, so a whole-file scan would produce a false positive.
 */
const tradesTable = schema.split(/\nexport const /).find(chunk => chunk.startsWith("trades = pgTable")) ?? "";

describe("trade text length is unbounded end to end", () => {
  it("validates every free-text trade field with the unbounded validator", () => {
    expect(goldRouter).toContain('const freeText = z.string().trim().optional().default("");');
    for (const field of TRADE_TEXT_FIELDS) {
      // `session` is required (non-empty) while the rest default to "".
      if (field === "session") expect(tradeInputBlock, field).toContain("session: z.string().trim().min(1),");
      else expect(tradeInputBlock, field).toContain(`${field}: freeText,`);
      // No numeric budget may creep back in, e.g. `mistake: optionalText(80)`
      // or `level: z.string().max(100)`.
      expect(tradeInputBlock, field).not.toMatch(new RegExp(`${field}: optionalText\\(\\d`));
      expect(tradeInputBlock, field).not.toMatch(new RegExp(`${field}: z\\.string\\(\\)[^,\\n]*\\.max\\(`));
    }
    for (const field of ["notes", "emotionBefore", "emotionDuring", "emotionAfter"]) {
      expect(tradeInputBlock, field).toContain(`${field}: freeText,`);
    }
  });

  it("declares the trade and option label columns as unbounded text in the Drizzle model", () => {
    expect(tradesTable).toContain('pgTable("gj_trades"');
    for (const field of TRADE_TEXT_FIELDS) {
      expect(tradesTable, field).toContain(`${field}: text("${field}")`);
      expect(tradesTable, field).not.toContain(`varchar("${field}"`);
    }
    expect(schema).toContain('value: text("value").notNull()');
    expect(schema).toContain('normalizedValue: text("normalizedValue").notNull()');
  });

  it("converts every affected deployed column to text without dropping data", () => {
    for (const field of TRADE_TEXT_FIELDS) {
      expect(migration, field).toContain(`alter column "${field}" type text`);
    }
    expect(migration).toContain('alter column "value" type text');
    expect(migration).toContain('alter column "normalizedValue" type text');
    // A destructive rewrite is never acceptable here.
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/delete\s+from/i);
    expect(migration).not.toMatch(/truncate\s+table/i);
  });

  it("removes the arbitrary option-name length budget from the registry and UI", () => {
    expect(optionRegistry).not.toContain("maxLength");
    expect(optionManager).not.toContain("maxLength");
    // Option text inputs in the trade dialog carry no maxLength either.
    expect(dialog).not.toContain("maxLength");
  });
});
