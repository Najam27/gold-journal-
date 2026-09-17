import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_RISK_PERCENT,
  MIN_CUSTOM_RISK_PERCENT,
  RISK_PROFILE_IDS,
  RISK_PROFILES,
  calculateRisk,
  floorLotsToStep,
  type RiskInput,
} from "./riskCalculator";

/**
 * Deterministic broker-aware risk sizing.
 *
 * Every case here is pure arithmetic: no key, no provider, no network. If one
 * of these ever needs an AI call to pass, the calculator has regressed.
 */

const account = { balance: 10_000, equity: 12_500, margin: 250, freeMargin: 9_900, currency: "USD" };

// A broker that quotes gold with a 0.1 tick and a $10 tick value per lot, so a
// 6.00 price-unit stop is 60 ticks and $600 of loss per lot.
const spec = { symbol: "XAUUSDm", tickSize: 0.1, tickValueLoss: 10, contractSize: 100, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01 };

const input = (overrides: Partial<RiskInput> = {}): RiskInput => ({
  basis: "EQUITY",
  riskProfile: "STANDARD",
  riskPercent: 1,
  direction: "BUY",
  entryPrice: 2350,
  stopLoss: 2344,
  takeProfit: null,
  ...overrides,
});

describe("risk amount · fixed fractional sizing", () => {
  it("sizes 1% of a $10,000 balance as $100", () => {
    const result = calculateRisk(input({ basis: "BALANCE" }), account, spec);
    expect(result.riskAmount).toBe(100);
    expect(result.capital).toBe(10_000);
    expect(result.valid).toBe(true);
  });

  it("sizes 0.5% of $12,500 equity as $62.50", () => {
    const result = calculateRisk(input({ basis: "EQUITY", riskProfile: "CONSERVATIVE", riskPercent: 0.5 }), account, spec);
    expect(result.riskAmount).toBe(62.5);
    expect(result.capital).toBe(12_500);
  });

  it("changes the risk amount when the capital basis switches from equity to balance", () => {
    const equity = calculateRisk(input({ basis: "EQUITY" }), account, spec);
    const balance = calculateRisk(input({ basis: "BALANCE" }), account, spec);
    expect(equity.riskAmount).toBe(125);
    expect(balance.riskAmount).toBe(100);
    expect(equity.riskAmount).not.toBe(balance.riskAmount);
  });

  it("sizes custom risk of 1.25% of $10,000 equity as $125", () => {
    const result = calculateRisk(input({ basis: "BALANCE", riskProfile: "CUSTOM", riskPercent: 1.25 }), account, spec);
    expect(result.capital).toBe(10_000);
    expect(result.riskAmount).toBe(125);
    expect(result.riskProfileLabel).toBe("Custom");
  });

  it("resolves every predefined profile to its documented percentage", () => {
    const expected: Record<string, number> = { CONSERVATIVE: 0.5, LOW: 0.75, STANDARD: 1, MODERATE: 1.5, HIGH: 2 };
    for (const profile of RISK_PROFILES) {
      if (profile.riskPercent == null) continue;
      const result = calculateRisk(
        input({ basis: "BALANCE", riskProfile: profile.id, riskPercent: profile.riskPercent }),
        account,
        spec
      );
      expect(profile.riskPercent).toBe(expected[profile.id]);
      expect(result.riskPercent).toBe(profile.riskPercent);
      expect(result.riskAmount).toBe(Number((10_000 * profile.riskPercent / 100).toFixed(2)));
      expect(result.valid).toBe(true);
    }
  });

  it("declares every profile in the shared id list exactly once", () => {
    expect(RISK_PROFILES.map(profile => profile.id)).toEqual([...RISK_PROFILE_IDS]);
  });

  it("applies the profile percentage even when the client sends a different one", () => {
    const result = calculateRisk(input({ riskProfile: "STANDARD", riskPercent: 9 }), account, spec);
    expect(result.riskPercent).toBe(1);
    expect(result.riskAmount).toBe(125);
    expect(result.warnings.join(" ")).toContain("Standard profile stores 1%");
  });

  it("rejects custom risk outside the bounded range instead of sizing it", () => {
    for (const riskPercent of [0, -1, MAX_CUSTOM_RISK_PERCENT + 0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = calculateRisk(input({ riskProfile: "CUSTOM", riskPercent }), account, spec);
      expect(result.valid).toBe(false);
      expect(result.lots).toBe(0);
      expect(result.errors.join(" ")).toContain(`between ${MIN_CUSTOM_RISK_PERCENT}% and ${MAX_CUSTOM_RISK_PERCENT}%`);
    }
  });
});

describe("stop distance and direction", () => {
  it("uses the absolute entry-to-stop distance and never a signed one", () => {
    const buy = calculateRisk(input({ direction: "BUY", entryPrice: 2350, stopLoss: 2344 }), account, spec);
    const sell = calculateRisk(input({ direction: "SELL", entryPrice: 2344, stopLoss: 2350 }), account, spec);
    expect(buy.stopDistance).toBe(6);
    expect(sell.stopDistance).toBe(6);
    expect(buy.directionAligned).toBe(true);
    expect(sell.directionAligned).toBe(true);
    expect(sell.lots).toBe(buy.lots);
  });

  it("flags a BUY whose stop sits above the entry", () => {
    const result = calculateRisk(input({ direction: "BUY", entryPrice: 2344, stopLoss: 2350 }), account, spec);
    expect(result.directionAligned).toBe(false);
    expect(result.warnings.join(" ")).toContain("This is a BUY, but the stop loss is above the entry price");
    expect(result.errors).toEqual([]);
  });

  it("flags a SELL whose stop sits below the entry", () => {
    const result = calculateRisk(input({ direction: "SELL", entryPrice: 2350, stopLoss: 2344 }), account, spec);
    expect(result.directionAligned).toBe(false);
    expect(result.warnings.join(" ")).toContain("This is a SELL, but the stop loss is below the entry price");
  });

  it("rejects an entry equal to the stop loss", () => {
    const result = calculateRisk(input({ entryPrice: 2350, stopLoss: 2350 }), account, spec);
    expect(result.valid).toBe(false);
    expect(result.lots).toBe(0);
    expect(result.stopDistance).toBe(0);
    expect(result.errors.join(" ")).toContain("cannot be identical");
  });

  it("keeps a larger stop at a smaller position for the same monetary risk", () => {
    const wide = calculateRisk(input({ basis: "BALANCE", entryPrice: 2350, stopLoss: 2344 }), account, spec);
    const tight = calculateRisk(input({ basis: "BALANCE", entryPrice: 2350, stopLoss: 2347 }), account, spec);
    expect(wide.riskAmount).toBe(tight.riskAmount);
    expect(tight.lots).toBeGreaterThan(wide.lots);
    expect(wide.lots).toBe(0.16);
    expect(tight.lots).toBe(0.33);
  });
});

describe("volume step rounding", () => {
  it("rounds 0.037 lots down to 0.03 at a 0.01 step", () => {
    expect(floorLotsToStep(0.037, 0.01)).toBe(0.03);
  });

  it("never rounds up, even when the raw size is almost a full step", () => {
    expect(floorLotsToStep(0.0399, 0.01)).toBe(0.03);
    expect(floorLotsToStep(1.999, 0.01)).toBe(1.99);
  });

  it("survives binary floating-point drift at common steps", () => {
    expect(floorLotsToStep(0.29, 0.01)).toBe(0.29);
    expect(floorLotsToStep(0.07, 0.01)).toBe(0.07);
    expect(floorLotsToStep(0.3, 0.1)).toBe(0.3);
    expect(floorLotsToStep(0.25, 0.1)).toBe(0.2);
    expect(floorLotsToStep(2.5, 1)).toBe(2);
    expect(floorLotsToStep(0.6, 0.25)).toBe(0.5);
  });

  it("returns no volume for a non-positive raw size or step", () => {
    expect(floorLotsToStep(0, 0.01)).toBe(0);
    expect(floorLotsToStep(-1, 0.01)).toBe(0);
    expect(floorLotsToStep(1, 0)).toBe(0);
    expect(floorLotsToStep(Number.NaN, 0.01)).toBe(0);
  });

  it("rounds the final position down inside a full calculation", () => {
    // 100 / 600 = 0.1666… lots, so the safe executable size is 0.16.
    const result = calculateRisk(input({ basis: "BALANCE" }), account, spec);
    expect(result.rawLots).toBeCloseTo(0.16666667, 6);
    expect(result.lots).toBe(0.16);
    expect(result.actualRisk).toBe(96);
    expect(result.actualRisk).toBeLessThanOrEqual(result.riskAmount);
    expect(result.riskBudgetUtilization).toBe(96);
  });
});

describe("broker minimum and maximum", () => {
  it("warns instead of silently raising a sub-minimum size to the broker floor", () => {
    const result = calculateRisk(input({ basis: "BALANCE", riskProfile: "CUSTOM", riskPercent: 0.03 }), account, spec);
    expect(result.valid).toBe(false);
    expect(result.belowBrokerMinimum).toBe(true);
    expect(result.lots).toBe(0);
    expect(result.rawLots).toBeCloseTo(0.005, 6);
    expect(result.minimumExecutableLots).toBe(0.01);
    // 0.01 lots × $600 per lot — the risk the trader would actually be taking.
    expect(result.minimumExecutableRisk).toBe(6);
    expect(result.errors.join(" ")).toContain("Broker minimum volume is higher than your calculated risk size");
    expect(result.errors.join(" ")).toContain("Calculated size: 0.005 lots");
    expect(result.errors.join(" ")).toContain("Broker minimum: 0.01 lots");
    // Nothing was executed and no risk was fabricated.
    expect(result.actualRisk).toBe(0);
  });

  it("caps at the broker maximum and reports the capped volume's real risk", () => {
    const bigAccount = { ...account, balance: 1_000_000, equity: 1_000_000, freeMargin: 900_000 };
    const result = calculateRisk(
      input({ basis: "BALANCE", riskProfile: "CUSTOM", riskPercent: 10, entryPrice: 2350, stopLoss: 2344 }),
      bigAccount,
      spec
    );
    expect(result.rawLots).toBeGreaterThan(spec.volumeMax);
    expect(result.cappedAtBrokerMaximum).toBe(true);
    expect(result.lots).toBe(spec.volumeMax);
    expect(result.actualRisk).toBe(spec.volumeMax * result.lossPerLot);
    expect(result.actualRisk).toBeLessThan(result.riskAmount);
    expect(result.warnings.join(" ")).toContain("Broker maximum volume reached.");
  });

  it("reports loss per lot from the broker tick value, not from a hard-coded contract", () => {
    const result = calculateRisk(input({ entryPrice: 2350, stopLoss: 2344 }), account, spec);
    expect(result.stopTicks).toBe(60);
    expect(result.lossPerLot).toBe(600);
    const otherBroker = calculateRisk(input({ entryPrice: 2350, stopLoss: 2344 }), account, { ...spec, tickValueLoss: 1 });
    expect(otherBroker.lossPerLot).toBe(60);
    expect(otherBroker.lots).toBeGreaterThan(result.lots);
  });
});

describe("risk versus margin", () => {
  it("keeps risk and margin as separate numbers", () => {
    const result = calculateRisk(input({ basis: "BALANCE" }), account, spec);
    expect(result.riskAmount).toBe(100);
    expect(result.freeMargin).toBe(9_900);
    expect(result.freeMarginRiskPercent).toBe(0.97);
    expect(result.riskAmount).not.toBe(result.freeMargin);
  });

  it("still returns the maths when free margin is not positive, plus a caution", () => {
    const result = calculateRisk(input({ basis: "BALANCE" }), { ...account, freeMargin: 0 }, spec);
    expect(result.valid).toBe(true);
    expect(result.freeMarginRiskPercent).toBeNull();
    expect(result.warnings.join(" ")).toContain("Free margin is not positive");
  });
});

describe("optional take profit", () => {
  it("derives reward distance and R:R without changing the risk amount", () => {
    const withTarget = calculateRisk(input({ basis: "BALANCE", takeProfit: 2362 }), account, spec);
    const withoutTarget = calculateRisk(input({ basis: "BALANCE" }), account, spec);
    expect(withTarget.riskAmount).toBe(withoutTarget.riskAmount);
    expect(withTarget.lots).toBe(withoutTarget.lots);
    expect(withTarget.rewardDistance).toBe(12);
    expect(withTarget.rewardTicks).toBe(120);
    expect(withTarget.riskRewardRatio).toBe(2);
    // 0.16 lots × 120 ticks × $10 per tick.
    expect(withTarget.potentialProfit).toBe(192);
  });

  it("warns about a target on the wrong side of the entry", () => {
    const result = calculateRisk(input({ direction: "SELL", entryPrice: 2350, stopLoss: 2356, takeProfit: 2362 }), account, spec);
    expect(result.warnings.join(" ")).toContain("This is a SELL, but the take profit is above the entry price");
  });

  it("skips reward metrics when the target equals the entry", () => {
    const result = calculateRisk(input({ takeProfit: 2350 }), account, spec);
    expect(result.riskRewardRatio).toBeNull();
    expect(result.potentialProfit).toBeNull();
    expect(result.warnings.join(" ")).toContain("Take profit equals the entry price");
  });
});

describe("stale or missing broker data", () => {
  it("refuses to size a position without live MT5 account metrics", () => {
    const result = calculateRisk(input(), null, spec);
    expect(result.dataAvailable).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.lots).toBe(0);
    expect(result.errors.join(" ")).toContain("Broker risk data unavailable");
  });

  it("refuses to size a position without the broker contract specification", () => {
    const result = calculateRisk(input(), account, null);
    expect(result.dataAvailable).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("Broker symbol specifications are unavailable");
    expect(result.account?.equity).toBe(12_500);
  });

  it("exposes the raw broker facts for the details panel instead of defaults", () => {
    const result = calculateRisk(input(), account, spec);
    expect(result.broker).toEqual(spec);
    expect(result.account).toEqual({ ...account });
    expect(result.symbol).toBe("XAUUSDm");
    expect(result.currency).toBe("USD");
  });

  it("refuses an incomplete broker specification", () => {
    const result = calculateRisk(input(), account, { ...spec, tickValueLoss: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("invalid broker symbol constraints");
  });
});

describe("AI independence", () => {
  it("has no AI, provider, or Gemini dependency in its own source", () => {
    const source = readFileSync(fileURLToPath(new URL("./riskCalculator.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/groq|gemini|openai|openrouter|coachRisk|useAiSettings|AI_UI_COPY|@\/lib\/ai/i);
  });

  it("calculates successfully with no key, no settings, and no network", () => {
    // Nothing here is async and nothing is mocked: the maths itself is the proof.
    const result = calculateRisk(input({ basis: "BALANCE" }), account, spec);
    expect(result.valid).toBe(true);
    expect(result.riskAmount).toBe(100);
  });
});
