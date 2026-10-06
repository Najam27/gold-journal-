import { describe, expect, it } from "vitest";
import {
  emptyBiasTimeframes,
  formatBiasCompact,
  formatBiasLines,
  hasBias,
  normalizeBiasTimeframes,
} from "./biasTimeframes";

describe("biasTimeframes", () => {
  it("normalizes a full five-timeframe bias", () => {
    const out = normalizeBiasTimeframes({
      D1: "Bull",
      H4: "Bear",
      H1: "Bull",
      M15: "Bear",
      M5: "Bull",
    });
    expect(out).toEqual({
      D1: "Bull",
      H4: "Bear",
      H1: "Bull",
      M15: "Bear",
      M5: "Bull",
    });
    expect(hasBias(out)).toBe(true);
  });

  it("drops unknown keys and invalid sides instead of throwing", () => {
    const out = normalizeBiasTimeframes({
      D1: "Bull",
      H4: "Sideways",
      W1: "Bear",
      M5: 42,
    });
    expect(out.D1).toBe("Bull");
    expect(out.H4).toBe(null);
    expect(out.M5).toBe(null);
    expect(out).not.toHaveProperty("W1");
  });

  it("returns an empty structure for null, arrays, and garbage", () => {
    for (const bad of [null, undefined, "Bull", 42, ["D1"], { D1: ["Bull"] }]) {
      const out = normalizeBiasTimeframes(bad);
      expect(out).toEqual(emptyBiasTimeframes());
      expect(hasBias(out)).toBe(false);
    }
  });

  it("formats compact and line displays in D1 → M5 order", () => {
    const bias = normalizeBiasTimeframes({
      D1: "Bull",
      H4: "Bull",
      H1: "Bear",
      M15: "Bull",
      M5: "Bear",
    });
    expect(formatBiasCompact(bias)).toBe(
      "D1 Bull · H4 Bull · H1 Bear · M15 Bull · M5 Bear"
    );
    expect(formatBiasLines(bias)).toEqual([
      "D1: Bull",
      "H4: Bull",
      "H1: Bear",
      "M15: Bull",
      "M5: Bear",
    ]);
  });

  it("skips unset timeframes and reports missing when empty", () => {
    const partial = normalizeBiasTimeframes({ D1: "Bear", M5: "Bull" });
    expect(formatBiasCompact(partial)).toBe("D1 Bear · M5 Bull");
    expect(formatBiasLines(partial)).toEqual(["D1: Bear", "M5: Bull"]);
    expect(formatBiasCompact(emptyBiasTimeframes())).toBe(null);
    expect(formatBiasLines(emptyBiasTimeframes())).toEqual([]);
  });

  it("never reinterprets legacy free-text bias values", () => {
    // Old "Direction vs bias" strings must not become per-timeframe bias.
    const out = normalizeBiasTimeframes("Aligned");
    expect(hasBias(out)).toBe(false);
  });
});
