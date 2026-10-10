import { describe, expect, it } from "vitest";
import { actualRMultiple, formatActualR, formatMoney, formatRr, getPktDateInput, getPktSession, isFuturePktDate } from "./gold";

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

  it("keeps planned R:R and realized actual R in the same 1:X ratio format", () => {
    expect(formatRr(12.3, 101.25)).toBe("1 : 8.23");
    expect(actualRMultiple(12.3, -7.4)).toBeCloseTo(-0.6016, 4);
    expect(formatActualR(12.3, -7.4)).toBe("1 : -0.60");
    expect(formatActualR(100, 250)).toBe("1 : 2.50");
    expect(formatActualR(0, 100)).toBe("—");
    expect(actualRMultiple(0, 100)).toBeNull();
  });

  it("never renders a fake zero: missing P&L is —, not 1 : 0.00", () => {
    expect(actualRMultiple(100, null)).toBeNull();
    expect(actualRMultiple(100, "")).toBeNull();
    expect(actualRMultiple(null, 50)).toBeNull();
    expect(actualRMultiple("", 50)).toBeNull();
    expect(actualRMultiple("N/A", 50)).toBeNull();
    expect(formatActualR(100, null)).toBe("—");
    expect(formatActualR(100, "")).toBe("—");
  });

  it("renders — for missing money, never $0.00", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney("")).toBe("—");
    expect(formatMoney("N/A")).toBe("—");
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(12.3)).toBe("$12.30");
  });

  it("renders — for missing or zero planned risk/reward, never 1 : 0.00", () => {
    expect(formatRr(46.4, 0)).toBe("—");
    expect(formatRr(46.4, null)).toBe("—");
    expect(formatRr(46.4, undefined)).toBe("—");
    expect(formatRr(46.4, "")).toBe("—");
    expect(formatRr(null, 100)).toBe("—");
    expect(formatRr("", "")).toBe("—");
    expect(formatRr(0, 100)).toBe("—");
    expect(formatRr(46.4, 92.8)).toBe("1 : 2.00");
  });
});
