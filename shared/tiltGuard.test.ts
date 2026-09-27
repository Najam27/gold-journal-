import { describe, expect, it } from "vitest";
import { assessTiltRisk } from "./tiltGuard";

const loss = (day: number, overrides: Record<string, unknown> = {}) => ({
  tradeDate: new Date(Date.UTC(2026, 0, day, 10)),
  result: "LOSS",
  pnl: -50,
  risk: 50,
  ...overrides,
});
const win = (day: number, overrides: Record<string, unknown> = {}) => ({
  tradeDate: new Date(Date.UTC(2026, 0, day, 10)),
  result: "WIN",
  pnl: 80,
  risk: 50,
  ...overrides,
});
const NOW = new Date(Date.UTC(2026, 0, 10, 15));

describe("pre-trade tilt guard", () => {
  it("is CLEAR for a calm journal", () => {
    const trades = [win(8), loss(9), win(10)];
    const tilt = assessTiltRisk(trades, { now: NOW });
    expect(tilt.level).toBe("CLEAR");
    expect(tilt.cooldownMinutes).toBeNull();
    expect(tilt.reasons).toHaveLength(0);
  });

  it("raises CAUTION on three consecutive losses", () => {
    const trades = [win(7), loss(8), loss(9), loss(10)];
    const tilt = assessTiltRisk(trades, { now: NOW });
    expect(tilt.level).toBe("CAUTION");
    expect(tilt.cooldownMinutes).toBe(15);
    expect(tilt.reasons[0]).toMatch(/3 consecutive losses/);
  });

  it("orders STAND_DOWN on five consecutive losses", () => {
    const trades = [loss(6), loss(7), loss(8), loss(9), loss(10)];
    const tilt = assessTiltRisk(trades, { now: NOW });
    expect(tilt.level).toBe("STAND_DOWN");
    expect(tilt.cooldownMinutes).toBe(60);
    expect(tilt.summary).toMatch(/Stand down/);
  });

  it("stands down when the daily loss limit is hit", () => {
    const trades = [loss(10, { pnl: -300 }), loss(10, { pnl: -250 })];
    const tilt = assessTiltRisk(trades, { now: NOW, dailyLossLimit: 500 });
    expect(tilt.level).toBe("STAND_DOWN");
    expect(tilt.reasons.some(reason => reason.includes("daily limit"))).toBe(true);
  });

  it("warns at 80% of the daily loss limit", () => {
    const trades = [loss(10, { pnl: -400 })];
    const tilt = assessTiltRisk(trades, { now: NOW, dailyLossLimit: 500 });
    expect(tilt.level).toBe("CAUTION");
    expect(tilt.reasons[0]).toMatch(/80%/);
  });

  it("flags self-tagged revenge behaviour in recent trades", () => {
    const trades = [win(8), win(9), loss(10, { behaviors: "revenge, fomo" })];
    const tilt = assessTiltRisk(trades, { now: NOW });
    expect(tilt.level).toBe("CAUTION");
    expect(tilt.reasons.some(reason => reason.includes("revenge/overtrading"))).toBe(true);
  });

  it("flags revenge sizing after losses", () => {
    const trades = [loss(7), loss(8), loss(9), loss(10, { risk: 200 })];
    const tilt = assessTiltRisk(trades, { now: NOW });
    expect(tilt.level).toBe("CAUTION");
    expect(tilt.reasons.some(reason => reason.includes("revenge sizing"))).toBe(true);
  });

  it("ignores OPEN trades", () => {
    const trades = [loss(8), loss(9), { ...loss(10), result: "OPEN", pnl: 5000 }];
    const tilt = assessTiltRisk(trades, { now: NOW });
    expect(tilt.level).toBe("CLEAR");
  });
});
