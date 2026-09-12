import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA reliability contract", () => {
  it("keeps the three-second cadence while using bounded retry for transient HTTP failures", () => {
    expect(source).toContain('#property version   "2.14"');
    expect(source).toContain("input int SyncSeconds = 3");
    expect(source).toContain("const int MAX_RETRY_BACKOFF_SECONDS = 60");
    expect(source).toContain("bool IsTransientStatus(int status)");
    // Server-side 4xx payload rejections (422 invalid data/timestamp, 400,
    // 410) are transient and must never stop the whole bridge; only 401/403
    // (key) and 404/405 (endpoint) are configuration problems, and those back
    // off without ever latching permanently.
    expect(source).toContain("status == 422 || status == 429");
    expect(source).toContain("status == 502 || status == 503 || status == 504");
    expect(source).toContain("g_next_retry_at = now + retry_delay;");
    expect(source).toContain("operation=%s; http=-1; mt5_error=%d; failures=%d");
  });

  it("never latches a permanent rejection, records per-event recovery, and never logs the API key", () => {
    expect(source).not.toContain("g_permanent_rejection");
    expect(source).toContain("bool g_requires_revalidation = false");
    expect(source).toContain("MarkEventSuccess(expectedEvent, JsonStringValue(response_text, \"connectionReference\"), JsonStringValue(response_text, \"dataSourceReference\"))");
    expect(source).toContain("JsonStringValue(response_text, \"dataSourceReference\")");
    expect(source).toContain("authenticated connection reference=%s");
    expect(source).toContain("authenticated data source reference=%s");
    expect(source).toContain("[MT5 LIVE] %s recovered");
    expect(source).not.toContain("input string ConnectionId");
    expect(source).not.toContain("\\\"connection_id\\\"");
    expect(source).not.toMatch(/Print(?:Format)?\([^\n]*ApiKey/);
  });

  it("prints safe startup state and gives a recoverable recovery instruction for invalid or retired keys", () => {
    expect(source).toContain("[MT5 LIVE] STARTUP; EA_VERSION=%s; endpoint=%s; terminal_connected=%s; api_key_present=true");
    expect(source).toContain("correcting the input and applying recovers it");
    expect(source).toContain("API key rejected or retired; operation=%s; http=%d");
    expect(source).toContain("The EA keeps probing and resumes automatically.");
    expect(source).toContain('input string Endpoint = "__GOLD_JOURNAL_MT5_ENDPOINT__";');
    expect(source).toContain("MT5 endpoint not found; operation=%s; http=%d; endpoint=%s");
  });

  it("sends only one bounded history batch per timer cycle and resumes a full backfill after transient failure", () => {
    expect(source).toContain("bool g_history_in_progress = false");
    expect(source).toContain("bool g_history_full_replay = true");
    expect(source).toContain("int g_history_cursor = 0");
    expect(source).toContain("while(cursor < position_count && added < HISTORY_BATCH_SIZE)");
    expect(source).toContain("if(!SendJson(payload, \"history_batch\")) return;");
    expect(source).toContain("g_history_cursor = cursor");
    expect(source).toContain("g_history_in_progress = false");
    expect(source).toContain("bool idle_window = (g_last_history_attempt == 0");
    expect(source).toContain("skipped unreconstructable historical position");
  });

  it("starts a recent incremental history scan when a broker-manual close transaction arrives after full history completed", () => {
    expect(source).toContain("void OnTradeTransaction(const MqlTradeTransaction &transaction");
    expect(source).toContain("DEAL_POSITION_ID");
    expect(source).toContain("SendHistory(false);");
    // The incremental sweep must reach back to the last successful close sync,
    // not a fixed one-hour window, so a close that happened while the EA was
    // offline is still collected instead of re-arming the 24-hour replay gate.
    expect(source).toContain("QUICK_HISTORY_WINDOW_SECONDS");
    expect(source).toContain("since_last_success");
    expect(source).not.toContain("MathMax(3600, SyncSeconds * 4)");
    // The in-progress guard must not permanently suppress deal-triggered
    // incremental syncs after a full replay has completed.
    expect(source).not.toContain("if(!fullReplay && g_history_full_replay) return;");
  });
});
