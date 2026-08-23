import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./GoldJournal.tsx", import.meta.url)),
  "utf8"
);

describe("Gold Journal sidebar routes", () => {
  it("keeps MT5 Live and Risk Calculator as distinct navigation destinations", () => {
    expect(source).toContain('{ id: "mt5", label: "MT5 Live"');
    expect(source).toContain('{ id: "risk", label: "Risk Calculator"');
    expect(source).toMatch(/view === "mt5" &&\s*\(\s*<Mt5LiveView/);
    expect(source).toMatch(/view === "risk" &&\s*<RiskCalculatorPanel/);
    expect(source).not.toMatch(/view === "mt5" &&\s*<RiskCalculatorPanel/);
    expect(source).not.toMatch(/view === "risk" &&\s*\(\s*<Mt5LiveView/);
  });
});
