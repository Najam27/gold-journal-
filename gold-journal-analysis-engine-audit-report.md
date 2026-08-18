# Gold Journal Analysis Engine, Trading Edge, and OpenRouter Audit

**Repository:** [Najam27/gold-journal-](https://github.com/Najam27/gold-journal-)

**Scope:** `pasted_content_7.txt`, covering deterministic analytics, evidence quality, Trading Edge ranking, Analysis UI, server-side OpenRouter integration, privacy, failure isolation, performance, testing, and production release readiness.

**Audit status:** **Code-complete and release-gate verified**, subject to live Supabase/Netlify acceptance checks described below.

## Executive summary

The previous Analysis view depended on a small browser-side edge helper and the legacy Mentor path could call OpenRouter directly from the browser with a user-entered key. The repaired architecture moves deterministic analysis to a shared, testable engine and authenticated server procedure, mounts a professional Analysis dashboard, and moves all OpenRouter traffic behind the server. The deterministic path is the source of truth; AI receives compact aggregates only and cannot gate, alter, or create financial records.

The release gate passed with **59 test files and 176 tests**, TypeScript validation, schema-source validation, whitespace validation, and a production Vite/esbuild build. The production bundle now lazy-loads the Analysis dashboard into a separate `38.50 kB` chunk (`5.55 kB` gzip). A remaining main-chunk warning is documented as an existing broader application bundle concern; no claim is made that the final bundle is fully optimized.

## Issue register

| Severity | File / function | Root cause | Root-cause fix | Verification |
| --- | --- | --- | --- | --- |
| **High** | `client/src/pages/GoldJournal.tsx` / legacy `MentorView` | The browser could previously store an OpenRouter key and send raw notes/emotions directly to the provider. | Replaced the Mentor implementation with authenticated `trpc.analysis.ai`; removed browser provider-key storage semantics, changed the privacy notice, and retained deterministic fallback behavior. | `GoldJournal.mentorPrivacy.test.ts`; source scan shows the only OpenRouter call is `server/analysisAi.ts`. |
| **High** | `server/goldRouter.ts` / `analysis.get`, `analysis.ai`, `analysis.compare` | Analysis needed a server authorization boundary and account-scoped data path. | Added protected procedures, application-user/account ownership arguments, a server analysis loader, AI rate limit, and comparison procedure. | `server/analysisRouter.test.ts` covers authentication, account/user propagation, and AI rate-limit rejection. |
| **High** | `server/analysisDb.ts` / `getAccountAnalysis` | Sending bounded browser history to an analytics/AI client would expose unnecessary raw journal data and could truncate history silently. | Added owned-account validation, explicit field selection, `1,000`-row Supabase-safe pages, `100,000` analysis ceiling, server-only aggregation, and no raw-trade response. | `server/analysisDb.test.ts`; full TypeScript/test/build gate. |
| **High** | `server/analysisAi.ts` / `analyzeWithOpenRouter`, `callModel` | Provider errors, malformed responses, hallucinated values, timeouts, and repeated calls could degrade the journal or mislead a trader. | Added server-only credentials, JSON-schema structured output, Zod validation, numerical grounding against deterministic payload values, 20-second abort timeout, one fallback model, bounded 15-minute/128-entry cache, safe observability, and deterministic-unavailable fallback. | `server/analysisAi.test.ts` covers valid output, privacy, cache reuse, malformed JSON, hallucinated `999` claims, fallback, provider failure, timeout, and absent configuration. |
| **High** | `shared/analysisEngine.ts` / `metricRow`, `buildAnalysis` | The prior edge calculation did not provide R-multiples, confidence intervals, sample tiers, drawdown/streak evidence, data quality, or explicit unavailable metrics. | Added closed-trade-only metrics, expectancy, PF, win rate, Wilson intervals, R metrics, sample/evidence tiers, edge scores, drawdown/streaks, rolling/decay analysis, risk coverage, journal completeness, win-vs-loss context leaders, and explicit MFE/MAE and exit-efficiency unavailability. | `shared/analysisEngine.test.ts` has 7 tests covering open exclusion, zero-loss/zero-win safety, R/Wilson calculations, streaks/drawdown, filters, comparison null semantics, and small-sample ranking. |
| **Medium** | `shared/analysisEngine.ts` / grouping and ranking | OPEN-only contexts could appear as zero-sample groups, and confidence ordering used lexical string comparison. | Excluded zero-sample groups and added explicit HIGH/MEDIUM/LOW confidence ranking. | Deterministic engine and Trading Edge regression tests. |
| **Medium** | `client/src/lib/tradingEdge.ts` / `edgeRows`, `buildTradingEdge` | The legacy Trading Edge UI was separate from the new deterministic engine, risking formula drift. | Routed the public legacy API through shared `metricRow`, preserving existing output fields and qualified strongest/weakest behavior. | `client/src/lib/tradingEdge.test.ts`: 2 tests pass. |
| **Medium** | `client/src/components/AnalysisDashboard.tsx` | The production UI lacked a clear evidence hierarchy, filters, comparison mode, data-quality warnings, and explicit unavailable-state handling. | Added filterable Analysis & Edge Development dashboard with overview cards, evidence-tier tables, session/timeframe/level/setup/direction/day/hour dimensions, combinations, streak/drawdown, risk, Win-vs-Loss, journal quality, MFE/MAE, rolling decay, and period comparison. | `AnalysisDashboard.test.tsx`; full UI suite. |
| **Medium** | `client/src/lib/accountScope.ts` / `invalidateAccountScopedQueries` | Trade/account mutations could leave deterministic analysis stale. | Added optional `analysis.get` invalidation to account-scoped refresh, with a 30-second deterministic React Query cache separate from AI cache. | `accountScope.test.ts`; full suite. |
| **Low** | `client/src/pages/GoldJournal.tsx` / Analysis route | The new dashboard would increase the initial bundle if imported eagerly. | Lazy-loaded the Analysis dashboard and added a Suspense fallback. | Production build emits `AnalysisDashboard-CQBUTr8K.js` at `38.50 kB` / `5.55 kB` gzip. |
| **Low** | `.env.example`, `README.md`, research snapshots | Documentation still described the old browser-local OpenRouter key path. | Documented `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, optional fallback/app URL as server-only; removed stale research excerpts. | Repository-wide provider-path scan. |

## Deterministic engine disposition

The engine treats `OPEN` trades as non-performance records. Closed-trade calculations include wins, losses, and break-even outcomes; break-even trades do not inflate wins. Profit factor is finite when gross loss exists, zero when there is no gross profit, and represented as a nullable “no losses” state when division would otherwise imply infinity. The UI does not display an Infinity value.

R-multiples use realized P&L divided by positive stored risk where risk exists. When risk is missing, the engine returns unavailable values rather than inventing them. Wilson intervals are shown with evidence tiers: insufficient data, early signal, developing, repeatable, and stronger evidence. Edge score combines sample quality, expectancy, confidence, and data completeness; a five-trade perfect sample cannot automatically outrank a materially larger positive context.

The engine computes chronological streaks and drawdown, consecutive-loss evidence, rolling windows, decay direction, grouped contexts, Win-vs-Loss leaders, and journal completeness. Duration, MFE, MAE, and exit efficiency are explicitly unavailable unless the underlying schema contains the required fields. The engine does not infer price-series excursions from P&L.

## Privacy and AI boundary

> OpenRouter is an optional interpretation layer, not the source of truth for financial statistics.

The browser calls only authenticated tRPC procedures. The server loads owned account rows, builds deterministic aggregates, and sends OpenRouter a compact payload containing metrics, filters, evidence tiers, warnings, and period information. It does not send JWTs, Supabase service credentials, screenshots, raw notes, or emotional text. Structured output is validated before presentation, and React renders AI strings as text rather than arbitrary HTML.

The configured AI budget is three requests per ten minutes per user in the current process. This is a useful per-instance guard, not a distributed security boundary. Multi-instance Netlify production requires an edge/WAF or Supabase-backed distributed limiter for hostile traffic. AI cache entries are bounded and keyed by user, account, engine version, and deterministic aggregate hash; deterministic React Query caching is separate and invalidated by account-scoped mutations.

## Verification evidence

| Gate | Result |
| --- | --- |
| `git diff --check` | Passed |
| `pnpm schema:audit` | Passed |
| `pnpm check` | Passed |
| `pnpm test` | **59 files / 176 tests passed** |
| `pnpm build` | Passed; Vite and server esbuild bundle completed |
| UI analysis regression | Passed under jsdom |
| OpenRouter integration tests | Passed without contacting a real provider |
| Privacy/source scan | Only `server/analysisAi.ts` contains the provider URL; no browser key storage or `VITE_OPENROUTER_API_KEY` implementation remains |

## Production acceptance gates still required

The local release gate cannot prove live Supabase authorization, live Storage policies, real PostgREST query plans, or Netlify multi-instance behavior. Before production approval, apply Supabase migrations `0001`–`0006` in order and execute the two-user matrix: User A must never read or mutate User B’s account analysis, AI procedure, trades, screenshots, notifications, or comparison results. Run authenticated staging tests with representative history and inspect `EXPLAIN` plans for the analysis date/account indexes. Configure a distributed AI/API limiter, set provider spend limits, and verify OpenRouter credentials exist only in server environment variables.

The main production bundle still reports a generic Vite warning for a broader `1,103.74 kB` application chunk. The Analysis feature itself is lazy-loaded, but the remaining global bundle should be monitored and further route-split if first-load performance is a hard release target. No authenticated Supabase/database load capacity is claimed by the local tests.

## Changed files

The implementation includes `shared/analysisEngine.ts` and tests, `server/analysisDb.ts`, `server/analysisAi.ts`, `server/goldRouter.ts`, the new authenticated router/data/AI tests, `client/src/components/AnalysisDashboard.tsx` and tests, `client/src/pages/GoldJournal.tsx`, the shared Trading Edge adapter, query invalidation, visual styles, environment documentation, and stale research-map corrections.

## References

[1]: https://github.com/Najam27/gold-journal- "Gold Journal repository"
[2]: https://openrouter.ai/docs "OpenRouter documentation"
