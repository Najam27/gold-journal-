import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA reliability contract", () => {
  it("keeps the three-second cadence while using bounded retry for transient HTTP failures", () => {
    expect(source).toContain("input int SyncSeconds = 3");
    expect(source).toContain("const int MAX_RETRY_BACKOFF_SECONDS = 60");
    expect(source).toContain("bool IsTransientStatus(int status)");
    expect(source).toContain("status == 502 || status == 503 || status == 504");
    expect(source).toContain("g_next_retry_at = TimeCurrent() + delay");
  });

  it("stops permanent rejections, records per-event recovery, and never logs the API key", () => {
    expect(source).toContain("bool g_permanent_rejection = false");
    expect(source).toContain("if(g_permanent_rejection) return false");
    expect(source).toContain("MarkEventSuccess(expectedEvent)");
    expect(source).toContain("[MT5 LIVE] %s recovered");
    expect(source).not.toMatch(/Print(?:Format)?\([^\n]*ApiKey/);
  });
});
