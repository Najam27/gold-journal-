#property strict
#property version   "2.16"
#property description "Gold Journal read-only journal bridge: never places or manages trades; sends account, position, and history facts to Gold Journal."

input string Endpoint = "__GOLD_JOURNAL_MT5_ENDPOINT__";
input string ApiKey = "PASTE_ONCE_FROM_GOLD_JOURNAL";
input int BrokerUtcOffsetMinutes = 180;
input int SyncSeconds = 3;
input int SummarySeconds = 15;
input int HeartbeatSeconds = 30;
input int HistoryDays = 3650;
input bool SendHistoryOnInit = true;
input string RiskSymbol = "";
// Ceiling for the transient-failure backoff (1,2,4,8,15,30,60 by default).
// Configurable so a flaky network can trade speed against request volume.
input int MaxRetrySeconds = 60;
// Maximum size of one open-position request (the backend rejects larger
// batches), so this must never exceed its 200-position cap.
input int MaxOpenPositionsPerBatch = 200;

const string EA_VERSION = "2.16.0";
const string PAYLOAD_VERSION = "2";
const int REQUEST_TIMEOUT_MS = 15000;
const int HISTORY_BATCH_SIZE = 50;
// The backend accepts at most 200 open positions per request (one atomic
// Supabase RPC). A 500-position account is therefore split into independently
// retryable batches instead of being rejected forever as one oversized payload.
const int MAX_OPEN_POSITIONS_PER_BATCH = 200;
// The server sends every ticket it believes is OPEN with each heartbeat. The EA
// verifies each one against the terminal and resolves the missing ones from
// authoritative history, which recovers closes MT5 never reported.
const int MAX_TRACKED_OPEN_TICKETS = 2000;
const int RECONCILE_RETRY_SECONDS = 600;
const int RECONCILE_MAX_RETRY_SECONDS = 3600;
// Bounded escalation window used only when a position is gone but the terminal
// history cache does not yet hold its deals.
const int RECONCILE_HISTORY_ESCALATION_DAYS = 730;
const int WIDE_HISTORY_SELECT_MIN_INTERVAL_SECONDS = 300;
const int FULL_HISTORY_RETRY_SECONDS = 24 * 60 * 60;
// One close batch per timer cycle while a multi-batch backfill walks its
// cursor: two heavy batches back to back would fight the open-position stream
// for the same WebRequest slot every three seconds.
const int HISTORY_BATCH_COOLDOWN_SECONDS = 12;
const int QUICK_HISTORY_WINDOW_SECONDS = 24 * 60 * 60;
// Even with no close event at all, a bounded incremental sweep runs this often
// so a missed OnTradeTransaction can never leave a closed trade OPEN for a day.
const int HISTORY_SWEEP_SECONDS = 900;
// Default ceiling for the transient backoff when the MaxRetrySeconds input is
// not overridden.
const int MAX_RETRY_BACKOFF_SECONDS = 60;
// Configuration or credential problems must never become a permanent dead
// state. They back off further (five minutes) but are always retried, so
// correcting the key or endpoint recovers the EA without re-attaching it.
const int MAX_CONFIG_RETRY_SECONDS = 300;
// Backoff ceiling as a clamped input (<=0 input falls back to the default).
const int DEFAULT_OPEN_BATCH_SIZE = 200;
// Absolute upper bound for the configurable transient-backoff ceiling, so an
// unusual input can never silence the EA for hours.
const int MAX_RETRY_CEILING_SECONDS = 900;
// After this many seconds a position that failed reconstruction goes back in
// the pending queue, so "skipped" never becomes "forgotten".
const int PENDING_HISTORY_RETRY_SECONDS = 60;
// Hard bound for the pending-history queue: keeps memory and retries bounded
// even if a broker's history cache stays empty for a long stretch.
const int MAX_PENDING_HISTORY_TICKETS = 500;
// A 429 Retry-After value is honored up to this bound (rate-limit windows can
// legitimately be minutes long; longer values are clamped to keep the EA live).
const int MAX_RETRY_AFTER_HONOR_SECONDS = 900;
// A price above this absolute bound is treated as malformed data instead of
// being forwarded as-is (guards against garbage numeric values).
const double MAX_PLAUSIBLE_PRICE = 1000000.0;

// Connection state machine. A single failed call moves the EA to RECONNECTING;
// it never destroys its ability to recover. AUTH_ERROR and CONFIG_ERROR are
// distinct latched-but-recoverable states: they tell the trader exactly which
// knob is wrong (key vs endpoint) instead of showing a generic offline.
enum ENUM_EA_STATE
{
   EA_INIT = 0,
   EA_CONNECTING = 1,
   EA_CONNECTED = 2,
   EA_SYNCING = 3,
   EA_HEALTHY = 4,
   EA_RECONNECTING = 5,
   EA_AUTH_ERROR = 6,
   EA_CONFIG_ERROR = 7,
   EA_ERROR = 8
};

datetime g_last_history_sync = 0;
datetime g_last_history_attempt = 0;
datetime g_last_close_event_at = 0;
datetime g_next_retry_at = 0;
datetime g_next_summary_at = 0;
datetime g_next_heartbeat_at = 0;
datetime g_last_contact_ok_at = 0;
datetime g_last_summary_success = 0;
datetime g_last_open_success = 0;
datetime g_last_history_success = 0;
int g_consecutive_failures = 0;
int g_config_failures = 0;
bool g_requires_revalidation = false;
bool g_config_warning_logged = false;
bool g_compatibility_reported = false;
bool g_summary_reported = false;
bool g_open_batch_reported = false;
bool g_history_reported = false;
bool g_history_in_progress = false;
bool g_history_full_replay = true;
int g_history_cursor = 0;
bool g_payload_warning_logged = false;
// Set when the EA is loaded with missing/invalid inputs. The EA stays on the
// chart in CONFIG_ERROR, prints one actionable line, and re-evaluates the
// inputs on every timer so a corrected key/endpoint recovers without removal.
bool g_config_invalid = false;
// Pending-history retry queue: positions whose closing deals exist but could
// not be reconstructed yet, or whose batch failed transiently. They are
// retried until they send successfully, so "skipped" never becomes data loss.
ulong g_pending_tickets[];
datetime g_pending_next_at[];
int g_pending_count = 0;
// Working set of the current history job, kept between timer cycles so the
// batch cursor walks one stable snapshot instead of re-selecting history
// (which would shift indexes under the cursor mid-run).
ulong g_history_position_ids[];
int g_history_position_count = 0;
// Set when a close transaction arrives while a history job is already
// running; Sync() then reruns the sweep instead of silently dropping it.
bool g_history_retry_requested = false;
// Before this time, one history batch per cycle: a multi-batch backfill must
// spread out instead of hammering the API every 3 seconds.
datetime g_history_batch_cooldown_until = 0;
// Detects a backwards clock jump (VPS/VM time resync) so schedules computed
// from an earlier TimeCurrent() cannot silently extend into the future.
datetime g_last_timer_now = 0;
ulong g_deal_position_id = 0;
string g_connection_reference = "";
string g_data_source_reference = "";
ENUM_EA_STATE g_state = EA_INIT;
// Reconciliation state: what the server believes is open, and the closes this
// terminal has not been able to reconstruct yet.
ulong g_server_open_tickets[];
int g_server_open_count = 0;
bool g_server_open_known = false;
bool g_server_open_truncated = false;
ulong g_reconcile_tickets[];
int g_reconcile_attempts[];
datetime g_reconcile_next_at[];
int g_reconcile_count = 0;
datetime g_last_wide_history_select = 0;

