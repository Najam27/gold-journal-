# Gold Journal MT5 System Production Audit

**Audit target:** `https://github.com/Najam27/gold-journal-`
**Audit scope:** MT5 EA + MT5 ingest backend + Supabase schema/migrations + MT5 Live frontend state + synchronization semantics
**Reading date:** 2026-09-14
**Current EA version:** 2.16 (public template `client/public/GoldJournal_EA.mq5`)

This audit was performed as a single comprehensive review of the current MT5 pipeline. It is intentionally broader than the most recent EA hardening commit: that commit fixed a few local control-flow and cohesion issues; this report covers the whole stack against the full hardening checklist the user supplied.

---

## TL;DR

The current MT5 system is one of the most deliberately hardened read-only MT5 bridges I have reviewed. The weakest parts are not in the protocol itself; they are in **operational and audit-surface gaps**:

- The user-facing hardening story exists, but there is no running end-to-end regression harness for the lifecycle scenarios.
- Several defensive server code paths have tests that exist in files but were not executed in this session.
- Key-rotation UX recovered from the previous report is sound, but the browser flow still says “restart the EA once” in several places.
- There are still no application-level server tests for the actual positional lifecycle semantics (partial close, multiple partial closes, netting reversal, hedging, multi-entry, offline closes, duplicate payloads, rejected records, cursor failure).
- The app repo is not yet on Bun, even though the Freebuff infra it runs in (dev server, preview, deploy) may be optimized for Bun-based tooling.

Everything below is actionable and prioritized.

---

## What I verified in this session

1. **MT5 EA template** — `client/public/GoldJournal_EA.mq5`
   - read in full
2. **MT5 ingestion server** — `server/mt5Ingest.ts`
   - read in full
3. **MT5 HTTP adapter** — `server/mt5Http.ts`
   - read in full
4. **MT5 download/render path** — `server/mt5EaDownload.ts`, `server/mt5EaCore.ts`, `server/mt5Security.ts`
   - read in full
5. **MT5 database layer** — `server/mt5Db.ts`
   - read in full
6. **MT5 reliability classification** — `server/mt5Reliability.ts`
   - read in full
7. **MT5 route safety tests** — `server/mt5Route.test.ts`
   - read in full
8. **MT5 sync hardening contract tests** — `server/mt5SyncHardening.test.ts`
   - read in full
9. **Supabase schema and migrations** — `drizzle/schema.ts` plus a broad set of `supabase/migrations/*.sql`
   - `0001`, `0002`, `0004`, `0005`, `0006`, `0007`, `0008`, `0010`, `0011`, `0012`, `0013`, `0016`, `0017`, `0018`, `0019`, `0020`, `0021`, `0022` plus `supabase/verify_production_mt5_contract.sql`
10. **MT5 Live frontend** — `client/src/components/Mt5LiveView.tsx`
    - read in full
11. **Repo status and history** — `git status`, `git diff`, `git log`
    - reviewed

I did **not** run typechecks, tests, build, Supabase migrations, or preview in this session. That is stage 2.

---

## Architecture summary

The current MT5 design is:

- **EA (read-only)** sends:
  - `compat`
  - `ping`
  - `summary`
  - `open_batch`
  - `close`
  - `history_batch`
- API key is the sole credential and routing authority.
- Server derives `connectionReference` and `dataSourceReference` internally.
- Backend:
  - authenticates via `getActiveMt5Connection`
  - classifies failures
  - applies atomic Supabase RPCs where possible
  - returns a single HTTP response contract the EA already understands
- Live state is reconstructed from `gj_mt5_connections` + `gj_mt5_live_positions` + `gj_trades`.
- MT5 Live view polls workspace + history every ~2.5s and renders separate stream freshness for heartbeat / open sync / summary / history.

This is a good architecture for the stated goal: *temporary failures may make data stale, but they should not permanently kill the EA or corrupt the trade lifecycle.*

---

## Audit findings

### CRITICAL

These are the issues that most directly threaten the user’s acceptance checklist or future scalability.

