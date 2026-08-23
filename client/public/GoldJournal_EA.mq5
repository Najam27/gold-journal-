#property strict
#property version   "2.10"
#property description "Gold Journal read-only journal bridge: never places or manages trades; sends account, position, and history facts to Gold Journal."

input string Endpoint = "__GOLD_JOURNAL_MT5_ENDPOINT__";
input string ApiKey = "PASTE_ONCE_FROM_GOLD_JOURNAL";
input int BrokerUtcOffsetMinutes = 180;
input int SyncSeconds = 3;
input int HistoryDays = 3650;
input bool SendHistoryOnInit = true;
input string RiskSymbol = "";

const string EA_VERSION = "2.10.0";
const string PAYLOAD_VERSION = "2";
const int REQUEST_TIMEOUT_MS = 15000;
const int HISTORY_BATCH_SIZE = 50;
const int FULL_HISTORY_RETRY_SECONDS = 24 * 60 * 60;
const int MAX_RETRY_BACKOFF_SECONDS = 60;

datetime g_last_history_sync = 0;
datetime g_last_history_attempt = 0;
datetime g_next_retry_at = 0;
datetime g_last_summary_success = 0;
datetime g_last_open_success = 0;
datetime g_last_history_success = 0;
int g_consecutive_failures = 0;
bool g_permanent_rejection = false;
bool g_compatibility_reported = false;
bool g_summary_reported = false;
bool g_open_batch_reported = false;
bool g_history_reported = false;
bool g_history_in_progress = false;
bool g_history_full_replay = true;
int g_history_cursor = 0;

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

bool IsTransientStatus(int status) { return status == -1 || status == 408 || status == 429 || status == 500 || status == 502 || status == 503 || status == 504; }
int RetryDelaySeconds() {
   int exponent = MathMin(g_consecutive_failures - 1, 4);
   int base_delay = MathMin(MAX_RETRY_BACKOFF_SECONDS, SyncSeconds * (1 << exponent));
   return MathMin(MAX_RETRY_BACKOFF_SECONDS, base_delay + (MathRand() % MathMax(1, SyncSeconds)));
}
void MarkEventSuccess(string expectedEvent) {
   datetime now = TimeCurrent();
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
   g_next_retry_at = 0;
}
bool SendJson(string payload, string expectedEvent) {
   if(StringLen(payload) == 0) return false;
   if(g_permanent_rejection) return false;
   if(g_next_retry_at > TimeCurrent()) return false;
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) {
      PrintFormat("[MT5 LIVE] %s deferred: terminal is not connected to the broker", expectedEvent);
      return false;
   }
   char data[];
   int data_size = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(data_size > 0 && data[data_size - 1] == 0) ArrayResize(data, data_size - 1);
   char response[];
   string response_headers;
   string headers = "Content-Type: application/json\r\nAccept: application/json\r\n";
   ResetLastError();
   int status = WebRequest("POST", Endpoint, headers, REQUEST_TIMEOUT_MS, data, response, response_headers);
   string response_text = CharArrayToString(response, 0, WHOLE_ARRAY, CP_UTF8);
   if(status < 200 || status >= 300) {
      if(status == -1) {
         g_consecutive_failures++;
         int delay = RetryDelaySeconds();
         g_next_retry_at = TimeCurrent() + delay;
         PrintFormat("[MT5 LIVE] WebRequest failed; operation=%s; http=-1; mt5_error=%d; endpoint=%s; retry_in=%ds. Check Tools > Options > Expert Advisors > Allow WebRequest for this endpoint origin.", expectedEvent, GetLastError(), Endpoint, delay);
      } else if(IsTransientStatus(status)) {
         g_consecutive_failures++;
         int delay = RetryDelaySeconds();
         g_next_retry_at = TimeCurrent() + delay;
         PrintFormat("[MT5 LIVE] server temporarily unavailable; operation=%s; http=%d; endpoint=%s; retry=%d; retry_in=%ds", expectedEvent, status, Endpoint, g_consecutive_failures, delay);
      } else {
         g_permanent_rejection = true;
         if(status == 401 || status == 403) PrintFormat("[MT5 LIVE] API key rejected or retired; operation=%s; http=%d. In Gold Journal MT5 Live, issue a replacement key, paste it into EA Inputs, then restart the EA", expectedEvent, status);
         else if(status == 404 || status == 405) PrintFormat("[MT5 LIVE] MT5 endpoint not found; operation=%s; http=%d; endpoint=%s. Download a fresh EA from the same Gold Journal deployment, then restart it", expectedEvent, status, Endpoint);
         else PrintFormat("[MT5 LIVE] request rejected; operation=%s; http=%d; endpoint=%s. Check the endpoint and payload, then restart the EA", expectedEvent, status, Endpoint);
      }
      return false;
   }
   if(StringFind(response_text, "\"ok\":true") < 0) {
      g_consecutive_failures++;
      int delay = RetryDelaySeconds();
      g_next_retry_at = TimeCurrent() + delay;
      PrintFormat("[MT5 LIVE] %s returned an invalid response retry=%d in %ds", expectedEvent, g_consecutive_failures, delay);
      return false;
   }
   MarkEventSuccess(expectedEvent);
   return true;
}

