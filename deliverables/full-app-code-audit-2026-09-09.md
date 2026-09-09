# Gold Journal — Full Code Audit (line-by-line review)

Date: 2026-09-09 · Branch: `arena/01a08589-gold-journal` @ `c9d9197`
Scope: MT5 bridge (EA ↔ ingest ↔ DB RPCs ↔ UI), AI pipeline (Analysis / Mentor / Risk Coach + Netlify background job queue), auth/session, tRPC router, DB migrations, client polling.
Method: static line-by-line read of `client/public/GoldJournal_EA.mq5`, `server/*`, `netlify/functions/*`, `supabase/migrations/*`, relevant `client/src/*`. (No `node_modules` in the checkout, so tsc/tests were not executed here.)

---

## 1. Your symptoms → root causes (short version)

| Your complaint | Root cause (see section) |
|---|---|
| MT5 connection “auto timeout” / dies by itself | EA hard-stops all traffic after ONE non-transient HTTP error (422 etc.) and only an EA restart revives it → server sees no contact → **STALE (60 s) / OFFLINE (300 s)**. (§2.1) |
| Trade closed in MT5 (SL / manual / TP) but still **Live/OPEN** in journal | EA “quick” close-sync only scans the **last 1 hour** of terminal history; the 24 h full replay is throttled and the 1 h sweep re-arms it, so a close missed while the EA was offline/blocked stays OPEN up to 24 h. Partial closes are also journaled as full closes. (§2.2) |
| AI Mentor / AI Analysis never analyze — error or timeout | Async job dispatch depends on Netlify background-function env/behavior; several code paths leave a job QUEUED/RUNNING forever with the UI polling endlessly, or throw “AI background processing could not be started”. Overs-strict AI number validation also makes good model output get rejected → “temporarily unavailable”. (§3) |
| “Session” feels involved | Deterministic analysis + AI re-run twice; journal/trades API do a per-row MT5→Trade-Log upsert storm on every 2.5 s poll — queries can exceed the client 15 s timeout and look like a session hang. (§4, §6) |

---

## 2. MT5 Live — the two reported bugs

### 2.1 CRITICAL — EA permanently stops on any non-transient HTTP error (including 422)

`client/public/GoldJournal_EA.mq5`

- `IsTransientStatus()` (line 56) treats only `-1, 408, 429, 500, 502, 503, 504` as retryable.
- `SendJson()` lines 126–138: **any other status** (400, 401, 403, 404, 405, 410, **422**, …) sets `g_permanent_rejection = true`.
- Line 105: `if(g_permanent_rejection) return false;` — after that, **every** event (summary, open batch, history, ping) is dropped without an HTTP call until the EA is restarted (`OnInit` resets the flag).
- The server intentionally returns **422** for per-position problems (`server/mt5Ingest.ts:127,166,188` — codes `INVALID_SYNC_DATA`, `SYNC_PERMISSION_DENIED`, `INVALID_MT5_TIMESTAMP`, `FUTURE_TRADE`). So **one** position with a timestamp the server considers “future” (broker/terminal clock or `BrokerUtcOffsetMinutes` mismatch > 5 min, `server/mt5Timestamp.ts` `MT5_FUTURE_CLOCK_SKEW_MS`) or one rejected row kills the whole bridge.
- Result: the server’s `lastContactAt` stops advancing; `classifyMt5SyncHealth` (`server/mt5Reliability.ts`) shows **STALE after 60 s, OFFLINE after 300 s** → the UI badge “MT5 offline” = the “auto timeout” the user sees. Only an EA restart (which resets `g_permanent_rejection`) revives it, and then only until the next 422.

**Fix:**
1. Only *truly* permanent statuses should stop the EA: `401/403` (key retired/rejected) and `404/405` (endpoint wrong/stale). Keep `400/422/410` retryable with exponential backoff, and log the server `code`/`diagnostic`.
2. Never let a history-payload rejection block summary/open heartbeats — block only the failing event class, or better, retry the *whole event* but continue other events.
3. EA: parse `{"code":"FUTURE_TRADE"}`/`INVALID_MT5_TIMESTAMP` responses and print a precise, actionable message (“broker UTC offset probably wrong; set BrokerUtcOffsetMinutes to …”) instead of “check endpoint and restart”.
4. On 401/403 show the existing “issue a replacement key” copy (already present).