string StateLabel(ENUM_EA_STATE state)
{
   switch(state)
   {
      case EA_INIT:         return "INIT";
      case EA_CONNECTING:   return "CONNECTING";
      case EA_CONNECTED:    return "CONNECTED";
      case EA_SYNCING:      return "SYNCING";
      case EA_HEALTHY:      return "HEALTHY";
      case EA_RECONNECTING: return "RECONNECTING";
      case EA_AUTH_ERROR:   return "AUTH_ERROR";
      case EA_CONFIG_ERROR: return "CONFIG_ERROR";
      case EA_ERROR:        return "ERROR";
   }
   return "UNKNOWN";
}

void SetState(ENUM_EA_STATE next)
{
   if(g_state == next) return;
   g_state = next;
   PrintFormat("[MT5 LIVE] state=%s; failures=%d; last_success=%s; next_retry=%s",
               StateLabel(g_state), g_consecutive_failures,
               g_last_contact_ok_at > 0 ? TimeToString(g_last_contact_ok_at, TIME_DATE | TIME_SECONDS) : "never",
               g_next_retry_at > TimeCurrent() ? TimeToString(g_next_retry_at, TIME_DATE | TIME_SECONDS) : "now");
}

string JsonEscape(string value) {
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", "\\r");
   StringReplace(value, "\n", "\\n");
   return value;
}

string Number(double value, int digits = 2) { return DoubleToString(value, digits); }
bool HasConfiguredEndpoint() { return StringFind(Endpoint, "https://") == 0 && StringFind(Endpoint, "__GOLD_JOURNAL_MT5_ENDPOINT__") < 0 && StringFind(Endpoint, "YOUR-SITE.netlify.app") < 0; }
bool HasConfiguredApiKey() { return StringLen(ApiKey) >= 24 && StringFind(ApiKey, "PASTE_ONCE_FROM_GOLD_JOURNAL") < 0; }
// MT5 datetime values are broker-server clock values. Send an offset-free string so
// the API can apply BrokerUtcOffsetMinutes before deriving fixed PKT session/date.
string BrokerTimestamp(datetime value) { return "\"" + TimeToString(value, TIME_DATE | TIME_SECONDS) + "\""; }
string Direction(ENUM_POSITION_TYPE type) { return type == POSITION_TYPE_BUY ? "BUY" : "SELL"; }
string DealDirection(long type) { return type == DEAL_TYPE_BUY ? "BUY" : "SELL"; }
string OppositeDirection(long type) { return type == DEAL_TYPE_BUY ? "SELL" : "BUY"; }

// Temporarily unhealthy conditions that must always be retried: a network drop,
// a Worker restart, rate limiting, a Cloudflare gateway error, and the
// transient 400/410/422 payload conditions the backend reports while it folds a
// broker snapshot into the journal.
bool IsTransientStatus(int status) { return status == -1 || status == 400 || status == 408 || status == 410 || status == 422 || status == 429 || status == 500 || status == 502 || status == 503 || status == 504; }

// Server codes that describe a payload/version/clock mismatch. Retrying them at
// the three-second cadence would be a request storm, so they use the slower
// configuration backoff. They are still retried forever: once the EA build or
// the configuration is corrected the bridge recovers with no manual restart.
bool IsNonRetryableCode(string code) {
   return code == "UNSUPPORTED_VERSION" || code == "INVALID_PAYLOAD" || code == "INVALID_JSON" || code == "BATCH_TOO_LARGE" || code == "INVALID_SYNC_DATA" || code == "INVALID_MT5_TIMESTAMP" || code == "FUTURE_TRADE" || code == "SYNC_PARTIAL" || code == "MIGRATION_REQUIRED_0008";
}

// The server reports per-record rejections for batches it accepted. Those
// tickets are never retried automatically (a malformed trade must not block the
// history), but the EA still tells the trader what was skipped.
void ReportRejectedRecords(string response_text) {
   int rejected = (int)JsonNumberValue(response_text, "rejected");
   if(rejected <= 0) return;
   PrintFormat("[MT5 LIVE] server accepted the batch and skipped %d malformed record(s); see the MT5 Live connection card for details. Skipped records are not retried automatically.", rejected);
}

int BackoffSeconds(int failures, int ceiling)
{
   int exponent = MathMin(MathMax(failures - 1, 0), 5);
   int base_delay = MathMin(ceiling, MathMax(SyncSeconds, 1) * (1 << exponent));
   int jitter = MathRand() % MathMax(1, MathMax(SyncSeconds, 1));
   return MathMax(1, MathMin(ceiling, base_delay + jitter));
}

// Transient-failure ceiling comes from the clamped MaxRetrySeconds input so a
// network with longer outages can wait longer between attempts.
int EffectiveMaxRetrySeconds() { return MaxRetrySeconds > 0 ? MathMin(MaxRetrySeconds, MAX_RETRY_CEILING_SECONDS) : MAX_RETRY_BACKOFF_SECONDS; }
int RetryDelaySeconds() { return BackoffSeconds(g_consecutive_failures, EffectiveMaxRetrySeconds()); }
// Open-batch size comes from the clamped input and can never exceed the
// backend's 200-position atomic-RPC cap.
int OpenBatchSize() {
   int requested = MaxOpenPositionsPerBatch > 0 ? MaxOpenPositionsPerBatch : DEFAULT_OPEN_BATCH_SIZE;
   return MathMin(requested, MAX_OPEN_POSITIONS_PER_BATCH);
}

string JsonStringValue(string json, string field) {
   string prefix = "\"" + field + "\":\"";
   int start = StringFind(json, prefix);
   if(start < 0) return "";
   start += StringLen(prefix);
   int finish = StringFind(json, "\"", start);
   return finish < start ? "" : StringSubstr(json, start, finish - start);
}

// Minimal numeric field reader for the bounded server response contract
// (accepted / rejected / stored counters). No general JSON parser is needed.
double JsonNumberValue(string json, string field) {
   string prefix = "\"" + field + "\":";
   int start = StringFind(json, prefix);
   if(start < 0) return 0.0;
   start += StringLen(prefix);
   int length = StringLen(json);
   int finish = start;
   while(finish < length) {
      ushort character = StringGetCharacter(json, finish);
      if((character >= '0' && character <= '9') || character == '.' || character == '-' || character == '+') finish++;
      else break;
   }
   if(finish <= start) return 0.0;
   return StringToDouble(StringSubstr(json, start, finish - start));
}

void MarkEventSuccess(string expectedEvent, string connection_reference, string data_source_reference) {
   datetime now = TimeCurrent();
   if(connection_reference != "" && connection_reference != g_connection_reference) {
      g_connection_reference = connection_reference;
      PrintFormat("[MT5 LIVE] authenticated connection reference=%s. Match this with the MT5 Live connection card.", g_connection_reference);
   }
   if(data_source_reference != "" && data_source_reference != g_data_source_reference) {
      g_data_source_reference = data_source_reference;
      PrintFormat("[MT5 LIVE] authenticated data source reference=%s. Match this with the MT5 Live workspace source.", g_data_source_reference);
   }
   if(expectedEvent == "compat" && !g_compatibility_reported) {
      Print("[MT5 LIVE] API authentication accepted; read-only bridge is connected to Gold Journal.");
      g_compatibility_reported = true;
   }
   if(expectedEvent == "summary" && !g_summary_reported) {
      Print("[MT5 LIVE] summary sync successful; MT5 Live snapshot will refresh.");
      g_summary_reported = true;
   }
   if(expectedEvent == "open_batch" && !g_open_batch_reported) {
      Print("[MT5 LIVE] open-position sync successful; active Trade Log records will refresh.");
      g_open_batch_reported = true;
   }
   if(expectedEvent == "history_batch" && !g_history_reported) {
      Print("[MT5 LIVE] history sync accepted; closed Trade Log records will refresh after all batches complete.");
      g_history_reported = true;
   }
   if(expectedEvent == "summary") g_last_summary_success = now;
   else if(expectedEvent == "open_batch") g_last_open_success = now;
   else if(expectedEvent == "history_batch") g_last_history_success = now;
   if(g_consecutive_failures > 0) PrintFormat("[MT5 LIVE] %s recovered after %d transient failure(s)", expectedEvent, g_consecutive_failures);
   g_consecutive_failures = 0;
   g_config_failures = 0;
   g_next_retry_at = 0;
   g_history_batch_cooldown_until = 0;
   g_last_contact_ok_at = now;
   if(g_requires_revalidation) {
      Print("[MT5 LIVE] authentication/config revalidation succeeded; resuming full synchronization.");
      g_requires_revalidation = false;
      g_config_warning_logged = false;
   }
   g_payload_warning_logged = false;
   g_compatibility_reported = g_compatibility_reported || expectedEvent == "compat";
   SetState(expectedEvent == "compat" || expectedEvent == "ping" ? EA_CONNECTED : EA_HEALTHY);
}

