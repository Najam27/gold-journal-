#property strict
#property version   "1.0"

input string Endpoint = "https://YOUR-SITE.netlify.app/.netlify/functions/mt5";
input string ApiKey = "PASTE_ONCE_FROM_GOLD_JOURNAL";
input string ConnectionId = "PASTE_CONNECTION_ID";
input int BrokerUtcOffset = 3;
input int SyncSeconds = 30;

string JsonEscape(string value) { StringReplace(value, "\\", "\\\\"); StringReplace(value, "\"", "\\\""); return value; }

void OnTimer() {
   // Production EA implementations should enumerate AccountInfoDouble values,
   // PositionsTotal(), PositionGetTicket(), and history deals into the payload.
   // The endpoint treats ticket as the idempotency key and safely upserts retries.
   string payload = "{\"apiKey\":\"" + JsonEscape(ApiKey) + "\",\"connectionId\":\"" + JsonEscape(ConnectionId) + "\",\"brokerUtcOffset\":" + IntegerToString(BrokerUtcOffset) + ",\"account\":{\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",\"floatingPnl\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + "},\"positions\":[]}";
   char body[]; StringToCharArray(payload, body, 0, WHOLE_ARRAY, CP_UTF8);
   char result[]; string responseHeaders; string headers = "Content-Type: application/json\r\n";
   int status = WebRequest("POST", Endpoint, headers, 15000, body, result, responseHeaders);
   if(status < 200 || status >= 300) Print("Gold Journal sync failed: ", status);
}

int OnInit() { EventSetTimer(MathMax(5, SyncSeconds)); return INIT_SUCCEEDED; }
void OnDeinit(const int reason) { EventKillTimer(); }
