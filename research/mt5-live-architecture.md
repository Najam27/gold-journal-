# MT5 Live Connection Architecture Note

Gold Journal uses a direct, API-key-protected HTTP ingestion endpoint at `/api/mt5`. A Gold Journal account owns one generated connection key; the EA supplies that key in each `ping`, `open`, or `close` payload. The server resolves the key to its account before writing any live-position data, so the browser never sends an ownership identifier to the ingest endpoint.

The implementation follows the official MQL5 `WebRequest` model. MetaTrader requires the destination URL to be added under **Tools → Options → Expert Advisors → Allow WebRequests for listed URL**. `WebRequest` is synchronous and is supported from Expert Advisors and scripts, which is why the downloadable EA uses a bounded five-second request timeout and a two-second timer.[1]

The endpoint limits each API key to five requests per second, uses unique `(accountId, ticket)` records for concurrent-safe live-position upserts, and stores the ticket server-side when the trader intentionally journals a closed MT5 position.

## Reference

[1]: https://www.mql5.com/en/docs/network/webrequest "MQL5 Reference — WebRequest"
