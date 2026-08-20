import { coachRiskWithOpenRouter, DEFAULT_RISK_COACH_TIMEOUT_MS, resolveRiskCoachTimeoutMs } from "./riskCoachAi";
import { describe, expect, it } from "vitest";

const calculation = { valid: true, basis: "EQUITY" as const, capital: 10_000, freeMargin: 9_900, riskPercent: 1, riskAmount: 100, stopDistance: 5, stopTicks: 50, lossPerLot: 500, rawLots: 0.2, lots: 0.2, actualRisk: 100, symbol: "XAUUSDm", currency: "USD", warnings: [], verification: ["Confirm broker values."] };

describe("risk coach safeguards", () => {
  it("uses the selected bounded two-minute policy and caps environment overrides", () => {
    expect(DEFAULT_RISK_COACH_TIMEOUT_MS).toBe(120_000); expect(resolveRiskCoachTimeoutMs(undefined)).toBe(120_000); expect(resolveRiskCoachTimeoutMs("240000")).toBe(120_000); expect(resolveRiskCoachTimeoutMs("5000")).toBe(5_000);
  });
  it("keeps deterministic calculation available when server-only OpenRouter configuration is absent", async () => {
    const key = process.env.OPENROUTER_API_KEY; const model = process.env.OPENROUTER_MODEL; delete process.env.OPENROUTER_API_KEY; delete process.env.OPENROUTER_MODEL;
    await expect(coachRiskWithOpenRouter(calculation)).resolves.toMatchObject({ available: false, coach: null });
    if (key) process.env.OPENROUTER_API_KEY = key; if (model) process.env.OPENROUTER_MODEL = model;
  });
});