### 2.2 CRITICAL — closed trades stay OPEN in the journal (SL/manual/TP close lost)

`client/public/GoldJournal_EA.mq5`

- The close path is **only** `OnTradeTransaction` (line 391–394) → `SendHistory(false)`, plus a throttled full replay.
- Quick sync scans only `now − max(3600, SyncSeconds*4)` (line 303) → **last 1 hour**.
- Full replay condition (line 362): only when `g_history_in_progress`, OR (`last attempt ≥ 300 s ago` AND (`lastHistorySync == 0` OR **≥ 24 h** since last successful sync)). Constant `FULL_HISTORY_RETRY_SECONDS = 24*60*60` (line 17).
- Failure sequence that matches the report:
  1. A trade closes while the EA/terminal is offline, WebRequest keeps failing, or the EA is permanently stopped (§2.1) → the deal event can’t be sent.
  2. When contact returns **more than 1 h later**, every retry re-runs the 1-hour sweep, finds nothing, and sends an **empty `history_batch {complete:true}`** (lines 287–300).
  3. That empty batch stamps `g_last_history_sync = now` and resets the 24 h full-replay timer → the closed position is not re-sent for up to another 24 h.
- Server side can’t repair it: `gj_sync_mt5_open_batch` (migration `0016`) only upserts OPEN rows that are present; it never closes rows that vanished. `mt5.workspace`, `mt5.history`, `journal.get` and `trades.list` only read what was stored. `syncStoredMt5PositionsToTradeLog` can’t create a close it never received. So `gj_mt5_live_positions.status = 'OPEN'` and the matching `gj_trades.result = 'OPEN'` row stay visible in Trade Log/MT5 Live as a live trade.

**Fix (EA):** make the quick sweep window start at `g_last_history_sync`/`g_last_history_success` (capped by `HistoryDays`), never `now−1h`; only advance `g_last_history_sync` when the sweep truly covered everything since the previous sync; don’t let an empty 1-hour sweep re-arm the 24 h gate.
**Fix (server):** reconciliation in `gj_sync_mt5_open_batch` — if the EA (which is authoritative for open positions while connected) sends an open batch that omits stored OPEN rows **in two consecutive batches**, close them server-side (mark `result='CLOSED_BY_RECONCILIATION'` or reuse normal close). This bounds the stale window to seconds instead of 24 h, but still journal correctly when the deal payload arrives later.
**Operational:** after deploys of the EA fix, users with stuck OPEN rows can trigger the full replay by restarting the EA (flag resets) or pressing the existing “Reconnect/Journal now” flow.

### 2.3 HIGH — partial closes are journaled as full closes

`GoldJournal_EA.mq5` `CollectClosedPositionIds()` (lines 231–245) + `ClosedPositionJson()`:
- It treats any `DEAL_ENTRY_OUT`/`OUT_BY`/`INOUT` as a close and sends `close` for the position id — even a **partial close** where the position still exists with reduced volume.
- Server: `gj_sync_mt5_position` (migration `0012`) makes a **CLOSED row terminal** (`if existing_status = 'CLOSED' then return false`) — subsequent OPEN events for the same ticket are dropped.
- Result: partially closed position shows in the journal as CLOSED (with partial volume/P&L), while MT5 still has it open; later real close events are ignored.

**Fix:** in `CollectClosedPositionIds`/`SendHistory(false)`, skip ids that still exist in the open-positions pool (`PositionSelectByTicket(position_id)` true → not closed yet); or require `HistorySelectByPosition` + position absence before sending. Only the final deal (position fully gone) should journal the close. For netting accounts, an `INOUT` position that still exists should likewise be deferred.

### 2.4 MEDIUM — UI/health perception issues

