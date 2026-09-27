import { describe, expect, it } from "vitest";
import { pktWeekRange, pktWeekday, reviewableWeekOffset, summarizeWeek } from "./weeklyReview";

// 27 Sep 2026 is a Sunday in PKT.
const SUNDAY = new Date("2026-09-27T12:00:00+05:00");

describe("pktWeekday", () => {
  it("returns 7 for a Sunday in PKT", () => {
    expect(pktWeekday(SUNDAY)).toBe(7);
  });

  it("returns 1 for a Monday in PKT", () => {
    expect(pktWeekday(new Date("2026-09-21T09:00:00+05:00"))).toBe(1);
  });

  it("returns 6 for a Saturday in PKT", () => {
    expect(pktWeekday(new Date("2026-09-26T18:00:00+05:00"))).toBe(6);
  });
});

describe("reviewableWeekOffset", () => {
  it("returns 0 on Sunday — the week ending today is reviewable", () => {
    expect(reviewableWeekOffset(SUNDAY)).toBe(0);
  });

  it("returns -1 on Saturday — the current week is still in progress", () => {
    expect(reviewableWeekOffset(new Date("2026-09-26T18:00:00+05:00"))).toBe(-1);
  });

  it("returns -1 on Monday", () => {
    expect(reviewableWeekOffset(new Date("2026-09-21T09:00:00+05:00"))).toBe(-1);
  });

  it("pairs with pktWeekRange to yield 21–27 Sep on Sunday 27 Sep", () => {
    const { start, end } = pktWeekRange(SUNDAY, reviewableWeekOffset(SUNDAY));
    expect(start.toISOString()).toBe("2026-09-20T19:00:00.000Z"); // Mon 21 Sep 00:00 PKT
    expect(end.toISOString()).toBe("2026-09-27T18:59:59.999Z"); // Sun 27 Sep 23:59:59.999 PKT
  });
});

describe("pktWeekRange", () => {
  it("returns Monday 00:00 PKT -> Sunday 23:59:59.999 PKT for the week containing a Sunday ref", () => {
    const { start, end } = pktWeekRange(SUNDAY);
    expect(start.toISOString()).toBe("2026-09-20T19:00:00.000Z"); // Mon 21 Sep 00:00 PKT
    expect(end.toISOString()).toBe("2026-09-27T18:59:59.999Z"); // Sun 27 Sep 23:59:59.999 PKT
  });

  it("handles a mid-week ref identically", () => {
    const { start, end } = pktWeekRange(new Date("2026-09-24T08:00:00+05:00"));
    expect(start.toISOString()).toBe("2026-09-20T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-27T18:59:59.999Z");
  });

  it("offsetWeeks=-1 returns the previous week", () => {
    const { start, end } = pktWeekRange(SUNDAY, -1);
    expect(start.toISOString()).toBe("2026-09-13T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-20T18:59:59.999Z");
  });

  it("offsetWeeks=1 returns the next week", () => {
    const { start, end } = pktWeekRange(SUNDAY, 1);
    expect(start.toISOString()).toBe("2026-09-27T19:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-04T18:59:59.999Z");
  });

  it("week starting on a Monday ref stays in the same week", () => {
    const { start } = pktWeekRange(new Date("2026-09-21T00:00:00+05:00"));
    expect(start.toISOString()).toBe("2026-09-20T19:00:00.000Z");
  });

  it("throws on an invalid ref", () => {
    expect(() => pktWeekRange("not-a-date")).toThrow();
  });
});

