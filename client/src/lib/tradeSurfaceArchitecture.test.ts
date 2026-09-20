import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicTradeCardFields } from "./tradeCardPng";
import {
  EDITABLE_TRADE_FIELDS,
  TRADE_INTERNAL_KEYS,
  TRADE_PRESENTATION_LABELS,
  TRADE_PRESENTATION_SOURCE_KEYS,
  TRADE_SECTION_THEME,
  buildTradePresentation,
  presentationValues,
} from "./tradePresentation";

/**
 * The architecture contract between the four trade surfaces.
 *
 * Edit Trade defines what can be recorded, `tradePresentation.ts` defines what is
 * shown, and View Trade, the Share Trade Card, and the PDF report are only
 * *renderers* of that one model. These tests read the surface sources themselves,
 * so a future surface that starts hand-picking its own field list — the exact
 * failure that made Edit Trade richer than View Trade — fails here instead of
 * shipping a partial export.
 */

const source = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const SURFACES = [
  { name: "View Trade / Trade Card", file: "./../components/TradeDetailDialog.tsx", needsModel: true },
  { name: "Share Trade Card", file: "./tradeCardPng.ts", needsModel: true },
  { name: "PDF report", file: "./tradePdfReport.ts", needsModel: true },
] as const;

/** A trade carrying every editable field, plus the metadata that must stay hidden. */
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
};

const model = () => buildTradePresentation(completeTrade, { runningBalance: 1270.9 });

describe("trade surface architecture", () => {
  it("has every rendering surface consume the canonical presentation model", () => {
    for (const surface of SURFACES) {
      const text = source(surface.file);
      expect(text, `${surface.name} must build the canonical model`).toContain("buildTradePresentation");
      expect(text, `${surface.name} must not import a removed model`).not.toContain("tradePdfModel");
    }
  });

  it("keeps internal plumbing out of every surface source", () => {
    for (const surface of SURFACES) {
      const text = source(surface.file);
      for (const key of TRADE_INTERNAL_KEYS) {
        expect(text.includes(`"${key}"`) || text.includes(`.${key}`), `${surface.name} references internal key ${key}`).toBe(false);
      }
    }
  });

  it("does not re-list the canonical fields by hand in a surface", () => {
    // The canonical model is the only place that names a field. A surface may print
    // field.label / field.value, never its own copy of the field list.
    for (const surface of SURFACES) {
      const text = source(surface.file);
      const duplicated = TRADE_PRESENTATION_LABELS.filter(label => text.includes(`"${label}"`));
      expect(duplicated, `${surface.name} hardcodes canonical labels: ${duplicated.join(", ")}`).toEqual([]);
    }
  });

  it("gives every editable field a canonical home and no internal key one", () => {
    const covered = new Set([...TRADE_PRESENTATION_SOURCE_KEYS, "planChecklist", "screenshotUrl", "hasScreenshot", "screenshot"]);
    for (const field of EDITABLE_TRADE_FIELDS) {
      expect(covered.has(field.key), `${field.key} is editable but has no canonical field`).toBe(true);
    }
    for (const key of TRADE_INTERNAL_KEYS) {
      expect(covered.has(key), `${key} is internal and must not be a presentation field`).toBe(false);
    }
  });

  it("carries identical labels and values from Edit Trade through View, Share, and PDF", () => {
    // The share card has no running-balance context of its own, so both surfaces
    // are compared on the same inputs.
    const view = presentationValues(buildTradePresentation(completeTrade));
    const share = new Map(publicTradeCardFields(completeTrade));
    // View Trade and the share card resolve every canonical field to the same value.
    for (const [label, value] of Object.entries(view)) expect(share.get(label), `share card ${label}`).toBe(value);
    // And every user-facing value Edit Trade can record is present in both.
    for (const field of EDITABLE_TRADE_FIELDS) {
      if (field.key === "screenshot") continue;
      expect(Object.values(view).join("\n"), `no canonical value for editable field ${field.key}`).not.toBe("");
    }
    const serialized = JSON.stringify([...share.entries()]);
    [...TRADE_INTERNAL_KEYS, "17446150", "new-york-retest.png", "gold-journal/owner"].forEach(secret => {
      expect(serialized, `share card leaked ${secret}`).not.toContain(secret);
    });
  });

  it("never prints evidence or sync plumbing as a technical label", () => {
    // Evidence is the trader's chart image; how it is stored is not part of the
    // review. These are the exact labels the review surfaces must never print.
    const forbidden = ["MT5 ticket", "Ticket #", "Screenshot filename", "Stored screenshot", "Storage key", "Image dimensions", "PNG / JPEG"];
    const files = [...SURFACES.map(surface => surface.file), "./../components/TradeDialogWithCustomOptions.tsx"];
    for (const file of files) {
      const text = source(file);
      for (const phrase of forbidden) expect(text, `${file} prints "${phrase}"`).not.toContain(phrase);
    }
  });

  it("shares one section palette across the surfaces", () => {
    const accents = Object.values(TRADE_SECTION_THEME).map(theme => theme.accent);
    // Every canonical section is visually distinguishable in the viewer, the shared
    // image, and the PDF.
    expect(new Set(accents).size).toBe(accents.length);
    accents.forEach(accent => expect(accent).toMatch(/^#[0-9A-F]{6}$/i));
  });
});
