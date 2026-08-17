# Gold Journal — Complete Supabase + Netlify Build Prompt

Copy the prompt below into your preferred coding agent or app builder. It is written as a single comprehensive implementation brief.

---

## Prompt

Build a production-quality, installable progressive web application named **Gold Journal** for a real **XAUUSD / gold trader**. The app must be a secure, cloud-backed trading journal—not a visual mock-up. Every screen, input, calculation, filter, export, and account boundary must function end to end with real Supabase data. Use **React 19 + TypeScript + Vite + Tailwind CSS** for the frontend, **Supabase Auth + PostgreSQL + Storage + Row Level Security** for the backend, and **Netlify** for deployment and serverless functions. Configure the project as a Netlify-ready SPA/PWA from the beginning.

The application should feel like a professional trading workstation: dark graphite background, warm gold accents, high information density without clutter, subtle depth, restrained micro-interactions, strong focus states, and fully readable light mode. Use **Inter** for interface text and **DM Mono** for prices, P&L, percentages, dates, time, statistics, and trade data. The default dark background must use `#10141a`, with a refined amber/gold accent. Respect `prefers-reduced-motion` and never use distracting or excessive animations.

### Product goal and non-negotiable principles

Gold Journal is a personal multi-account journal for discretionary XAUUSD trading. It must allow a trader to record manual trades, automatically ingest MT5 activity, review mistakes and missed trades, plan a trading day, evaluate strategy edge, manage risk/behavior controls, export evidence-rich PDF reports, and use an AI mentor. The interface must never contain fake testimonials, fabricated user reviews, mock ratings, or hard-coded sample trades. Every numeric dashboard metric must come from the active account’s stored data. New manual entry forms must begin blank except for values that are genuinely auto-detected, such as the current date and PKT session.

### Required architecture

Create a clear repository structure with `src/`, `src/components/`, `src/pages/`, `src/lib/`, `supabase/migrations/`, `supabase/functions/` or `netlify/functions/`, tests, and documentation. Use a typed Supabase client, TypeScript domain types, Zod validation for every browser and server input, React Query or an equivalent cache layer, and a small well-defined state layer only where needed. Implement loading, empty, error, offline, and retry states for every remote data surface. Use serverless functions for privileged operations and never expose service-role secrets in browser code.

| Area | Required implementation |
|---|---|
| Frontend | React, TypeScript, Vite, Tailwind, accessible component primitives, responsive mobile-first layout |
| Authentication | Supabase Auth using secure session handling; protected routes and account-scoped queries |
| Database | Supabase PostgreSQL migrations, foreign keys, constraints, indexes, timestamps, and RLS |
| File storage | Private Supabase Storage bucket for screenshots; server-generated short-lived signed URLs only |
| Server logic | Netlify Functions or Supabase Edge Functions for MT5 ingestion, PDF preparation where required, and protected actions |
| Hosting | Netlify configuration with SPA redirects, environment-variable documentation, production build command, and PWA headers |
| Testing | Vitest + React Testing Library for core UI and calculation regressions; add server/function tests for authorization-sensitive paths |

### Authentication, privacy, and account isolation

Use Supabase Auth for registration, login, logout, session restoration, and protected routes. A user can have multiple trading accounts; every business record must belong to exactly one account and every account must belong to exactly one authenticated user. Implement RLS on **every user-data table**. Users may only select, insert, update, and delete rows where they own the parent account. Do not trust account IDs coming from the browser; verify ownership in database policies and in privileged serverless functions.

Do not expose internal IDs, owner IDs, raw storage keys, database metadata, signed URLs, API key hashes, or backend implementation details in the visible UI, trade detail panels, generated PDF reports, CSV, or Excel exports. Use generic authentication and validation errors. Reject HTML/script markup and unsafe control characters in user-facing text fields. Validate screenshot file type from both MIME type and bytes/signature, enforce safe size limits, and restrict uploads to JPEG, PNG, and WebP. Use private storage paths scoped by user and account. Remove or unlink screenshot references safely when a user deletes the evidence attachment.

