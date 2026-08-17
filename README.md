# Gold Journal

Gold Journal is the complete trading-journal application ported from [Najam27/MyGoldJournal](https://github.com/Najam27/MyGoldJournal). The target repository now contains the source repository’s full UI, feature pages, reusable components, validation, tRPC contracts, MT5 workflows, tests, PWA assets, and export functionality.

The runtime keeps the source application architecture while moving persistence and screenshot storage to **Supabase PostgreSQL and Supabase Storage**. Netlify serves the Vite frontend and exposes the copied Express/tRPC backend through a serverless function.

## Included source features

The copied implementation includes Trade Log with search, filtering, pagination, manual entry, editing, deletion, duplicate entry, screenshots, CSV/Excel/PDF export, account balance and cash movements; Missed Trades; Analysis Edge; configurable Goals and goal alerts; P&L Calendar; Plan & Execution; AI Mentor privacy behavior; MT5 Live telemetry, history, reconciliation, and journal linking; Options; notification center; account switching; responsive sidebar/mobile navigation; dark/light themes; offline state; installable PWA behavior; and the complete source test suite.

## Supabase setup

Create a Supabase project and open the SQL Editor. Run the complete migration at `supabase/migrations/0001_source_gold_journal.sql`. It creates all source-compatible `users`, `gj_*` application tables, indexes, constraints, and the private `trade-screenshots` Storage bucket. The Netlify backend uses the Supabase transaction-pooler `DATABASE_URL` for Drizzle PostgreSQL access and the service-role key for private screenshot uploads and signed URLs.

The source application’s authentication contract remains the source OAuth/session contract. Supabase is the persistent data and storage layer; the Netlify function must receive the source OAuth/session environment variables as well as the Supabase variables.

## Environment variables

Copy `.env.example` to `.env` for local work. In Netlify, configure the same values in **Site configuration → Environment variables**. Never expose `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `MT5_ENCRYPTION_KEY`, or `BUILT_IN_FORGE_API_KEY` with a `VITE_` prefix.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Supabase PostgreSQL transaction-pooler URL, normally port 6543 |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only private Storage/database key |
| `SUPABASE_STORAGE_BUCKET` | Private screenshot bucket; use `trade-screenshots` |
| `JWT_SECRET` | Session cookie signing secret |
| `VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL` | Source authentication flow |
| `OWNER_OPEN_ID`, `OWNER_NAME` | Source owner configuration |
| `MT5_ENCRYPTION_KEY` | Server-only MT5 secret encryption key |
| `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY` | Optional source service integrations |
| `VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID` | Optional Umami analytics |

## Netlify deployment

The repository includes `netlify.toml`. Netlify should use the `pnpm build` command, publish `dist/public`, and use `netlify/functions` for the API. The redirect from `/api/*` to `/.netlify/functions/api/:splat` keeps the copied source tRPC, OAuth, storage, and MT5 routes available under the same API path expected by the source UI.

Connect the GitHub repository, set the environment variables, deploy, then run the Supabase migration once. Do not commit `.env` files or any Supabase service-role key.

## Local verification

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

The copied source baseline was verified before porting with 42 Vitest files and 129 tests. After the Supabase/Postgres conversion, the same checks pass locally, including the source UI tests and MT5 lifecycle tests.

## MT5

The source MT5 implementation remains intact. Create the connection from the MT5 Live view, configure the EA with the returned API key, and point it at the deployed Netlify endpoint. MT5 account metrics, live positions, history, ticket reconciliation, UTC offset handling, and journal linking remain source features. Keep the generated API key private and configure the broker timestamp offset explicitly.
