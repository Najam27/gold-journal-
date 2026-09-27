import { describe, expect, it } from "vitest";
import { summarizeCalibration, type CalibrationTradeInput } from "./calibration";

/** Five rated trades at the given scores; scores may be numbers or numeric strings. */
const rated = (scores: Array<number | string | null>): CalibrationTradeInput[] =>
  scores.map((planFollowScore) => ({ planFollowScore }));

describe("summarizeCalibration", () => {
  it("needs data when the journal has no computed adherence", () => {
    const result = summarizeCalibration(rated([5, 5, 5, 5, 5]), null);
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
    expect(result.sample).toBe(5);
    expect(result.gapPoints).toBeNull();
    expect(result.message).toMatch(/computed adherence/i);
  });

  it("needs data when computed adherence is undefined", () => {
    const result = summarizeCalibration(rated([5, 5, 5, 5, 5]), undefined);
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
  });

  it("says how many more rated trades are needed below the minimum sample", () => {
    const result = summarizeCalibration(rated([4, 5]), 80);
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
    expect(result.sample).toBe(2);
    expect(result.message).toMatch(/3 more trades/);
  });

  it("ignores ratings outside 1-5 and non-numeric values", () => {
    const result = summarizeCalibration(rated([5, 0, 6, "abc", null, "", 5, 5, 5, 5]), 100);
    // Only the five 5s count; gap is 0 -> calibrated.
    expect(result.sample).toBe(5);
    expect(result.verdict).toBe("CALIBRATED");
    expect(result.averageSelfScore).toBe(5);
  });

  it("accepts numeric-string and fractional in-range ratings", () => {
    const result = summarizeCalibration(rated(["5", 4.5, "4", 5, 5]), 95);
    expect(result.sample).toBe(5);
    expect(result.averageSelfScore).toBeCloseTo(4.7, 5);
    expect(result.selfAdherencePct).toBeCloseTo(94, 5);
  });

  it("maps the 1-5 average onto 0-100 for comparison", () => {
    const result = summarizeCalibration(rated([4, 4, 4, 4, 5]), 80);
    expect(result.averageSelfScore).toBeCloseTo(4.2, 5);
    expect(result.selfAdherencePct).toBeCloseTo(84, 5);
    expect(result.gapPoints).toBeCloseTo(4, 5);
    expect(result.verdict).toBe("CALIBRATED");
  });

  it("calls a 10-point gap calibrated (boundary is inclusive)", () => {
    const result = summarizeCalibration(rated([5, 5, 5, 5, 5]), 90);
    expect(result.gapPoints).toBeCloseTo(10, 5);
    expect(result.verdict).toBe("CALIBRATED");
  });

  it("flags overconfidence when self-scores run hotter than the data", () => {
    const result = summarizeCalibration(rated([5, 5, 5, 5, 5]), 60);
    expect(result.verdict).toBe("OVERCONFIDENT");
    expect(result.gapPoints).toBeCloseTo(40, 5);
    expect(result.message).toMatch(/40 points higher/);
  });

  it("flags underconfidence when the trader grades harder than the data", () => {
    const result = summarizeCalibration(rated([1, 1, 1, 1, 1]), 70);
    expect(result.verdict).toBe("UNDERCONFIDENT");
    expect(result.gapPoints).toBeCloseTo(-50, 5);
    expect(result.message).toMatch(/50 points harder/);
  });

  it("reports the sample even when there is nothing to compare", () => {
    const result = summarizeCalibration([], 80);
    expect(result.sample).toBe(0);
    expect(result.verdict).toBe("INSUFFICIENT_DATA");
    expect(result.message).toMatch(/5 more trades/);
  });
});
