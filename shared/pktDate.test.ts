import { describe, expect, it } from "vitest";
import { addPktMonths, getPktDateKey, pktDateToTimestamp, pktMonthCalendar } from "./pktDate";

describe("PKT business-date helpers", () => {
  it("uses UTC+5 for date keys and canonical midday persistence", () => {
    expect(getPktDateKey("2026-08-03T19:30:00.000Z")).toBe("2026-08-04");
    expect(pktDateToTimestamp("2026-08-04")).toBe(Date.parse("2026-08-04T12:00:00+05:00"));
  });

  it("builds calendar months without the browser-local timezone", () => {
    expect(addPktMonths("2026-01", -1)).toBe("2025-12");
    expect(pktMonthCalendar("2026-08")).toEqual(expect.objectContaining({ firstWeekday: 6 }));
    expect(pktMonthCalendar("2026-08").days).toHaveLength(31);
  });
});
