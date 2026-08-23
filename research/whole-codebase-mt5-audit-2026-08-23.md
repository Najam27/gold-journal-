# Whole-Codebase MT5 Live Audit

**Scope:** audited tracked executable client, server, Netlify, Supabase migration, PWA, EA, shared-library, configuration, and test paths on 2026-08-23. The repository contains 161 client-source files, 75 server files, 18 Supabase migrations, 7 audit/build scripts, 11 shared-library files, and 2 Netlify function files.

## Production-Path Findings

| Boundary | Source result | Conclusion |
|---|---|---|
| PWA | `sw.js` bypasses `/api/` and `/storage/`; it caches only successful same-origin static script/style/image/font responses. | A stale service-worker API response cannot keep MT5 Live disconnected or hide history. |
| Frontend session | `main.tsx` obtains a current Supabase access token for every tRPC batch; `authSession.ts` bounds lookup to five seconds; `GoldJournal.tsx` reconciles the selected account against owned accounts before enabling MT5 queries. | No hidden frontend session fallback or stale selected-account request path was found. |
| Netlify ingress | `netlify/functions/api.ts` mounts raw MT5 JSON parsing before the MT5 ingest route, mounts tRPC separately, and returns bounded JSON for malformed/payload-too-large requests. | MT5 and tRPC do not compete for the same body parser or route handler. |
| Supabase persistence | `mt5Db.ts` authenticates the key before routing, writes contact immediately, persists summary/open/history through account-scoped operations, and reports safe categorized failures. | A successful EA response necessarily refers to the authenticated connection/account; account routing is not supplied by the EA payload. |
| Owner integrity | `getMt5Workspace()` and API-key lookup canonicalize a legacy connection owner. `getMt5Integrity()` previously retained a stale `userId + accountId` filter. | Fixed in this release so all workspace, health, and ingress reads share account-scoped canonical ownership. |
| EA history | EA v2.9 synchronously sent every historical batch in one `SendHistory()` call and stopped the entire scan on one unreconstructable historic position. | This was a real backfill reliability defect: large histories could hit request bursts/rate limits and one malformed legacy position could block all later records. |

## Corrected EA v2.10 Contract

EA v2.10 sends exactly one bounded 50-position history batch per timer cycle. It stores a cursor and resume mode, preserves the cursor after a transient HTTP failure, and marks `complete: true` only after the final batch has been accepted. A historic position that cannot be reconstructed is explicitly logged and skipped; later valid positions continue. This removes a batch-burst path and prevents a single bad record from blocking the complete history backfill.

The EA remains strictly read-only: it has no order-send, order-modify, order-close, order-delete, position-modify, or trade-library calls. MT5 WebRequest remains the only outbound operation.

## Tests and Validation

The focused EA, history-contract, owner-integrity, health, ingest, and route suites passed after the change. The full suite completed with 83 passing test files and 285 passing tests; one environment-dependent suite and two tests remain intentionally skipped. TypeScript, production build, migration-source audit, service-worker syntax, and whitespace validation all passed.

## Remaining Runtime Boundary

The source audit cannot read a trader's one-time key stored in a local MT5 terminal. After a key is replaced or rotated, the previous key is intentionally invalid and the current connection remains `WAITING` until the current one-time key produces a request. EA v2.10 now reports an explicit HTTP 401 if that key is invalid, and reports individual history-batch progress/completion after authentication succeeds.
