import { describe, expect, it } from "vitest";
import {
  CANONICAL_TRADE_PRESENTATION_FIELDS,
  EDITABLE_TRADE_FIELDS,
  PRESENTATION_MISSING,
  TRADE_INTERNAL_KEYS,
  TRADE_PRESENTATION_FIELD_SPECS,
  TRADE_PRESENTATION_KPI_KEYS,
  TRADE_PRESENTATION_LABELS,
  TRADE_PRESENTATION_SOURCE_KEYS,
  buildTradePresentation,
  checklistCompletion,
  checklistItems,
  checklistText,
  presentationValues,
  resolveTone,
  tradeIdLabel,
} from "./tradePresentation";

/** A trade carrying every field the Edit Trade form can record. */
const completeTrade = {
  id: 696,
  userId: 3,
  accountId: 11,
  tradeDate: "2026-09-16T09:15:00.000Z",
  session: "New York",
  direction: "SELL",
  result: "WIN",
  level: "H4 RBS + FVG",
  timeframe: "15m",
  setupQuality: "A+",
  confirmationType: "BOS + displacement",
  executionType: "Manual direct",
  marketCondition: "Trending",
  biasAlignment: "Counter-trend",
  slPlacement: "Above swing high",
  tpPlacement: "R multiple",
  holdQuality: "Average",
  patienceScore: 4,
  mistake: "Impatience|Closed early|Entered without confirmation",
  risk: "10.00",
  reward: "93.30",
  pnl: "70.90",
  planStatus: "PLANNED",
  planChecklist: "setup-exists|matches-plan|stop-defined|risk-in-limit|size-valid|rr-acceptable|session-valid|no-emotional-trigger|not-revenge",
  notes: "Waited for the retest, entered on displacement, managed the position into the weekly level.",
  emotionBefore: "Calm",
  emotionDuring: "Fear",
  emotionAfter: "Regret",
  openTime: "2026-09-16T09:15:00.000Z",
  closeTime: "2026-09-16T09:19:00.000Z",
  mfe: "80.00",
  mae: "-6.00",
  symbol: "XAUUSD",
  mt5Ticket: "17446150",
  clientMutationId: "mutation-1",
  screenshotKey: "gold-journal/owner/accounts/11/trades/696/private.png",
  screenshotName: "new-york-retest.png",
  screenshotUrl: "https://signed.example/evidence",
  hasScreenshot: true,
  createdAt: new Date("2026-09-16T12:00:00.000Z"),
  updatedAt: new Date("2026-09-16T12:00:00.000Z"),
  futureField: "added after this code was written",
};

const model = () => buildTradePresentation(completeTrade, { runningBalance: 1270.9 });
const values = () => presentationValues(model());

