# Gold Journal

Gold Journal is the complete application ported from [Najam27/MyGoldJournal](https://github.com/Najam27/MyGoldJournal). The target repository contains the source UI, feature pages, reusable components, validation, MT5 workflows, exports, PWA behavior, server procedures, and regression tests.

The application now uses **Supabase as the single backend**:

| Layer | Supabase implementation |
| --- | --- |
| Authentication | Supabase Auth with email/password and magic-link sign-in |
| Database | Supabase PostgreSQL through the transaction pooler and Drizzle PostgreSQL |
| File storage | Private Supabase Storage bucket with server-generated signed URLs |
| API delivery | Netlify Function running the copied tRPC/Express API |
| Frontend delivery | Netlify static Vite build |

The previous source OAuth/session provider, Manus session SDK, source OAuth callback, Forge storage proxy, and source MySQL adapter are no longer used by the application.

## Supabase setup

Create a Supabase project. In **Authentication → Providers**, enable Email. Configure the site URL and redirect URL to your Netlify site URL. Email confirmation may remain enabled; the login form supports password sign-in, account creation, and magic links.

Open the Supabase SQL Editor and run the complete migration at `supabase/migrations/0001_source_gold_journal.sql`. It creates the source-compatible users/accounts/trades/goals/plans/options/notifications/MT5 tables, indexes, constraints, and the private `trade-screenshots` Storage bucket. The Netlify backend maps each Supabase Auth UUID to the `users.openId` column and enforces ownership through the server procedures.

The server uses the Supabase service role only inside Netlify Functions. Browser code receives only the Supabase anonymous key. Do not expose the service role key in a `VITE_` variable.

## Required environment variables

Use `.env.example` as the template. Configure these in Netlify Site configuration → Environment variables and use the browser-safe pair during local Vite development.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser | Supabase project URL for Supabase Auth |
| `VITE_SUPABASE_ANON_KEY` | Browser | Supabase anonymous public key |
| `SUPABASE_URL` | Netlify only | Server-side Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Netlify only | Server-side Auth verification, database/storage access |
| `DATABASE_URL` | Netlify only | Supabase PostgreSQL transaction-pooler URL, normally port 6543 |
| `SUPABASE_STORAGE_BUCKET` | Netlify only | Private screenshot bucket; use `trade-screenshots` |

`OPENAI_API_KEY` and `OPENAI_API_BASE` are optional non-database variables for AI/integration helpers. Analytics variables are also optional. The old `VITE_APP_ID`, `JWT_SECRET`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `OWNER_OPEN_ID`, `OWNER_NAME`, and source Forge variables are not required by the Supabase Auth flow.

## Netlify deployment

The repository includes `netlify.toml`. Connect the target GitHub repository to Netlify. The build command is `pnpm build`, the publish directory is `dist/public`, and the Function directory is `netlify/functions`. The `/api/*` redirect routes to the serverless tRPC/MT5 API function.

After setting environment variables, deploy the site and run the Supabase migration once. Then verify account creation, email confirmation or magic-link return, password sign-in, sign-out, trade creation, screenshot upload, and MT5 connection setup.

## Local verification

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

The source feature suite remains in the repository. The Supabase-only conversion adds dedicated Auth and runtime configuration tests while retaining the source UI, journal, goals, plans, exports, and MT5 regression coverage.

## MT5

The source MT5 feature set remains intact. Create an MT5 connection from the MT5 Live view, configure the EA with the generated API key, and point it at the deployed Netlify endpoint. Account metrics, open positions, history, ticket reconciliation, UTC offset handling, and journal linking are stored in Supabase PostgreSQL.