#### 1. No running end-to-end lifecycle regression harness for the full checklist.

- **File(s):** repo-wide; strongest near-term target is `server/mt5SyncHardening.test.ts` and `tests/`-style server suites; frontend side is `client/src/components/Mt5LiveView.tsx`.
- **Root cause:** The user’s checklist asks for 30+ lifecycle tests, but the repo currently proves the contract around payload parsing, chunking, timestamp normalization, config/auth classification, and key-history semantics. It does not currently provide a single harness that:
  - simulates full open → update → partial close → multiple partial closes → final close
  - simulates offline close / offline open / offline partial close recovery
  - simulates 201+ open positions
  - simulates one malformed history ticket
  - simulates duplicate payloads being idempotent
  - simulates server 500/502/503/504/429 with EA recovery
  - simulates EA restart / MT5 restart / VPS restart reconstruction
  - simulates key rotation behavior across connection state and history preservation
- **Impact:** High. Without these tests, the current architecture can look correct in code review and still hide lifecycle regressions, especially around partial closes and cursor/replay decisions.
- **Fix:** Add a server-side MT5 lifecycle test suite that exercises `processMt5Payload` / `upsertMt5ClosedPositionBatch` / `upsertMt5OpenPositionBatch` with a real or mocked Supabase path and explicit assertions for:
  - position status transitions
  - no duplicate trade rows
  - no reopening a CLOSED lifecycle
  - partial close stays OPEN
  - multiple partial closes stay OPEN until final close
  - netting reversal semantics
  - hedging tickets staying independent
  - multi-entry weighted position reconstruction acceptance criteria
  - malformed record rejection does not block valid records
  - duplicate payload does not create duplicate rows
  - 201+ open positions are chunked and processed
- For the frontend side, add at least one lifecycle view test that proves the browser can refresh without resetting the apparent MT5 connection state and that stream labels reflect the backend semantics, not a generic “disconnected” message.
- **Regression risk:** Medium. The risk is mainly in writing tests that accidentally assert current behavior too narrowly; lifecycle tests should assert final database invariants, not intermediate EA chatter.

#### 2. Server does not currently assert positional lifecycle semantics in tests.

- **File(s):** `server/mt5SyncHardening.test.ts`, `server/mt5Ingest.ts`, `server/mt5Db.ts`, Supabase RPC `gj_sync_mt5_position`, `gj_sync_mt5_open_batch`, `gj_sync_mt5_history_batch`.
- **Root cause:** The current tests validate parsing, chunking, key history, version contract, and classification. None of them directly tests the **database RPC behavior** for the hardest lifecycle rules:
  - CLOSED terminal row stays CLOSED
  - OPEN stays OPEN after OUT deal unless terminal position is really gone
  - final close reconstruction
  - partial-close volume handling
  - multi-deal weighted position acceptance
- **Impact:** High for correctness confidence. This is the exact layer where “partial close becomes CLOSED” or “CLOSED becomes OPEN again” would regress.
- **Fix:** Add focused server tests against the actual Supabase-backed RPC path (or a high-fidelity mock of it) with explicit position lifecycle fixtures.
- **Regression risk:** Low to medium, depending on how much mocking is required.

### HIGH

These are real issues, but they do not currently threaten core synchronization correctness the way the Critical items do.

#### 3. Browser still occasionally tells the user to restart the EA after key rotation.

- **File(s):** `client/src/components/Mt5LiveView.tsx`
- **Root cause:** Several UI strings and toast messages still say “restart the EA once” after issuing/replacing a key.
- **Impact:** Medium. The backend and EA design already support key rotation without requiring a restart. The UI should stop implying otherwise. If the product intentionally keeps a restart step as a conservative recommendation, that should be stated explicitly and consistently everywhere, not mixed with “EA keeps probing and resumes automatically” messaging.
- **Fix:** Make post-rotation/new-key instructions consistent and accurate. If the EA truly recovers without restart, say so. If MT5 requires a reload for the new key to take effect on the chart after a replacement, say exactly that without leaving contradictory signals.
- **Regression risk:** Low.