### Supabase database model

Create SQL migrations for the following tables. Use UUID primary keys unless a different internal key is justified; do not display those IDs in the UI. Add `created_at` and `updated_at` columns where applicable. Add indexes for active-account dashboard and date-range reporting queries.

| Table | Essential fields and behavior |
|---|---|
| `profiles` | `id` references `auth.users`, display name, avatar preference, theme preference |
| `trading_accounts` | owner user ID, account name, broker name optional, base currency, starting balance optional, active state, archived state |
| `trades` | account, date/time stored in UTC, PKT display/session fields, source (`manual` or `mt5`), MT5 ticket nullable/unique per account, direction, result, setup and execution fields, risk, planned reward, realized P&L, calculated realized R:R, notes, emotions, behavior tags, screenshots metadata only |
| `trade_screenshots` | trade, account, private storage object path, display order, original filename sanitized, MIME type, creation timestamp |
| `mt5_connections` | account, terminal/account label, status, last seen, broker metrics, API-key verifier/hash only, never raw key after initial reveal |
| `mt5_positions` | connection/account, MT5 position ticket, open/close timestamps, direction, status, risk/reward/P&L, deduplication and reconciliation metadata |
| `cash_movements` | account, deposit/withdrawal, amount, note, timestamp; hide this workflow for an MT5-linked account if broker balance is the source of truth |
| `trader_goals` | account, active flag, period, metric, comparator, target, strategy scope, notification preference, behavior/risk template data |
| `goal_alerts` | account, goal, period key, status, message, read state, timestamps, deduplicated alerts |
| `skipped_trades` | account, date, PKT session, direction, reason, confidence, later outcome, optional estimated missed P&L, notes |
| `daily_plans` | account, date, pre-market plan, thesis, levels, news/risk context, execution checklist, post-session scorecard, archived/searchable state |
| `option_lists` | account, option category, label, enabled, sort order; drives all user-customizable dropdown/chip values |
| `trading_rules` | account, title, active state, sort order; used in Plan & Execution checklists |
| `notifications` | account, category, title, body, read state, timestamp |
| `mentor_reports` | account, date range/reference, prompt summary, result, model metadata without secret leakage; store only if user explicitly saves it |

Make all custom option lists account-scoped. The trader must be able to add, rename, enable/disable, and remove reusable choices such as levels, timeframes, setup quality, execution type, market condition, bias alignment, confirmations, SL/TP placement, emotions, and behavior/mistake tags. Values saved in previous trades must remain displayable even if an option is later disabled.

### Navigation and application shell

Build a desktop sidebar, a compact tablet navigation pattern, a mobile drawer or bottom navigation, and a persistent header. The active account selector must be visible and reachable. Place account-management controls above any fixed support/hosting overlay so controls can never be hidden. Include the following primary views:

1. **Trade Log**
2. **Missed Trades**
3. **Analysis Edge**
4. **Goals**
5. **P&L Calendar**
6. **Plan & Execution**
7. **AI Mentor**
8. **MT5 Live**
9. **Options**

Include a visible theme toggle, online/offline indicator, notification bell, PWA install affordance, and account selector. The notification bell must open a real account-scoped notification panel. Build a safe PWA update experience that informs the user when an update is available and reloads only after the new service worker has taken control.

### Multi-account management

Provide a clear account manager with create, rename, switch, archive/remove, and confirmation flows. The removal action must have an explicit destructive confirmation and explain what data will be removed. If an account is removed, select a valid replacement active account. The visible account name must have adequate contrast in both themes. Switching accounts must refresh all account-scoped queries and not leak stale data from the prior account.

### Trade Log: complete requirements

The Trade Log is the central workspace. Support table, card, and detail-view experiences. Use DD/MM/YYYY display formatting and preserve UTC internally. The table must support debounced search, result filter, pagination, CSV export, Excel export without unsafe spreadsheet injection, and bulk PDF export. A per-row view icon must open an accessible trade card/detail dialog. The visible detail dialog must show trader-meaningful facts only; never show internal IDs, storage paths, ticket implementation metadata, raw URLs, or owner fields.

