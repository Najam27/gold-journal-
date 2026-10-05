import { describe, expect, it } from "vitest";
import { buildTradePresentation } from "@/lib/tradePresentation";
import { LIVE_MODE, TESTING_MODE } from "@/lib/tradeModeConfig";

/**
 * Tests 9–10 of the Testing Mode isolation suite:
 *
 *   9. Live Psychology remains unchanged — the default (Live) presentation
 *      keeps the psychology section and the $ P&L, exactly as before.
 *  10. Testing hides Psychology/Emotions — the Testing presentation drops the
 *      psychology section and renders the result in pips.
 *
 * Every surface (viewer, trade-card PNG, PDF) renders from this canonical
 * model, so these assertions cover all of them.
 */

const trade = {
  id: 1,
  userId: 3,
  accountId: 11,
  tradeDate: "2026-10-05T09:15:00.000Z",
  session: "London",
  direction: "BUY",
  result: "WIN",
  level: "",
  timeframe: "",
  setupQuality: "",
  executionType: "",
  marketCondition: "",
  biasAlignment: "",
  confirmationType: "",
  slPlacement: "",
  tpPlacement: "",
  holdQuality: "",
  mistake: "",
  patienceScore: null,
  planFollowScore: null,
  planStatus: null,
  planChecklist: null,
  quickLogged: false,
  entryPrice: "2650.00",
  slPrice: null,
  tpPrice: null,
  exitPrice: "2652.00",
  mfe: null,
  mae: null,
  risk: "50.00",
  reward: "100.00",
  pnl: "20.00",
  notes: "",
  emotionBefore: "Calm",
  emotionDuring: "Patient",
  emotionAfter: "Satisfied",
  screenshotKey: null,
  screenshotName: null,
  screenshotUrl: null,
  hasScreenshot: false,
};

describe("trade presentation environment modes", () => {
  it("9. Live keeps Psychology and the $ P&L (default mode, unchanged)", () => {
    const model = buildTradePresentation(trade as any);
    expect(model.sections.map(section => section.id)).toContain("psychology");
    const psychology = model.sections.find(section => section.id === "psychology")!;
    expect(psychology.fields.length).toBeGreaterThan(0);
    // The P&L KPI still renders dollars for Live.
    const pnlField = model.sections.flatMap(section => section.fields).find(field => field.key === "pnl")!;
    expect(pnlField.label).toBe("Actual P&L");
    expect(pnlField.value).toContain("$");
    expect(model.identity.pnl).toContain("$");
  });

  it("9b. explicit LIVE_MODE matches the default", () => {
    const def = buildTradePresentation(trade as any);
    const explicit = buildTradePresentation(trade as any, { mode: LIVE_MODE });
    expect(explicit.sections.map(section => section.id)).toEqual(def.sections.map(section => section.id));
  });

  it("10. Testing drops the Psychology section and renders pips", () => {
    const model = buildTradePresentation(trade as any, { mode: TESTING_MODE });
    expect(model.sections.map(section => section.id)).not.toContain("psychology");
    // The P&L field becomes pips: 2650 → 2652 on a BUY = +20.0 pips.
    const pnlField = model.sections.flatMap(section => section.fields).find(field => field.key === "pnl")!;
    expect(pnlField.label).toBe("Actual pips");
    expect(pnlField.value).toBe("+20 pips");
    expect(model.identity.pnl).toBe("+20 pips");
    // The exit price is visible on Testing trades.
    const exitField = model.sections.flatMap(section => section.fields).find(field => field.key === "exitPrice");
    expect(exitField).toBeDefined();
  });

  it("10b. Testing without an exit price shows no pips yet", () => {
    const open = buildTradePresentation({ ...trade, exitPrice: null, result: "OPEN" } as any, { mode: TESTING_MODE });
    const pnlField = open.sections.flatMap(section => section.fields).find(field => field.key === "pnl")!;
    expect(pnlField.value).toBe("—");
  });
});
