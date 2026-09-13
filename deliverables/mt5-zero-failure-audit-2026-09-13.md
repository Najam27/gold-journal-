# MT5 zero-failure audit, EA hardening, and trade-lifecycle repair — 2026-09-13

Scope: the complete MT5 pipeline (`GoldJournal_EA.mq5` → Cloudflare Worker `/api/mt5` →
`server/mt5Ingest.ts` → Supabase RPCs → MT5 Live UI → Trade Log), including failure,
recovery, idempotency, multi-account routing, history, and timezone behaviour.

Every table below lists the finding, its severity, the root cause, the exact code that
changed, the observable behaviour before/after, and the regression test that now guards it.

---

## 1. Findings

### CRITICAL-1 — A partial close permanently froze the trade and silently dropped the remaining volume

* **Root cause** — `OnTradeTransaction` fired on any `DEAL_ENTRY_OUT` deal (which MT5 also
  emits for partial closes and for the closing leg of a netting `INOUT` reversal) and
  `ClosedPositionJson()` built a terminal `CLOSED` record from whatever deals existed.
* **Behaviour before** — Position `12345` at 10 lots, 4 lots closed: the EA sent a
  `CLOSED` record with the partial P&L. `gj_sync_mt5_position` treats `CLOSED` as terminal,
  so the 6 remaining lots could never be written again: the Trade Log showed a finished
  trade and the live account was wrong forever.
* **Fix** — `client/public/GoldJournal_EA.mq5`: `ClosedPositionJson()` returns no record
  while `PositionSelectByTicket(position_id)` still succeeds, and the batch builder skips
  still-open positions explicitly (`still_open` counter). A still-open position is owned by
  the live open stream, which refreshes volume, price, SL/TP and floating P&L every cycle.
* **Test** — `client/src/lib/mt5EaReliability.test.ts` (“never reports a still-existing
  position as terminal CLOSED”).
* **Regression risk** — Low. The only path that could now under-report a close is a position
  that exists but whose tickets are unreadable, which is impossible while it is open; the
  reconciliation path in CRITICAL-3 covers the opposite direction.

### CRITICAL-2 — More than 200 open positions could never synchronize

* **Root cause** — the EA serialized `PositionsTotal()` into a single `open_batch`, while the
  server schema and RPC bound the batch at 200. The server answered `400 INVALID_PAYLOAD`,
  which the EA classifies as transient → an infinite 3-second retry loop and no live data.
* **Fix** — EA splits the snapshot into independently retryable batches of at most 200
  (`MAX_OPEN_POSITIONS_PER_BATCH`, `SendOpenBatch()`); the first failed batch stops the
  remaining batches for that cycle (no storm) and everything retries on the next timer.
  The server now answers an oversized batch from an *older* EA with an actionable
  `400 BATCH_TOO_LARGE` (with `maxPositionsPerBatch`) instead of an opaque validation error.
* **Tests** — `mt5EaReliability.test.ts`, `server/mt5Ingest.test.ts` (“rejects an oversized
  open batch…”), `server/mt5SyncHardening.test.ts` (chunk bounds).

### CRITICAL-3 — A close that MT5 never reported could leave a trade OPEN for up to 24 hours

* **Root cause** — after the first full replay, the only automatic history sweep was the
  `OnTradeTransaction` close notification. It depended on `HistoryDealGetInteger(deal, …)`
  for a deal that may not be in the terminal's history cache yet (MT5 returns 0 → the
  notification was silently dropped), and the 24-hour replay was the only fallback.
* **Fix** —
  1. `OnTradeTransaction` now reads `transaction.type`, `transaction.entry` and
     `transaction.position` — data carried by the event itself, no history-cache dependency.
  2. Each heartbeat/compat response now carries the server's authoritative open-ticket list
     (`openTicketFormat: "csv"`, `openTickets`, `openTicketCount`, `openTicketsTruncated`).
     The EA compares it with its own positions, and for a ticket the server still believes is
     OPEN but the terminal no longer holds, reconstructs the close with
     `HistorySelectByPosition` and sends a single `close` event (bounded to one ticket per
     cycle, escalating the history window at most once per 5 minutes, retrying an
     unreconstructable ticket on a 10-minute → 60-minute backoff).
  3. A bounded incremental history sweep now also runs on its own cadence
     (`HISTORY_SWEEP_SECONDS = 900`).