#### 4. No local MT5 lifecycle sandbox or failure-injection environment is visible in repo.

- **File(s):** repo-wide; likely future target would be `scripts/` or `tests/`.
- **Root cause:** The checklist asks for a real failure-injection matrix. The repo has audit/deliverable documents and scripts, but nothing that directly exercises the EA + backend + Supabase path under controlled failure conditions.
- **Impact:** High on confidence, not necessarily on correctness. Without this, it is hard to prove the EA survives the exact sequences described in the checklist.
- **Fix:** Decide whether to build:
  - a local harness that replays payloads into the ingest path with a Supabase test project, or
  - a documented test matrix with mocked responses if a full Supabase-local path is not practical in this environment
- **Regression risk:** Low, if framed as verification tooling rather than production runtime.

#### 5. Repo is not using Bun yet, even though the runtime/platform context may favor it.

- **File(s):** `package.json`, `pnpm-lock.yaml`, any platform config that may assume Bun
- **Root cause:** The project locks a `pnpm` workspace and lockfile today.
- **Impact:** Medium-term. If the environment is moving to Bun-based workflows, the project may want to align. This is not an MT5 correctness issue; it is an operational friction issue.
- **Fix:** Evaluate migration to Bun tooling when the user wants to align the repo with that runtime, and validate that the TS toolchain, test runner, and deploy story still work.
- **Regression risk:** Low if done carefully; higher if done without validating tests/build first.

---

### MEDIUM

#### 6. `FINAL_STATE_INVARIANT` checklist is not yet mechanically enforced.

- **File(s):** repo-wide documentation and test surface
- **Root cause:** The checklist contains a long acceptance matrix, but the repo does not yet have a single artifact that maps each box to an executable assertion.
- **Fix:** Convert the checklist into a living verification matrix in code or in a deliverable file with explicit test/file mappings.
- **Regression risk:** Low.

#### 7. The MT5 Live view could do a more explicit multi-stream failure narrative.

- **File(s):** `client/src/components/Mt5LiveView.tsx`
- **Root cause:** The UI already has multi-stream freshness, but the user-facing copy could make the distinction between “heartbeat healthy, open sync degraded, history healthy” even clearer in edge cases.
- **Fix:** Tighten stream-level explanations and make sure the degraded/stale/offline wording never implies the terminal is down when only one stream is affected.
- **Regression risk:** Low.

#### 8. Timestamp/normalization tests exist, but broader timestamp edge-case coverage could be stronger in the lifecycle suite.

- **File(s):** `server/mt5SyncHardening.test.ts`, `server/mt5Timestamp.ts`
- **Root cause:** Current tests cover invalid broker timestamps reasonably well. Lifecycle tests should also assert behavior around zero timestamps, missing timestamps, future timestamps, and duplicate timestamps in the context of trade reconstruction.
- **Fix:** Add explicit lifecycle-level timestamp assertions.
- **Regression risk:** Low.

#### 9. Key/account isolation is well designed, but should have a direct test for “same key, different account” rejection.

- **File(s):** `server/mt5Ingest.ts`, `server/mt5Security.ts`, `server/mt5Db.ts`
- **Root cause:** The design looks correct: API key is the routing/authority source. Still, a dedicated test for cross-account key usage would make the invariant visible rather than implied.
- **Fix:** Add a test proving that a valid key for one connection cannot write to another account’s positions or trades.
- **Regression risk:** Low.

#### 10. Validation boundary documentation is good, but could be more explicit for consumer-facing error categories.

- **File(s):** `server/mt5Ingest.ts`, `server/mt5Reliability.ts`
- **Root cause:** The server classifies many failure categories internally. Frontend and user-facing diagnostics should stay aligned with those categories so the user sees the same distinction the backend is already making.
- **Fix:** Ensure frontend copy, backend diagnostics, and EA log language all use the same categories: transient network vs auth vs config vs data error.
- **Regression risk:** Low.

