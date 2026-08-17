import { describe, expect, it } from "vitest";
import { getPktDateInput, getPktSession, isFuturePktDate } from "./gold";

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
});