Required trade fields include the following. All of these must be persisted and editable where relevant:

| Group | Fields |
|---|---|
| Time and origin | Trade date, PKT session, source, optional MT5 ticket hidden from normal UI detail metadata |
| Core outcome | Direction, result, risk in dollars, planned reward, realized P&L, calculated realized R:R = realized P&L divided by risk |
| Strategy context | Bias versus direction, level, timeframe, setup quality, execution type, market condition, confirmation type, SL placement, TP placement |
| Process review | Multi-select behavior/mistake tags, hold quality, patience score, emotion before/during/after, notes |
| Evidence | Multiple screenshots with private signed display URLs, upload progress, removal, and PDF inclusion |

For a **new manual trade**, show blank/manual-required choices for Direction and Result with disabled placeholders such as `Select direction` and `Select result`. Do not allow the browser’s first select option to silently become the saved value. Validate required fields in the UI and again on the server. Other strategy fields must start blank and be fed only by account-scoped custom lists. Pre-fill only the current date and the correctly computed PKT session. Editing a trade must retain stored values and must allow recently closed trades; do not incorrectly reject a current PKT-date record as a future date.

For MT5-linked accounts, show **MT5 broker balance, equity, and floating P&L** in the Trade Log summary and sidebar. Do not replace those figures with a journal running balance. Do not show deposit/withdraw controls on a linked MT5 Trade Log. Historical and live MT5-created trades should retain only factual imported fields—date/session, direction, result, risk, reward, realized P&L, and ticket linkage—while analyst fields remain empty for the trader to complete.

### Pakistan trading session classification

Store canonical timestamps in UTC. For MT5, interpret broker timestamps as **UTC+3** unless an explicit timestamp offset is present; convert them to Pakistan Standard Time, UTC+5, before displaying or classifying a session. Implement the following exact PKT session schedule and unit-test each boundary:

| PKT time | Session |
|---|---|
| 00:00–02:59 | Post-NY |
| 03:00–04:59 | Pre-Asian |
| 05:00–07:59 | Asian |
| 08:00–09:59 | Post-Asian |
| 10:00–11:59 | Pre-London |
| 12:00–13:59 | London |
| 14:00–15:59 | Post-London |
| 16:00–16:59 | Pre-NY |
| 17:00–19:59 | New York |
| 20:00–23:59 | Post-NY |

Create direct regression tests showing that 05:30 PKT is **Asian** and 01:30 PKT is **Post-NY**. The manual New Trade and Missed Trades forms must derive their initial session from the `Asia/Karachi` timezone, not the browser’s local timezone.

### MT5 Live: direct, secure connection

Create a full MT5 Live workspace and provide a downloadable Expert Advisor implementation or a clearly documented EA source file. The EA should send account metrics, current open positions, closed positions, and historical position-level backfill to a protected Netlify Function or Supabase Edge Function such as `/api/mt5`. Use a unique per-connection API key created in the app, display it **once only** after creation, persist only a SHA-256 verifier/hash, and never return the raw key again. Do not place this key in browser storage or logs.

The ingest endpoint must be public only in the sense that it accepts EA traffic; it must authenticate each request using the API key, rate-limit requests, validate exact schemas, reject malformed JSON and unsafe fields, provide generic non-sensitive errors, and store non-sensitive diagnostics. Implement ticket-based deduplication, idempotent upsert behavior, partial-close/reversal-safe logic, and retry-safe reconciliation. Historical closed positions and current open positions must automatically mirror into the linked Trade Log exactly once. When a position closes, reconcile its existing open record rather than making a duplicate trade. Make previous MT5 trade history, live balance, equity, floating P&L, open positions, and closed positions visible. Include clear in-app setup guidance for terminal installation, WebRequest allowlisting, EA attachment, API key entry, UTC+3 broker offset, testing, sync status, failure diagnosis, and historical backfill.

