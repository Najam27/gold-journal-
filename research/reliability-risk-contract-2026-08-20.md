# Reliability and Risk Calculator Contract

## Account isolation and offline recovery

Offline recovery is browser-local and account scoped. Each queued record carries an authenticated user subject snapshot, active account ID, mutation kind, generated idempotency key, sanitized payload, retry count, and creation timestamp. Queue storage contains no access token, API key, signed screenshot URL, file bytes, or server-only value. The client replays only when the same authenticated subject and active account are still selected, in original order, and only for safe create/upsert operations. Destructive deletes, Clear All, account changes, screenshots, and MT5 actions are never queued. Server procedures retain authorization and enforce an idempotency key for queued create operations.

## MT5 health and integrity

MT5 health derives from existing authenticated workspace data: last EA ping, latest account summary, history attempt/status/message, latest history completion, and configured connection status. A connection is classified as Live within 10 seconds, Idle within 60 seconds, Stale beyond 60 seconds, or Unavailable when absent. It does not pretend to poll MT5 when the EA is offline.

Integrity findings are account scoped and read-only. They identify: stale/missing MT5 contacts, failed/incomplete history, closed broker positions lacking a journal record, and future-dated journal rows. Findings never mutate or delete data. Their server procedure proves account ownership before querying and returns aggregate counts plus safe text only.

## Broker-backed risk calculator

The calculator receives only the selected account's safe workspace snapshot. The EA sends MT5 account balance, equity, margin, free margin, and selected symbol specifications: symbol name, tick size, loss tick value, contract size, and minimum/maximum/step volumes. The trader must explicitly enter entry price and stop loss and choose a risk percent. The deterministic calculation uses the selected balance/equity basis, risk amount, stop distance, broker tick values, and rounds volume down to the broker step; it warns if the resulting volume is below broker minimum, required data is unavailable, free margin is non-positive, or stop distance is invalid. The feature only calculates—no execution route, order placement, or terminal command is created.

## AI risk coach

The client sends a compact calculator snapshot to a protected rate-limited server mutation. The server recomputes and validates the deterministic calculator values from the authenticated MT5 workspace and accepted inputs; it does not trust a client-supplied lot size. The server-only OpenRouter request has a capped deadline, strict JSON schema, a prompt forbidding market predictions and Buy/Sell calls, and safe generic provider errors. The response can identify calculation/margin/process cautions and verification steps, not recommend a trade or guarantee an outcome.
