import { describe, expect, it, vi } from "vitest";
vi.mock("./userAiProviderVault", () => ({ getUserAiCredential: vi.fn() }));
import { coachRiskWithOpenRouter, DEFAULT_RISK_COACH_TIMEOUT_MS, resolveRiskCoachTimeoutMs } from "./riskCoachAi";
import { getUserAiCredential } from "./userAiProviderVault";

const calculation = { valid: true, basis: "EQUITY" as const, capital: 10_000, freeMargin: 9_900, riskPercent: 1, riskAmount: 100, stopDistance: 5, stopTicks: 50, lossPerLot: 500, rawLots: 0.2, lots: 0.2, actualRisk: 100, riskBudgetUtilization: 100, freeMarginRiskPercent: 1.01, symbol: "XAUUSDm", currency: "USD", warnings: [], verification: ["Confirm broker values."] };

describe("risk coach safeguards", () => {
  it("uses the selected bounded two-minute policy and caps environment overrides", () => {
    expect(DEFAULT_RISK_COACH_TIMEOUT_MS).toBe(120_000); expect(resolveRiskCoachTimeoutMs(undefined)).toBe(120_000); expect(resolveRiskCoachTimeoutMs("240000")).toBe(120_000); expect(resolveRiskCoachTimeoutMs("5000")).toBe(5_000);
  });
  it("keeps deterministic calculation available when the authenticated user has no configured provider key", async () => {
    vi.mocked(getUserAiCredential).mockResolvedValueOnce(null);
    await expect(coachRiskWithOpenRouter(42, calculation)).resolves.toMatchObject({ available: false, coach: null });
  });
});
