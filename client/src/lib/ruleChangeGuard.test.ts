import { describe, expect, it } from "vitest";
import { checkRuleChange, RULE_CHANGE_MIN_TRADES, type GuardRule } from "./ruleChangeGuard";

/**
 * The 30-trade rule-change guard: changing rules on a small sample is
 * overfitting to noise. These tests pin the id-based diff (added / removed /
 * renamed), the first-plan-ever exemption, the 30-trade boundary, and the
 * "strictly after the plan date" counting rule.
 */

const rule = (id: string, label: string): GuardRule => ({ id, label });

const PLAN_DATE = "2026-09-01T10:00:00+05:00";

/** n closed trades, all strictly after the plan date. */
const tradesAfter = (n: number, overrides: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => ({
    tradeDate: new Date(Date.parse("2026-09-02T10:00:00+05:00") + i * 86_400_000),
    result: "WIN",
    ...overrides,
  }));

function check(overrides: Partial<Parameters<typeof checkRuleChange>[0]> = {}) {
  return checkRuleChange({
    previousRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 1% max")],
    newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 1% max")],
    previousPlanDate: PLAN_DATE,
    trades: [],
    ...overrides,
  });
}

describe("checkRuleChange", () => {
  it("detects an added rule", () => {
    const result = check({ newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 1% max"), rule("r3", "No news trading")] });
    expect(result.rulesChanged).toBe(true);
    expect(result.added).toEqual(["No news trading"]);
    expect(result.removed).toEqual([]);
    expect(result.renamed).toEqual([]);
  });

  it("detects a removed rule", () => {
    const result = check({ newRules: [rule("r1", "Only A+ setups")] });
    expect(result.rulesChanged).toBe(true);
    expect(result.removed).toEqual(["Risk 1% max"]);
    expect(result.added).toEqual([]);
  });

  it("detects a renamed rule by id with a changed label", () => {
    const result = check({
      newRules: [rule("r1", "Only A setups (relaxed)"), rule("r2", "Risk 1% max")],
    });
    expect(result.rulesChanged).toBe(true);
    expect(result.renamed).toEqual([{ from: "Only A+ setups", to: "Only A setups (relaxed)" }]);
  });

  it("treats a case-only label change as renamed (case-sensitive)", () => {
    const result = check({
      newRules: [rule("r1", "only a+ setups"), rule("r2", "Risk 1% max")],
    });
    expect(result.rulesChanged).toBe(true);
    expect(result.renamed).toHaveLength(1);
  });

  it("ignores whitespace-only label differences", () => {
    const result = check({
      newRules: [rule("r1", "  Only A+ setups  "), rule("r2", "Risk 1% max")],
    });
    expect(result.rulesChanged).toBe(false);
    expect(result.shouldWarn).toBe(false);
    expect(result.message).toBe("");
  });

  it("reports no change for identical rule sets", () => {
    const result = check({ trades: tradesAfter(50) });
    expect(result.rulesChanged).toBe(false);
    expect(result.shouldWarn).toBe(false);
    expect(result.message).toBe("");
  });

  it("does not warn on the first plan ever, even with new rules", () => {
    const result = check({
      previousRules: [],
      newRules: [rule("r1", "Only A+ setups")],
      trades: [],
    });
    expect(result.rulesChanged).toBe(false);
    expect(result.shouldWarn).toBe(false);
    expect(result.message).toBe("");
  });

  it("warns with 29 trades and reports the remaining count", () => {
    const result = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: tradesAfter(29),
    });
    expect(result.tradesOnCurrentRules).toBe(29);
    expect(result.remaining).toBe(1);
    expect(result.shouldWarn).toBe(true);
    expect(result.message).toBe("You've logged 29 trades on this rule — 1 more before changing it.");
  });

  it("does not warn at exactly 30 trades", () => {
    expect(RULE_CHANGE_MIN_TRADES).toBe(30);
    const result = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: tradesAfter(30),
    });
    expect(result.tradesOnCurrentRules).toBe(30);
    expect(result.remaining).toBe(0);
    expect(result.shouldWarn).toBe(false);
    expect(result.message).toBe("30+ trades logged — you have a real sample; change thoughtfully.");
  });

  it("excludes OPEN trades from the sample count", () => {
    const result = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: [...tradesAfter(28), ...tradesAfter(5, { result: "OPEN" })],
    });
    expect(result.tradesOnCurrentRules).toBe(28);
    expect(result.shouldWarn).toBe(true);
  });

  it("counts only trades strictly after the plan date", () => {
    const result = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: [
        { tradeDate: new Date("2026-08-31T10:00:00+05:00"), result: "WIN" }, // before plan
        { tradeDate: new Date("2026-09-01T10:00:00+05:00"), result: "WIN" }, // same PKT day as plan
        { tradeDate: new Date("2026-09-02T10:00:00+05:00"), result: "WIN" }, // after plan
      ],
    });
    expect(result.tradesOnCurrentRules).toBe(1);
    expect(result.referenceDate).toBe("2026-09-01");
  });

  it("handles singular vs plural in the warning message", () => {
    const singular = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: tradesAfter(1),
    });
    expect(singular.message).toBe("You've logged 1 trade on this rule — 29 more before changing it.");

    const zero = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: [],
    });
    expect(zero.tradesOnCurrentRules).toBe(0);
    expect(zero.remaining).toBe(30);
    expect(zero.message).toBe("You've logged 0 trades on this rule — 30 more before changing it.");
  });

  it("counts zero trades and keeps referenceDate null when previousPlanDate is null", () => {
    const result = check({
      previousPlanDate: null,
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: tradesAfter(50),
    });
    expect(result.tradesOnCurrentRules).toBe(0);
    expect(result.referenceDate).toBeNull();
    expect(result.remaining).toBe(30);
    expect(result.shouldWarn).toBe(true);
    expect(result.message).toBe("You've logged 0 trades on this rule — 30 more before changing it.");
  });

  it("skips trades with invalid dates", () => {
    const result = check({
      newRules: [rule("r1", "Only A+ setups"), rule("r2", "Risk 2% max")],
      trades: [{ tradeDate: "not-a-date", result: "WIN" }, ...tradesAfter(2)],
    });
    expect(result.tradesOnCurrentRules).toBe(2);
  });
});
