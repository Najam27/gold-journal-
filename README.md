# Gold Journal

Gold Journal is the complete application ported from [Najam27/MyGoldJournal](https://github.com/Najam27/MyGoldJournal). The target repository contains the source UI, feature pages, reusable components, validation, MT5 workflows, exports, PWA behavior, server procedures, and regression tests.

The application now uses **Supabase as the single backend**:

| Layer | Supabase implementation |
| --- | --- |
| Authentication | Supabase Auth with email/password and magic-link sign-in |
| Database | Supabase PostgreSQL through the Supabase client API |
| File storage | Private Supabase Storage bucket with server-generated signed URLs |
| API delivery | Cloudflare Worker running the tRPC/MT5/AI API (same origin as the app) |
| Frontend delivery | Cloudflare Worker static assets (Vite build) |

The previous source OAuth/session provider, Manus session SDK, source OAuth callback, Forge storage proxy, source MySQL adapter, and Netlify Function packaging are no longer used by the application. The same API code also runs as the local Node/Express development server (`pnpm dev`) and as a standalone Node production server (`pnpm start`).

## Supabase setup

Create a Supabase project. In **Authentication → Providers**, enable Email. In **Authentication → URL Configuration**, set **Site URL** to the deployed Cloudflare URL and add both the deployed URL and the local Vite URL (for example `http://localhost:5173/`) to **Redirect URLs**. Email confirmation may remain enabled; the login form supports password sign-in, account creation, and magic links. The app requests an environment-aware callback: locally it uses the current origin/path, while `VITE_AUTH_REDIRECT_URL` can pin production email links to the deployed site.

Open the Supabase SQL Editor and run the migrations in order: `0001_source_gold_journal.sql` through `0021_mt5_connection_key_history.sql`. Migration 0007 replaces the production trade-summary RPC with fully qualified trade columns and keeps it service-role-only. Migration 0008 adds composite account ownership constraints, corrected MT5 OPEN/CLOSE semantics, analysis fields, and the Supabase-backed distributed rate limiter. Migration 0009 adds immutable, account-scoped AI report, edge-history, and experiment-history persistence. Migration 0014 adds the encrypted per-user AI-provider vault; direct browser roles have no access to this table and only the verified server service role can read or write its ciphertext. Migration 0015 adds a service-role-only durable AI job queue with opaque hashed dispatch tokens; it records filtered Analysis and Risk Coach work without storing plaintext provider credentials. Migration 0016 adds durable MT5 contact, summary, open-position, and failure diagnostics plus one service-role-only transaction for each open-position batch. Migration 0017 preserves the account-scoped MT5 connection row when a user retires it, invalidates its active state, and supports a replacement key without removing retained history. Migrations 0018–0020 harden connection ownership repair, write confirmation, and multi-user routing. Migration 0021 stores the outgoing MT5 key *fingerprint* when a key is rotated or replaced, so a terminal still sending a retired key is reported as a credential problem instead of looking offline; it stores no second credential and changes no existing row. The migrations create the source-compatible users/accounts/trades/goals/plans/options/notifications/MT5 tables, indexes, ownership constraints, private Storage bucket policies, server-side financial aggregates, the full-history trade summary, and real PostgreSQL transaction functions for destructive account, MT5, and notification multi-write operations. The Cloudflare Worker (or Node server) maps each Supabase Auth UUID to the `users.openId` column and enforces ownership through the server procedures; the service-role-only RPC functions are not a substitute for that authorization chain.

The server uses the Supabase service role only server-side (Cloudflare Worker secrets or Node environment variables). Browser code receives only the Supabase anonymous key. Do not expose the service role key in a `VITE_` variable. No separate `DATABASE_URL`, PostgreSQL pool, or direct database connection is required.

## Required environment variables

Use `.env.example` as the template. On Cloudflare, server variables are `wrangler.toml` `[vars]` entries or `wrangler secret` values (never commit the secrets); the browser-safe pair is only needed at `vite build` time.

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser (build-time) | Supabase project URL for Supabase Auth |
| `VITE_SUPABASE_ANON_KEY` | Browser (build-time) | Supabase anonymous public key |
| `VITE_AUTH_REDIRECT_URL` | Browser (build-time) | Optional safe origin/path for email confirmation and magic-link callbacks; use the deployed Cloudflare URL in production |
| `VITE_API_BASE_URL` | Browser (build-time) | Optional API origin override. Blank = same origin (`/api`), correct for Workers Assets and `pnpm dev`. Set it only when the frontend and the API live on different origins. |
| `SUPABASE_URL` | Server | Server-side Supabase project URL (public identifier; safe as a `[vars]` value) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server secret | Server-side Auth verification, Supabase database/storage access |
| `SUPABASE_STORAGE_BUCKET` | Server | Private screenshot bucket; use `trade-screenshots` |
| `NODE_ENV` | Server | `production` on deployed targets so the API validates server configuration. |

### AI runs only in the browser

There is **no server-side AI configuration**. Analysis, AI Mentor, and Risk Coach call **Groq** directly from the user's browser using the user's own Groq API key, so Cloudflare never spends AI tokens and the backend never receives a provider credential.

**Groq is the only AI provider.** There is no Gemini, OpenRouter, or OpenAI client, model list, key slot, or fallback anywhere in the active application.

1. Create a free key at `https://console.groq.com/keys`.
2. In **Options → Private AI Provider**, paste your Groq key and press **Test Groq Connection**. This performs a real `GET https://api.groq.com/openai/v1/models` request: it lists the chat models that key can actually call (audio, guardrail, and embedding models are filtered out) and pre-selects the best available one (`openai/gpt-oss-120b` is the first preference).
3. The key is stored in this browser's `localStorage` under `gold-journal.ai.groq:v1` and is read only by `client/src/lib/ai`. A previously saved Gemini (Google AI Studio) or OpenRouter key is **deleted, never migrated**, because those credentials cannot work against Groq; the app starts at "Groq not configured" until a Groq key is added.
4. Pressing **Analyze my journal**, **AI Mentor**, or **AI risk coach review** verifies the selected model against the live Groq model list (one cached lookup, then repaired and re-saved if Groq retired it), sends `POST https://api.groq.com/openai/v1/chat/completions` straight from the browser, then validates the response against the shared evidence schema and grounding rules before rendering it. Models with strict structured-output support (`openai/gpt-oss-*`, `qwen/qwen3.8-27b`) use `response_format: { type: "json_schema", strict: true }`; every other Groq chat model uses `json_object` mode, and a strict-schema rejection downgrades once to `json_object`. Either way the browser-side zod schema and the evidence-grounding checks are the source of truth, so an invalid response is reported as a schema error instead of a successful analysis. A model Groq rejects at generation time is reported as a model error with a link into AI settings — never as a generic provider failure.

The key is never sent to Cloudflare, Supabase, tRPC, logs, telemetry, or this repository. It travels in an `Authorization: Bearer <key>` header, never in a URL or query parameter. Local storage is readable by JavaScript running on the site, so use a key you are willing to keep on the device and remove it on shared machines. The finished report (no credential) is POSTed to `analysis.saveAiReport` so report history keeps working. The old `VITE_APP_ID`, `JWT_SECRET`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `OWNER_OPEN_ID`, `OWNER_NAME`, source Forge variables, and Netlify's `URL`/`DEPLOY_PRIME_URL` are not required by the Supabase Auth flow.

## Cloudflare deployment (production)

The repository deploys to **Cloudflare Workers with static assets**: one worker serves the Vite build from `dist/public` and answers `/api/*` and `/mt5` on the same origin. No Netlify configuration is used anymore. The full runbook (exact commands, logs, troubleshooting, rollback) is in `deliverables/cloudflare-deployment-guide-2026-09-09.md`; the migration report is `deliverables/netlify-to-cloudflare-migration-report-2026-09-09.md`.

Before deploying: apply all Supabase migrations in order (`0001` through `0021`), then deploy. Verify account creation, email confirmation or magic-link return, password sign-in, sign-out, local-first trade creation (including offline save then reconnect), screenshot upload, account clearing/removal, notification pagination/mark-all-read, MT5 connection setup, the browser-local Groq key Test → Save/Replace → Delete lifecycle in Options, and browser-side AI completion in Analysis, AI Mentor, and Risk Coach. After a confirmation link is opened, Supabase consumes the URL session fragment in the browser client; do not copy access or refresh tokens from the address bar or share them. If a link still targets `localhost:3000`, update the Supabase Redirect URLs and the `VITE_AUTH_REDIRECT_URL` value, then request a new confirmation email. Do not deploy code that calls the atomic or trade-summary RPCs before migrations `0004` and `0005` have been applied. Apply `0006` before relying on its database checks, notification uniqueness, or updatedAt triggers, and apply `0007` before relying on the corrected trade-summary RPC. Apply `0016` before relying on MT5 Live health diagnostics or atomic open-position batches, and apply `0017` before relying on the non-destructive MT5 connection retirement lifecycle. Apply `0021` before relying on retired-key attribution (`AUTH_REVOKED`) in MT5 Live health; the EA payload contract and reconciliation feed work without it, but the connection tile then reports a rejected key only as a stale/offline terminal. After applying `0007`, directly test `public.gj_account_trade_summary(target_user_id, target_account_id)` with zero, open, winning, losing, break-even, positive-P&L, negative-P&L, and zero-P&L trade cases; the function must not produce an ambiguous-column error.

Cloudflare free-plan notes: 100,000 Worker requests/day, 10 ms CPU per invocation (I/O waits do not count). AI inference no longer runs on the Worker at all, so it consumes none of that budget; the Worker only serves assets, the tRPC API, MT5 ingest, and report-history persistence.

## Local verification

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

The source feature suite remains in the repository. The Supabase-only conversion adds dedicated Auth, runtime configuration, storage-content, aggregate-statistics, query-adapter, and atomic-operation tests while retaining the source UI, journal, goals, plans, exports, and MT5 regression coverage. Deterministic Analysis is cached independently in the client query layer and invalidated with account-scoped journal mutations; AI results use a bounded server cache keyed by the deterministic aggregate hash. The Analysis AI procedure allows three requests per ten minutes per user and returns deterministic-unavailable results on provider failure. Production endpoint throttles use the Supabase-backed limiter created by migration 0008; local in-memory buckets are retained only for unconfigured development and tests. The limiter fails closed when the shared RPC is unavailable. The included local burst harness measures API routing only and is not evidence of authenticated Supabase/database capacity.

## MT5

The source MT5 feature set remains intact. Create an MT5 connection from the MT5 Live view and download the EA from that same page. The download is generated by the MT5 API for the current deployed origin, so its endpoint is the exact backend that displayed the connection key rather than a fixed domain. On Cloudflare the same Worker answers `/api/mt5`, `/api/mt5/ea`, and `/api/mt5/compat`; the EA derivation honors the request host and forwarded protocol headers exactly as the previous Express server did. The EA is a **strict read-only journal bridge**: it never opens, closes, modifies, or cancels trades, orders, SL, or TP. It requires only that the exact site origin is allow-listed for MT5 `WebRequest()`; Auto Trading may remain off because the EA contains no trade-execution API. It prints safe attached, authentication, summary, open-position, and history status lines in the MT5 Experts tab before sending sync events. Account metrics, open positions, history, ticket reconciliation, UTC offset handling, and journal linking are stored through Supabase. Retiring a connection invalidates its current key but preserves its account-scoped record, diagnostics, history, and Trade Log rows; issue a replacement key from that retained record to reactivate it. If a legacy deployment already has historical positions but no connection row, the historical records remain safe; create a replacement connection for that same Gold Journal account, copy its newly issued key into the EA, and restart the EA once to resume snapshot and live-position events.
