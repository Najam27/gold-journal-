import { describe, expect, it } from "vitest";
import { PDF_MISSING, TRADE_PDF_INTERNAL_KEYS, TRADE_PDF_MAPPED_KEYS, buildTradePdfModel, checklistCompletion, checklistText, tradeIdLabel } from "./tradePdfModel";

const longNotes = Array.from({ length: 40 }, (_, index) => `Note line ${index + 1}: waited for the retest, managed risk, and reviewed the session narrative before closing.`).join("\n");

/** A trade carrying every persisted field, including a future one. */
const completeTrade = {
  id: 27,
  userId: 3,
  accountId: 11,
  tradeDate: "2026-08-12T09:30:00.000Z",
  session: "London",
  direction: "BUY",
  result: "WIN",
  level: "H4 RBS + FVG",
  timeframe: "15m",
  setupQuality: "A+",
  executionType: "Limit retest",
  marketCondition: "Trending · High volatility",
  biasAlignment: "With bias",
  confirmationType: "Displacement + BOS",
  slPlacement: "Below swing low",
  tpPlacement: "Previous week high",
  mistake: "Early entry|Oversize",
  holdQuality: "Good",
  patienceScore: 4,
  risk: "25.00",
  reward: "100.00",
  pnl: "75.50",
  openTime: "2026-08-12T09:30:00.000Z",
  closeTime: "2026-08-12T11:15:00.000Z",
  mfe: "92.00",
  mae: "-12.00",
  notes: longNotes,
  emotionBefore: "Calm and patient",
  emotionDuring: "Focused",
  emotionAfter: "Satisfied",
  planStatus: "PLANNED",
  planChecklist: "setup-exists|entry-confirmed|risk-in-limit",
  mt5Ticket: "123456789",
  clientMutationId: "mutation-1",
  screenshotKey: "gold-journal/owner/accounts/11/trades/27/private.png",
  screenshotName: "london-retest.png",
  screenshotUrl: "https://signed.example/screenshot",
  hasScreenshot: true,
  createdAt: new Date("2026-08-12T12:00:00.000Z"),
  updatedAt: new Date("2026-08-12T12:00:00.000Z"),
  futureField: "added after this export was written",
};

const fields = (model: ReturnType<typeof buildTradePdfModel>) => model.sections.flatMap(section => section.fields);
const value = (model: ReturnType<typeof buildTradePdfModel>, label: string) => fields(model).find(field => field.label === label)?.value;
const labels = (model: ReturnType<typeof buildTradePdfModel>) => fields(model).map(field => field.label);

