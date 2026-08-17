# Gold Journal MT5 Data-Integrity Trace

**Status:** Pre-change trace completed on 2026-08-17. This record distinguishes code-proven behavior from items that require implementation and automated verification.

## Current End-to-End Flow

| Stage | Current implementation | Verified boundary |
|---|---|---|
| MT5 ingress | `POST /api/mt5` is registered in `server/mt5Ingest.ts`. The payload supports `ping`, `summary`, `open`, `close`, and bounded `history_batch` events. | The request body is parsed by Zod; history batches are limited to 50 positions. |
| Authentication and ownership | The incoming API key is resolved with `getActiveMt5Connection()`. The resolved connection supplies the server-side `userId` and `accountId`; payload account fields are ignored. | An unauthorized key returns a generic `UNAUTHORIZED` code. |
| Timestamp parse | The Zod transform accepts only string timestamps. A timestamp with an explicit ISO offset is parsed as an instant. A timestamp without an offset is unconditionally treated as `UTC+3`. | This is the confirmed broker-timezone defect: connection-specific broker time is not available to the parser. |
| Position persistence | Open and close helpers upsert `gj_mt5_live_positions` by `(accountId, ticket)`. | The database has the expected account-scoped unique key; the same ticket can exist in separate journal accounts. |
| Journal synchronization | Each position is mirrored to `gj_trades` through an upsert keyed by `(accountId, mt5Ticket)`. Journal rows preserve manual-analysis fields because the MT5 upsert updates only synchronized facts. | The ticket uniqueness scope prevents cross-account journal collisions. |
| Reads | Workspace, history, and journal queries receive a selected account and verify ownership before returning data. | MT5 workspace and journal records are account-scoped. |

## Confirmed Gaps and Failure Paths

| Risk | Evidence from the traced implementation | Required correction |
|---|---|---|
| Broker timezone mismatch | Offset-free timestamps are transformed to `+03:00` before the server has resolved the connection. No connection-level broker offset exists. | Parse timestamp shape first, resolve connection, then normalize through one server-side function using the explicit offset or that connection's configured broker offset. |
| Delayed OPEN reopens a closed trade | The open-position upsert writes `status: "OPEN"` on every `(accountId, ticket)` collision. | Preserve a terminal `CLOSED` position when an older/retried OPEN arrives. |
| Partial close finalization | Close persistence and trade-log synchronization are separate database writes. A failure after the first write can leave a closed position with an open journal row. | Perform the position write and journal synchronization in one database transaction. |
| Close inherits raw incoming open time | Close persistence preserves an existing open time in the live row, but the journal sync receives the incoming close payload's `openTime`. | Reuse the stored canonical open time when finalizing a close. |
| Raw API-key retention | New connections write the plaintext API key to `gj_mt5_connections.apiKey`; the key is returned once at creation. | Store an SHA-256 verifier, migrate legacy plaintext values on the next valid request, and never expose or log the raw key after setup. |
| Unbounded pre-auth rate-limit map | The ingress limiter keys an in-memory `Map` by raw API key and does not evict stale entries. | Rate-limit by a one-way key fingerprint and cap/prune the map. |
| Safe diagnostic categories | Ingest failures currently collapse to `SYNC_UNAVAILABLE`; history diagnostics can retain raw thrown messages. | Emit safe client-facing categories and bounded, non-secret structured diagnostics. |

## Validation Order to Preserve

1. Receive the raw MT5 timestamp.
2. Resolve the API key to the active, owned connection.
3. Normalize the raw timestamp to an absolute instant using its explicit offset, a Unix epoch value, or the connection's configured broker UTC offset.
4. Interpret session/day business logic in fixed UTC+5.
5. Apply a narrow future-instant guard with a documented clock-skew tolerance.
6. Persist the live-position and journal changes atomically.

> **Representation note:** JavaScript `Date` and the managed MySQL `timestamp` columns represent an absolute instant. Gold Journal's fixed business timezone remains **UTC+5**: session classification and business-date rendering must derive UTC+5 components from that instant rather than using the browser's timezone.

## Scope Guard

No production MT5 record, connection, account, or journal row was modified during this trace. The next stage will add the smallest server-side normalization and lifecycle correction supported by these findings, with targeted regression coverage before publication.

## Approved Minimal Correction Design

The correction will add a signed `brokerUtcOffsetHours` connection field. New connections must explicitly select a value in the supported `UTC-12` through `UTC+14` range; legacy connections retain their existing, documented `UTC+3` EA behavior through a non-destructive default. The browser will show the selected account's configured offset in the MT5 setup flow, but it will not interpret or convert business timestamps.

`server/mt5Timestamp.ts` will become the only server-side parser/normalizer. It will accept Unix seconds/milliseconds as absolute instants, preserve ISO strings with explicit offsets, and parse offset-free MQL broker-local timestamps using the authenticated connection's configured offset. It will return an absolute `Date`; all Gold Journal business-time operations continue to derive their fixed UTC+5 components from that instant. A five-minute future-clock tolerance will be enforced only after normalization.

Open and close upserts will run their position and journal writes in the same database transaction. A close will reuse the stored canonical open time and finalize the matching `(accountId, ticket)` journal row. A delayed or duplicate open for an existing closed position will be a no-op, preserving the terminal state. Repeated closes and repeated history batches will remain idempotent through the existing account-scoped unique keys.

