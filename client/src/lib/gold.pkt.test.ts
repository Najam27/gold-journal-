import { describe, expect, it } from "vitest";
import { actualRMultiple, formatActualR, formatRr, getPktDateInput, getPktSession, isFuturePktDate } from "./gold";

describe("getPktSession", () => {
  it("classifies a manual trade opened at 05:30 PKT as Asian regardless of the browser timezone", () => {
    expect(getPktSession(new Date("2026-08-14T00:30:00.000Z"))).toBe("Asian");
  });

  it("uses the trader-specified PKT transitions across the session schedule", () => {
    expect(getPktSession(new Date("2026-08-13T20:30:00.000Z"))).toBe("Post-NY");
    expect(getPktSession(new Date("2026-08-13T22:30:00.000Z"))).toBe("Pre-Asian");
    expect(getPktSession(new Date("2026-08-14T10:00:00.000Z"))).toBe("Post-London");
    expect(getPktSession(new Date("2026-08-14T11:30:00.000Z"))).toBe("Pre-NY");
    expect(getPktSession(new Date("2026-08-14T15:00:00.000Z"))).toBe("Post-NY");
  });

  it("uses the fixed UTC+5 business date regardless of the browser-local day", () => {
    const beforePktMidnight = new Date("2026-08-16T18:30:00.000Z");
    const afterPktMidnight = new Date("2026-08-16T19:30:00.000Z");
    expect(getPktDateInput(beforePktMidnight)).toBe("2026-08-16");
    expect(getPktDateInput(afterPktMidnight)).toBe("2026-08-17");
    expect(isFuturePktDate("2026-08-18", afterPktMidnight)).toBe(true);
    expect(isFuturePktDate("2026-08-17", afterPktMidnight)).toBe(false);
  });

  it("keeps planned R:R separate from realized actual R and blocks undefined risk", () => {
    expect(formatRr(12.3, 101.25)).toBe("1 : 8.23");
    expect(actualRMultiple(12.3, -7.4)).toBeCloseTo(-0.6016, 4);
    expect(formatActualR(12.3, -7.4)).toBe("-0.60R");
    expect(formatActualR(0, 100)).toBe("—");
    expect(actualRMultiple(0, 100)).toBeNull();
  });
});
