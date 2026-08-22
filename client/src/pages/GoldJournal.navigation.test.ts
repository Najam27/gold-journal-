import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./GoldJournal.tsx", import.meta.url)), "utf8");

describe("Gold Journal sidebar routes", () => {
  it("keeps MT5 Live and Risk Calculator as distinct navigation destinations", () => {
    expect(source).toContain('{ id: "mt5", label: "MT5 Live"');
    expect(source).toContain('{ id: "risk", label: "Risk Calculator"');
    expect(source).toContain('{view === "mt5" && <Mt5LiveView');
    expect(source).toContain('{view === "risk" && <RiskCalculatorPanel');
    expect(source).not.toContain('{view === "mt5" && <RiskCalculatorPanel');
    expect(source).not.toContain('{view === "risk" && <Mt5LiveView');
  });
});