---

### LOW

#### 11. A few UI strings are slightly redundant across the MT5 Live guide.

- **File(s):** `client/src/components/Mt5LiveView.tsx`
- **Fix:** Consolidate repeated “restart the EA once” wording and keep it consistent with the underlying recovery model.

#### 12. Some operational docs are dated relative to the current hardening state.

- **File(s):** `deliverables/`, `research/`
- **Fix:** Keep only the artifacts that still reflect the live system. If a doc is a historical record, label it as such. Do not let stale docs argue with current behavior.

---

## EA-level observations

The current EA already implements a lot of what the checklist asks for:

- explicit states
- backoff + jitter
- retry gating
- differential handling of auth and configuration errors
- partial-close protection via `PositionSelectByTicket`
- pending retry queue for unreconstructed closes
- bounded open-position batches
- bounded history batches
- cooldown during multi-batch backfill
- clock-jump guard in `OnTimer`
- incremental vs full replay separation
- `OnTradeTransaction` debounce
- numeric validation before payload generation

The most important EA-level reminder from this audit is **not** that the EA is broken; it is that the same hardening should now be proven by lifecycle tests rather than assumed from code review.

---

## Backend observations

Backend strengths:

- single ingest contract
- separate failure classification
- atomic batch RPCs
- rejected-record reporting
- version contract versioning
- reconciliation feed for heartbeat-driven close recovery
- key history without storing a second live credential
- chunked ticket filters for large accounts

Backend gaps relative to the checklist:

- lifecycle tests described above
- more explicit cross-account rejection assertion
- stronger end-to-end server failure-recovery tests for 500/502/503/504/429/Supabase-outage scenarios

---

## Schema / migration observations

Schema and migrations look strong:

- CLOSED is terminal in `gj_sync_mt5_position`
- unique `(accountId, mt5Ticket)` protects against duplicate journal rows
- atomic open/history batch RPCs
- connection owner repair
- key history without storing secret material
- write-confirmation RPCs for touch/summary
- ticket filter chunking
- bounded batch caps

Migration hygiene note:

- The repo has many additive migrations, which is good. The only thing to watch is ensuring the production migration set is applied in the correct order for the running Supabase project. That is an operations concern, not a schema defect.

---

## Frontend observations

The MT5 Live view is the right shape:

- separate streams
- connection cards
- key creation / rotation / replacement flows
- download endpoint
- WebRequest origin guidance
- refresh without implying EA reset

The main frontend fixes are copy accuracy and lifecycle-state narrative, not architecture.

---

## Final verdict

**Does the MT5 system already meet the spirit of the checklist?** Mostly yes, and in several places better than typical.  
**Can I call it fully production-ready against the full checklist today?** Not yet, because the hardest lifecycle guarantees are protected by design and code review but not yet by a complete executable lifecycle test suite and failure-injection evidence.

That is the honest answer.

---

## Recommended next steps

1. **Short term**
   - Add a server MT5 lifecycle test suite covering the hardest cases.
   - Add one frontend lifecycle assertion for refresh/state consistency.
   - Fix the key-rotation “restart the EA once” messaging so it is consistent everywhere.
2. **Medium term**
   - Add cross-account key rejection test.
   - Add a failure-injection matrix, even if partly mocked.
   - Convert the checklist into a mapped verification artifact.
3. **Operational**
   - Decide whether to migrate to Bun tooling and validate tests/build afterward.
   - Verify whichever Supabase migrations are still pending on the live project.

If you want, I can now either:

- convert this audit into a concrete implementation plan for the lifecycle test suite, or
- execute the highest-value part of it first (most likely the server MT5 lifecycle tests and the cross-account/rejected-record/idempotency assertions).

<!-- AUTO-GENERATED FILE NOTE -->
<!-- This audit was generated for the Gold Journal MT5 hardening discussion. -->
<!-- It is a read-only audit artifact. Edit or replace it if the repo changes materially. -->