- `Mt5LiveView.tsx` maps health with contact-age thresholds (10 s / 60 s) and `classifyMt5SyncHealth` uses 15/60/300 s; the EA can be alive and backing off while the UI says “MT5 offline”. Add an EA `ping` while in backoff (after 60 s of failures) so `touchMt5Connection` (RPC `gj_touch_mt5_connection`, migration `0019`) keeps `lastContactAt` fresh and the badge can show “degraded/retrying” with `lastErrorMessage`.
- Failure diag exists but the user-visible MT5 Live card only surfaces `lastErrorCode/message` indirectly; show `connection.lastErrorMessage` + `syncHealth.message` prominently (they already exist in the payload — UI currently reads only label/state, lines ~284, 357).
- Ingest rate limit is 5 req/s per key (`mt5Ingest.ts:107`); EA timer (3 s) sends up to 3 requests plus deal-triggered bursts — generally fine, but during full replays the history batch is 1/tick; OK. No change needed, but if `SyncSeconds < 3` is entered (`MathMax(3,…)` protects the timer only; WebRequest cadence can still exceed 5/s briefly → 429 retryable).

### 2.5 MEDIUM — `open_batch` > 200 positions breaks grid/hedge accounts

- Server RPC rejects any open batch > 200 (`0016` `gj_sync_mt5_open_batch`), but the EA sends **all** open positions in one unbounded payload (`SendOpenPositions()`). Accounts with > 200 open positions fail forever; error classifies as generic `SYNC_UNAVAILABLE` (503) → transient retries forever, positions never sync.
**Fix:** chunk open positions like history (≤ 200 per payload), and return a distinct `OPEN_BATCH_TOO_LARGE` code rather than a generic one.

### 2.6 LOW — one bad history row aborts the whole batch

- `gj_sync_mt5_history_batch` (`0011`) wraps `gj_sync_mt5_position` per row in one transaction — a single bad row rolls back all 50 valid closes and the EA re-sends the same failing batch forever (cursor never advances; `recordMt5HistoryFailure` marks FAILED each tick).
**Fix:** per-row `begin/exception … continue` + return skipped ids/codes; EA should drop the offending ticket after N failures (or server tells it the index).

---

## 3. AI Analysis / AI Mentor / Risk Coach — why AI “never analyzes” or errors/timeouts

### Architecture (as built)
`analysis.ai` (goldRouter ~161–181) and `mt5.riskCoach` (~226–240):
1. Rate limit (analysis **3 / 10 min**, risk coach **6 / 10 min**) → deterministic calc → check vault (`analysis.config`) → `queueAnalysisJob/RiskCoachJob` (insert `gj_ai_jobs` QUEUED, sha-256 dispatch token) → `dispatchAiJob()` → return `{…, ai/coach:{pending:true, jobId}}`.
2. Client polls `aiJobs.status` every 1.5 s while QUEUED/RUNNING and reads `result` on COMPLETED (MentorView + RiskCalculatorPanel in `GoldJournal.tsx`, `AnalysisDashboard.tsx`).
3. Netlify Background Function `/.netlify/functions/ai-job-worker` claims (QUEUED→RUNNING with token), runs `runAiJob` (server/aiJobs.ts) → OpenRouter → `completeJob` (or `failJob`).

### 3.1 CRITICAL (env-dependent) — dispatch has a silent “never runs” path on serverless

`server/aiJobs.ts`:
- `workerOrigin()` (30–34): `AI_JOB_WORKER_BASE_URL || URL || DEPLOY_PRIME_URL`. 
- If no origin:
  - `allowInlineWorkerFallback()` (36–41) = `AI_JOB_INLINE_FALLBACK` env, else **`NODE_ENV !== "production"`**.
  - **Netlify does not set `NODE_ENV` by default** (docs: build system leaves it undefined unless you define it). If `URL`/`DEPLOY_PRIME_URL` are also absent (or stripped in some host), the code takes the **inline `setTimeout` fallback inside the API function** (43–46, 54–56). In a serverless function the sandbox is frozen right after the response — the deferred job never actually runs, the row stays **QUEUED/RUNNING**, and every UI polls “Analyzing in background…” forever. This exactly matches “AI analyze hi nahi karta”.
  - If `NODE_ENV === "production"` and no origin → throws “AI background processing is unavailable on this deployment.” every run (deterministic-only).
- Netlify’s documented behavior for `config.background: true` (ai-job-worker.ts:14) is: **platform immediately answers 202, then runs the function in the background up to 15 min; the function’s own Response is discarded**. The worker returns 204 (line 11) and `dispatchAiJob` requires exactly 202 (line 61) — consistent *on Netlify*, but broken on any host that ignores `background` (dev CLI without bg support, other platforms, direct invocation): the caller then waits the full AI duration and aborts at 10 s (`AbortSignal.timeout(10_000)`), throwing “could not be started” while the job may complete afterwards or stay RUNNING.