describe("canonical trade PDF model", () => {
  it("exports every persisted trade field of a complete trade", () => {
    const model = buildTradePdfModel(completeTrade, { runningBalance: 1275.5 });
    expect(model.sections.map(section => section.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(model.sections.map(section => section.title)).toEqual(["Trade details", "Strategy", "Execution", "Risk & performance", "Plan & discipline", "Process & mistakes"]);
    expect(value(model, "Trade ID")).toBe("27");
    expect(value(model, "Trade date")).toBe("12/08/2026");
    expect(value(model, "Symbol")).toBe(PDF_MISSING);
    expect(value(model, "MT5 ticket")).toBe("#123456789");
    expect(value(model, "Session")).toBe("London");
    expect(value(model, "Direction")).toBe("BUY");
    expect(value(model, "Result")).toBe("WIN");
    expect(value(model, "Timeframe")).toBe("15m");
    expect(value(model, "Level / confluence")).toBe("H4 RBS + FVG");
    expect(value(model, "Setup quality")).toBe("A+");
    expect(value(model, "Confirmation")).toBe("Displacement + BOS");
    expect(value(model, "Market condition")).toBe("Trending · High volatility");
    expect(value(model, "Bias alignment")).toBe("With bias");
    expect(value(model, "Execution type")).toBe("Limit retest");
    expect(value(model, "SL placement")).toBe("Below swing low");
    expect(value(model, "TP placement")).toBe("Previous week high");
    expect(value(model, "Hold quality")).toBe("Good");
    expect(value(model, "Patience score")).toBe("4/5");
    expect(value(model, "Mistake / rule-break tags")).toBe("Early entry|Oversize");
    expect(value(model, "Rule-break tags")).toBe("Early entry · Oversize");
    expect(value(model, "Execution mistakes")).toBe("Early entry · Oversize");
    expect(value(model, "Analytical mistakes")).toBe(PDF_MISSING);
    expect(value(model, "Emotional triggers")).toBe(PDF_MISSING);
    expect(value(model, "Environmental factors")).toBe(PDF_MISSING);
    expect(value(model, "Planned risk")).toBe("$25.00");
    expect(value(model, "Planned reward")).toBe("$100.00");
    expect(value(model, "Planned R:R")).toBe("1 : 4.00");
    expect(value(model, "Actual P&L")).toBe("$75.50");
    expect(value(model, "Actual R")).toBe("+3.02R");
    expect(value(model, "Running balance")).toBe("$1,275.50");
    expect(value(model, "MFE")).toBe("$92.00");
    expect(value(model, "MAE")).toBe("-$12.00");
    expect(value(model, "Plan status")).toBe("PLANNED");
    expect(value(model, "Planned / unplanned")).toBe("Planned entry");
    expect(value(model, "Checklist completion")).toBe("3 / 10 checks confirmed");
    expect(value(model, "Process classification")).toMatch(/(Good|Bad) win — /);
    expect(value(model, "Rule adherence")).toMatch(/^\d+%$/);
    expect(value(model, "Trade duration")).toBe("1h 45m");
    expect(model.psychology).toEqual({ before: "Calm and patient", during: "Focused", after: "Satisfied" });
    expect(model.journalNotes).toBe(longNotes);
    expect(model.evidence).toEqual({ url: "https://signed.example/screenshot", filename: "london-retest.png", hasScreenshot: true });
  });

  it("keeps the whole journal entry instead of truncating it", () => {
    const model = buildTradePdfModel(completeTrade);
    expect(model.journalNotes).toBe(longNotes);
    expect(model.journalNotes.length).toBeGreaterThan(3000);
    expect(model.journalNotes.endsWith("before closing.")).toBe(true);
  });

  it("gives every persisted property a home in the export, including a field added later", () => {
    const model = buildTradePdfModel(completeTrade);
    expect(model.additionalFields).toEqual([{ label: "futureField", value: "added after this export was written" }]);
    const covered = new Set([...TRADE_PDF_MAPPED_KEYS, ...TRADE_PDF_INTERNAL_KEYS, ...model.additionalFields.map(field => field.label)]);
    Object.keys(completeTrade).forEach(key => expect(covered.has(key), `unhandled trade property: ${key}`).toBe(true));
  });

  it("never exports internal ownership, audit, or storage-path fields", () => {
    const serialized = JSON.stringify(buildTradePdfModel(completeTrade));
    ["gold-journal", "screenshotKey", "userId", "accountId", "clientMutationId", "createdAt", "updatedAt", "mutation-1"].forEach(secret => expect(serialized).not.toContain(secret));
    expect(labels(buildTradePdfModel(completeTrade))).not.toContain("screenshotKey");
  });

  it("renders a missing optional field as — rather than dropping it", () => {
    const minimal = buildTradePdfModel({ id: 9, tradeDate: "2026-08-12T09:30:00.000Z", pnl: null, result: "" });
    expect(labels(minimal)).toEqual(expect.arrayContaining(["Trade ID", "Trade date", "Symbol", "MT5 ticket", "Session", "Direction", "Result", "Timeframe", "Level / confluence", "Mistake / rule-break tags", "Planned risk", "Actual P&L", "Running balance", "Plan status", "Pre-trade checklist", "Confirmation"]));
    ["Symbol", "MT5 ticket", "Session", "Direction", "Timeframe", "Planned risk", "Actual P&L", "Running balance", "Pre-trade checklist"].forEach(label => expect(value(minimal, label), `${label} should render the missing marker`).toBe(PDF_MISSING));
    expect(value(minimal, "Result")).toBe(PDF_MISSING);
  });

  it("succeeds for an MT5 import that only carries execution fields", () => {
    const mt5 = buildTradePdfModel({ id: 41, tradeDate: "2026-08-13T02:00:00.000Z", mt5Ticket: 778899, direction: "SELL", result: "LOSS", pnl: "-30.00", openTime: "2026-08-13T02:00:00.000Z", closeTime: "2026-08-13T02:20:00.000Z", session: "Asian", timeframe: "5m", hasScreenshot: true, screenshotName: "mt5-chart.webp", screenshotUrl: null });
    expect(value(mt5, "MT5 ticket")).toBe("#778899");
    expect(value(mt5, "Actual P&L")).toBe("-$30.00");
    expect(value(mt5, "Trade duration")).toBe("20m");
    expect(value(mt5, "Plan status")).toBe(PDF_MISSING);
    expect(mt5.journalNotes).toBe("");
    expect(mt5.evidence).toEqual({ url: null, filename: "mt5-chart.webp", hasScreenshot: true });
  });

  it("exports the full psychology block", () => {
    const model = buildTradePdfModel({ id: 3, tradeDate: "2026-08-12T09:30:00.000Z", pnl: "5", result: "WIN", emotionBefore: "dar lag raha tha", emotionDuring: "confident in the setup", emotionAfter: "gussa aya — closed too early" });
    expect(model.psychology.before).toBe("dar lag raha tha");
    expect(model.psychology.during).toBe("confident in the setup");
    expect(model.psychology.after).toBe("gussa aya — closed too early");
  });

  it("exports plan status and the pre-trade checklist state", () => {
    const model = buildTradePdfModel({ id: 4, tradeDate: "2026-08-12T09:30:00.000Z", pnl: "5", result: "WIN", planStatus: "UNPLANNED", planChecklist: [{ id: "setup-exists", label: "Setup exists", checked: true }, { id: "stop-defined", label: "Stop-loss defined", checked: false }] });
    expect(value(model, "Plan status")).toBe("UNPLANNED");
    expect(value(model, "Planned / unplanned")).toBe("Unplanned entry");
    expect(value(model, "Pre-trade checklist")).toContain("✓ Setup exists");
    expect(value(model, "Pre-trade checklist")).toContain("✗ Stop-loss defined — not confirmed");
    expect(value(model, "Checklist completion")).toBe("1 / 10 checks confirmed");
    expect(model.sections.flatMap(section => section.fields).length).toBeGreaterThan(0);
  });

  it("flags the values the compact report must give the full page width", () => {
    const model = buildTradePdfModel(completeTrade);
    const field = (label: string) => fields(model).find(entry => entry.label === label);
    expect(field("Pre-trade checklist")?.wide).toBe(true);
    expect(field("Process review")?.wide).toBe(true);
    expect(field("Symbol")?.wide).toBeUndefined();
  });

  it("labels an unsynced local record and an empty checklist honestly", () => {
    expect(tradeIdLabel(-1000001)).toBe("Pending sync (local record)");
    expect(checklistText(null)).toBe(PDF_MISSING);
    expect(checklistCompletion("")).toBe(PDF_MISSING);
  });
});
