import { describe, expect, it } from "vitest";
import {
  activeOptionValues,
  archivedOptionLabel,
  duplicateOptionMessage,
  joinTradeOptionValues,
  optionRowsForCategory,
  splitTradeOptionValue,
  toggleTradeOptionValue,
  tradeOptionChoices,
  tradeOptionSelectChoices,
  type JournalOption,
  type TradeOptionStore,
} from "./tradeOptions";

const option = (id: number, category: string, value: string, extra: Partial<JournalOption> = {}): JournalOption => ({
  id,
  category,
  value,
  active: true,
  isDefault: false,
  ...extra,
});

const store = (options: JournalOption[], state: Partial<TradeOptionStore> = {}): TradeOptionStore => ({
  options,
  isLoading: false,
  isError: false,
  isReady: true,
  ...state,
});

describe("Trade Log option store helpers", () => {
  it("orders a category with the seeded defaults first and custom values after them", () => {
    const rows = optionRowsForCategory(
      [option(3, "Setup quality", "Zed"), option(2, "Setup quality", "A", { isDefault: true }), option(1, "Setup quality", "A+", { isDefault: true })],
      "Setup quality"
    );
    expect(rows.map(row => row.value)).toEqual(["A", "A+", "Zed"]);
  });

  it("lets the managed rows decide what is selectable once the category is seeded", () => {
    const values = activeOptionValues(
      store([
        option(1, "Setup quality", "A+ Institutional", { isDefault: true }),
        option(2, "Setup quality", "C", { isDefault: true }),
        option(3, "Setup quality", "Watch only", { isDefault: true, active: false }),
      ]),
      "Setup quality"
    );
    expect(values).toEqual(["A+ Institutional", "C"]);
  });

  it("never resurrects a disabled option, even when every default was disabled", () => {
    const values = activeOptionValues(
      store([
        option(1, "Setup quality", "A+", { isDefault: true, active: false }),
        option(2, "Setup quality", "A", { isDefault: true, active: false }),
      ]),
      "Setup quality"
    );
    expect(values).toEqual([]);
  });

  it("falls back to the Gold Journal defaults only for a category that is not seeded yet", () => {
    const values = activeOptionValues(store([option(9, "Level", "Saved level")]), "Setup quality");
    expect(values).toEqual(["A+", "A", "B"]);

    const merged = activeOptionValues(store([option(9, "Level", "Saved level"), option(10, "Level", "Hidden zone", { active: false })]), "Level");
    expect(merged).toEqual(["SBR/TJL1", "RBS/TJL1", "TJL2", "QML", "FIB", "LVL4", "LVL2", "Saved level"]);
  });

  it("uses the read-only defaults when the canonical store cannot be reached", () => {
    expect(activeOptionValues(store([], { isReady: false, isError: true }), "Session")).toContain("London");
    expect(activeOptionValues(store([], { isReady: false, isError: true }), "Timeframe")).toEqual(["1m", "5m", "15m", "H1", "4H"]);
  });

  it("keeps the existing pipe-separated multi-select storage format", () => {
    expect(splitTradeOptionValue("BOS | CHoCH | None").join(",")).toBe("BOS,CHoCH");
    expect(joinTradeOptionValues(["BOS", "bos", " CHoCH "])).toBe("BOS | CHoCH");
    expect(toggleTradeOptionValue("BOS | CHoCH", "choCH")).toBe("BOS");
    expect(toggleTradeOptionValue("BOS", "Liquidity sweep")).toBe("BOS | Liquidity sweep");
  });

  it("keeps a recorded value that is no longer active visible as archived when editing", () => {
    const choices = tradeOptionChoices(["BOS", "CHoCH"], "BOS | Displacement");
    expect(choices).toEqual([
      { value: "BOS", archived: false, selected: true },
      { value: "CHoCH", archived: false, selected: false },
      { value: "Displacement", archived: true, selected: true },
    ]);
    expect(archivedOptionLabel("Displacement")).toBe("Displacement — Archived");
  });

  it("keeps an unmanaged single value selectable so an old trade is never blanked", () => {
    const choices = tradeOptionSelectChoices(["Aligned", "Neutral"], "Trend-aligned (legacy)");
    expect(choices.at(-1)).toEqual({ value: "Trend-aligned (legacy)", archived: true, selected: true });
    expect(tradeOptionSelectChoices(["Aligned"], "Aligned")).toEqual([
      { value: "Aligned", archived: false, selected: true },
    ]);
  });

  it("blocks a duplicate option name in the same category regardless of case or spacing", () => {
    const options = [option(1, "Setup quality", "A+", { isDefault: true }), option(2, "Session", "A+")];
    expect(duplicateOptionMessage(options, "Setup quality", " a+ ")).toBe("“A+” already exists in Setup quality.");
    expect(duplicateOptionMessage(options, "Timeframe", " a+ ")).toBeNull();
    expect(duplicateOptionMessage(options, "Setup quality", "  ")).toBe("Enter a name for this option.");
  });
});