// Records a recoverable failure. Every path schedules a retry; none of them can
// leave the EA permanently dead until the user intervenes.
void MarkEventFailure(string expectedEvent, int status, string detail, int retry_after_seconds = 0) {
   datetime now = TimeCurrent();
   if(status == 401 || status == 403) {
      g_config_failures++;
      g_requires_revalidation = true;
      int delay = BackoffSeconds(g_config_failures, MAX_CONFIG_RETRY_SECONDS);
      g_next_retry_at = now + delay;
      if(!g_config_warning_logged) {
         PrintFormat("[MT5 LIVE] API key rejected or retired; operation=%s; http=%d. Issue a replacement key in Gold Journal MT5 Live, paste it into the EA Inputs, and apply. The EA keeps probing and resumes automatically.", expectedEvent, status);
         g_config_warning_logged = true;
      } else {
         PrintFormat("[MT5 LIVE] auth probe still failing; operation=%s; http=%d; failures=%d; retry_in=%ds", expectedEvent, status, g_config_failures, delay);
      }
      SetState(EA_AUTH_ERROR);
      return;
   }
   if(status == 404 || status == 405) {
      g_config_failures++;
      g_requires_revalidation = true;
      int delay = BackoffSeconds(g_config_failures, MAX_CONFIG_RETRY_SECONDS);
      g_next_retry_at = now + delay;
      if(!g_config_warning_logged) {
         PrintFormat("[MT5 LIVE] MT5 endpoint not found; operation=%s; http=%d; endpoint=%s. Download a fresh EA from the same Gold Journal deployment. The EA keeps probing and resumes automatically.", expectedEvent, status, Endpoint);
         g_config_warning_logged = true;
      } else {
         PrintFormat("[MT5 LIVE] endpoint probe still failing; operation=%s; http=%d; retry_in=%ds", expectedEvent, status, delay);
      }
      SetState(EA_CONFIG_ERROR);
      return;
   }
   if(IsNonRetryableCode(detail) || (status >= 400 && !IsTransientStatus(status))) {
      g_config_failures++;
      int delay = BackoffSeconds(g_config_failures, MAX_CONFIG_RETRY_SECONDS);
      g_next_retry_at = now + delay;
      if(!g_payload_warning_logged) {
         PrintFormat("[MT5 LIVE] server rejected this payload; operation=%s; http=%d; code=%s; retry_in=%ds. This is a payload/version/configuration mismatch, not a network outage: re-download the EA from Gold Journal MT5 Live and replace the copy on the chart. The EA keeps probing and resumes automatically.", expectedEvent, status, detail == "" ? "-" : detail, delay);
         g_payload_warning_logged = true;
      } else {
         PrintFormat("[MT5 LIVE] payload still rejected; operation=%s; http=%d; code=%s; failures=%d; retry_in=%ds", expectedEvent, status, detail == "" ? "-" : detail, g_config_failures, delay);
      }
      SetState(EA_CONFIG_ERROR);
      return;
   }
   g_consecutive_failures++;
   // A 429 response may carry Retry-After; honoring it backs off exactly as
   // long as the server asks (bounded) instead of hammering the rate limiter.
   int retry_delay = retry_after_seconds > 0 ? MathMin(retry_after_seconds, MAX_RETRY_AFTER_HONOR_SECONDS) : RetryDelaySeconds();
   g_next_retry_at = now + retry_delay;
   if(status == -1) {
      PrintFormat("[MT5 LIVE] WebRequest failed; operation=%s; http=-1; mt5_error=%d; failures=%d; event=%s; endpoint=%s; retry_in=%ds. Check Tools > Options > Expert Advisors > Allow WebRequest for this endpoint origin.", expectedEvent, GetLastError(), g_consecutive_failures, detail, Endpoint, retry_delay);
   } else {
      PrintFormat("[MT5 LIVE] server temporarily unavailable; operation=%s; http=%d; server_code=%s; failures=%d; retry_in=%ds", expectedEvent, status, detail == "" ? "-" : detail, g_consecutive_failures, retry_delay);
   }
   SetState(EA_RECONNECTING);
}

// A request is only attempted when the retry gate is open, the credential or
// endpoint does not need revalidation, and the terminal is connected to the
// broker. Everything else is an automatic, bounded retry — never a dead state.
bool CanSend(string expectedEvent) {
   // The lightweight compat/ping probes are exempt from the transient backoff so
   // the heartbeat keeps proving liveness during a partial outage: otherwise a
   // 60-second backoff made a healthy EA look "stale" to the dashboard, and a
   // corrected credential would wait out the full configuration backoff.
   bool probe = (expectedEvent == "compat" || expectedEvent == "ping");
   if(!probe && g_next_retry_at > TimeCurrent()) return false;
   // While the credential or endpoint looks wrong, send only the cheap
   // compat/ping probes instead of full payloads. The probe is always attempted,
   // so a corrected configuration recovers without re-attaching the EA.
   if(g_requires_revalidation && expectedEvent != "compat" && expectedEvent != "ping") return false;
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) {
      SetState(EA_RECONNECTING);
      PrintFormat("[MT5 LIVE] %s deferred: terminal is not connected to the broker", expectedEvent);
      return false;
   }
   return true;
}

bool SendJson(string payload, string expectedEvent) {
   if(StringLen(payload) == 0) return false;
   if(!CanSend(expectedEvent)) return false;
   if(g_state == EA_INIT) SetState(EA_CONNECTING);
   char data[];
   int data_size = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(data_size > 0 && data[data_size - 1] == 0) ArrayResize(data, data_size - 1);
   char response[];
   string response_headers;
   string headers = "Content-Type: application/json\r\nAccept: application/json\r\n";
   ResetLastError();
   int status = WebRequest("POST", Endpoint, headers, REQUEST_TIMEOUT_MS, data, response, response_headers);
   string response_text = CharArrayToString(response, 0, WHOLE_ARRAY, CP_UTF8);
   if(status == 429) {
      // Honor the server's Retry-After header when present (seconds form), so
      // a rate-limited EA backs off exactly as long as it was asked to.
      int retry_after = 0;
      int header_index = StringFind(response_headers, "Retry-After:");
      if(header_index < 0) header_index = StringFind(response_headers, "retry-after:");
      if(header_index >= 0) {
         int value_start = header_index + StringLen("Retry-After:");
         while(value_start < StringLen(response_headers) && StringGetCharacter(response_headers, value_start) == ' ') value_start++;
         string value = "";
         for(int i = value_start; i < StringLen(response_headers); i++) {
            ushort character = StringGetCharacter(response_headers, i);
            if(character < '0' || character > '9') break;
            value += ShortToString(character);
         }
         if(value != "") retry_after = (int)StringToInteger(value);
      }
      MarkEventFailure(expectedEvent, status, JsonStringValue(response_text, "code"), retry_after);
      return false;
   }
   if(status < 200 || status >= 300) {
      MarkEventFailure(expectedEvent, status, JsonStringValue(response_text, "code"));
      return false;
   }
   if(StringFind(response_text, "\"ok\":true") < 0) {
      MarkEventFailure(expectedEvent, status, "invalid_response");
      return false;
   }
   ReportRejectedRecords(response_text);
   MarkEventSuccess(expectedEvent, JsonStringValue(response_text, "connectionReference"), JsonStringValue(response_text, "dataSourceReference"));
   // Heartbeats carry the server's authoritative open-ticket list, which drives
   // close reconciliation (a close MT5 never reported is still resolved).
   if(expectedEvent == "ping" || expectedEvent == "compat") ApplyReconciliationFeed(response_text);
   return true;
}

