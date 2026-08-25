import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA reliability contract", () => {
  it("keeps the three-second cadence while using bounded retry for transient HTTP failures", () => {
    expect(source).toContain("#property version   \"2.12\"");
    expect(source).toContain("input int SyncSeconds = 3");
    expect(source).toContain("const int MAX_RETRY_BACKOFF_SECONDS = 60");
    expect(source).toContain("bool IsTransientStatus(int status)");
    expect(source).toContain("status == 502 || status == 503 || status == 504");
    expect(source).toContain("g_next_retry_at = TimeCurrent() + delay");
    expect(source).toContain("operation=%s; http=-1; mt5_error=%d; endpoint=%s");
  });

  it("stops permanent rejections, records per-event recovery, and never logs the API key", () => {
    expect(source).toContain("bool g_permanent_rejection = false");
    expect(source).toContain("if(g_permanent_rejection) return false");
    expect(source).toContain("MarkEventSuccess(expectedEvent, JsonStringValue(response_text, \"connectionReference\"), JsonStringValue(response_text, \"dataSourceReference\"))");
    expect(source).toContain("JsonStringValue(response_text, \"dataSourceReference\")");
    expect(source).toContain("authenticated connection reference=%s");
    expect(source).toContain("authenticated data source reference=%s");
    expect(source).toContain("[MT5 LIVE] %s recovered");
    expect(source).not.toContain("input string ConnectionId");
    expect(source).not.toContain("\\\"connection_id\\\"");
    expect(source).not.toMatch(/Print(?:Format)?\([^\n]*ApiKey/);
  });

  it("prints safe startup state and gives a specific recovery instruction for invalid or retired keys", () => {
    expect(source).toContain("[MT5 LIVE] STARTUP; EA_VERSION=%s; endpoint=%s; terminal_connected=%s; api_key_present=true");
    expect(source).toContain("[MT5 LIVE] startup blocked: paste the current API key from Gold Journal MT5 Live into EA Inputs. Do not share that key.");
    expect(source).toContain("API key rejected or retired; operation=%s; http=%d. In Gold Journal MT5 Live, issue a replacement key");
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
    expect(source).toContain("g_history_in_progress || (g_last_history_attempt == 0");
    expect(source).toContain("skipped unreconstructable historical position");
  });

  it("starts a recent incremental history scan when a broker-manual close transaction arrives after full history completed", () => {
    expect(source).toContain("void OnTradeTransaction(const MqlTradeTransaction &transaction");
    expect(source).toContain("if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT) SendHistory(false);");
    expect(source).not.toContain("if(!fullReplay && g_history_full_replay) return;");
    expect(source).toContain("datetime from = now - (g_history_full_replay ? HistoryDays * 86400 : MathMax(3600, SyncSeconds * 4));");
  });
});
