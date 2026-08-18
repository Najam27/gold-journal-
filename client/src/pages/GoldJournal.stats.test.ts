import { describe, expect, it } from "vitest";
import { journalStats } from "./GoldJournal";

describe("journalStats", () => {
  it("uses full-account aggregates when the visible trade list is bounded", () => {
    const stats = journalStats(
      [{ result: "WIN", pnl: "10" }, { result: "LOSS", pnl: "-5" }],
      { startingBalance: "100" },
      [],
      50,
      { total: 100_000, wins: 60_000, losses: 35_000, closed: 95_000, pnl: "12345.67" },
    );
    expect(stats).toEqual({ total: 100_000, wins: 60_000, losses: 35_000, pnl: 12345.67, balance: 12495.67, winRate: 60_000 / 95_000 * 100 });
  });
});
