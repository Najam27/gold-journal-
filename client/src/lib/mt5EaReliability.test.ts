import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA reliability contract", () => {
  it("keeps the three-second cadence while using bounded retry for transient HTTP failures", () => {
    expect(source).toContain("#property version   \"2.6\"");
    expect(source).toContain("input int SyncSeconds = 3");
    expect(source).toContain("const int MAX_RETRY_BACKOFF_SECONDS = 60");
    expect(source).toContain("bool IsTransientStatus(int status)");
    expect(source).toContain("status == 502 || status == 503 || status == 504");
    expect(source).toContain("g_next_retry_at = TimeCurrent() + delay");
    expect(source).toContain("MT5 error=%d. Check Tools > Options > Expert Advisors > Allow WebRequest");
  });

  it("stops permanent rejections, records per-event recovery, and never logs the API key", () => {
    expect(source).toContain("bool g_permanent_rejection = false");
    expect(source).toContain("if(g_permanent_rejection) return false");
    expect(source).toContain("MarkEventSuccess(expectedEvent)");
    expect(source).toContain("[MT5 LIVE] %s recovered");
    expect(source).not.toContain("input string ConnectionId");
    expect(source).not.toContain("\\\"connection_id\\\"");
    expect(source).not.toMatch(/Print(?:Format)?\([^\n]*ApiKey/);
  });

  it("prints safe startup state and gives a specific recovery instruction for invalid or retired keys", () => {
    expect(source).toContain("[MT5 LIVE] EA v%s attached. Endpoint=%s; sync interval=%ds; history=%s.");
    expect(source).toContain("[MT5 LIVE] startup blocked: paste the current API key from Gold Journal MT5 Live into EA Inputs. Do not share that key.");
    expect(source).toContain("rejected HTTP=401; this API key is invalid or retired. In Gold Journal MT5 Live, issue a replacement key");
    expect(source).toContain('input string Endpoint = "https://topgjournal.netlify.app/api/mt5";');
  });
});
