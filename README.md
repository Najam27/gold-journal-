# Gold Journal

A trading journal built for XAUUSD (gold) traders on funded accounts. Log every trade, guard your risk rules, analyze your edge, and get brutally honest AI coaching — all in one dark, fast, installable web app.

## Features

### Journal
- **Trade Log** — full trade entry: direction, session, setup, execution scores, MFE/MAE, mistake tags, screenshots. More than 3 trades in a day is flagged as overtrading, and the 4th+ trade is auto-tagged with a visible warning explaining the consequence.
- **Missed Trades** — capture the setups you didn't take and why.
- **Analysis** — win rate, profit factor, expectancy, R-multiples, and breakdowns by session, setup, timeframe, and hour (PKT). Every R value is normalized to the `1 : X` convention with risk always 1.
- **Weekly Review** — structured weekly reflection with persistent review records.
- **PnL Calendar** — daily/weekly P&L with overtrading days flagged.

### Discipline
- **Goals** — flexible trading goals with progress tracking.
- **Psychology** — behavioral tracking: patience and plan-following scores, emotional state, rule breaks.
- **Plan & Execution** — pre-trade checklist gate and plan-adherence scoring computed by the journal, not self-reported.

### Intelligence
- **AI Mentor** — professional-trader coaching powered by the free tiers of Groq and Gemini. Direct, no fluff, and brutally honest about bad numbers. Requests are paced and budgeted to stay inside free-tier limits.
- **MT5 Live** — real-time connection to MetaTrader 5 via the bundled Expert Advisor (`GoldJournal_EA.mq5`, v2.19). Live positions, history sync, and trade reconciliation.
- **Risk Calculator** — position sizing with a percentage-based **Funded guard** per account: warns at 70% and 90% of your daily loss allowance, blocks at 100%, and enforces the max-drawdown floor.

### Workspace
- **Options** — manage every dropdown/taxonomy in the journal (setups, sessions, mistakes, market conditions…). All lists are editable; defaults ship as ordinary rows.
- **Exports** — per-trade PDF reports, trade cards, PNG share images, and bulk PDF export.
- **PWA** — installable, works offline, auto-updates.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React + Vite + TypeScript (dark-only UI) |
| API | tRPC, served by the same origin |
| Auth & database | Supabase Auth + Supabase PostgreSQL |
| File storage | Private Supabase Storage bucket (trade screenshots, signed URLs) |
| Hosting | Cloudflare Workers (frontend + API on one origin) |
| AI | Groq + Gemini free tiers, browser-side with request budgeting |
| MT5 bridge | MQL5 Expert Advisor posting to the Worker API |

## Setup

### 1. Supabase

Create a Supabase project. In **Authentication → Providers**, enable Email. In **Authentication → URL Configuration**, set the Site URL to your deployed URL and add your local dev URL (e.g. `http://localhost:5173/`) to Redirect URLs.

Run the migrations in order from `supabase/migrations/` (`0001` → `0031`) in the Supabase SQL Editor. They create the users/accounts/trades/goals/plans/options/notifications/MT5 tables, ownership constraints, storage policies, and service-role-only RPC functions.

### 2. Environment variables

Copy `.env.example` to `.env`:

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser (build-time) | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Browser (build-time) | Supabase anonymous public key |
| `VITE_AUTH_REDIRECT_URL` | Browser (build-time) | Optional: pins email-link callbacks to the deployed URL |
| `VITE_API_BASE_URL` | Browser (build-time) | Optional API origin override; blank = same origin |
| `SUPABASE_URL` | Server | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server secret | Server-side DB/storage access — never expose as `VITE_` |
| `SUPABASE_STORAGE_BUCKET` | Server | Private screenshot bucket (`trade-screenshots`) |

On Cloudflare, server variables are `wrangler.toml` `[vars]` entries or `wrangler secret` values.

### 3. Run it

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/
npm test         # vitest suites
```

Deploy with `wrangler deploy` (see `wrangler.toml`; staging config in `wrangler.staging.toml`).

## MT5 Expert Advisor

`client/public/GoldJournal_EA.mq5` is the bridge between MetaTrader 5 and the journal.

1. Open the **MT5 Live** tab → **Setup guide** and download the current EA build.
2. Copy it to MT5's `MQL5/Experts` folder.
3. Open it in MetaEditor and press **F7** to compile.
4. Attach it to an XAUUSD chart, paste your journal API key, and connect.

The EA reports open positions and history to the journal for live monitoring and reconciliation.

## Key rules the app enforces

- **Overtrading** = more than 3 trades in one day (flagged in the calendar, Analysis, and Trade Log).
- **R:R display** is always normalized with risk = 1 (`1 : 2.50`), everywhere including PDF exports.
- **Funded guard** is percentage-based per account: 70% caution, 90% danger, 100% breached.
- **Closed-trade outcomes** come from the sign of the P&L, not a manual result field.
- **AI** runs on free Groq/Gemini tiers with pacing (12s between Groq chunks, 3s between Gemini chunks) and automatic smaller retries — free-tier limits are treated as hard engineering constraints.
