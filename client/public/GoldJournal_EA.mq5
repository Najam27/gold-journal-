#property strict
#property version   "2.0"
#property description "Gold Journal authoritative MT5 bridge: summary, open positions, close events, and replay-safe history batches."

input string Endpoint = "https://YOUR-SITE.netlify.app/api/mt5";
input string ApiKey = "PASTE_ONCE_FROM_GOLD_JOURNAL";
input string ConnectionId = "PASTE_CONNECTION_ID";
input int BrokerUtcOffsetMinutes = 180;
input int SyncSeconds = 30;
input int HistoryDays = 30;
input bool SendHistoryOnInit = true;

const string EA_VERSION = "2.0.0";
const string PAYLOAD_VERSION = "2";
const int REQUEST_TIMEOUT_MS = 15000;
const int HISTORY_BATCH_SIZE = 50;

datetime g_last_history_sync = 0;

string JsonEscape(string value) {
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", "\\r");
   StringReplace(value, "\n", "\\n");
   return value;
}

string Number(double value, int digits = 2) { return DoubleToString(value, digits); }
string Unix(datetime value) { return IntegerToString((long)value); }
string Direction(ENUM_POSITION_TYPE type) { return type == POSITION_TYPE_BUY ? "BUY" : "SELL"; }
string DealDirection(long type) { return type == DEAL_TYPE_BUY ? "BUY" : "SELL"; }

bool SendJson(string payload, string expectedEvent) {
   char data[];
   int data_size = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(data_size > 0 && data[data_size - 1] == 0) {
      ArrayResize(data, data_size - 1);
   }
   char response[];
   string response_headers;
   string headers = "Content-Type: application/json\r\n";
   int status = WebRequest("POST", Endpoint, headers, REQUEST_TIMEOUT_MS, data, response, response_headers);
   if(status < 200 || status >= 300) {
      PrintFormat("Gold Journal %s sync failed: HTTP %d", expectedEvent, status);
      return false;
   }
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
   return "{\"ticket\":\"" + IntegerToString((long)ticket) + "\",\"symbol\":\"" + JsonEscape(symbol) + "\",\"direction\":\"" + Direction(type) + "\",\"lots\":" + Number(volume, 2) + ",\"open_price\":" + Number(open_price, 6) + ",\"sl_price\":" + Number(sl, 6) + ",\"tp_price\":" + Number(tp, 6) + ",\"risk_usd\":" + Number(risk, 2) + ",\"reward_usd\":" + Number(reward, 2) + ",\"rr_ratio\":" + Number(rr, 2) + ",\"floating_pnl\":" + Number(floating, 2) + ",\"open_time\":" + Unix(open_time) + "}";
}

void SendCompatibility() {
   string payload = "{\"event\":\"compat\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"connection_id\":\"" + JsonEscape(ConnectionId) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\"}";
   SendJson(payload, "compat");
}