// Guards against NaN/Infinity/garbage from the terminal: an invalid number
// must never reach the JSON payload (MQL5 DoubleToString would print "nan" or
// "inf", which is invalid JSON and would reject the whole batch server-side).
bool IsValidNumber(double value) { return !MathIsValidNumber(value) ? false : MathAbs(value) <= MAX_PLAUSIBLE_PRICE * 1000.0; }
double SafeNumber(double value, double fallback) { return IsValidNumber(value) ? value : fallback; }

string PositionJson(ulong ticket) {
   if(!PositionSelectByTicket(ticket)) return "";
   string symbol = PositionGetString(POSITION_SYMBOL);
   ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   double volume = SafeNumber(PositionGetDouble(POSITION_VOLUME), 0.0);
   double open_price = SafeNumber(PositionGetDouble(POSITION_PRICE_OPEN), 0.0);
   double sl = SafeNumber(PositionGetDouble(POSITION_SL), 0.0);
   double tp = SafeNumber(PositionGetDouble(POSITION_TP), 0.0);
   double floating = SafeNumber(PositionGetDouble(POSITION_PROFIT), 0.0);
   // A zero-volume or non-positive-price snapshot is malformed data; sending it
   // would poison the live table, so the record is dropped this cycle.
   if(volume <= 0.0 || open_price <= 0.0) return "";
   double risk = 0.0;
   double reward = 0.0;
   ENUM_ORDER_TYPE order_type = type == POSITION_TYPE_BUY ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(sl > 0.0) OrderCalcProfit(order_type, symbol, volume, open_price, sl, risk);
   if(tp > 0.0) OrderCalcProfit(order_type, symbol, volume, open_price, tp, reward);
   risk = MathAbs(SafeNumber(risk, 0.0));
   reward = MathAbs(SafeNumber(reward, 0.0));
   double rr = risk > 0.0 ? reward / risk : 0.0;
   datetime open_time = (datetime)PositionGetInteger(POSITION_TIME);
   return "{\"ticket\":\"" + IntegerToString((long)ticket) + "\",\"symbol\":\"" + JsonEscape(symbol) + "\",\"direction\":\"" + Direction(type) + "\",\"lots\":" + Number(volume, 2) + ",\"open_price\":" + Number(open_price, 6) + ",\"sl_price\":" + Number(sl, 6) + ",\"tp_price\":" + Number(tp, 6) + ",\"risk_usd\":" + Number(risk, 2) + ",\"reward_usd\":" + Number(reward, 2) + ",\"rr_ratio\":" + Number(rr, 2) + ",\"floating_pnl\":" + Number(floating, 2) + ",\"open_time\":" + BrokerTimestamp(open_time) + "}";
}

void SendCompatibility() {
   string payload = "{\"event\":\"compat\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\"}";
   SendJson(payload, "compat");
}

// Liveness probe. The backend/UI can tell "connected just now" apart from
// "stale snapshot" only because this keeps arriving on its own cadence.
void SendHeartbeat() {
   string payload = "{\"event\":\"ping\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"state\":\"" + StateLabel(g_state) + "\",\"consecutive_failures\":" + IntegerToString(g_consecutive_failures) + "}";
   SendJson(payload, "ping");
}