describe("canonical trade presentation model", () => {
  it("maps every editable trade field to a presentation field", () => {
    const covered = new Set([...TRADE_PRESENTATION_SOURCE_KEYS, "screenshotUrl", "hasScreenshot", "planChecklist"]);
    for (const field of EDITABLE_TRADE_FIELDS) {
      expect(covered.has(field.key), `EDITABLE_TRADE_FIELDS.${field.key} has no canonical presentation field`).toBe(true);
    }
  });

  it("covers every persisted property of a complete trade, including a field added later", () => {
    const presented = model();
    expect(presented.additionalFields).toEqual([{ key: "additional:futureField", label: "futureField", value: "added after this code was written" }]);
    const known = new Set([...TRADE_PRESENTATION_SOURCE_KEYS, ...TRADE_INTERNAL_KEYS, "id", "symbol", ...presented.additionalFields.map(field => field.label)]);
    Object.keys(completeTrade).forEach(key => expect(known.has(key), `unhandled trade property: ${key}`).toBe(true));
  });

  it("never exposes technical or internal metadata on any user-facing surface", () => {
    const presented = model();
    const serialized = JSON.stringify(presented);
    ["mt5Ticket", "17446150", "screenshotName", "new-york-retest.png", "screenshotKey", "gold-journal/owner", "userId", "accountId", "clientMutationId", "createdAt", "updatedAt"].forEach(secret => {
      expect(serialized, `leaked ${secret}`).not.toContain(secret);
    });
    // The screenshot itself stays available as evidence: the signed url is how the
    // image is fetched (never printed), and no file or storage metadata travels.
    expect(presented.evidence).toEqual({ url: "https://signed.example/evidence", hasScreenshot: true });
    expect(Object.keys(presented.evidence)).toEqual(["url", "hasScreenshot"]);
  });

  it("uses identical labels and values on every surface", () => {
    const presented = model();
    const fromSections = new Map(presented.sections.flatMap(section => section.fields).map(field => [field.label, field.value]));
    TRADE_PRESENTATION_LABELS.forEach(label => expect(fromSections.has(label), `missing label ${label}`).toBe(true));
    expect(presented.sections.map(section => section.id)).toEqual(["overview", "strategy", "execution", "risk", "discipline", "checklist", "mistakes", "psychology", "journal"]);
    const kpiLabels = presented.kpis.map(kpi => kpi.key);
    expect(kpiLabels).toEqual([...TRADE_PRESENTATION_KPI_KEYS]);
  });

  it("renders every recorded value of a fully populated trade", () => {
    const presented = values();
    expect(presented["Trade ID"]).toBe("696");
    expect(presented["Trade date"]).toBe("16/09/2026");
    expect(presented["Session"]).toBe("New York");
    expect(presented["Direction"]).toBe("SELL");
    expect(presented["Result"]).toBe("WIN");
    expect(presented["Symbol"]).toBe("XAUUSD");
    expect(presented["Level / confluence"]).toBe("H4 RBS + FVG");
    expect(presented["Timeframe"]).toBe("15m");
    expect(presented["Setup quality"]).toBe("A+");
    expect(presented["Confirmation signals"]).toBe("BOS + displacement");
    expect(presented["Execution type"]).toBe("Manual direct");
    expect(presented["Market conditions"]).toBe("Trending");
    expect(presented["Direction vs bias"]).toBe("Counter-trend");
    expect(presented["SL placement"]).toBe("Above swing high");
    expect(presented["TP placement"]).toBe("R multiple");
    expect(presented["Hold quality"]).toBe("Average");
    expect(presented["Patience score"]).toBe("4/5");
    expect(presented["Planned risk"]).toBe("$10.00");
    expect(presented["Planned reward"]).toBe("$93.30");
    expect(presented["Planned R:R"]).toBe("1 : 9.33");
    expect(presented["Actual P&L"]).toBe("$70.90");
    expect(presented["Actual R"]).toBe("+7.09R");
    expect(presented["Running balance"]).toBe("$1,270.90");
    expect(presented["MFE"]).toBe("$80.00");
    expect(presented["MAE"]).toBe("-$6.00");
    expect(presented["Plan status"]).toBe("PLANNED");
    expect(presented["Planned / unplanned"]).toBe("Planned entry");
    expect(presented["Checklist completion"]).toBe("9 / 10 checks confirmed");
    expect(presented["Rule adherence"]).toMatch(/^\d+%$/);
    expect(presented["Process classification"]).toMatch(/win — /);
    expect(presented["Mistake / rule-break tags"]).toBe("Impatience|Closed early|Entered without confirmation");
    expect(presented["Analytical mistakes"]).toBe("Entered without confirmation");
    expect(presented["Execution mistakes"]).toBe("Closed early");
    expect(presented["Emotional triggers"]).toBe("Impatience");
    expect(presented["Environmental factors"]).toBe(PRESENTATION_MISSING);
    expect(presented["Before trade"]).toBe("Calm");
    expect(presented["During trade"]).toBe("Fear");
    expect(presented["After trade"]).toBe("Regret");
    expect(presented["Trade notes"]).toBe(completeTrade.notes);
  });

  it("keeps the identity, key figures, checklist, and psychology as typed data", () => {
    const presented = model();
    expect(presented.identity.line).toBe("16/09/2026 · XAUUSD · NEW YORK · SELL · WIN");
    expect(presented.identity.pnl).toBe("$70.90");
    expect(presented.identity.pnlValue).toBeCloseTo(70.9, 5);
    expect(presented.kpis.map(kpi => kpi.value)).toEqual(["$70.90", "+7.09R", "1 : 9.33", presented.kpis[3].value, "9 / 10 checks confirmed", "4/5"]);
    expect(presented.kpis.map(kpi => kpi.tone)).toEqual(["positive", "positive", "accent", "neutral", "neutral", "neutral"]);
    expect(presented.checklist).toHaveLength(10);
    expect(presented.checklist.filter(item => item.confirmed)).toHaveLength(9);
    expect(presented.checklist[2]).toEqual({ label: "Entry condition confirmed", confirmed: false, recorded: false });
    expect(presented.psychology).toEqual({ before: "Calm", during: "Fear", after: "Regret" });
    expect(presented.classification.label).toMatch(/win/i);
  });

  it("renders — for a field that exists but was never recorded", () => {
    const minimal = buildTradePresentation({ id: 9, tradeDate: "2026-09-16T09:15:00.000Z", pnl: null, result: "" });
    const fields = presentationValues(minimal);
    expect(fields["Symbol"]).toBe(PRESENTATION_MISSING);
    expect(fields["Session"]).toBe(PRESENTATION_MISSING);
    expect(fields["Result"]).toBe(PRESENTATION_MISSING);
    expect(fields["Planned risk"]).toBe(PRESENTATION_MISSING);
    expect(fields["Actual P&L"]).toBe(PRESENTATION_MISSING);
    expect(fields["Running balance"]).toBe(PRESENTATION_MISSING);
    expect(fields["Checklist completion"]).toBe(PRESENTATION_MISSING);
    expect(fields["Planned / unplanned"]).toBe(PRESENTATION_MISSING);
    expect(fields["Trade notes"]).toBe(PRESENTATION_MISSING);
    // No field is dropped just because it is empty: the full schema is present.
    expect(Object.keys(fields)).toHaveLength(CANONICAL_TRADE_PRESENTATION_FIELDS.length);
    expect(minimal.kpis.map(kpi => kpi.tone)).toEqual(["neutral", "neutral", "accent", "neutral", "neutral", "neutral"]);
  });

  it("keeps a very long journal entry whole and never truncates it", () => {
    const long = Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}: waited for the retest, managed risk, reviewed the session before closing.`).join("\n");
    const presented = buildTradePresentation({ id: 1, tradeDate: "2026-09-16", pnl: "5", result: "WIN", notes: long });
    expect(presented.journalNotes).toBe(long);
    expect(presented.journalNotes.length).toBeGreaterThan(3000);
    expect(presented.journalNotes.endsWith("before closing.")).toBe(true);
  });

  it("keeps every mistake tag, including ones the taxonomy does not recognise", () => {
    const presented = buildTradePresentation({ id: 1, tradeDate: "2026-09-16", pnl: "5", result: "WIN", mistake: "Moved SL|Not in taxonomy|Revenge" });
    const fields = presentationValues(presented);
    expect(fields["Mistake / rule-break tags"]).toBe("Moved SL|Not in taxonomy|Revenge");
    expect(fields["Rule adherence"]).not.toBeUndefined();
    // A custom tag stays visible in the raw tag field even when it has no category.
    expect(fields["Mistake / rule-break tags"]).toContain("Not in taxonomy");
  });

  it("describes the process independently of the outcome", () => {
    expect(buildTradePresentation({ id: 1, tradeDate: "2026-09-16", pnl: "50", risk: "10", result: "WIN", mistake: "Revenge|Oversize" }).classification.key).toBe("BAD_WIN");
    expect(buildTradePresentation({ id: 2, tradeDate: "2026-09-16", pnl: "-10", risk: "10", result: "LOSS", mistake: "Moved SL" }).classification.key).toBe("BAD_LOSS");
    expect(buildTradePresentation({ id: 3, tradeDate: "2026-09-16", pnl: null, result: "" }).classification.key).toBe("NOT_EVALUATED");
  });

  it("labels an unsynced local record and an empty checklist honestly", () => {
    expect(tradeIdLabel(-1000001)).toBe("Pending sync (local record)");
    expect(checklistText(null)).toBe(PRESENTATION_MISSING);
    expect(checklistItems(null)).toHaveLength(10);
    expect(checklistItems(null).every(item => !item.recorded)).toBe(true);
    expect(checklistCompletion("")).toBe(PRESENTATION_MISSING);
  });

  it("declares each field's tone on the model instead of guessing it in a renderer", () => {
    const spec = (key: string) => TRADE_PRESENTATION_FIELD_SPECS.find(field => field.key === key);
    expect(spec("pnl")?.tone).toBe("signed");
    expect(spec("plannedRr")?.tone).toBe("accent");
    expect(spec("level")?.wide).toBe(true);
    expect(spec("tradeDate")?.inHeader).toBe(true);
    expect(resolveTone({ tone: "signed", value: "-$12.00" })).toBe("negative");
    expect(resolveTone({ tone: "signed", value: "$12.00" })).toBe("positive");
    expect(resolveTone({ tone: "signed", value: PRESENTATION_MISSING })).toBe("neutral");
  });
});