describe("summarizeWeek", () => {
  const { start, end } = pktWeekRange(SUNDAY);
  const inWeek = (date: string, extra: Record<string, unknown> = {}) => ({
    tradeDate: date,
    pnl: 0,
    result: "WIN",
    ...extra,
  });

  it("produces correct bounds, label, and an empty summary", () => {
    const s = summarizeWeek([], [], start, end);
    expect(s.weekStartIso).toBe(start.toISOString());
    expect(s.weekEndIso).toBe(end.toISOString());
    expect(s.weekLabel).toBe("21 – 27 Sep 2026");
    expect(s.tradeCount).toBe(0);
    expect(s.closedCount).toBe(0);
    expect(s.winRate).toBeNull();
    expect(s.netPnl).toBe(0);
    expect(s.avgR).toBeNull();
    expect(s.profitFactor).toBeNull();
    expect(s.biggestWin).toBeNull();
    expect(s.biggestLoss).toBeNull();
    expect(s.topMistakes).toEqual([]);
    expect(s.plannedPct).toBeNull();
    expect(s.daysTraded).toBe(0);
    expect(s.plansLogged).toBe(0);
  });

  it("labels a week crossing a month boundary", () => {
    const { start: s2, end: e2 } = pktWeekRange(new Date("2026-10-01T12:00:00+05:00"));
    const summary = summarizeWeek([], [], s2, e2);
    expect(summary.weekLabel).toBe("28 Sep – 4 Oct 2026");
  });

  it("labels a week crossing a year boundary", () => {
    const { start: s3, end: e3 } = pktWeekRange(new Date("2026-12-31T12:00:00+05:00"));
    const summary = summarizeWeek([], [], s3, e3);
    expect(summary.weekLabel).toBe("28 Dec – 3 Jan 2027");
  });

  it("excludes trades outside the week and ignores invalid dates", () => {
    const trades = [
      inWeek("2026-09-21T00:00:00+05:00"), // Monday 00:00 PKT — inside
      inWeek("2026-09-27T23:59:59+05:00"), // Sunday edge — inside
      { ...inWeek("2026-09-28T00:00:00+05:00"), tradeDate: "2026-09-28T00:00:00+05:00" }, // next week
      { ...inWeek("2026-09-20T23:59:00+05:00"), tradeDate: "2026-09-20T23:59:00+05:00" }, // prev week
      { ...inWeek("2026-09-23T10:00:00+05:00"), tradeDate: "garbage" },
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.tradeCount).toBe(2);
    expect(s.daysTraded).toBe(2);
  });

  it("computes win rate over closed trades only (WIN only)", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN" }),
      inWeek("2026-09-22T11:00:00+05:00", { result: "win" }), // case-insensitive
      inWeek("2026-09-22T12:00:00+05:00", { result: "LOSS" }),
      inWeek("2026-09-22T13:00:00+05:00", { result: "BREAK_EVEN" }),
      inWeek("2026-09-22T14:00:00+05:00", { result: "OPEN" }), // not closed
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.closedCount).toBe(4);
    expect(s.winRate).toBeCloseTo(2 / 4);
  });

  it("returns null profit factor when there are no losses", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", pnl: 100 }),
      inWeek("2026-09-22T11:00:00+05:00", { result: "WIN", pnl: 50 }),
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.profitFactor).toBeNull();
    expect(s.netPnl).toBe(150);
  });

  it("computes profit factor as gross profit / gross loss", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", pnl: 200 }),
      inWeek("2026-09-22T11:00:00+05:00", { result: "LOSS", pnl: -100 }),
      inWeek("2026-09-22T12:00:00+05:00", { result: "LOSS", pnl: -50 }),
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.profitFactor).toBeCloseTo(200 / 150);
  });

  it("computes avgR ignoring zero-risk and non-numeric-risk trades", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", pnl: 200, risk: 100 }), // 2R
      inWeek("2026-09-22T11:00:00+05:00", { result: "LOSS", pnl: -50, risk: 100 }), // -0.5R
      inWeek("2026-09-22T12:00:00+05:00", { result: "WIN", pnl: 999, risk: 0 }), // ignored
      inWeek("2026-09-22T13:00:00+05:00", { result: "WIN", pnl: 999, risk: null }), // ignored
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.avgR).toBeCloseTo((2 - 0.5) / 2);
  });

  it("returns null avgR when no closed trade has risk > 0", () => {
    const trades = [inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", pnl: 100, risk: 0 })];
    expect(summarizeWeek(trades, [], start, end).avgR).toBeNull();
  });

  it("picks biggestWin and biggestLoss with PKT dates", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", pnl: 300 }),
      inWeek("2026-09-23T10:00:00+05:00", { result: "WIN", pnl: 100 }),
      inWeek("2026-09-24T10:00:00+05:00", { result: "LOSS", pnl: -50 }),
      inWeek("2026-09-25T10:00:00+05:00", { result: "LOSS", pnl: -400 }),
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.biggestWin).toEqual({ pnl: 300, date: "2026-09-22" });
    expect(s.biggestLoss).toEqual({ pnl: -400, date: "2026-09-25" });
  });

  it("returns null biggestWin/biggestLoss when there is nothing on that side", () => {
    const s = summarizeWeek([inWeek("2026-09-22T10:00:00+05:00", { result: "BREAK_EVEN", pnl: 0 })], [], start, end);
    expect(s.biggestWin).toBeNull();
    expect(s.biggestLoss).toBeNull();
  });

  it("tallies top mistakes, ordered by count, ignoring blanks", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "LOSS", mistake: "FOMO" }),
      inWeek("2026-09-22T11:00:00+05:00", { result: "LOSS", mistake: "FOMO" }),
      inWeek("2026-09-22T12:00:00+05:00", { result: "LOSS", mistake: "Revenge" }),
      inWeek("2026-09-22T13:00:00+05:00", { result: "LOSS", mistake: "   " }),
      inWeek("2026-09-22T14:00:00+05:00", { result: "LOSS", mistake: null }),
      inWeek("2026-09-22T15:00:00+05:00", { result: "OPEN", mistake: "Late — should not count" }),
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.topMistakes).toEqual([
      { mistake: "FOMO", count: 2 },
      { mistake: "Revenge", count: 1 },
    ]);
  });

  it("caps top mistakes at 5 and breaks ties deterministically", () => {
    const mistakes = ["m6", "m5", "m4", "m3", "m2", "m1"];
    const trades = mistakes.map((m, i) =>
      inWeek(`2026-09-22T${String(10 + i).padStart(2, "0")}:00:00+05:00`, { result: "LOSS", mistake: m }),
    );
    const s = summarizeWeek(trades, [], start, end);
    expect(s.topMistakes).toHaveLength(5);
    expect(s.topMistakes.map((m) => m.mistake)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("computes plannedPct over closed trades only", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", planStatus: "PLANNED" }),
      inWeek("2026-09-22T11:00:00+05:00", { result: "LOSS", planStatus: "UNPLANNED" }),
      inWeek("2026-09-22T12:00:00+05:00", { result: "LOSS", planStatus: "PLANNED" }),
      inWeek("2026-09-22T13:00:00+05:00", { result: "OPEN", planStatus: "PLANNED" }),
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.plannedPct).toBeCloseTo((2 / 3) * 100);
  });

  it("counts plans whose planDate falls in the week", () => {
    const plans = [
      { planDate: "2026-09-22T09:00:00+05:00" },
      { planDate: new Date("2026-09-25T09:00:00+05:00") },
      { planDate: "2026-09-28T09:00:00+05:00" }, // next week
      { planDate: "not-a-date" },
    ];
    const s = summarizeWeek([], plans, start, end);
    expect(s.plansLogged).toBe(2);
  });

  it("coerces string pnl and counts distinct PKT trade days", () => {
    const trades = [
      inWeek("2026-09-22T10:00:00+05:00", { result: "WIN", pnl: "150" }),
      inWeek("2026-09-22T23:30:00+05:00", { result: "LOSS", pnl: "-60" }),
    ];
    const s = summarizeWeek(trades, [], start, end);
    expect(s.netPnl).toBe(90);
    expect(s.daysTraded).toBe(1);
  });
});