void SendSummary() {
   string risk_symbol = RiskSymbol == "" ? _Symbol : RiskSymbol;
   SymbolSelect(risk_symbol, true);
   double tick_size = SymbolInfoDouble(risk_symbol, SYMBOL_TRADE_TICK_SIZE);
   double tick_value_loss = SymbolInfoDouble(risk_symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   double contract_size = SymbolInfoDouble(risk_symbol, SYMBOL_TRADE_CONTRACT_SIZE);
   double volume_min = SymbolInfoDouble(risk_symbol, SYMBOL_VOLUME_MIN);
   double volume_max = SymbolInfoDouble(risk_symbol, SYMBOL_VOLUME_MAX);
   double volume_step = SymbolInfoDouble(risk_symbol, SYMBOL_VOLUME_STEP);
   string payload = "{\"event\":\"summary\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"mt5_login\":\"" + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "\",\"broker_server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",\"balance\":" + Number(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\"equity\":" + Number(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",\"margin\":" + Number(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",\"free_margin\":" + Number(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",\"floating_pnl\":" + Number(AccountInfoDouble(ACCOUNT_PROFIT), 2) + ",\"risk_symbol\":\"" + JsonEscape(risk_symbol) + "\",\"risk_tick_size\":" + Number(tick_size, 8) + ",\"risk_tick_value_loss\":" + Number(tick_value_loss, 8) + ",\"risk_contract_size\":" + Number(contract_size, 8) + ",\"risk_volume_min\":" + Number(volume_min, 8) + ",\"risk_volume_max\":" + Number(volume_max, 8) + ",\"risk_volume_step\":" + Number(volume_step, 8) + "}";
   SendJson(payload, "summary");
}

// One open-position batch (at most OpenBatchSize() records). Each batch is an
// independent idempotent request: a batch that fails is retried on the next
// timer, and it never invalidates the batches that already succeeded.
bool SendOpenBatch(string &items[], int count, int batch_number, int batch_total) {
   string positions = "[";
   for(int i = 0; i < count; i++) {
      if(i > 0) positions += ",";
      positions += items[i];
   }
   positions += "]";
   string payload = "{\"event\":\"open_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":" + positions + "}";
   bool sent = SendJson(payload, "open_batch");
   if(!sent && batch_total > 1) PrintFormat("[MT5 LIVE] open batch %d/%d deferred; it and later batches retry on the next timer.", batch_number, batch_total);
   return sent;
}

void SendOpenPositions() {
   int total = PositionsTotal();
   int batch_size = OpenBatchSize();
   int batch_total = (total + batch_size - 1) / batch_size;
   if(batch_total < 1) batch_total = 1;
   string items[];
   ArrayResize(items, batch_size);
   int count = 0;
   int batch_number = 0;
   bool sent_any = false;
   int deferred_batches = 0;
   for(int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      string item = PositionJson(ticket);
      if(item == "") continue;
      items[count++] = item;
      if(count >= batch_size) {
         batch_number++;
         // One failed batch must not block the others: the rest of the snapshot
         // still goes out; only the failed batch repeats on the next timer.
         if(!SendOpenBatch(items, count, batch_number, batch_total)) deferred_batches++;
         else sent_any = true;
         count = 0;
      }
   }
   // A trailing partial batch, or a single empty snapshot so an account with no
   // open positions still proves its live stream is healthy.
   if(count > 0 || (!sent_any && deferred_batches == 0)) {
      batch_number++;
      if(!SendOpenBatch(items, count, batch_number, batch_total)) deferred_batches++;
      else sent_any = true;
   }
   if(deferred_batches > 0) {
      PrintFormat("[MT5 LIVE] %d open batch(es) deferred this cycle; only they repeat on the next timer.", deferred_batches);
      g_consecutive_failures++;
      if(g_next_retry_at == 0) g_next_retry_at = TimeCurrent() + RetryDelaySeconds();
   }
}

bool IsAllDigits(string value) {
   int length = StringLen(value);
   if(length == 0 || length > 20) return false;
   for(int i = 0; i < length; i++) {
      ushort character = StringGetCharacter(value, i);
      if(character < '0' || character > '9') return false;
   }
   return true;
}

bool IsPositionOpenNow(ulong ticket) {
   if(ticket == 0) return false;
   return PositionSelectByTicket(ticket);
}

int ReconcileIndex(ulong ticket) {
   for(int i = 0; i < g_reconcile_count; i++) if(g_reconcile_tickets[i] == ticket) return i;
   return -1;
}

void RemoveReconcileAt(int index) {
   if(index < 0 || index >= g_reconcile_count) return;
   for(int i = index; i < g_reconcile_count - 1; i++) {
      g_reconcile_tickets[i] = g_reconcile_tickets[i + 1];
      g_reconcile_attempts[i] = g_reconcile_attempts[i + 1];
      g_reconcile_next_at[i] = g_reconcile_next_at[i + 1];
   }
   g_reconcile_count--;
   ArrayResize(g_reconcile_tickets, g_reconcile_count);
   ArrayResize(g_reconcile_attempts, g_reconcile_count);
   ArrayResize(g_reconcile_next_at, g_reconcile_count);
}

// Rebuilds the list of tickets the server still believes are OPEN but this
// terminal does not hold. Only a feed that reports its own format is trusted, so
// an older server (or a failed lookup) never clears pending reconciliation.
void RefreshReconcileQueue() {
   datetime now = TimeCurrent();
   for(int i = g_reconcile_count - 1; i >= 0; i--) {
      ulong ticket = g_reconcile_tickets[i];
      if(IsPositionOpenNow(ticket)) { RemoveReconcileAt(i); continue; }
      if(g_server_open_truncated) continue;
      bool still_reported = false;
      for(int j = 0; j < g_server_open_count; j++) if(g_server_open_tickets[j] == ticket) { still_reported = true; break; }
      // The server no longer lists it, which means another path already resolved
      // the close; stop chasing it.
      if(!still_reported) RemoveReconcileAt(i);
   }
   for(int j = 0; j < g_server_open_count; j++) {
      ulong ticket = g_server_open_tickets[j];
      if(IsPositionOpenNow(ticket)) continue;
      if(ReconcileIndex(ticket) >= 0) continue;
      ArrayResize(g_reconcile_tickets, g_reconcile_count + 1);
      ArrayResize(g_reconcile_attempts, g_reconcile_count + 1);
      ArrayResize(g_reconcile_next_at, g_reconcile_count + 1);
      g_reconcile_tickets[g_reconcile_count] = ticket;
      g_reconcile_attempts[g_reconcile_count] = 0;
      g_reconcile_next_at[g_reconcile_count] = now + MathMax(3, SyncSeconds);
      g_reconcile_count++;
   }
}

void ApplyReconciliationFeed(string response_text) {
   string format = JsonStringValue(response_text, "openTicketFormat");
   if(format != "csv") return;
   g_server_open_known = true;
   g_server_open_truncated = StringFind(response_text, "\"openTicketsTruncated\":true") >= 0;
   string csv = JsonStringValue(response_text, "openTickets");
   ArrayResize(g_server_open_tickets, 0);
   g_server_open_count = 0;
   if(csv == "") { RefreshReconcileQueue(); return; }
   string parts[];
   int fields = StringSplit(csv, (ushort)StringGetCharacter(",", 0), parts);
   for(int i = 0; i < fields && g_server_open_count < MAX_TRACKED_OPEN_TICKETS; i++) {
      string value = parts[i];
      if(!IsAllDigits(value)) continue;
      ulong ticket = (ulong)StringToInteger(value);
      if(ticket == 0) continue;
      ArrayResize(g_server_open_tickets, g_server_open_count + 1);
      g_server_open_tickets[g_server_open_count++] = ticket;
   }
   RefreshReconcileQueue();
}

// Reconstructs a close from authoritative MT5 deal history. The position is
// only sent as CLOSED when the terminal no longer holds it AND its deals are
// present, so a partial close can never be reported as a finished trade.
bool SendClosedRecord(string record) {
   if(record == "") return false;
   string payload = "{\"event\":\"close\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + "," + StringSubstr(record, 1);
   return SendJson(payload, "close_reconcile");
}

void ReconcileNextTicket() {
   if(!g_server_open_known || g_reconcile_count == 0) return;
   datetime now = TimeCurrent();
   for(int i = 0; i < g_reconcile_count; i++) {
      ulong ticket = g_reconcile_tickets[i];
      if(g_reconcile_next_at[i] > now) continue;
      if(IsPositionOpenNow(ticket)) { RemoveReconcileAt(i); return; }
      if(!CanSend("close_reconcile")) return;
      string record = ClosedPositionJson(ticket);
      if(record == "" && now - g_last_wide_history_select >= WIDE_HISTORY_SELECT_MIN_INTERVAL_SECONDS) {
         // Escalate once per bounded interval: widen the terminal history cache
         // and try again, so a close older than the current cache is still found.
         g_last_wide_history_select = now;
         int days = HistoryDays < RECONCILE_HISTORY_ESCALATION_DAYS ? HistoryDays : RECONCILE_HISTORY_ESCALATION_DAYS;
         if(days < 1) days = 1;
         HistorySelect(now - days * 86400, now);
         record = ClosedPositionJson(ticket);
      }
      if(record != "") {
         if(SendClosedRecord(record)) {
            PrintFormat("[MT5 LIVE] reconciled a close Gold Journal had not seen; ticket=%I64u recovered from terminal history.", ticket);
            RemoveReconcileAt(i);
         }
         return;
      }
      g_reconcile_attempts[i]++;
      int delay = RECONCILE_RETRY_SECONDS * g_reconcile_attempts[i];
      if(delay > RECONCILE_MAX_RETRY_SECONDS) delay = RECONCILE_MAX_RETRY_SECONDS;
      g_reconcile_next_at[i] = now + delay;
      PrintFormat("[MT5 LIVE] ticket=%I64u is no longer open in MT5 but its closing deals are not in this terminal's history yet; Gold Journal keeps the row open and this EA retries the close reconstruction in %ds.", ticket, delay);
      return;
   }
}

// Pending-history queue: tickets whose closing deals could not be
// reconstructed yet. Entries are retried on their own schedule until they send
// successfully, so a temporary history-cache gap can never become permanent
// data loss. Bounded at MAX_PENDING_HISTORY_TICKETS.
void EnqueuePendingTicket(ulong position_id) {
   for(int i = 0; i < g_pending_count; i++) {
      if(g_pending_tickets[i] == position_id) {
         // Already queued: push the next attempt out by one retry interval so
         // the queue cannot hammer the history API every timer tick.
         g_pending_next_at[i] = TimeCurrent() + PENDING_HISTORY_RETRY_SECONDS;
         return;
      }
   }
   if(g_pending_count >= MAX_PENDING_HISTORY_TICKETS) {
      // Drop the OLDEST entry (FIFO) so a sustained cache gap cannot grow the
      // queue unbounded; the periodic sweep will re-enqueue anything still
      // unreconstructed.
      for(int i = 1; i < g_pending_count; i++) {
         g_pending_tickets[i - 1] = g_pending_tickets[i];
         g_pending_next_at[i - 1] = g_pending_next_at[i];
      }
      g_pending_count--;
   }
   ArrayResize(g_pending_tickets, g_pending_count + 1);
   ArrayResize(g_pending_next_at, g_pending_count + 1);
   g_pending_tickets[g_pending_count] = position_id;
   g_pending_next_at[g_pending_count] = TimeCurrent() + PENDING_HISTORY_RETRY_SECONDS;
   g_pending_count++;
}

void DequeuePendingTicket(ulong position_id) {
   int found = -1;
   for(int i = 0; i < g_pending_count; i++) {
      if(g_pending_tickets[i] == position_id) { found = i; break; }
   }
   if(found < 0) return;
   for(int j = found; j < g_pending_count - 1; j++) {
      g_pending_tickets[j] = g_pending_tickets[j + 1];
      g_pending_next_at[j] = g_pending_next_at[j + 1];
   }
   g_pending_count--;
   ArrayResize(g_pending_tickets, g_pending_count);
   ArrayResize(g_pending_next_at, g_pending_count);
}

// Merges pending tickets into the working set at the start of a history job.
// ClosedPositionJson() selects a position's deals with HistorySelectByPosition
// (its own selection context), so a pending ticket is reconstructable even when
// it lies outside the sweep's time window.
void MergePendingIntoHistory() {
   if(g_pending_count == 0) return;
   for(int i = 0; i < g_pending_count; i++) {
      ulong ticket = g_pending_tickets[i];
      if(ContainsPositionId(g_history_position_ids, g_history_position_count, ticket)) continue;
      ArrayResize(g_history_position_ids, g_history_position_count + 1);
      g_history_position_ids[g_history_position_count++] = ticket;
   }
   // The working set now owns the retry for every queued ticket.
   g_pending_count = 0;
   ArrayResize(g_pending_tickets, 0);
   ArrayResize(g_pending_next_at, 0);
}

bool ContainsPositionId(ulong &ids[], int count, ulong position_id) {
   for(int i = 0; i < count; i++) if(ids[i] == position_id) return true;
   return false;
}

bool CollectClosedPositionIds(ulong &ids[], int &count) {
   count = 0;
   ArrayResize(ids, 0);
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++) {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) continue;
      ulong position_id = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
      if(position_id == 0 || ContainsPositionId(ids, count, position_id)) continue;
      if(ArrayResize(ids, count + 1) != count + 1) return false;
      ids[count++] = position_id;
   }
   return true;
}

string ClosedPositionJson(ulong position_id) {
   // A DEAL_ENTRY_OUT deal is NOT proof that the trade is over: a partial close
   // (hedging or netting) removes volume while the position stays open, and MT5
   // also emits OUT deals for the closing leg of an INOUT reversal. Emitting a
   // terminal CLOSED record here would freeze the trade and silently lose the
   // remaining volume, so a still-existing position is left to the live open
   // stream, which refreshes its volume, price, SL/TP and profit every cycle.
   if(PositionSelectByTicket(position_id)) return "";
   if(!HistorySelectByPosition(position_id)) {
      PrintFormat("Gold Journal could not select history for position %I64u", position_id);
      return "";
   }
   string symbol = "";
   string direction = "";
   datetime open_time = 0;
   datetime close_time = 0;
   double open_price = 0.0;
   double open_volume = 0.0;
   double entry_price_volume = 0.0;
   int entry_count = 0;
   double close_volume = 0.0;
   double close_price_volume = 0.0;
   double realized = 0.0;
   double sl = 0.0;
   double tp = 0.0;
   bool found_entry = false;
   bool found_close = false;
   int deals = HistoryDealsTotal();
   for(int i = 0; i < deals; i++) {
      ulong deal = HistoryDealGetTicket(i);
      if(deal == 0) continue;
      long deal_type = HistoryDealGetInteger(deal, DEAL_TYPE);
      if(deal_type != DEAL_TYPE_BUY && deal_type != DEAL_TYPE_SELL) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      string deal_symbol = HistoryDealGetString(deal, DEAL_SYMBOL);
      if(symbol == "" && deal_symbol != "") symbol = deal_symbol;
      datetime deal_time = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);
      double deal_volume = HistoryDealGetDouble(deal, DEAL_VOLUME);
      double deal_price = HistoryDealGetDouble(deal, DEAL_PRICE);
      // A position can be built from many entry deals (0.5 @ 4000, 0.5 @ 4010,
      // 1.0 @ 4020 ...). The lifecycle record must reflect ALL of them: total
      // entry volume and the weighted-average entry price, not just the first
      // deal's volume and price.
      if(entry == DEAL_ENTRY_IN || entry == DEAL_ENTRY_INOUT) {
         if(!found_entry || deal_time < open_time) {
            found_entry = true;
            open_time = deal_time;
            direction = entry == DEAL_ENTRY_INOUT ? OppositeDirection(deal_type) : DealDirection(deal_type);
            sl = HistoryDealGetDouble(deal, DEAL_SL);
            tp = HistoryDealGetDouble(deal, DEAL_TP);
         }
         entry_count++;
         entry_price_volume += deal_price * deal_volume;
         open_volume += deal_volume;
      }
      if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT) {
         found_close = true;
         if(deal_time >= close_time) close_time = deal_time;
         close_volume += deal_volume;
         close_price_volume += deal_price * deal_volume;
         realized += HistoryDealGetDouble(deal, DEAL_PROFIT) + HistoryDealGetDouble(deal, DEAL_SWAP) + HistoryDealGetDouble(deal, DEAL_COMMISSION) + HistoryDealGetDouble(deal, DEAL_FEE);
         double close_sl = HistoryDealGetDouble(deal, DEAL_SL);
         double close_tp = HistoryDealGetDouble(deal, DEAL_TP);
         if(sl <= 0.0 && close_sl > 0.0) sl = close_sl;
         if(tp <= 0.0 && close_tp > 0.0) tp = close_tp;
      }
   }
   if(!found_entry || !found_close || symbol == "" || direction == "" || open_time == 0 || close_time == 0) return "";
   // Weighted-average entry price across every entry deal; falls back to the
   // close price when entry deals carry zero prices (degenerate broker data).
   open_price = open_volume > 0.0 ? entry_price_volume / open_volume : close_price_volume / MathMax(close_volume, 0.0000001);
   open_price = SafeNumber(open_price, 0.0);
   double close_price = close_volume > 0.0 ? close_price_volume / close_volume : open_price;
   double lots = open_volume > 0.0 ? open_volume : close_volume;
   if(lots <= 0.0 || open_price <= 0.0 || close_price <= 0.0) return "";
   double risk = 0.0;
   double reward = 0.0;
   ENUM_ORDER_TYPE order_type = direction == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(sl > 0.0) OrderCalcProfit(order_type, symbol, lots, open_price, sl, risk);
   if(tp > 0.0) OrderCalcProfit(order_type, symbol, lots, open_price, tp, reward);
   risk = MathAbs(risk);
   reward = MathAbs(reward);
   double rr = risk > 0.0 ? reward / risk : 0.0;
   string outcome = realized > 0.005 ? "WIN" : realized < -0.005 ? "LOSS" : "BREAK_EVEN";
   // The position id is the stable identifier: the same closed deal can never
   // create a second journal record after a reconnect, restart, or replay.
   return "{\"ticket\":\"" + IntegerToString((long)position_id) + "\",\"symbol\":\"" + JsonEscape(symbol) + "\",\"direction\":\"" + direction + "\",\"lots\":" + Number(lots, 2) + ",\"open_price\":" + Number(open_price, 6) + ",\"sl_price\":" + Number(sl, 6) + ",\"tp_price\":" + Number(tp, 6) + ",\"risk_usd\":" + Number(risk, 2) + ",\"reward_usd\":" + Number(reward, 2) + ",\"rr_ratio\":" + Number(rr, 2) + ",\"close_price\":" + Number(close_price, 6) + ",\"realized_pnl\":" + Number(realized, 2) + ",\"result\":\"" + outcome + "\",\"open_time\":" + BrokerTimestamp(open_time) + ",\"close_time\":" + BrokerTimestamp(close_time) + "}";
}

