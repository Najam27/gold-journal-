# Gold Journal

Gold Journal is the complete application ported from [Najam27/MyGoldJournal](https://github.com/Najam27/MyGoldJournal). The target repository contains the source UI, feature pages, reusable components, validation, MT5 workflows, exports, PWA behavior, server procedures, and regression tests.

The application now uses **Supabase as the single backend**:

| Layer | Supabase implementation |
| --- | --- |
| Authentication | Supabase Auth with email/password and magic-link sign-in |
| Database | Supabase PostgreSQL through the Supabase client API |
| File storage | Private Supabase Storage bucket with server-generated signed URLs |
| API delivery | Netlify Function running the copied tRPC/Express API |
| Frontend delivery | Netlify static Vite build |

The previous source OAuth/session provider, Manus session SDK, source OAuth callback, Forge storage proxy, and source MySQL adapter are no longer used by the application.

## Supabase setup

Create a Supabase project. In **Authentication → Providers**, enable Email. In **Authentication → URL Configuration**, set **Site URL** to the deployed Netlify URL and add both the deployed URL and the local Vite URL (for example `http://localhost:5173/`) to **Redirect URLs**. Email confirmation may remain enabled; the login form supports password sign-in, account creation, and magic links. The app requests an environment-aware callback: locally it uses the current origin/path, while `VITE_AUTH_REDIRECT_URL` can pin production email links to the deployed site.

Open the Supabase SQL Editor and run the migrations in order: `0001_source_gold_journal.sql`, `0002_security_rls_and_storage.sql`, `0003_scale_aggregates.sql`, `0004_atomic_operations.sql`, `0005_trade_summary.sql`, `0006_schema_integrity.sql`, and `0007_fix_trade_summary_and_accounts.sql`. The final migration replaces the production trade-summary RPC with fully qualified trade columns and keeps it service-role-only. They create the source-compatible users/accounts/trades/goals/plans/options/notifications/MT5 tables, indexes, ownership constraints, private Storage bucket policies, server-side financial aggregates, the full-history trade summary, and real PostgreSQL transaction functions for destructive account, MT5, and notification multi-write operations. The Netlify backend maps each Supabase Auth UUID to the `users.openId` column and enforces ownership through the server procedures; the service-role-only RPC functions are not a substitute for that authorization chain.

The server uses the Supabase service role only inside Netlify Functions. Browser code receives only the Supabase anonymous key. Do not expose the service role key in a `VITE_` variable. No separate `DATABASE_URL`, PostgreSQL pool, or direct database connection is required.

## Required environment variables

Use `.env.example` as the template. Configure these in Netlify Site configuration → Environment variables and use the browser-safe pair during local Vite development.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser | Supabase project URL for Supabase Auth |
| `VITE_SUPABASE_ANON_KEY` | Browser | Supabase anonymous public key |
| `VITE_AUTH_REDIRECT_URL` | Browser | Optional safe origin/path for email confirmation and magic-link callbacks; use the deployed Netlify URL in production |
| `SUPABASE_URL` | Netlify only | Server-side Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Netlify only | Server-side Auth verification, Supabase database/storage access |
| `SUPABASE_STORAGE_BUCKET` | Netlify only | Private screenshot bucket; use `trade-screenshots` |

The Analysis and AI Mentor views use an optional server-side OpenRouter integration. Configure `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` only in Netlify/server environment variables; never create a `VITE_OPENROUTER_API_KEY` or place provider credentials in browser storage. If these variables are absent, deterministic analysis remains available and the AI panel reports that it is not configured. `OPENROUTER_FALLBACK_MODEL` and `OPENROUTER_APP_URL` are optional. The old `VITE_APP_ID`, `JWT_SECRET`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `OWNER_OPEN_ID`, `OWNER_NAME`, and source Forge variables are not required by the Supabase Auth flow.

## Netlify deployment

The repository includes `netlify.toml`. Connect the target GitHub repository to Netlify. The build command is `pnpm build`, the publish directory is `dist/public`, and the Function directory is `netlify/functions`. The `/api/*` redirect routes to the serverless tRPC/MT5 API function.

After setting environment variables, apply all seven Supabase migrations in order, then deploy the site. Verify account creation, email confirmation or magic-link return, password sign-in, sign-out, trade creation, screenshot upload, account clearing/removal, notification pagination/mark-all-read, and MT5 connection setup. After a confirmation link is opened, Supabase consumes the URL session fragment in the browser client; do not copy access or refresh tokens from the address bar or share them. If a link still targets `localhost:3000`, update the Supabase Redirect URLs and the Netlify `VITE_AUTH_REDIRECT_URL` value, then request a new confirmation email. Do not deploy code that calls the atomic or trade-summary RPCs before migrations `0004` and `0005` have been applied. Apply `0006` before relying on its database checks, notification uniqueness, or updatedAt triggers, and apply `0007` before relying on the corrected trade-summary RPC. After applying `0007`, directly test `public.gj_account_trade_summary(target_user_id, target_account_id)` with zero, open, winning, losing, break-even, positive-P&L, negative-P&L, and zero-P&L trade cases; the function must not produce an ambiguous-column error.

## Local verification

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

The source feature suite remains in the repository. The Supabase-only conversion adds dedicated Auth, runtime configuration, storage-content, aggregate-statistics, query-adapter, and atomic-operation tests while retaining the source UI, journal, goals, plans, exports, and MT5 regression coverage. Deterministic Analysis is cached independently in the client query layer and invalidated with account-scoped journal mutations; AI results use a bounded server cache keyed by the deterministic aggregate hash. The Analysis AI procedure allows three requests per ten minutes per user in the current process and returns deterministic-unavailable results on provider failure. Procedure throttles are process-local safeguards; configure a distributed edge/WAF or Supabase-backed limiter before operating multiple Netlify instances under hostile traffic. The included local burst harness measures API routing only and is not evidence of authenticated Supabase/database capacity.

## MT5

The source MT5 feature set remains intact. Create an MT5 connection from the MT5 Live view, configure the EA with the generated API key, and point it at the deployed Netlify endpoint. Account metrics, open positions, history, ticket reconciliation, UTC offset handling, and journal linking are stored through Supabase.