**Fix:**
1. Set explicitly in Netlify: `NODE_ENV=production` **and** `AI_JOB_WORKER_BASE_URL=https://<your-site>` so the fetch path is deterministic. (Or in code: only allow inline fallback when a real long-running process is proven, e.g. `AI_INLINE_WORKER=true` set by `pnpm dev`.)
2. On dispatch failure, **still return the queued `jobId`** (instead of `failQueuedAiJob` + throw), so the client can poll and display the real failure message from `aiJobs.status`.
3. Add a **lease/reaper**: any job QUEUED/RUNNING older than N minutes (no heartbeat) → FAILED with “worker did not start”; the client should stop polling after the lease and show retry guidance. There is currently no such timeout anywhere.
4. Accept `200/202/204` from the worker endpoint to be host-agnostic.

### 3.2 HIGH — AI number grounding is too strict → good answers rejected as “temporarily unavailable”

`server/analysisAi.ts`:
- `allowedNumbers()` (line 60): allowed = raw numbers in the compact prompt, `Number(x.toFixed(2))`, and `Math.round(x)`.
- `hasOnlyGroundedNumbers()` (61) + line 73: every number in the model’s JSON must exactly equal one of those.
- A model that writes a **1-decimal or truncated** value (e.g. `62.3` instead of raw `62.345678…`, `3.4` for `3.37`, or recomputed percentages) fails → `throw "OpenRouter returned an ungrounded numerical claim"` → catch → `{available:false, message:"AI analysis temporarily unavailable…"}`.
- `validateEvidenceReport` (62, 74) additionally requires exact equality of `sample/wins/losses/expectancy/…` per evidence row (only expectancy has a 1e-4 epsilon).
- Consequences: token money is spent, user sees “temporarily unavailable”, retries burn the 3-per-10-min limit; small/cheap models (the default `openai/gpt-4o-mini`) fail most often. This is likely the #1 reason the user experiences “AI error aa jata hai” even when the key and dispatch are healthy.

**Fix:** allow rounding to 1–2 significant decimals (match within `1e-2` or accept `toFixed(1)`/`toFixed(3)`), relax exact-equality for derived statistics, and/or do one automatic re-prompt with the exact error text before giving up. Consider validating only *semantic* grounding (ratios/percentages within tolerance of the source row).

### 3.3 MEDIUM — timeouts & limits create “timeout” UX