// Event-triggered close sweep. When a history job is already running (a
// multi-batch cursor walk), the trigger is queued, not discarded: Sync() runs
// one more incremental sweep after the current job completes.
void RequestIncrementalHistory() {
   if(g_history_in_progress) {
      g_history_retry_requested = true;
      return;
   }
   SendHistory(false);
}

void SendHistory(bool fullReplay) {
   datetime now = TimeCurrent();
   // A running multi-batch job is CONTINUED here on the next timer tick; a new
   // job is only started when none is in progress. Never nest or fork a second
   // job.
   bool continue_job = g_history_in_progress;
   if(g_history_batch_cooldown_until > now) return;
   // Defer (new jobs and continuations alike) while the transient backoff gate
   // is closed, so an outage never burns CPU rebuilding batches it cannot send.
   if(!CanSend("history_batch")) return;
   if(!continue_job) {
      g_last_history_attempt = now;
      g_history_cursor = 0;
      g_history_in_progress = true;
      g_history_full_replay = fullReplay;
      datetime from;
      if(g_history_full_replay) {
         from = now - HistoryDays * 86400;
      } else {
         // Always re-scan back to the last successful close sync (bounded by the
         // configured history window). A fixed short sweep could miss a close that
         // happened while the EA was offline or backing off, and then the next
         // sweep would find nothing and re-arm the full replay timer, leaving the
         // position OPEN in the journal for up to a day.
         datetime window_start = now - QUICK_HISTORY_WINDOW_SECONDS;
         datetime oldest = now - HistoryDays * 86400;
         // Before the first successful sync the full replay owns the backfill, so
         // an incremental sweep simply covers the configured history window.
         datetime since_last_success = (g_last_history_sync > 0 ? g_last_history_sync : oldest);
         if(since_last_success < window_start) window_start = since_last_success;
         if(window_start < oldest) window_start = oldest;
         from = window_start;
      }
      if(!HistorySelect(from, now)) {
         PrintFormat("Gold Journal HistorySelect failed: %d", GetLastError());
         g_history_in_progress = false;
         return;
      }
      // The working set is captured ONCE at the start of a multi-batch run and
      // reused until it completes: re-selecting every cycle would shift array
      // indexes under the cursor (a new close can appear mid-run) and could skip
      // or resend records. New closes land in the next job instead.
      if(!CollectClosedPositionIds(g_history_position_ids, g_history_position_count)) {
         Print("Gold Journal could not allocate historical position IDs");
         g_history_in_progress = false;
         return;
      }
      MergePendingIntoHistory();
   }
   int position_count = g_history_position_count;
   if(position_count == 0) {
      string empty_payload = "{\"event\":\"history_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":[],\"complete\":true}";
      if(SendJson(empty_payload, "history_batch")) {
         g_last_history_sync = now;
         g_history_in_progress = false;
         g_history_full_replay = true;
         g_history_cursor = 0;
         g_history_batch_cooldown_until = 0;
         Print("[MT5 LIVE] history sync completed; no closed positions found in the selected period.");
      }
      return;
   }
   int cursor = MathMin(g_history_cursor, position_count);
   string positions = "[";
   int added = 0;
   int pending = 0;
   int still_open = 0;
   bool first = true;
   while(cursor < position_count && added < HISTORY_BATCH_SIZE) {
      ulong position_id = g_history_position_ids[cursor++];
      // A partially closed position still exists: the live open stream owns it.
      if(IsPositionOpenNow(position_id)) { still_open++; continue; }
      string item = ClosedPositionJson(position_id);
      if(item == "") {
         // A ticket that cannot be reconstructed yet is NOT forgotten: it goes
         // into the pending queue for retry, and the batch continues without
         // it so one cache gap cannot block the other 49 trades.
         pending++;
         EnqueuePendingTicket(position_id);
         PrintFormat("[MT5 LIVE] close reconstruction pending for position %I64u; continuing batch.", position_id);
         continue;
      }
      if(!first) positions += ",";
      positions += item;
      first = false;
      added++;
      DequeuePendingTicket(position_id);
   }
   positions += "]";
   bool complete = cursor >= position_count;
   string payload = "{\"event\":\"history_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":" + positions + ",\"complete\":" + (complete ? "true" : "false") + "}";
   if(!SendJson(payload, "history_batch")) {
      // The batch was NOT accepted: the cursor stays where it was, so nothing
      // is skipped. A cooldown also prevents the next timer tick (3 s) from
      // resending the identical batch during an outage.
      g_history_cursor = MathMin(cursor - added, position_count);
      g_history_batch_cooldown_until = now + HISTORY_BATCH_COOLDOWN_SECONDS;
      g_history_in_progress = true;
      return;
   }
   // The server accepted this batch: only now may the cursor advance past it.
   if(complete) {
      g_last_history_sync = now;
      g_history_in_progress = false;
      g_history_cursor = 0;
      g_history_full_replay = true;
      PrintFormat("[MT5 LIVE] history sync completed; processed=%d; closed_batches=%d; still_open=%d; pending=%d.", position_count, added, still_open, pending);
   } else {
      // Cursor advances only past ACCEPTED records; the next batch continues
      // on the next timer tick after a short cooldown, so a multi-year
      // backfill spreads out instead of hammering the API every 3 seconds.
      g_history_cursor = cursor;
      g_history_batch_cooldown_until = now + HISTORY_BATCH_COOLDOWN_SECONDS;
      PrintFormat("[MT5 LIVE] history batch accepted; sent=%d; pending=%d; remaining=%d; continuing on next timer.", added, pending, position_count - cursor);
   }
}