### Goals: strategy-first risk and behavior controls

Build a professional, editable goals and controls workspace rather than a generic goal-card page. The trader must be able to create, edit, enable, disable, and remove account-scoped controls for daily, weekly, and monthly targets/limits. Support templates and free-form controls for max daily loss, max weekly loss/drawdown, loss streak, trade-frequency limit, FOMO, revenge trading, overtrading, rule violations, required screenshot evidence, required Plan & Execution completion, and behavior tags.

Loss limits must always be represented and evaluated as **negative P&L floors**. If the trader enters `100` for a maximum loss, show and evaluate it as `-$100`; do not confuse the user with sign inversion. Use summary cards plus a compact control table with current value, limit, status, scope, period, action, and row controls. Statuses must be driven by real account data: pending, on track, at risk, breached. Generate deduplicated notifications for active controls. Do not place, close, or alter a trade automatically; automation is limited to analytics, guardrails, alerts, and workflow recommendations.

### Plan & Execution

Build a professional pre-market and post-market protocol. The Plan & Execution view must support a daily protocol with market context, higher-timeframe bias, key levels, scenarios, invalidation, news/events, risk limits, selected user-defined trading rules, execution checklist, trade thesis, end-of-session scorecard, and review notes. Save plans account-scoped and make them searchable through a debounced archive search. Include new protocol, edit, archive, and confirmed remove actions. The checklist must draw from active user-defined Trading Rules; never show a hard-coded empty `0/0` protocol state. Use clear no-results, save, error, and recovery states.

### Missed Trades

Provide a Missed/Skipped Trades workspace for opportunities the trader did not take. Show a table and summary of skipped count, estimated missed outcome, and top recorded reason. The manual form must start with a correctly auto-detected PKT session and otherwise blank choices: Direction must show `Select direction`, confidence must show `Select confidence`, reason/outcome/notes must be empty, and estimated missed P&L must be optional. Require direction, reason, confidence, and outcome before saving. Include a proper Cancel path that discards the draft without changing cloud data.

### Analysis Edge

Build an account-scoped analytical edge engine using only real completed trade data. Show sample size, win rate, net P&L, average R, expectancy, and qualifying/inconclusive status by session, timeframe, level, strategy context, behavior tag, and combinations including session × timeframe, level × session, and level × timeframe. Let the trader select a minimum sample size. Identify strongest and weakest qualified contexts globally, but label insufficient data honestly. Provide actionable educational guidance without pretending that a small sample is proof of an edge.

### P&L Calendar

Create a P&L Calendar that is separate from the Trade Log. Put monthly overview metrics at the top: trade count, win/loss/breakeven counts, win rate, realized P&L, and risk/reward metrics. Use a month picker. Build a week-card layout with animated but restrained day cards. On hover/focus, populated day cards may lift slightly and center the P&L/trade summary. Every week must show a weekly total: **green** for profit, **red** for loss, and **neutral** for flat. All colors must remain readable in dark and light themes.

### AI Mentor

Create an AI Mentor screen for a blunt, evidence-based XAUUSD journal analyst. The user supplies an OpenRouter API key locally; the key must stay in browser-local storage only and never be sent to Supabase or written to server logs. Provide a clear no-key state, an editable key field, analysis controls, selected date range/account context, request cancellation/timeout around 30 seconds, circuit-breaker behavior after repeated failures, useful error messaging, and optional saved reports. Support English and Roman Urdu responses. The mentor must use journal facts, state assumptions, flag low-sample conclusions, and never make promises or execute trades.

### Bulk PDF and file exports

Provide a bulk PDF dialog that supports full-log export or a selected date range. Generate card-style trade pages with the trade’s meaningful facts, realized R:R, notes, analysis, behavior tags, and included screenshots where available. Include a selected-period performance analysis and a P&L calendar summary. Do not include internal IDs, storage paths, owner information, raw signed URLs, or hidden metadata. CSV and Excel exports must escape formulas and special characters to prevent spreadsheet formula injection. Avoid unsafe client-side XLSX parsing libraries if not needed; safe Excel XML is acceptable.

