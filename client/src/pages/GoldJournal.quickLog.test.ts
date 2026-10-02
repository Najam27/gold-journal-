import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPktDateInput } from "@/lib/gold";
import { pktDateToTimestamp } from "@shared/pktDate";

const source = readFileSync(
  fileURLToPath(new URL("./GoldJournal.tsx", import.meta.url)),
  "utf8"
);

describe("Quick Log trade date contract", () => {
  it("converts the dialog's YYYY-MM-DD string into the server's timestamp input", () => {
    // The Quick Log dialog works with the PKT date-input string, but
    // trades.create requires a positive integer millisecond timestamp
    // (server/goldRouter.ts timestampInput). Sending the raw string fails
    // validation on every submit — this is the regression guard.
    const input = getPktDateInput(new Date("2026-10-02T04:00:00+05:00"));
    expect(input).toBe("2026-10-02");
    const timestamp = pktDateToTimestamp(input);
    expect(Number.isInteger(timestamp)).toBe(true);
    expect(timestamp).toBeGreaterThan(0);
    expect(timestamp).toBe(Date.parse("2026-10-02T12:00:00+05:00"));
  });

  it("sends the converted timestamp from saveQuickTrade, never the raw string", () => {
    const start = source.indexOf("const saveQuickTrade");
    const end = source.indexOf("const exportRows", start);
    const body = source.slice(start, end);
    expect(body).toContain("tradeDate: pktDateToTimestamp(payload.tradeDate)");
    expect(body).not.toContain("tradeDate: payload.tradeDate");
    expect(body).not.toMatch(/mutateAsync\(\{[\s\S]*?\}\s*as any\)/);
  });
});