void SendSummary() {
   string payload = "{\"event\":\"summary\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"connection_id\":\"" + JsonEscape(ConnectionId) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"mt5_login\":\"" + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "\",\"broker_server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\",\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\",\"balance\":" + Number(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\"equity\":" + Number(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",\"margin\":" + Number(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",\"free_margin\":" + Number(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",\"floating_pnl\":" + Number(AccountInfoDouble(ACCOUNT_PROFIT), 2) + "}";
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
   string payload = "{\"event\":\"open_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"connection_id\":\"" + JsonEscape(ConnectionId) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":" + positions + "}";
   SendJson(payload, "open_batch");
}

bool FindOpenDeal(ulong position_id, datetime &open_time, double &open_price) {
   datetime earliest = 0;
   double price = 0.0;
   int total = HistoryDealsTotal();
   for(int i = 0; i < total; i++) {
      ulong deal = HistoryDealGetTicket(i);
      if((ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID) != position_id) continue;
      long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_IN && entry != DEAL_ENTRY_INOUT) continue;
      datetime time = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);
      if(earliest == 0 || time < earliest) {
         earliest = time;
         price = HistoryDealGetDouble(deal, DEAL_PRICE);
      }
   }
   if(earliest == 0) return false;
   open_time = earliest;
   open_price = price;
   return true;
}

string ClosedDealJson(ulong deal) {
   long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT) return "";
   ulong position_id = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
   string symbol = HistoryDealGetString(deal, DEAL_SYMBOL);
   if(position_id == 0 || symbol == "") return "";
   datetime close_time = (datetime)HistoryDealGetInteger(deal, DEAL_TIME);
   datetime open_time = close_time;
   double open_price = HistoryDealGetDouble(deal, DEAL_PRICE);
   FindOpenDeal(position_id, open_time, open_price);
   double realized = HistoryDealGetDouble(deal, DEAL_PROFIT) + HistoryDealGetDouble(deal, DEAL_SWAP) + HistoryDealGetDouble(deal, DEAL_COMMISSION);
   string result = realized > 0.005 ? "WIN" : realized < -0.005 ? "LOSS" : "BREAK_EVEN";
   long deal_type = HistoryDealGetInteger(deal, DEAL_TYPE);
   return "{\"ticket\":\"" + IntegerToString((long)position_id) + "\",\"symbol\":\"" + JsonEscape(symbol) + "\",\"direction\":\"" + DealDirection(deal_type) + "\",\"lots\":" + Number(HistoryDealGetDouble(deal, DEAL_VOLUME), 2) + ",\"open_price\":" + Number(open_price, 6) + ",\"sl_price\":0,\"tp_price\":0,\"risk_usd\":0,\"reward_usd\":0,\"rr_ratio\":0,\"close_price\":" + Number(HistoryDealGetDouble(deal, DEAL_PRICE), 6) + ",\"realized_pnl\":" + Number(realized, 2) + ",\"result\":\"" + result + "\",\"open_time\":" + Unix(open_time) + ",\"close_time\":" + Unix(close_time) + "}";
}

void SendHistory(bool fullReplay) {
   datetime now = TimeCurrent();
   datetime from = now - (fullReplay ? HistoryDays * 86400 : MathMax(3600, SyncSeconds * 4));
   if(!HistorySelect(from, now)) return;
   int total = HistoryDealsTotal();
   int cursor = 0;
   bool sent = false;
   while(cursor < total) {
      string positions = "[";
      int added = 0;
      bool first = true;
      while(cursor < total && added < HISTORY_BATCH_SIZE) {
         ulong deal = HistoryDealGetTicket(cursor++);
         string item = ClosedDealJson(deal);
         if(item == "") continue;
         if(!first) positions += ",";
         positions += item;
         first = false;
         added++;
      }
      positions += "]";
      if(added == 0) continue;
      bool complete = cursor >= total;
      string payload = "{\"event\":\"history_batch\",\"api_key\":\"" + JsonEscape(ApiKey) + "\",\"connection_id\":\"" + JsonEscape(ConnectionId) + "\",\"ea_version\":\"" + EA_VERSION + "\",\"payload_version\":\"" + PAYLOAD_VERSION + "\",\"broker_utc_offset_minutes\":" + IntegerToString(BrokerUtcOffsetMinutes) + ",\"positions\":" + positions + ",\"complete\":" + (complete ? "true" : "false") + "}";
      if(!SendJson(payload, "history_batch")) return;
      sent = true;
   }
   if(sent) g_last_history_sync = now;
}

void Sync() {
   SendSummary();
   SendOpenPositions();
   if(SendHistoryOnInit && (g_last_history_sync == 0 || TimeCurrent() - g_last_history_sync >= MathMax(60, HistoryDays * 60))) SendHistory(true);
}

int OnInit() {
   EventSetTimer(MathMax(5, SyncSeconds));
   SendCompatibility();
   Sync();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { Sync(); }

void OnTradeTransaction(const MqlTradeTransaction &transaction, const MqlTradeRequest &request, const MqlTradeResult &result) {
   if(transaction.deal == 0) return;
   long entry = HistoryDealGetInteger(transaction.deal, DEAL_ENTRY);
   if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT) SendHistory(false);
}
