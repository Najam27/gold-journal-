import { describe, expect, it } from "vitest";
import { formatUtcPlus5, Mt5TimestampError, normalizeMt5TimestampToUtcPlus5 } from "./mt5Timestamp";

describe("normalizeMt5TimestampToUtcPlus5", () => {
  const now = Date.parse("2026-12-31T23:59:59Z");

  it.each([
    [-8 * 60, "2026-08-17 10:00:00", "2026-08-17T18:00:00.000Z", "2026-08-17T23:00:00+05:00"],
    [-5 * 60, "2026-08-17 10:00:00", "2026-08-17T15:00:00.000Z", "2026-08-17T20:00:00+05:00"],
    [-3 * 60, "2026-08-17 10:00:00", "2026-08-17T13:00:00.000Z", "2026-08-17T18:00:00+05:00"],
    [-60, "2026-08-17 10:00:00", "2026-08-17T11:00:00.000Z", "2026-08-17T16:00:00+05:00"],
    [0, "2026-08-17 10:00:00", "2026-08-17T10:00:00.000Z", "2026-08-17T15:00:00+05:00"],
    [60, "2026-08-17 10:00:00", "2026-08-17T09:00:00.000Z", "2026-08-17T14:00:00+05:00"],
    [2 * 60, "2026-08-17 10:00:00", "2026-08-17T08:00:00.000Z", "2026-08-17T13:00:00+05:00"],
    [3 * 60, "2026-08-17 10:00:00", "2026-08-17T07:00:00.000Z", "2026-08-17T12:00:00+05:00"],
    [4 * 60, "2026-08-17 10:00:00", "2026-08-17T06:00:00.000Z", "2026-08-17T11:00:00+05:00"],
    [5 * 60, "2026-08-17 10:00:00", "2026-08-17T05:00:00.000Z", "2026-08-17T10:00:00+05:00"],
    [6 * 60, "2026-08-17 10:00:00", "2026-08-17T04:00:00.000Z", "2026-08-17T09:00:00+05:00"],
    [7 * 60, "2026-08-17 10:00:00", "2026-08-17T03:00:00.000Z", "2026-08-17T08:00:00+05:00"],
    [8 * 60, "2026-08-17 10:00:00", "2026-08-17T02:00:00.000Z", "2026-08-17T07:00:00+05:00"],
    [9 * 60, "2026-08-17 10:00:00", "2026-08-17T01:00:00.000Z", "2026-08-17T06:00:00+05:00"],
    [10 * 60, "2026-08-17 10:00:00", "2026-08-17T00:00:00.000Z", "2026-08-17T05:00:00+05:00"],
  ])("converts broker UTC offset %i minutes through an absolute instant to fixed UTC+5", (offset, raw, iso, business) => {
    const normalized = normalizeMt5TimestampToUtcPlus5(raw, offset, now);
    expect(normalized.toISOString()).toBe(iso);
    expect(formatUtcPlus5(normalized)).toBe(business);
  });

  it("preserves explicit offsets and Unix epoch values as absolute instants", () => {
    expect(normalizeMt5TimestampToUtcPlus5("2026.08.17 10:00:00+02:00", 480, now).toISOString()).toBe("2026-08-17T08:00:00.000Z");
    expect(normalizeMt5TimestampToUtcPlus5(Date.parse("2026-08-17T08:00:00Z") / 1_000, 0, now).toISOString()).toBe("2026-08-17T08:00:00.000Z");
  });

  it("handles a broker UTC+8 midnight-crossing into the preceding fixed UTC+5 business date", () => {
    const normalized = normalizeMt5TimestampToUtcPlus5("2026-08-18 01:00:00", 8 * 60, now);
    expect(normalized.toISOString()).toBe("2026-08-17T17:00:00.000Z");
    expect(formatUtcPlus5(normalized)).toBe("2026-08-17T22:00:00+05:00");
  });

  it("rejects malformed and genuinely future timestamps after normalization", () => {
    expect(() => normalizeMt5TimestampToUtcPlus5("not a timestamp", 180, now)).toThrow(Mt5TimestampError);
    expect(() => normalizeMt5TimestampToUtcPlus5("2027-01-01 05:06:00", 180, now)).toThrow("FUTURE_TRADE");
  });
});