### Theme, accessibility, and responsive acceptance criteria

Implement semantic CSS variables or equivalent theme tokens for backgrounds, surfaces, input backgrounds, borders, foreground text, muted text, success, warning, danger, and gold accent. Do not rely on a hard-coded light/dark class scattered through components. Test light and dark mode across cards, tables, dialogs, dropdowns, input fields, native selects, empty states, notifications, floating widgets, and destructive controls.

Audit the full app—not only the login or loading shell—at these minimum viewport sizes: **375 × 812**, **768 × 1024**, **1280 × 720**, and **1600 × 1000**. At phone size, navigation, new-trade actions, dialogs, account controls, tables, cards, and export actions must remain reachable with no hidden critical control or unintended horizontal overflow. At tablet and desktop, preserve readable data density, sticky/fixed control reachability, and multi-column information hierarchy. Use accessible labels, keyboard focus, semantic buttons, readable error text, and dialogs that trap focus and close safely.

### PWA requirements

Make the app installable on Android, iOS, Windows, and macOS. Provide `manifest.webmanifest`, icons, theme colors, Apple-specific metadata, and an update-aware service worker. Cache only truly static assets. Never cache private API responses, HTML documents, authenticated page data, Supabase responses, or private storage URLs. Use network-first with offline fallback for static assets where appropriate. Show an offline state that clearly explains cached-data limitations. Ensure a deployed update activates reliably and users do not remain trapped on an old JavaScript bundle after a release.

### Netlify deployment requirements

Create `netlify.toml` with the correct Vite build command, publish directory, SPA redirect, functions directory, and security headers that do not break Supabase authentication. Document all environment variables. Browser-safe variables may include `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Server-only values must include `SUPABASE_SERVICE_ROLE_KEY` and any MT5/server secret; do not prefix server-only secrets with `VITE_`. Use Netlify Functions for privileged MT5 ingestion and any server-only signed URL or administrative action. Add production-ready error handling, request timeouts, compression where supported, rate limiting for public ingest, and no hard-coded ports. Include a README section with exact Supabase migration, storage-bucket, RLS, environment, local-development, Netlify-preview, and production-deployment steps.

### Acceptance tests before delivery

Do not claim completion until all of the following are proven:

1. A user cannot read or mutate another user’s account, trade, plan, screenshot, rule, goal, or MT5 connection through Supabase/RLS or serverless endpoints.
2. A fresh manual trade has blank Direction and Result prompts; a fresh skipped trade has blank Direction, reason, confidence, outcome, estimate, and notes prompts; neither can save until required facts are selected or supplied.
3. 05:30 PKT classifies as Asian, 01:30 PKT classifies as Post-NY, and UTC+3 MT5 timestamps are converted to PKT before classification.
4. MT5 historical closes and live positions synchronize with ticket-based deduplication and reconcile open positions to closed records without duplicates.
5. Linked accounts display MT5 broker balance, equity, and floating P&L rather than journal running balance.
6. Goals, Analysis Edge, P&L Calendar, Plan & Execution, notifications, custom lists, exports, AI Mentor states, and account switching use active account-scoped real data.
7. Screenshots remain private and visible only via short-lived signed URLs; no internal metadata appears in UI or PDF output.
8. Dark and light modes pass readable-contrast review across every primary view and dialog.
9. Phone, tablet, laptop, and wide-desktop views pass overflow, reachability, and readable-density review.
10. Unit/component/server tests, TypeScript checks, database migration validation, production build, and Netlify deployment all pass.

Deliver the finished application with source code, Supabase migrations and RLS policies, Netlify configuration, a clear README, test results, and a concise manual QA checklist. Do not leave placeholder buttons, fake data, dead routes, unimplemented account boundaries, or hard-coded trader outcomes.

---

## End of Prompt
