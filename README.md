# Gold Journal

Gold Journal is a private, installable progressive web application for discretionary XAUUSD traders. It provides an account-scoped trade log, missed-trade review, strategy-edge analysis, risk and behavior controls, a P&L calendar, daily planning, an AI mentor, MT5 synchronization, custom option lists, and secure export-ready architecture.

## Stack

The frontend is React 19 with TypeScript and Vite. Supabase provides Auth, PostgreSQL, Storage, and Row Level Security. Netlify serves the SPA and the protected MT5 Function. Zod validates browser-bound and server-bound input. Vitest covers deterministic core behavior, including the PKT session classifier and blank-form validation.

The app intentionally has a local preview mode when Supabase variables are absent. Local preview uses browser storage, never fabricates trades, and is useful for visual QA. Production must use Supabase and the migration in `supabase/migrations/0001_gold_journal.sql`.

## Local development

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

The browser-safe variables are:

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Browser | Supabase anonymous client key |
| `SUPABASE_URL` | Netlify Functions only | Server-side Supabase URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Netlify Functions only | Privileged server key; never prefix with `VITE_` |

Never commit `.env.local`, service-role keys, MT5 raw keys, or OpenRouter keys. The OpenRouter key is intentionally local-browser-only for the AI Mentor and is not persisted to Supabase.

## Supabase setup

Create a Supabase project, enable email/password Auth, and run the SQL migration in the Supabase SQL editor or through the Supabase CLI. The migration creates the account-scoped domain tables, indexes, update triggers, private screenshot bucket, and RLS policies. Every business row is protected through `trading_accounts.owner_id` and the `public.owns_account(account_id)` security-definer helper.

The private screenshot bucket is `trade-screenshots`. Production upload code should use paths beginning with the authenticated user ID and should return short-lived signed URLs only. Do not expose object paths or signed URLs in exports.

## MT5 setup

The MT5 ingestion endpoint is `/.netlify/functions/mt5`. The Expert Advisor must send an API key, connection ID, account metrics, and position objects. Each position must contain a stable ticket, direction, status, and timestamps. Broker timestamps default to UTC+3 and are converted to UTC before PKT classification. The function hashes the API key, authenticates requests, limits requests by source IP, validates payloads, upserts positions by `(account_id, mt5_position_ticket)`, and reconciles closed positions to an existing journal trade by ticket.

A production EA source file should be placed beside the function or distributed from the MT5 Live page. The key is revealed once in the application and must never be stored in browser storage or logs.

## Netlify deployment

Netlify uses the configuration in `netlify.toml`:

```bash
pnpm build
```

The publish directory is `dist`, SPA routing falls back to `index.html`, and serverless functions are read from `netlify/functions`. Configure the browser-safe `VITE_` variables as Netlify environment variables for the build. Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as function runtime variables only. Deploying a new version should invalidate the static asset bundle; the service worker caches static assets only and never caches authenticated HTML, Supabase responses, private API data, or signed storage URLs.

## Verification

```bash
pnpm lint
pnpm test
pnpm build
```

The regression suite proves that 05:30 PKT is Asian, 01:30 PKT is Post-NY, key boundaries are covered, and blank direction/result or skipped-trade required fields are rejected. Production QA should additionally verify account switching, RLS with two users, MT5 retry and reconciliation, private screenshot URLs, light and dark themes, and the four target viewport sizes: 375×812, 768×1024, 1280×720, and 1600×1000.

## Manual QA checklist

| Area | Check |
| --- | --- |
| Auth | Register, sign in, restore a session, sign out, and receive generic auth errors |
| Isolation | A second user cannot select, update, delete, or infer another account's rows |
| Manual trade | New form starts blank for direction/result and refuses incomplete saves |
| PKT | Date changes recompute session using Asia/Karachi rather than browser timezone |
| Missed trades | Cancel discards the draft; required direction, reason, confidence, and outcome are enforced |
| Account manager | Create, switch, rename/archive with a destructive confirmation and valid replacement |
| Analysis | Only completed real data is used; insufficient samples are labeled inconclusive |
| Goals | Loss limits display as negative P&L floors and statuses use current account data |
| Planning | Active trading rules populate the protocol checklist; archive search works |
| MT5 | Keys are one-time, payloads are idempotent by ticket, and broker metrics remain separate from journal balance |
| Privacy | Internal IDs, storage paths, owner IDs, raw keys, and signed URLs are absent from user-facing views and exports |
| PWA | Install manifest works, offline state is clear, static updates activate without caching private data |
| Responsive | No critical control is hidden or horizontally clipped at all required viewport sizes |

## Repository layout

```text
src/                 React application and domain logic
src/lib/              Supabase client, data service, time, types, Zod schemas
src/test/             Vitest regression tests
netlify/functions/   Protected serverless ingestion
supabase/migrations/ Database schema, indexes, RLS, and private storage policies
public/              PWA manifest, icons, and service worker
```
