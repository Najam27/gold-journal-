import { describe, expect, it } from "vitest";
import { evaluateGoal } from "./goldRules";

describe("Gold Journal goal calculations", () => {
  it("keeps an inactive goal pending while reporting safe progress", () => {
    expect(evaluateGoal({ value: 0, target: 3, comparison: "LTE", hasActivity: false })).toEqual({ status: "PENDING", percentage: 0 });
  });

  it("distinguishes GTE met, at-risk, and pending status", () => {
    expect(evaluateGoal({ value: 10, target: 10, comparison: "GTE", hasActivity: true }).status).toBe("MET");
    expect(evaluateGoal({ value: 8.5, target: 10, comparison: "GTE", hasActivity: true }).status).toBe("AT RISK");
    expect(evaluateGoal({ value: 4, target: 10, comparison: "GTE", hasActivity: true }).status).toBe("PENDING");
  });

  it("distinguishes LTE met, at-risk, and breached status", () => {
    expect(evaluateGoal({ value: 2, target: 3, comparison: "LTE", hasActivity: true }).status).toBe("MET");
    expect(evaluateGoal({ value: 2.5, target: 3, comparison: "LTE", hasActivity: true }).status).toBe("AT RISK");
    expect(evaluateGoal({ value: 4, target: 3, comparison: "LTE", hasActivity: true })).toEqual({ status: "BREACHED", percentage: 100 });
  });

  it("reports intermediate progress percentages for both comparison directions", () => {
    expect(evaluateGoal({ value: 4, target: 10, comparison: "GTE", hasActivity: true }).percentage).toBe(40);
    expect(evaluateGoal({ value: 1.5, target: 3, comparison: "LTE", hasActivity: true }).percentage).toBe(50);
  });
});