* **Tests** — `mt5EaReliability.test.ts` (reconciliation + sweep contract),
  `server/mt5Ingest.test.ts` (“publishes the server's open tickets…”), `mt5SyncHardening.test.ts`.
* **Remaining limitation** — if the terminal's history cache holds no deals for a position
  that has genuinely closed, the EA keeps the row OPEN and reports it rather than inventing
  a close price, P&L, and result. (Fabricating them would corrupt the journal and is blocked
  by `gj_mt5_closed_position_complete`.)

### HIGH-1 — One malformed trade rejected the whole history batch, forever

* **Root cause** — `history_batch.positions` was validated as a unit (`closedPosition.parse` on
  each element inside one Zod schema). One bad record → `400 INVALID_PAYLOAD` → the EA kept the
  cursor and re-sent the same 50 records for the rest of the epoch.
* **Fix** — `partitionMt5Records()` validates each record independently, persists the valid
  ones in one transaction, and reports ticket-level results
  (`{ ok, synced, accepted, rejected, stored, failed: [{ ticket, code, retryable }] }`).
  The EA advances its cursor because the batch was processed, logs the skipped count, and
  never re-sends a poison record automatically. A batch consisting *only* of unusable records
  returns `422 SYNC_PARTIAL` (never a silent success). A rejection summary is stored on the
  connection so MT5 Live can show it.
* **Tests** — `mt5Ingest.test.ts` (quarantine for timestamps, structure, and all-rejected batch).

### HIGH-2 — A rejected or rotated EA key was reported as an offline terminal

* **Root cause** — a key that no longer matches resolves to `401` with no record on the
  connection, so the UI could only fall back to “no recent contact” (stale/offline), and
  `rotateConnectionKey` overwrote the only stored hash of the outgoing key.
* **Fix** — migration `0021_mt5_connection_key_history.sql` adds `previousApiKeyHash`
  (and `previousApiKeyAt`, a validity check, and a partial index); the router records the
  outgoing fingerprint on rotate/replace; a rejected key that matches a retired or outgoing
  fingerprint is attributed with `AUTH_REVOKED` (never advancing `lastContactAt`, so the
  connection never looks live); `classifyMt5SyncHealth` now returns `AUTH_ERROR` /
  `CONFIG_ERROR` with an actionable message and a 7-day authority window that ends as soon as
  authenticated contact supersedes it. The HTTP response stays an opaque 401.
* **Tests** — `mt5Ingest.test.ts` (attribution, unknown key, plain 401),
  `server/mt5Reliability.test.ts` (AUTH/CONFIG classification, recovery, transient
  non-classification), `Mt5LiveView.test.tsx` (presentation).

### HIGH-3 — Large accounts could break the entire MT5 Live workspace poll

* **Root cause** — `getMt5Workspace`/`getMt5History` built one PostgREST `or()` filter from
  every visible ticket (500 open + 10 closed), producing a multi-kilobyte query URL, and the
  workspace also issued one owner-canonicalization query *per connection* every 2.5 seconds.
* **Fix** — a shared `chunkMt5TicketFilters()`/`journaledTicketSet()` helper (100 tickets per
  chunk) is used by the workspace, the history reader, and the Trade Log pre-sync; the owner
  lookup is a single account query with an in-memory map.
* **Tests** — `mt5SyncHardening.test.ts` (chunk bounds, helper usage),
  `server/mt5ConnectionOwner.test.ts`.

### MEDIUM-1 — Unknown payload versions were processed as if they were known

* **Fix** — the server explicitly rejects a data event whose `payload_version` is not in
  `["1","2"]` with `400 UNSUPPORTED_VERSION` (and records the code on the connection, which
  MT5 Live reports as a configuration problem, not an outage). `compat`/`ping` still answer so
  the EA can discover and report the mismatch. The EA maps `UNSUPPORTED_VERSION`,
  `INVALID_PAYLOAD`, `INVALID_JSON`, `BATCH_TOO_LARGE`, `INVALID_SYNC_DATA`,
  `INVALID_MT5_TIMESTAMP`, `FUTURE_TRADE`, `SYNC_PARTIAL` and `MIGRATION_REQUIRED_0008` to a
  bounded 5-minute configuration backoff instead of the 60-second transient retry.

### MEDIUM-2 — Impossible broker timestamps were silently rolled into another day

* **Fix** — `parseOffsetFreeBrokerTime` validates every component and round-trips it, so
  `2026-02-31` or `2026-13-01` is an `INVALID_MT5_TIMESTAMP` rejection (quarantined per record)
  instead of being stored as 3 March / January.

### MEDIUM-3 — A partial transcript of the chart lifecycle could make a healthy EA look stale

* **Fix** — `compat`/`ping` are exempt from the transient backoff gate, so the heartbeat keeps
  proving liveness during a partial outage and a corrected credential does not wait out the
  configuration backoff. Three independent streams (heartbeat, open positions, snapshot,
  history) are now surfaced separately in MT5 Live to satisfy “do not collapse all three into
  one misleading connected indicator”.

### Reviewed and deliberately unchanged

* `CLOSED is terminal` in `gj_sync_mt5_position` — correct protection against stale/late
  `open_batch` replays; the fixes above remove the ways a *false* CLOSED could be produced.
* Hedging: identity remains `(accountId, ticket)` and `open_batch` never merges tickets that
  share a symbol or direction.
* Netting: a reversal that keeps the position alive is never reported as a closed trade; a
  reversal that closes it produces a real `CLOSED` record at the end of that position's life.
* Multi-user routing, ownership canonicalization, RLS, service-role-only RPCs, and the
  API-key-as-sole-credential model were re-verified and left intact. No EA-supplied identity
  (accountId/userId/email) is trusted anywhere.

---

## 2. Files changed

| File | Change |
| --- | --- |
| `client/public/GoldJournal_EA.mq5` | v2.15: partial-close guard, 200-position chunking, server-driven close reconciliation, transaction-based close detection, payload/version failure classification, probe exemption from transient backoff, bounded history sweep |
| `server/mt5Ingest.ts` | per-record quarantine, ticket-level batch results, payload-version gate, oversized-batch code, revocation attribution, heartbeat reconciliation feed, per-event broker offset |
| `server/mt5Db.ts` | chunked ticket filters, batched owner canonicalization, open-ticket feed, revoked-key lookup, `AUTH_REVOKED` recording, history rejection record |
| `server/mt5Reliability.ts` | `AUTH_ERROR`/`CONFIG_ERROR` states, `errorCategory`, `historyAgeSeconds`, auth/config integrity findings |
| `server/mt5Timestamp.ts` | impossible-component and round-trip validation |
| `server/goldRouter.ts` | store the outgoing key fingerprint on rotate/replace |
| `client/src/components/Mt5LiveView.tsx`, `client/src/mt5-live.css` | auth/config badges and the four-stream freshness strip |
| `drizzle/schema.ts`, `scripts/schema-source-audit.mjs`, `README.md` | schema metadata, audit expectations, migration documentation |
| `supabase/migrations/0021_mt5_connection_key_history.sql` | new |
| Tests | `server/mt5SyncHardening.test.ts` (new), `server/mt5Ingest.test.ts`, `server/mt5Reliability.test.ts`, `server/mt5ConnectionOwner.test.ts`, `client/src/lib/mt5EaReliability.test.ts`, `client/src/components/Mt5LiveView.test.tsx` |

## 3. Verification

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | pass |
| `npx vitest run` | 87 files passed (1 skipped), 407 tests passed (2 skipped) |
| `node scripts/schema-source-audit.mjs` | all migration/schema expectations pass, migration order `0001`–`0021` valid |
| `npx vite build` | pass |
| `node scripts/build-worker.mjs` | pass (EA template inlined and verified) |

## 4. Production deployment checklist

1. Apply `supabase/migrations/0021_mt5_connection_key_history.sql` (SQL Editor or
   `supabase db push`). It is additive: two nullable columns, one check, one partial index.
2. Reload the PostgREST schema cache (`NOTIFY pgrst, 'reload schema'`) so the new column is
   visible to the service role.
3. Deploy the Worker (`pnpm build` artifacts already verified). The new `/api/mt5` contract is
   backward compatible: payload v1/v2 EAs keep working, an unknown version now gets an
   explicit `UNSUPPORTED_VERSION`.
4. In MT5 Live, re-download `GoldJournal_EA.mq5` (2.15) and replace the copy on each chart:
   the chunking, partial-close guard, and reconciliation feed exist only in 2.15. Existing
   2.x EAs continue to work while a chart is updated.
5. Rotate the key of any connection whose EA was deleted or whose key leaked (`Issue new API
   key`), then paste it into the EA and apply. The retired fingerprint is retained for
   attribution only.
6. Watch the MT5 Live connection card: EA heartbeat / Open positions / Account snapshot /
   Trade history must each read live within one cycle; `MT5 key rejected` and `MT5
   configuration invalid` are credential/build problems, everything else is a network problem
   that recovers by itself.
7. Do not delete or recreate the connection row to fix a stale EA — the key alone routes data
   and the row must exist for the reconciliation feed.