The API-key verifier will be SHA-256 based. New keys will be stored only as verifiers and returned once on creation. A successful request using a legacy plaintext verifier will migrate it in place. Ingress rate-limit buckets will use the one-way fingerprint and be bounded/pruned; payload parsing will receive an MT5-specific small request-size limit. Client errors will expose safe categories without database details or secrets.

## Implementation Record

The reviewed migration `0006_lively_leech.sql` added `brokerUtcOffsetMinutes` with a non-destructive `180`-minute default and was applied to the managed database. The offset is now available only through selected-account workspace data and ownership-checked connection procedures. New connections select their server offset in the MT5 Live setup dialog; existing connections can update it from their own connection card.

`server/mt5Timestamp.ts` now owns all MT5 timestamp normalization. It correctly distinguishes Unix seconds/milliseconds, strings with explicit offsets, and offset-free MQL broker-local values. The result remains an absolute `Date`; the fixed UTC+5 formatter and PKT session classifier derive business semantics from that instant. The normalizer rejects malformed values and only rejects a value as future after conversion, with a five-minute clock-skew allowance.

MT5 open and close writes now use a database transaction for both `gj_mt5_live_positions` and the mirrored `gj_trades` row. Close reconciliation preserves the stored canonical open time. A terminal closed row is not reopened by a delayed or duplicated OPEN, and a repeated CLOSE is idempotent. Existing account-scoped `(accountId, ticket)` unique keys continue to isolate identical MT5 ticket values across accounts. The journal upsert continues to update synchronized facts only, preserving the trader's manual notes and analysis fields.

New API keys are written as SHA-256 verifiers and returned only once during setup. Existing plaintext verifiers migrate on their next successful EA request. Rate-limit buckets use key fingerprints, expire after one second, and are capped at 2,000 entries. MT5 JSON is now separately bounded at 256 KB while other application uploads retain their previous larger limit. Oversized MT5 requests return `PAYLOAD_TOO_LARGE`; timestamp failures use `INVALID_MT5_TIMESTAMP` or `FUTURE_TRADE` without exposing internals.

## Automated Verification

The final local validation passed **39 test files / 116 tests**, TypeScript, production build, and service-worker syntax. The added MT5 coverage includes broker offsets from UTC-8 through UTC+10, explicit offsets, Unix epochs, UTC+8 midnight crossing into the prior UTC+5 business date, malformed/future rejection after normalization, authenticated connection offsets, rate-limit bounds, duplicate closes, delayed opens, preserved manual journal notes, and the account-scoped broker-offset UI control. Existing ingestion coverage continues to assert separate same-ticket events resolve independently through separate authenticated account connections.

## Production No-Mutation Verification

The published release `1f1f2366` was reopened at `https://pwapp-luwwcqcw.manus.space/?update=1f1f2366&refresh=mt5-integrity-v5&theme=dark`. The selected **enx live** account retained its isolated **exn** connection, Exness login 174856819, MT5 balance/equity of $68.68, one XAUUSDm open position, 25 closed historical positions, and 26 synchronized Trade Log records. The newly published **Broker server time** control rendered for that selected connection with its legacy-migrated default of **UTC+03:00**, without displaying API-key material. Setup copy now clearly states that the configured broker offset is used only for timestamp values that arrive without an explicit offset, with final journal/session logic remaining fixed at UTC+5. No account, connection, offset, trade, position, journal record, key, or setting was changed during this verification.

## Reported stale OPEN ticket and edit-date trace — 2026-08-17

The reported XAUUSDm open record was traced to `(account 150001, ticket 2535093828)`. It has an open time of `2026-08-16 21:04:15`, an open price of 4374.421000, floating P&L of -$1.72, and no stored close price, close time, realized P&L, or terminal result. Its matching journal record remains OPEN. The active connection is still sending summaries and historical batches, but its state is `ACCEPTED` rather than `COMPLETE`: it is sending batches of 25 while historical synchronization remains unfinished. Therefore, the server has not received actual closing facts for this ticket and does not safely have enough information to fabricate a close.

The root cause was in EA v1.13 scheduling. Its live-close scan ran only after the full historical backfill completed; while backfill remained in progress, a newer terminal close could be delayed behind older history. EA v1.14 now starts historical batching with the newest closed positions and runs one bounded live-close check on every timer cycle, while staying inside the five-event-per-second ingestion budget. Its download path is updated in MT5 Live. Once the EA v1.14 sends ticket 2535093828's terminal close, the server's atomic close reconciliation will finalize the live row and its matching journal record with the actual broker close facts.

The journal edit failure had a separate browser-timezone cause. The page-level `dateInput()` used the browser-local offset even though journal business dates are UTC+5. It now uses a shared `getPktDateInput()` formatter, persisted date-only manual entries use noon UTC+5, and only a *new* manual entry is compared against the current PKT date. Existing journal records bypass that new-entry guard, so they remain editable without admitting a genuinely future-dated new trade. The shared date formatter now also renders journal dates in Asia/Karachi.

## Production manual-close recovery verification — 2026-08-17

After the EA v1.14 update and the published `16ad7aca` v7 client activation, the previously stale **XAUUSDm BUY** no longer appears in the Trade Log's live-position strip or the MT5 Live open-position section. Its actual terminal facts now appear as a synchronized historical close: opened at **4374.421000**, closed at **4373.011000**, risk **$3.89**, realized P&L **-$2.82**, result **LOSS**, timestamp **17 Aug, 02:05 am PKT**. MT5 Live reports **No open positions in MT5**, $0.00 floating P&L, and the setup guide renders **EA v1.14**. This confirms the recovered manual-close flow used broker-provided facts rather than a fabricated reconciliation.
