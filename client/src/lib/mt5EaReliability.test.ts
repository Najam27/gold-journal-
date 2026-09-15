import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("Gold Journal MT5 EA reliability contract", () => {
  it("declares every global it uses, so the EA compiles and appears in the MT5 Navigator", () => {
    // A used-but-undeclared global is a hard MetaEditor error: the compiler
    // produces no .ex5 file, so the EA never appears under Navigator > Expert
    // Advisors. This test is the guard against that class of regression.
    const declared = new Set<string>();
    for (const line of source.split("\n")) {
      if (!/^[A-Za-z#]/.test(line)) continue;
      for (const match of line.matchAll(/\b(g_[A-Za-z0-9_]+)\s*(?:\[\d*\])?\s*(?:=|;|,)/g)) declared.add(match[1]);
    }
    const used = new Set<string>([...source.matchAll(/\bg_[A-Za-z0-9_]+/g)].map(match => match[0]));
    const undeclared = [...used].filter(identifier => !declared.has(identifier));
    expect(undeclared).toEqual([]);
  });

  it("keeps the three-second cadence while using bounded retry for transient HTTP failures", () => {
    expect(source).toContain('#property version   "2.17"');
    expect(source).toContain("input int SyncSeconds = 3");
    // The transient-backoff ceiling is now a clamped EA input (default 60 s,
    // hard-capped at 900 s) instead of a magic constant.
    expect(source).toContain("input int MaxRetrySeconds = 60;");
    expect(source).toContain("const int MAX_RETRY_BACKOFF_SECONDS = 60");
    // Repeated configuration faults keep their own streak so the throttled log
    // line stays actionable instead of printing the same text forever.
    expect(source).toContain("int g_config_last_auth_status = 0;");
    expect(source).toContain("int g_config_auth_streak = 0;");
    expect(source).toContain("int g_config_last_endpoint_status = 0;");
    expect(source).toContain("int g_config_endpoint_streak = 0;");
    expect(source).toContain("const int MAX_RETRY_CEILING_SECONDS = 900");
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
    expect(source).toContain("[MT5 LIVE] STARTUP; EA_VERSION=%s; endpoint=%s; terminal_connected=%s; api_key_present=%s");
    expect(source).toContain("The EA stays loaded and recovers automatically once the inputs are valid.");
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
    // A rejected batch must NOT advance the cursor (zero data loss) and must
    // cool down before the next attempt instead of resending every 3 s.
    expect(source).toContain("if(!SendJson(payload, \"history_batch\")) {");
    expect(source).toContain("g_history_cursor = MathMin(cursor - added, position_count);");
    expect(source).toContain("g_history_batch_cooldown_until = now + HISTORY_BATCH_COOLDOWN_SECONDS;");
    expect(source).toContain("g_history_cursor = cursor");
    expect(source).toContain("g_history_in_progress = false");
    expect(source).toContain("bool idle_window = (g_last_history_attempt == 0");
    expect(source).toContain("pending++;");
  });

  it("queues a close event that arrives while a history job is running instead of dropping it", () => {
    expect(source).toContain("void RequestIncrementalHistory()");
    expect(source).toContain("g_history_retry_requested = true;");
    expect(source).toContain("g_history_retry_requested = false;");
    expect(source).toMatch(/else if\(g_history_retry_requested && !g_history_in_progress\) \{[\s\S]*?SendHistory\(false\);/);
  });

  it("never performs a 3650-day full replay as the routine 15-minute sync mechanism", () => {
    // The scheduler must choose the full window only when it is genuinely owed
    // (first backfill / daily gate); sweeps otherwise use the incremental path.
    expect(source).toContain("bool FullHistoryReplayDue(datetime now)");
    expect(source).toContain("if(HistoryDue(now)) SendHistory(FullHistoryReplayDue(now));");
    // The old scheduler hard-coded the full replay for every due history job.
    expect(source).not.toContain("if(HistoryDue(now)) SendHistory(true);");
  });

  it("queues a close event that arrives while a history job is running instead of dropping it", () => {
    expect(source).toContain("void RequestIncrementalHistory()");
    expect(source).toContain("g_history_retry_requested = true;");
    expect(source).toContain("g_history_retry_requested = false;");
    expect(source).toMatch(/else if\(g_history_retry_requested && !g_history_in_progress\) \{[\s\S]*?SendHistory\(false\);/);
  });

  it("never forgets an unreconstructable position: skipped becomes pending, never data loss", () => {
    expect(source).toContain("const int MAX_PENDING_HISTORY_TICKETS = 500;");
    expect(source).toContain("void EnqueuePendingTicket(ulong position_id)");
    expect(source).toContain("void DequeuePendingTicket(ulong position_id)");
    expect(source).toContain("void MergePendingIntoHistory()");
    expect(source).toContain("bool PendingHistoryRetryDue(datetime now)");
    expect(source).toContain("EnqueuePendingTicket(position_id);");
    // The working set must persist across timer cycles so the cursor cannot be
    // invalidated by a re-selected history snapshot mid-run.
    expect(source).toContain("ulong g_history_position_ids[];");
    expect(source).toContain("MergePendingIntoHistory();");
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
    expect(source).toContain("input int MaxOpenPositionsPerBatch = 200;");
    expect(source).toContain("bool SendOpenBatch(string &items[], int count, int batch_number, int batch_total)");
    // One failed batch must not block later batches of the same snapshot.
    expect(source).toContain("if(!SendOpenBatch(items, count, batch_number, batch_total)) deferred_batches++;");
    expect(source).toContain("only they repeat on the next timer");
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

  it("honors a 429 Retry-After and backs off exactly as long as the server asks", () => {
    expect(source).toContain("const int MAX_RETRY_AFTER_HONOR_SECONDS = 900;");
    expect(source).toContain("int retry_delay = retry_after_seconds > 0 ? MathMin(retry_after_seconds, MAX_RETRY_AFTER_HONOR_SECONDS) : RetryDelaySeconds();");
    expect(source).toMatch(/MarkEventFailure\(string expectedEvent, int status, string detail, int retry_after_seconds = 0\)/);
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