string PositionJson(ulong ticket) {
   if(!PositionSelectByTicket(ticket)) return "";
   string symbol = PositionGetString(POSITION_SYMBOL);
   ENUM_POSITION_TYPE type = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
   double volume = PositionGetDouble(POSITION_VOLUME);
   double open_price = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl = PositionGetDouble(POSITION_SL);
   double tp = PositionGetDouble(POSITION_TP);
   double floating = PositionGetDouble(POSITION_PROFIT);
   double risk = 0.0;
   double reward = 0.0;
   ENUM_ORDER_TYPE order_type = type == POSITION_TYPE_BUY ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(sl > 0.0) OrderCalcProfit(order_type, symbol, volume, open_price, sl, risk);
   if(tp > 0.0) OrderCalcProfit(order_type, symbol, volume, open_price, tp, reward);
   risk = MathAbs(risk);
   reward = MathAbs(reward);
   double rr = risk > 0.0 ? reward / risk : 0.0;
   datetime open_time = (datetime)PositionGetInteger(POSITION_TIME);
   return "{\"ticket\":\"" + IntegerToString((long)ticket) + "\",\"symbol\":\"" + JsonEscape(symbol) + "\",\"direction\":\"" + Direction(type) + "\",\"lots\":" + Number(volume, 2) + ",\"open_price\":" + Number(open_price, 6) + ",\"sl_price\":" + Number(sl, 6) + ",\"tp_price\":" + Number(tp, 6) + ",\"risk_usd\":" + Number(risk, 2) + ",\"reward_usd\":" + Number(reward, 2) + ",\"rr_ratio\":" + Number(rr, 2) + ",\"floating_pnl\":" + Number(floating, 2) + ",\"open_time\":" + BrokerTimestamp(open_time) + "}";
}

