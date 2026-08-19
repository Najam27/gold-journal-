# Gold Journal Supabase/Netlify Production Audit — Working Evidence

## Scope and constraints

The audit targets the `Najam27/gold-journal-` Supabase/Netlify codebase. Fixed Pakistan Standard Time (UTC+5) remains the business-date authority. The audit excludes fabricated data and does not change existing account, MT5, trade, goal, or AI records unless a verified repair requires an additive migration.

## Verified source findings

| ID | Area | Evidence | Impact | Planned remediation |
|---|---|---|---|---|
| A-01 | P&L Calendar | `PnlCalendarWithWeeks.tsx` constructs calendar cells and compares trades through browser-local `Date` APIs, while `performanceSummary.ts` already groups the same data through fixed PKT date keys. | A trade near midnight PKT can appear on the wrong calendar day, week, or month for users outside Pakistan. | Replace calendar cell generation, comparisons, labels, month navigation, and selected-day keys with PKT date-key helpers; add boundary coverage. |
| A-02 | Plan & Execution | `PlanExecutionEditor.tsx` derives the default date, plan lookup keys, month labels, and saved timestamp with browser-local APIs and serializes `T12:00:00` without `+05:00`. | The same plan can map to a different business date across devices/time zones and can create duplicate daily-plan rows. | Use the shared PKT date helpers and serialize every plan date as a fixed UTC+5 instant; add regression coverage. |
| A-03 | Missed Trades | `GoldJournal.tsx` serializes a skipped trade with browser-local `new Date(...T12:00:00)`, and its form begins with preset direction, reason, outcome, and confidence values. | Entries can be saved under the wrong PKT day and the form silently records defaults instead of trader-entered facts. | Use fixed UTC+5 serialization, blank required defaults, and explicit client validation; retain session auto-detection. |
| A-04 | Analysis date filters | `server/analysisDb.ts` treats `YYYY-MM-DD` filters as UTC midnights rather than PKT business-day boundaries. | Analysis can exclude or include trades from the adjacent PKT date. | Convert validated date filters to UTC+5 boundaries on the server and cover the boundary behavior. |

## Authentication, route, schema, and MT5 review evidence

The central tRPC router uses protected procedures for journal, account, MT5, trade, cash, goal, option, notification, plan, and AI mutations. Source review found explicit account ownership resolution before account-scoped operations, composite account-owner foreign keys in the schema, service-role-only security-definer RPC grants, key-hashed MT5 ingestion, bounded JSON bodies, fixed request limits, and fail-closed shared rate limiting. The MT5 lifecycle SQL is terminal-state protected for CLOSED positions and constrains RPC execution to `service_role`.

No new verified direct cross-account read/write route was found in the inspected router, atomic RPC, RLS policy, auth-context, MT5 ingestion, screenshot-signing, and rate-limit paths. Deployment verification remains limited because the public Netlify site is currently paused by its provider and the actual Supabase production schema cannot be queried from this environment.

## Dependency audit evidence

`pnpm audit --prod --json` reported **0 critical, 19 high, 33 moderate, and 4 low** advisories in the installed production dependency graph. Direct and reachable items require triage before remediation:

| Dependency path | Audit signal | Audit decision needed |
|---|---|---|
| `xlsx@0.18.5` | Direct high advisories for spreadsheet parsing; this application only exports user-owned data through `XLSX.writeFile` and does not read workbook uploads. | Preserve export behavior but remove or replace the unmaintained parser dependency if a compatible export-only alternative can be validated. |
| `axios` | Direct advisories plus `follow-redirects` and `form-data` transitive advisories. | Check whether Axios is imported; remove it if unused rather than upgrading an unused production surface. |
| `streamdown → mermaid` | Multiple transitive advisories, including Markdown/diagram rendering dependencies. | Check whether Streamdown is imported; remove it if unused. |
| `express@4.21.2` / `recharts` | Transitive `qs`, `path-to-regexp`, and `lodash` advisory paths. | Apply only compatible security overrides or direct upgrades that preserve the tested runtime. |

The initial raw advisory output is retained only in the local audit command output and is not committed.

### Dependency reachability result

The source import inventory found no Axios or Streamdown import in application, server, function, shared, or script source. Both are direct but unused production dependencies, so removing them removes their advisory trees without changing application behavior. `xlsx` is only dynamically imported for the existing browser-side Excel export and no workbook-import path exists in this application; its parsing advisories are therefore not currently reachable through a product input flow. Express and Recharts are active runtime dependencies, so their compatible transitive patches require a controlled lockfile override and full regression validation rather than a major framework upgrade during this audit.

### Applied dependency remediation and residual risk

The remediation removes unused `axios` and `streamdown`, upgrades `drizzle-orm` to `0.45.2`, upgrades `nanoid` to `5.1.16`, upgrades Express within its supported major line to `4.22.2`, and pins Recharts' Lodash dependency to `4.18.0`. The post-remediation production audit drops from **19 high, 33 moderate, and 4 low** findings to **3 high, 0 moderate, and 0 low** findings.

The three remaining high findings are two unpatched npm advisories on the retained `xlsx@0.18.5` exporter and one `path-to-regexp@0.1.12` advisory transitive to maintained Express 4.22.2. `xlsx` remains necessary for the existing export feature and the application has no workbook-import or `XLSX.read*` flow. The route matcher advisory requires a route segment containing three or more dynamic parameters; the application’s Express routes are fixed `/api/*` paths with no such segment. Replacing either remaining package would require a user-visible export replacement or an Express-major migration, neither of which is justified without a dedicated migration task and compatibility review.

## Validation evidence

The final local validation completed successfully after updating the source-schema audit to recognize migrations `0011` and `0012` and to assert their security-definer/service-role contracts. It includes 71 passing test files, 233 passing tests, two intentionally skipped integration tests, TypeScript checking, a production Vite/server build, service-worker syntax validation, frozen-lockfile installation, whitespace validation, and the schema-source audit.

The generated client bundle still reports a size warning for the existing `xlsx` export chunk and the main application chunk. This is a performance optimization opportunity, not a functional or security failure; the Excel module is already dynamically imported and no behavior was changed to suppress the warning.

## External rollout prerequisites

The audit could not query the user’s live Supabase project or paused Netlify deployment. Before production verification, apply the already committed Supabase migrations `0011_atomic_mt5_history_batch.sql` and `0012_mt5_open_trade_lifecycle.sql` in order if they are not yet present in the Supabase SQL Editor, then resume/redeploy the Netlify site from `main`. The application validates required server-side Supabase configuration at runtime, but the public client build must also retain `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Netlify’s build environment for authentication to operate.