- `resolveAiTimeoutMs()` caps at `DEFAULT_AI_TIMEOUT_MS = 120 s` and **clamps env overrides to 120 s** (`analysisAi.ts`), same for risk coach (120 s). OpenRouter with long analysis contexts routinely exceeds 120 s → `"AI analysis timed out after 120 seconds"` and the quota is consumed. Since Netlify Background Functions allow 15 min, raise the cap (e.g., 300–600 s) via env.
- Analysis re-runs the deterministic DB scan **twice** (once in the mutation to return the deterministic view, once inside the worker before calling AI) — for 10k-trade journals this adds many seconds before the OpenRouter call starts; client then perceives “hang” on top of the AI time. Optionally reuse the mutation-computed fingerprint/payload.
- The `analysis.ai` mutation consumes the rate limit *before* dispatch succeeds; failed dispatches + retries quickly produce “AI analysis limit reached” (TOO_MANY_REQUESTS), which is confusing when nothing was ever analyzed. (See 3.1 fix #2.)
- `server/rateLimit.ts`: when the shared Supabase limiter RPC errors, `consumeRateLimit` **fails closed** with `false` → same “limit reached” message although the user never exceeded it. Distinguish limiter-unavailable (allow-through with log, or a distinct message).

### 3.4 MEDIUM — model name is never validated; wrong model → silent “temporarily unavailable”

- `UserAiProviderSettings.tsx` saves any non-empty model string; `test` only calls `GET /api/v1/key` (server/userAiProviderVault.ts `testUserAiCredential`), never validates the model.
- A mistyped/non-OpenRouter model id → OpenRouter 404 → “AI analysis temporarily unavailable” with no hint. 
**Fix:** validate the model during save with `GET /api/v1/models` (or a 1-token chat completion), and surface the provider’s error text in the job result message when available.

### 3.5 MEDIUM — key vault master key falls back to `SUPABASE_SERVICE_ROLE_KEY`

`server/userAiProviderVault.ts`: `vaultSecret()` = `AI_KEY_ENCRYPTION_SECRET || SUPABASE_SERVICE_ROLE_KEY`.
- If only the service-role key is set, saving works, but **rotating the Supabase service-role key makes every stored key undecryptable** → AI errors “Your saved AI key could not be unlocked” until the user replaces it in Options.
- `.env.example` still documents legacy `OPENROUTER_API_KEY/OPENROUTER_MODEL/OPENROUTER_FALLBACK_MODEL` which **no code reads anymore**, and does not document `AI_KEY_ENCRYPTION_SECRET`/`AI_JOB_WORKER_BASE_URL` — prime source of deployment misconfiguration.
**Fix:** always require/dedicate `AI_KEY_ENCRYPTION_SECRET` in production, document it, and remove the legacy env names (README still references them too).

### 3.6 LOW — client polling edge cases

- Poll loop has no max duration; a RUNNING job that will never finish (3.1) keeps the button disabled forever with “Analyzing in background…” — add elapsed-time + lease stop + “Check back / retry” (jobId can be persisted so a later page view can still read COMPLETED).
- In `MentorView`/`RiskCalculatorPanel`, when a job ends FAILED the mutation data (`ai.pending:true`) is still used as the fallback outcome — logic does show `job.data.message` for FAILED, but only while the status query is mounted; navigating away and back loses the message (jobId is local state). Persist jobId per account (sessionStorage) and surface the FAILED message when re-opening.

---

## 4. Server/tRPC correctness issues found on the pass

1. **`journal.get` / `trades.list` pre-sync storm (PERF, high impact)** — `goldRouter.ts:152–155` and `285–289` call `syncStoredMt5PositionsToTradeLog` (mt5Db.ts:274–292) **on every call**, and GoldJournal polls `journal.get` + `trades.list` **every 2.5 s** in the trades view (GoldJournal.tsx 437–471). The sync loops up to 500 stored positions and issues a **separate `INSERT … ON CONFLICT` HTTP round-trip per row** with no “already journaled?” check (mt5Db.ts 233–271). With even 100 stored MT5 rows that is ~200+ Supabase requests per 5 s — query latency can exceed the client’s **15 s default tRPC timeout** (`client/src/lib/trpcFetch.ts` `API_REQUEST_TIMEOUT_MS`), producing “The API request timed out” on the main journal/trades screen (feels like a session hang), plus Postgres/PostgREST load and the “MT5 pre-sync degraded” warnings.
   **Fix:** single bulk SQL/RPC upsert (already have batch RPCs for MT5 — reuse the same shape for trade log sync), pre-filter with one `SELECT mt5Ticket` of existing trades, and only sync when `view === 'mt5'` or on MT5 data invalidation, not on a 2.5 s poll.
2. **Deleted OPEN/MT5 rows resurrect** — deleting a journal row whose `mt5LivePositions` row still exists is undone by the next pre-sync (result forced back to OPEN with floating P&L). Editing an OPEN ticket row also gets partially overwritten (tradeDate/session/result/pnl/openTime/closeTime) by the next sync. Either block delete/edit on `result === 'OPEN'` rows with a clear message or mark them system-owned.
3. **`trades.create`/`cash.create` replay paths** return early with `replayed:true` without validating that the stored payload matches — acceptable for idempotency but combined with (2) duplicates may be created when the original insert failed after commit; low.
4. **MT5 ticket linking on manual create/update** requires the position to be CLOSED in `gj_mt5_live_positions`; but because the pre-sync already journals closed rows automatically, the “journal now” path for *stale OPEN* rows (symptom §2.2) can’t be used by the user as a manual workaround — add a repair action that reconciles an OPEN row from a known terminal close or fetches the specific deal.
5. **Rate-limit identities**: screenshot/goal-alert limits keyed by numeric user id — fine.
6. **`nNotifications` goal-alert re-fire**: GoldJournal effect re-sends `recordGoalAlerts` on each journal poll when the goal remains AT_RISK (payload memo changes with each 2.5 s poll). DB unique `(userId, type)` (migration 0006) dedupes inserts, but the procedure runs every poll — cheap but wasteful; gate by “not attempted in this cycle” flag.
7. **`syncTradeLog`** (`goldRouter.ts:242`) has no rate limit and re-upserts everything — same per-row issue as (1); a user clicking “Journal now” repeatedly hammers the DB.

## 5. Auth/session notes (your “session ka” mention)

- Supabase browser client (`client/src/lib/supabase.ts`) persists sessions with auto refresh; tokens are attached as `Authorization: Bearer` per tRPC call (`client/src/lib/authSession.ts`), with 5 s session lookup race and 10 s bootstrap timeout — reasonable.
- If a token refresh fails while the app is idle (network), `useAuth` sets status `error` only on bootstrap; the tRPC calls then receive 401 UNAUTHORIZED from `protectedProcedure` — UI usually treats this as needing sign-in. Since AI jobs can run for minutes, **an expired access token does not affect the job** (server side uses service role), but the **poll** `aiJobs.status` is user-authenticated — a refresh failure during a long job stops the poll and the UI can look frozen. Consider allowing `aiJobs.status` to be fetched when the session is merely stale or auto-retrying once after `refreshSession()`.
- Server never revokes tokens on logout (client-only) — fine for this app size, but note it.
- No CSRF risk: bearer tokens in memory via supabase-js (localStorage default) — acceptable; not a bug found.

## 6. Client-side/UI issues noticed (non-MT5/AI)

- `GoldJournal.tsx` journals poll at 2.5 s and `journal.get` returns up to 500 trades + 10k goal trades each poll; with screenshots omitted this is fine, but with the pre-sync (see §4.1) the whole main view can stall.
- `AnalysisDashboard` AI panel: mutation error renders *after* an `aiPending` block; when `analysis.ai` returns pending but dispatch later fails server-side the mutation throws and `aiMutation.error` shows the raw message — good, but no auto-retry or rate-limit countdown.
- Screenshot upload accepts 7 MB base64 then rejects > 5 MB decoded — fine, but base64 in JSON means a 5 MB image inflates to ~6.7 MB payload — Express tRPC body limit 10 MB is fine.
- `TradeLogWithViewer` renders OPEN rows with the same table style as closed; consider a clear “LIVE” row badge so users instantly see which rows are still open (already exists in the MT5 live strip only).
- Minor: `AnalysisDashboard` compare table uses `previousStart/previousEnd` states that are not cleared by `clearFilters` (compareEnabled=false but dates remain) — cosmetic.
- ErrorBoundary exists at app root; unknown navigation falls to NotFound — fine.

## 7. Immediate priority fix list (suggested order)

1. EA: never permanently stop on 422; keep heartbeat alive; make quick-history sweep cover the period since last successful sync; skip still-open positions in close collection (§2.1–2.3).
2. AI dispatch: force background path with explicit env (`AI_JOB_WORKER_BASE_URL`, `NODE_ENV=production`); return jobId on dispatch failure; add job lease/reaper + client max-poll; accept 200/202/204 (§3.1).
3. AI validation: numeric grounding tolerance + re-prompt fallback; raise timeout cap; validate model on save (§3.2–3.4).
4. Server: single-statement bulk pre-sync + existence pre-filter; stop per-row upserts on 2.5 s polls (§4.1).
5. Reconciliation of missing open positions in open-batch RPC (2-batch rule) (§2.2 server fix).
6. Docs/env: fix `.env.example` and README (remove legacy `OPENROUTER_API_KEY`/`_MODEL`; document `AI_KEY_ENCRYPTION_SECRET`, `AI_JOB_WORKER_BASE_URL`) (§3.5).

## 8. Verification checklist for the deployed site

- [ ] `NODE_ENV` set (and = `production`) in Netlify env.
- [ ] `AI_JOB_WORKER_BASE_URL` set to the site root, or confirm `URL` exists in the **functions** runtime (deploy log/console).
- [ ] Netlify plan supports Background Functions (immediate-202 contract). Test: `curl -i -X POST https://<site>/.netlify/functions/ai-job-worker` with a dummy body → expect **202** fast.
- [ ] `AI_KEY_ENCRYPTION_SECRET` set (stable, backed up).
- [ ] Save key + model `openai/gpt-4o-mini` (or better) in Options → Test key → Analyze; watch Netlify function logs for `[ai-job]` lines.
- [ ] Supabase migrations 0001–0020 applied (folder has 20; README still says 0017 — docs drift).

---

## 9. Fix status — implemented 2026-09-09 (this branch)

The following code fixes from this audit were implemented, type-checked (`tsc --noEmit` clean) and covered by the test suite (306 passed; the only excluded file, `PnlCalendarWithWeeks.test.tsx`, fails on the pristine tree too — sandbox timezone artifact, unrelated):

**EA `client/public/GoldJournal_EA.mq5` → 2.13**
- [x] §2.1 — Only 401/403 (key retired) and 404/405 (endpoint) permanently stop the bridge (`g_api_rejected` / `g_endpoint_rejected`); 400/410/**422** and other server rejections are now transient with bounded backoff, and the server `code` (e.g. `FUTURE_TRADE`) is printed with a UTC-offset hint. Heartbeats never die on one bad position again.
- [x] §2.2 — Incremental close sweep now starts from `g_last_history_sync` (capped by the history window) instead of a fixed last-1-hour window, so a close missed while offline/backing-off is collected on the next contact instead of re-arming the 24 h replay gate. Deal-triggered syncs are debounced per position (multi-deal closes, stop-outs) instead of restarting the sweep.
- [x] EA version marker bumped (`#property version "2.13"`, `EA_VERSION 2.13.0`).

**Server**
- [x] §3.1 — AI dispatch: inline fallback is no longer auto-enabled by an unset `NODE_ENV` (Netlify default) — opt-in only (`AI_JOB_INLINE_FALLBACK=true`); dispatch failures now return a pollable FAILED outcome with an actionable message instead of throwing and burning the rate limit; `aiJobs.status` adds a lease: QUEUED > 2 min or RUNNING > 16 min is expired to FAILED, so the UI always reaches a terminal state.
- [x] §3.2 — AI number grounding is tolerant (±2% relative / ±0.5 absolute, accepts 1-decimal rounding) — capable model answers are no longer rejected as “temporarily unavailable”; hallucination tests still pass.
- [x] §3.3 — AI/Risk-Coach timeout cap raised 120 s → 14 min (background functions may run 15 min); env override respected up to that cap. Default remains 120 s.
- [x] §3.5 — `.env.example` + README now document `AI_KEY_ENCRYPTION_SECRET`, `AI_JOB_WORKER_BASE_URL`, `NODE_ENV=production`, `AI_JOB_INLINE_FALLBACK`, and remove the dead `OPENROUTER_API_KEY/MODEL/FALLBACK_MODEL` entries; migration count corrected to `0001–0020`.
- [x] §4.1 — `syncStoredMt5PositionsToTradeLog` now prefilters rows already present in the Trade Log with a single batched read and only writes changed rows (was: one Supabase insert/upsert round-trip per stored position on every 2.5 s poll).
- [x] §3.4 — Saved model name from the vault is used for the `pending` outcome so the UI shows the actual model; the risk-coach path reads the credential consistently.

**Still open (needs deployment-side or follow-up work)**
- [ ] Re-run Supabase migrations 0001–0020 and set the Netlify env (`NODE_ENV=production`, `AI_KEY_ENCRYPTION_SECRET`, `AI_JOB_WORKER_BASE_URL`, `SUPABASE_*`) — the AI fixes require these env vars to take effect.
- [ ] §2.2 server reconciliation (close OPEN rows missing from two consecutive authoritative open batches) — SQL migration candidate; EA fix already bounds the stale window to “until next contact”.
- [ ] §2.3 partial-close handling: EA still journals a full close for a partial exit (server treats CLOSED as terminal); deferred for a dedicated follow-up.
- [ ] §2.5 open batches > 200 positions on grid/hedge accounts (chunking in EA) — deferred.
- [ ] `PnlCalendarWithWeeks.test.tsx` fails in this sandbox only (timezone-dependent, fails on pristine tree) — unrelated to these changes.
