import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA reliability contract", () => {
  it("keeps the three-second cadence while using bounded retry for transient HTTP failures", () => {
    expect(source).toContain('#property version   "2.15"');
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

  it("never reports a still-existing position as terminal CLOSED, so a partial close keeps its remaining volume OPEN", () => {
    // A DEAL_ENTRY_OUT deal is emitted for partial closes and for the closing
    // leg of a netting INOUT reversal. Only a position that no longer exists in
    // the terminal may become a terminal Trade Log record.
    expect(source).toMatch(/string ClosedPositionJson\(ulong position_id\) \{\s*\/\/[\s\S]*?if\(PositionSelectByTicket\(position_id\)\) return "";/);
    expect(source).toContain("bool IsPositionOpenNow(ulong ticket)");
    expect(source).toContain("if(IsPositionOpenNow(position_id)) { still_open++; continue; }");
    expect(source).toContain("bool CanSend(string expectedEvent)");
  });

  it("splits a large open-position snapshot into independently retryable batches of at most 200 records", () => {
    expect(source).toContain("const int MAX_OPEN_POSITIONS_PER_BATCH = 200;");
    expect(source).toContain("bool SendOpenBatch(string &items[], int count, int batch_number, int batch_total)");
    expect(source).toContain("if(!SendOpenBatch(items, count, batch_number, batch_total)) return;");
    expect(source).toContain("the remaining batches retry on the next timer");
  });

  it("reconciles server-tracked open tickets against the terminal and reconstructs a close it never reported", () => {
    expect(source).toContain("const int MAX_TRACKED_OPEN_TICKETS = 2000;");
    expect(source).toContain("void ApplyReconciliationFeed(string response_text)");
    expect(source).toContain("void RefreshReconcileQueue()");
    expect(source).toContain("void ReconcileNextTicket()");
    expect(source).toContain('if(format != "csv") return;');
    expect(source).toContain("ReconcileNextTicket();");
    expect(source).toContain("recovered from terminal history.");
    expect(source).toContain("bool SendClosedRecord(string record)");
  });

  it("classifies payload/version rejections as recoverable configuration problems instead of a network storm", () => {
    expect(source).toContain("bool IsNonRetryableCode(string code)");
    expect(source).toContain('code == "UNSUPPORTED_VERSION"');
    expect(source).toContain('code == "BATCH_TOO_LARGE"');
    expect(source).toContain("IsNonRetryableCode(detail) || (status >= 400 && !IsTransientStatus(status))");
    expect(source).toContain("payload/version/configuration mismatch, not a network outage");
  });

  it("sweeps history incrementally on its own cadence so a missed transaction event cannot leave a trade OPEN", () => {
    expect(source).toContain("const int HISTORY_SWEEP_SECONDS = 900;");
    expect(source).toContain("bool sweep_due = (g_last_history_attempt == 0 || now - g_last_history_attempt >= HISTORY_SWEEP_SECONDS);");
    expect(source).toContain("return (idle_window && full_replay_due) || sweep_due;");
  });

  it("starts a recent incremental history scan when a broker-manual close transaction arrives after full history completed", () => {
    expect(source).toContain("void OnTradeTransaction(const MqlTradeTransaction &transaction");
    expect(source).toContain("DEAL_POSITION_ID");
    expect(source).toContain("SendHistory(false);");
    // The close notification reads the transaction itself, because the deal may
    // not be in the terminal history cache yet (HistoryDealGetInteger returned 0
    // and silently dropped the notification).
    expect(source).toContain("if(transaction.type != TRADE_TRANSACTION_DEAL_ADD) return;");
    expect(source).toContain("ENUM_DEAL_ENTRY entry = transaction.entry;");
    expect(source).toContain("ulong position_id = transaction.position;");
    expect(source).not.toContain("HistoryDealGetInteger(transaction.deal");
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
