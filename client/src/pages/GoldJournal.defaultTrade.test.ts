import { describe, expect, it } from "vitest";
import { defaultTrade } from "./GoldJournal";

describe("defaultTrade", () => {
  it("prefills only the current PKT session for a fresh manual trade", () => {
    expect(defaultTrade()).toMatchObject({
      direction: "",
      result: "",
      level: "",
      timeframe: "",
      setupQuality: "",
      executionType: "",
      patienceScore: "",
      risk: "",
      reward: "",
      pnl: "",
    });
  });
});
