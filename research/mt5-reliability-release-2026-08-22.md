# Gold Journal MT5 Reliability Release

**Author:** Manus AI  
**Date:** 2026-08-22  
**Scope:** MT5 Live snapshot reliability, connection lifecycle reporting, open-position concurrency, Expert Advisor recovery, and native control readability.

## Executive Summary

The audit found that a working MT5 history stream could continue to journal closed trades while the **private connection record** or the **live account-summary state** was unavailable. The previous MT5 Live screen could only infer state from `lastPing`, so it could falsely conflate a missing private connection with a stale live snapshot. In addition, an `open_batch` performed one database transaction per position, which amplified account-row locking under concurrent history and live-position traffic.

This release adds additive MT5 lifecycle fields, atomic open-position batch persistence, user-safe diagnostics, structured server logs, bounded EA retry/backoff, and explicit frontend states. Historical positions and Trade Log records are not deleted or rewritten. The Supabase migration `0016_mt5_live_reliability.sql` must be applied before the new diagnostics and atomic batch RPC are used in production.

## Root Cause Analysis

| Evidence source | Finding | Effect before this release |
|---|---|---|
| `server/mt5Ingest.ts` | History, open, and summary events shared authentication but stored different facts. A successful history batch could therefore journal trades independently of whether a summary was later stored. | Trade Log could be correct while MT5 Live lacked balance, equity, or a visible connection state. |
| `server/mt5Db.ts` | The active connection lookup returns `null` only when the authenticated private record is absent or inactive. Connection deletion remains an explicit protected user mutation in `server/goldRouter.ts`. | A missing record was a real lifecycle issue, not proof that historical trades should be removed. |
| `server/mt5Reliability.ts` | Prior health was derived largely from `lastPing`. It did not retain distinct timestamps for terminal contact, successful summary persistence, successful open sync, and event failures. | The UI could not explain “terminal contacted the app, but summary persistence failed.” |
| `server/mt5Ingest.ts` and `server/mt5Db.ts` | An `open_batch` loop invoked a transaction once per position. | More lock contention and more chances for a partially processed batch under live/history overlap. |
| `client/public/GoldJournal_EA.mq5` | The EA logged failures but had no bounded exponential retry window or permanent-error stop. | Temporary 503/timeout responses could repeatedly fail at the normal cadence; permanent errors could be retried indefinitely. |

## Changes Made

| File | Change |
|---|---|
| `supabase/migrations/0016_mt5_live_reliability.sql` | Adds lifecycle timestamps, safe diagnostic fields, a health index, atomic failure recording, and `gj_sync_mt5_open_batch`. The migration is additive and does not delete MT5 or Trade Log data. |
| `drizzle/schema.ts` | Adds matching connection fields and a health index declaration. |
| `server/atomicOperations.ts` | Adds service-role calls for atomic open-position batch synchronization and atomic event-failure diagnostics. |
| `server/mt5Db.ts` | Separates terminal contact from summary/open success, records bounded safe failures, and sends open positions in one atomic batch. |
| `server/mt5Ingest.ts` | Adds structured, secret-free operational logs with connection ID, account ID, operation, duration, result, batch size, accepted count, and safe error code. Summary, open, and history failures are independently classified. |
| `server/mt5Reliability.ts` | Adds `MISSING`, `CONNECTED`, `DEGRADED`, `STALE`, and `OFFLINE` lifecycle states. A stale contact never means the record was deleted. |
| `client/src/components/Mt5LiveView.tsx` | Displays last snapshot, last terminal contact, degraded reasons, and missing-record recovery guidance. Removes redundant integrity polling from the MT5 Live page. |
| `client/public/GoldJournal_EA.mq5` | Delivers EA v2.4 with bounded transient backoff for timeout/429/502/503/504 cases, recovery logging, and a permanent-rejection stop. It never logs the API key. |
| `client/src/theme-repair.css`, `client/src/mt5-live.css` | Applies semantic select focus and option colors plus readable degraded status styling in light and dark modes. |
| `client/public/sw.js` | Advances the static cache to `v20` so installed clients can activate this release. |

## Database and Security Properties

The new `gj_sync_mt5_open_batch` function accepts no more than 200 positions, locks the account row once, validates that every payload remains `OPEN`, and calls the existing terminal-state-aware position synchronization function. `gj_record_mt5_event_failure` atomically increments a failure counter without exposing error details to browser roles. Both functions are `security definer`, use `set search_path = public`, revoke public/anonymous/authenticated execution, and grant execution only to `service_role`.

The MT5 endpoint still derives the owner and journal account only from the authenticated connection API key. It does not trust a client-supplied account identifier. Explicit connection deletion remains the only normal record-deletion route, and no migration drops, truncates, or clears historic MT5 positions or Trade Log rows.

## Frontend Lifecycle Semantics

| State | Meaning shown to the user |
|---|---|
| **CONNECTED** | MT5 terminal contact and successful snapshot persistence are current. |
| **DEGRADED** | The terminal contacted Gold Journal, but the account snapshot has not been stored recently or the latest summary failed. |
| **STALE** | The last terminal contact is older than one minute; the private connection remains active. |
| **OFFLINE** | The last terminal contact is older than five minutes; the private connection remains active while the terminal/network is checked. |
| **MISSING** | No active private MT5 connection record exists for the selected journal account. Reconnect is required; existing journaled history remains safe. |

## Validation Results

| Validation | Result |
|---|---|
| TypeScript | Passed. |
| Full automated suite | **81 test files passed, 260 tests passed; 1 integration suite intentionally skipped, 2 tests skipped.** |
| MT5-focused tests | Passed, including summary failure diagnostics, open-batch atomicity, closed-trade terminality, same-ticket account isolation, health states, UI health output, and EA retry contract. |
| Production build | Passed. Vite reported the pre-existing large-chunk advisory; it is not a build failure. |
| Migration source audit | Passed for migrations `0001` through `0016`. |
| Service-worker syntax | Passed. |
| Whitespace/diff check | Passed. |

## Production Verification and Remaining Boundaries

The code and automated behavior have been validated locally. The deployment cannot be declared operational until the site owner applies migration `0016_mt5_live_reliability.sql`, deploys this commit, and replaces the installed EA with v2.4.

The following runtime checks still require the real Netlify and Supabase environment: a live 10–15 minute terminal session, a controlled transient database or 503 event, and confirmation that Netlify function logs emit the new structured MT5 entries. No production database logs or Netlify function logs were available in this environment, so this report does not claim that live operational test has already been observed.

## Deployment and Acceptance Checklist

1. Apply `supabase/migrations/0016_mt5_live_reliability.sql` in Supabase SQL Editor after migrations `0001`–`0015`.
2. Deploy the commit to Netlify, then update the service worker when prompted.
3. Download **Gold Journal EA v2.4**, replace the old file in the MT5 `MQL5/Experts` directory, refresh Navigator, and reattach it to one chart.
4. Use the same endpoint and the active connection’s API key. Confirm the MT5 Expert log displays success or a bounded retry status, never the raw key.
5. Confirm MT5 Live shows a connection card, current snapshot, balance, equity, floating P&L, free margin, and open positions.
6. Confirm a short internet interruption becomes **STALE** or **OFFLINE**, while the connection card remains. Once connectivity returns, confirm **CONNECTED** and a fresh snapshot.
7. Confirm an open position reaches MT5 Live and the Trade Log, then a close becomes terminal and does not reopen after delayed packets.
8. Toggle light and dark mode and check native account, broker-offset, and Options dropdowns before relying on the release.