bool HistoryDue(datetime now) {
   if(!SendHistoryOnInit) return false;
   if(g_history_in_progress) return true;
   bool idle_window = (g_last_history_attempt == 0 || now - g_last_history_attempt >= 300);
   bool full_replay_due = (g_last_history_sync == 0 || now - g_last_history_sync >= FULL_HISTORY_RETRY_SECONDS);
   // A bounded incremental sweep also runs on its own cadence, so a close that
   // MT5 never reported through OnTradeTransaction is still collected.
   bool sweep_due = (g_last_history_attempt == 0 || now - g_last_history_attempt >= HISTORY_SWEEP_SECONDS);
   return (idle_window && full_replay_due) || sweep_due;
}

// Chooses which history job the scheduler should run when one is due: a full
// 10-year replay only when it is genuinely owed (first backfill or the daily
// reconciliation gate); every other due case is a bounded incremental sweep.
// Before this split, every 15-minute sweep ran the FULL replay window, so a
// quiet account re-scanned 3650 days of deals every 15 minutes forever.
bool FullHistoryReplayDue(datetime now) {
   // A never-completed history sync (fresh attach, EA restart, terminal
   // restart) owes the one-time full backfill; afterwards the daily
   // reconciliation gate is the only full replay.
   if(g_last_history_sync == 0) return true;
   return now - g_last_history_sync >= FULL_HISTORY_RETRY_SECONDS;
}

