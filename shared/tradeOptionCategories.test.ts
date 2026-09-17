import { describe, expect, it } from "vitest";
import { MISTAKE_TAXONOMY } from "./psychologyEngine";
import {
  TRADE_FORM_OPTION_CATEGORIES,
  TRADE_OPTION_CATEGORIES,
  normalizeTradeOptionValue,
  tradeOptionCategory,
  tradeOptionDefaults,
  tradeOptionSeedKey,
  validateTradeOptionValue,
} from "./tradeOptionCategories";

describe("Trade Log option registry", () => {
  it("exposes one canonical entry per Trade Log dropdown, each mapped to a distinct form field", () => {
    const keys = TRADE_OPTION_CATEGORIES.map(entry => entry.key);
    const categories = TRADE_OPTION_CATEGORIES.map(entry => entry.category);
    const fields = TRADE_FORM_OPTION_CATEGORIES.map(entry => entry.field);

    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(categories).size).toBe(categories.length);
    expect(new Set(fields).size).toBe(fields.length);
    expect(fields).not.toContain(null);

    // Every option-bearing Trade Log field is covered by the registry.
    expect(TRADE_FORM_OPTION_CATEGORIES.map(entry => entry.field).sort()).toEqual([
      "biasAlignment",
      "confirmationType",
      "executionType",
      "holdQuality",
      "level",
      "marketCondition",
      "mistake",
      "session",
      "setupQuality",
      "slPlacement",
      "timeframe",
      "tpPlacement",
    ]);
  });

  it("resolves a category by its stable key and by its persisted label", () => {
    expect(tradeOptionCategory("setupQuality")?.category).toBe("Setup quality");
    expect(tradeOptionCategory("Setup quality")?.key).toBe("setupQuality");
    expect(tradeOptionCategory("Not a category")).toBeUndefined();
  });

  it("keeps every seed list unique so seeding can never produce duplicates", () => {
    for (const entry of TRADE_OPTION_CATEGORIES) {
      const normalized = entry.defaults.map(normalizeTradeOptionValue);
      expect(new Set(normalized).size).toBe(normalized.length);
      expect(entry.defaults.every(value => value === value.trim() && value.length > 0)).toBe(true);
    }
  });

  it("derives a deterministic seed key from the category and the original default label", () => {
    const first = tradeOptionSeedKey("Setup quality", "A+");
    expect(first).toBe(tradeOptionSeedKey("Setup quality", "A+"));
    expect(first).toMatch(/^default:setup-quality:a/);
    expect(tradeOptionSeedKey("Setup quality", "A+")).not.toBe(tradeOptionSeedKey("Setup quality", "A"));
    expect(tradeOptionSeedKey("Setup quality", " A+ ")).toBe(first);
  });

  it("treats the mistake taxonomy as the seeded Mistake option set", () => {
    expect(tradeOptionDefaults("Mistake")).toEqual(MISTAKE_TAXONOMY.map(item => item.label));
    expect(tradeOptionDefaults("Not a category")).toEqual([]);
  });

  it("validates option names against the category length budget", () => {
    expect(validateTradeOptionValue("Setup quality", "   ")).toBe("Enter a name for this option.");
    expect(validateTradeOptionValue("Setup quality", "A+ Institutional")).toBeNull();
    expect(validateTradeOptionValue("Setup quality", "x".repeat(41))).toContain("at most 40 characters");
    expect(validateTradeOptionValue("Trading rule", "x".repeat(161))).toContain("at most 160 characters");
  });
});