void SendCompatibility() {
   string payload = "{\"event\":\"compat\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\"}";
   SendJson(payload, "compat");
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

void SendOpenPositions() {
   string positions = "[";
   bool first = true;
   for(int i = 0; i < PositionsTotal(); i++) {
      ulong ticket = PositionGetTicket(i);
      string item = PositionJson(ticket);
      if(item == "") continue;
      if(!first) positions += ",";
      positions += item;
      first = false;
   }
   positions += "]";
   string payload = "{\"event\":\"open_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":" + positions + "}";
   SendJson(payload, "open_batch");
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
      if(entry == DEAL_ENTRY_IN || entry == DEAL_ENTRY_INOUT) {
         if(!found_entry || deal_time < open_time) {
            found_entry = true;
            open_time = deal_time;
            open_price = deal_price;
            open_volume = deal_volume;
            direction = entry == DEAL_ENTRY_INOUT ? OppositeDirection(deal_type) : DealDirection(deal_type);
            sl = HistoryDealGetDouble(deal, DEAL_SL);
            tp = HistoryDealGetDouble(deal, DEAL_TP);
         }
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
   double close_price = close_volume > 0.0 ? close_price_volume / close_volume : open_price;
   double lots = open_volume > 0.0 ? open_volume : close_volume;
   double risk = 0.0;
   double reward = 0.0;
   ENUM_ORDER_TYPE order_type = direction == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   if(sl > 0.0) OrderCalcProfit(order_type, symbol, lots, open_price, sl, risk);
   if(tp > 0.0) OrderCalcProfit(order_type, symbol, lots, open_price, tp, reward);
   risk = MathAbs(risk);
   reward = MathAbs(reward);
   double rr = risk > 0.0 ? reward / risk : 0.0;
   string result = realized > 0.005 ? "WIN" : realized < -0.005 ? "LOSS" : "BREAK_EVEN";
   return "{\"ticket\":\"" + IntegerToString((long)position_id) + "\",\"symbol\":\"" + JsonEscape(symbol) + "\",\"direction\":\"" + direction + "\",\"lots\":" + Number(lots, 2) + ",\"open_price\":" + Number(open_price, 6) + ",\"sl_price\":" + Number(sl, 6) + ",\"tp_price\":" + Number(tp, 6) + ",\"risk_usd\":" + Number(risk, 2) + ",\"reward_usd\":" + Number(reward, 2) + ",\"rr_ratio\":" + Number(rr, 2) + ",\"close_price\":" + Number(close_price, 6) + ",\"realized_pnl\":" + Number(realized, 2) + ",\"result\":\"" + result + "\",\"open_time\":" + BrokerTimestamp(open_time) + ",\"close_time\":" + BrokerTimestamp(close_time) + "}";
}

void SendHistory(bool fullReplay) {
   datetime now = TimeCurrent();
   g_last_history_attempt = now;
   if(!g_history_in_progress) {
      g_history_cursor = 0;
      g_history_in_progress = true;
      g_history_full_replay = fullReplay;
   }
   if(!fullReplay && g_history_full_replay) return;
   datetime from = now - (g_history_full_replay ? HistoryDays * 86400 : MathMax(3600, SyncSeconds * 4));
   if(!HistorySelect(from, now)) {
      PrintFormat("Gold Journal HistorySelect failed: %d", GetLastError());
      return;
   }
   ulong position_ids[];
   int position_count = 0;
   if(!CollectClosedPositionIds(position_ids, position_count)) {
      Print("Gold Journal could not allocate historical position IDs");
      return;
   }
   if(position_count == 0) {
      string empty_payload = "{\"event\":\"history_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":[],\"complete\":true}";
      if(SendJson(empty_payload, "history_batch")) {
         g_last_history_sync = now;
         g_history_in_progress = false;
         g_history_full_replay = true;
         g_history_cursor = 0;
         Print("[MT5 LIVE] history sync completed; no closed positions found in the selected period.");
      }
      return;
   }
   int cursor = MathMin(g_history_cursor, position_count);
   string positions = "[";
   int added = 0;
   int skipped = 0;
   bool first = true;
   while(cursor < position_count && added < HISTORY_BATCH_SIZE) {
      ulong position_id = position_ids[cursor++];
      string item = ClosedPositionJson(position_id);
      if(item == "") {
         skipped++;
         PrintFormat("[MT5 LIVE] skipped unreconstructable historical position %I64u; continuing batch.", position_id);
         continue;
      }
      if(!first) positions += ",";
      positions += item;
      first = false;
      added++;
   }
   positions += "]";
   bool complete = cursor >= position_count;
   string payload = "{\"event\":\"history_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":" + positions + ",\"complete\":" + (complete ? "true" : "false") + "}";
   if(!SendJson(payload, "history_batch")) return;
   if(complete) {
      g_last_history_sync = now;
      g_history_in_progress = false;
      g_history_full_replay = true;
      g_history_cursor = 0;
      PrintFormat("[MT5 LIVE] history sync completed; processed=%d; skipped=%d.", position_count, skipped);
   } else {
      g_history_cursor = cursor;
      PrintFormat("[MT5 LIVE] history batch accepted; sent=%d; skipped=%d; remaining=%d; continuing on next timer.", added, skipped, position_count - cursor);
   }
}

void Sync() {
   SendSummary();
   SendOpenPositions();
   if(SendHistoryOnInit && (g_history_in_progress || (g_last_history_attempt == 0 || TimeCurrent() - g_last_history_attempt >= 300) && (g_last_history_sync == 0 || TimeCurrent() - g_last_history_sync >= FULL_HISTORY_RETRY_SECONDS))) SendHistory(true);
}

int OnInit() {
   ResetLastError();
   if(!HasConfiguredEndpoint()) {
      Print("[MT5 LIVE] startup blocked: Endpoint must be the exact HTTPS API URL from Gold Journal MT5 Live.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(!HasConfiguredApiKey()) {
      Print("[MT5 LIVE] startup blocked: paste the current API key from Gold Journal MT5 Live into EA Inputs. Do not share that key.");
      return INIT_PARAMETERS_INCORRECT;
   }
   if(!EventSetTimer(MathMax(3, SyncSeconds))) {
      PrintFormat("[MT5 LIVE] timer could not start; MT5 error=%d", GetLastError());
      return INIT_FAILED;
   }
   PrintFormat("[MT5 LIVE] STARTUP; EA_VERSION=%s; endpoint=%s; terminal_connected=%s; api_key_present=true; sync_interval=%ds; history=%s.", EA_VERSION, Endpoint, TerminalInfoInteger(TERMINAL_CONNECTED) ? "true" : "false", MathMax(3, SyncSeconds), SendHistoryOnInit ? "enabled" : "disabled");
   Print("[MT5 LIVE] READ-ONLY MODE; this EA never opens, closes, modifies, or cancels MT5 orders and positions. Auto Trading is not required for Gold Journal synchronization.");
   if(!TerminalInfoInteger(TERMINAL_CONNECTED)) Print("[MT5 LIVE] broker connection is offline; summary, positions, and history will retry after MT5 reconnects.");
   SendCompatibility();
   Sync();
   return INIT_SUCCEEDED;
}
void OnDeinit(const int reason) { EventKillTimer(); PrintFormat("[MT5 LIVE] EA stopped; deinitialization reason=%d", reason); }
void OnTimer() { Sync(); }

// MQL5 requires request/result notification parameters for this passive terminal event.
// They are never read and this EA never calls a trade-execution API.
void OnTradeTransaction(const MqlTradeTransaction &transaction, const MqlTradeRequest &request, const MqlTradeResult &result) {
   if(transaction.deal == 0) return;
   long entry = HistoryDealGetInteger(transaction.deal, DEAL_ENTRY);
   if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT) SendHistory(false);
}