// A position that failed reconstruction gets its next try on its own schedule
// (PENDING_HISTORY_RETRY_SECONDS after it was queued), without waiting for the
// full 15-minute sweep. One cheap flag check per timer tick, so an empty queue
// costs nothing.
bool PendingHistoryRetryDue(datetime now) {
   for(int i = 0; i < g_pending_count; i++) {
      if(g_pending_next_at[i] <= now) return true;
   }
   return false;
}

void Sync() {
   datetime now = TimeCurrent();
   // Missing/invalid inputs: stay loaded in CONFIG_ERROR and re-evaluate the
   // inputs on every tick so a corrected key/endpoint recovers without
   // removing and re-attaching the EA.
   if(g_config_invalid) {
      SetState(EA_CONFIG_ERROR);
      if(HasConfiguredEndpoint() && HasConfiguredApiKey()) {
         Print("[MT5 LIVE] configuration now valid; resuming synchronization.");
         g_config_invalid = false;
      } else {
         return;
      }
   }
   if(g_requires_revalidation) {
      // Authentication probe only; a success clears the gate and resumes sync.
      SendCompatibility();
      return;
   }
   SetState(EA_SYNCING);
   if(now >= g_next_heartbeat_at) {
      SendHeartbeat();
      g_next_heartbeat_at = now + MathMax(10, HeartbeatSeconds);
   }
   // Resolve at most one server-tracked close per cycle before sending the live
   // snapshot, so the journal converges on the terminal's real state.
   ReconcileNextTicket();
   // Open positions stay frequent so the Trade Log feels live.
   SendOpenPositions();
   // The account snapshot and full history are heavier, so they run on their
   // own slower cadence instead of every open-position tick.
   if(now >= g_next_summary_at) {
      SendSummary();
      g_next_summary_at = now + MathMax(5, SummarySeconds);
   }
   // ONE history scheduler: full replay only when genuinely owed (first
   // backfill, daily reconciliation, or an explicit recovery request);
   // otherwise the bounded incremental sweep. Close events merely flag a
   // rerun, which is honored here after the current job completes.
   if(HistoryDue(now)) SendHistory(FullHistoryReplayDue(now));
   else if(g_history_retry_requested && !g_history_in_progress) {
      // A close event was queued while a job was running; run one incremental
      // sweep for it now. The flag is cleared first so the sweep cannot re-flag
      // itself (no recursive or duplicate retry loops).
      g_history_retry_requested = false;
      SendHistory(false);
   }
   else if(PendingHistoryRetryDue(now)) {
      // Unreconstructed positions get their scheduled retry inside a normal
      // incremental sweep.
      SendHistory(false);
   }
   if(g_state == EA_SYNCING) SetState(EA_HEALTHY);
}

int OnInit() {
   ResetLastError();
   MathSrand((int)(TimeLocal() % 2147483647));
   g_last_timer_now = TimeCurrent();
   // A missing/invalid endpoint or key is a PERMANENT CONFIGURATION problem,
   // but removing the EA from the chart is worse than keeping it: the trader
   // may not notice for days. The EA therefore stays loaded in CONFIG_ERROR,
   // prints one actionable line, and re-evaluates the inputs every timer tick
   // so a corrected input recovers without re-attaching (INIT_PARAMETERS_
   // INCORRECT would have unloaded the EA and silently ended recovery).
   g_config_invalid = !HasConfiguredEndpoint() || !HasConfiguredApiKey();
   if(g_config_invalid) {
      Print("[MT5 LIVE] CONFIGURATION REQUIRED: set the Endpoint to the exact HTTPS API URL from Gold Journal MT5 Live and paste the current API key into EA Inputs, then press OK. The EA stays loaded and recovers automatically once the inputs are valid.");
   }
   SetState(EA_INIT);
   g_next_summary_at = 0;
   g_next_heartbeat_at = 0;
   if(!EventSetTimer(MathMax(3, SyncSeconds))) {
      PrintFormat("[MT5 LIVE] timer could not start; MT5 error=%d", GetLastError());
      return INIT_FAILED;
   }
   PrintFormat("[MT5 LIVE] STARTUP; EA_VERSION=%s; endpoint=%s; terminal_connected=%s; api_key_present=%s; open_sync=%ds; summary_sync=%ds; heartbeat=%ds; history=%s; state=%s.",
               EA_VERSION, Endpoint, TerminalInfoInteger(TERMINAL_CONNECTED) ? "true" : "false",
               HasConfiguredApiKey() ? "true" : "invalid",
               MathMax(3, SyncSeconds), MathMax(5, SummarySeconds), MathMax(10, HeartbeatSeconds),
               SendHistoryOnInit ? "enabled" : "disabled", StateLabel(g_state));
   Print("[MT5 LIVE] READ-ONLY MODE; this EA never opens, closes, modifies, or cancels MT5 orders and positions. Auto Trading is not required for Gold Journal synchronization.");
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) Print("[MT5 LIVE] broker connection is offline; summary, positions, and history will retry after MT5 reconnects.");
   // With invalid inputs, skip the doomed compat probe and let Sync() hold the
   // CONFIG_ERROR state until the trader corrects the inputs.
   if(!g_config_invalid) SendCompatibility();
   Sync();
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) { EventKillTimer(); PrintFormat("[MT5 LIVE] EA stopped; deinitialization reason=%d", reason); }
void OnTimer() {
   datetime now = TimeCurrent();
   // Clock-jump guard: a VM/VPS time resync that moves the clock backwards
   // would otherwise extend every scheduled retry/cooldown into the future and
   // silence the EA until those timestamps elapse naturally. On a backwards
   // jump, clear the schedules so recovery is immediate.
   if(g_last_timer_now > 0 && now < g_last_timer_now - 1) {
      PrintFormat("[MT5 LIVE] terminal clock moved backwards by %d second(s); clearing scheduled retries so recovery is immediate.", (int)(g_last_timer_now - now));
      g_next_retry_at = 0;
      g_next_summary_at = 0;
      g_next_heartbeat_at = 0;
      g_history_batch_cooldown_until = 0;
      for(int i = 0; i < g_reconcile_count; i++) g_reconcile_next_at[i] = 0;
      for(int i = 0; i < g_pending_count; i++) g_pending_next_at[i] = 0;
   }
   g_last_timer_now = now;
   Sync();
}

// MQL5 requires notification parameters for this passive terminal event.
// They are never read and this EA never calls a trade-execution API.
void OnTradeTransaction(const MqlTradeTransaction &transaction, const MqlTradeRequest &request, const MqlTradeResult &result) {
   // The transaction itself carries the entry type and position identifier, so
   // the close notification does not depend on the terminal history cache being
   // loaded (HistoryDealGetInteger can return 0 for a deal that is not yet in
   // the cache, which silently dropped the notification).
   if(transaction.type != TRADE_TRANSACTION_DEAL_ADD) return;
   ENUM_DEAL_ENTRY entry = transaction.entry;
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) return;
   // MT5 emits one transaction per closing deal. A stop-out/TP/manual close can
   // produce several deals for the same position (for example a netting INOUT or
   // multiple partial fills); debounce to a single quick sync so the first deal
   // is not missed while a later transaction restarts the sweep.
   ulong position_id = transaction.position;
   if(position_id != 0 && position_id == g_deal_position_id) {
      if(TimeCurrent() - g_last_close_event_at > 60) g_deal_position_id = 0;
      else return;
   }
   g_deal_position_id = position_id;
   g_last_close_event_at = TimeCurrent();
   RequestIncrementalHistory();
}
