# Gold Journal — Netlify → Cloudflare Migration Report

**Date:** 2026-09-09 · **Branch:** `arena/01a08589-gold-journal` · **Status:** code-complete, tests green, deployment-verified locally; live account cutover is out-of-band (no Cloudflare/Supabase credentials in this sandbox).

## 1. Verdict and target architecture

The backend was classified **Cloudflare-Workers-viable**: every runtime dependency is Supabase REST + fetch + `node:crypto`, all of which work on workerd under `nodejs_compat`. The only Node-only surfaces were the Express/`http` glue, the `fs`-based EA template read, and the Netlify Background Function dispatch — each replaced with a platform-neutral equivalent.

Final $0 architecture:

| Layer | Host |
| --- | --- |
| Frontend (Vite SPA + PWA) | Cloudflare Worker **static assets** (`dist/public`), one origin |
| API (tRPC + MT5 + AI dispatch) | Same Worker script (same origin — zero CORS surface) |
| Database / Auth / Storage | Supabase (unchanged) |
| Durable AI jobs | Worker `/api/ai-job-dispatch`, executed in its own invocation with an atomic `QUEUED→RUNNING` claim |

One origin means the frontend keeps relative `/api` calls, the MT5 EA endpoint derivation stays exact, and no CORS configuration is required. `VITE_API_BASE_URL` remains available for split-origin staging.

## 2. What was removed

- `netlify/functions/api.ts`, `netlify/functions/ai-job-worker.ts`, `netlify.toml` (deleted).
- Dependencies/packaging: no Netlify Function runtime, no `serverless-http`, no Netlify Background Function dispatch URL (`/.netlify/functions/ai-job-worker`), no `URL`/`DEPLOY_PRIME_URL` reliance.
- Stale diagnostics: MT5 failure messages no longer say “Inspect the Netlify function log” (now “check the API deployment logs (`wrangler tail` on Cloudflare Workers)”); OpenRouter `HTTP-Referer` no longer defaults to the old Netlify domain.
- `.env.example`/README Netlify instructions replaced by Cloudflare equivalents.

## 3. What was added

| File | Purpose |
| --- | --- |
| `worker/index.ts` | Cloudflare Worker entry (EA template inlined at build time) |
| `worker/router.ts` | Platform-neutral router: MT5 ingest/compat/EA, tRPC via `fetchRequestHandler`, AI job dispatch, static assets + SPA fallback, security/no-store headers, HSTS |
| `worker/modules.d.ts` | `.mq5` text-module declaration |
| `worker/router.test.ts` | 21 Vitest tests over the Worker surface (mocked Supabase/AI) |
| `scripts/build-worker.mjs` | esbuild bundle → `dist/worker/worker.js`; **fails the build** if the EA template is missing or Node glue leaks in |
| `wrangler.toml`, `wrangler.staging.toml` | Production/staging Worker + Assets configs (free plan) |
| `client/src/lib/apiBase.ts` | `VITE_API_BASE_URL` override, default same-origin |
| `server/mt5EaCore.ts` | Pure EA endpoint/template helpers (no `fs`, no Express) |
| `deliverables/cloudflare-deployment-guide-2026-09-09.md` | Non-privileged runbook: exact commands, logs, troubleshooting, rollback |

## 4. Compatibility classification (P-classification)

- **crypto** — `node:crypto` (createHash/randomBytes/randomUUID/hkdfSync/AES-GCM) → `nodejs_compat` ✓
- **fs/path** — only the EA template read → replaced by build-time text inlining (verified in bundle) ✓
- **Express/http** — dev/prod Node server only (`pnpm dev`/`pnpm start` unchanged) → Worker uses `@trpc/server/adapters/fetch` + plain `Request` handlers ✓
- **Buffer** — global shim from `node:buffer` in the Worker entry ✓
- **process.env** — `nodejs_compat` mirrors vars/secrets ✓
- **Rate limiting** — Supabase RPC limiter unchanged ✓
- **supabase-js** — bundled for browser platform, works on workerd ✓

## 5. MT5 end-to-end design verification (no mocked MT5)

- `POST /api/mt5` and legacy `/mt5` → raw-body NUL-strip → same Zod schema, key routing, UTC+5 normalization, RPC upserts, 5/1000 ms rate limit, `connectionReference`/`dataSourceReference` responses (single source: `server/mt5Ingest.ts`, covered by 21 router tests + existing ingest/EA contract suites).
- `GET /api/mt5/ea` → derives `https://<request-host>/api/mt5` from Host/x-forwarded headers (same pure helper the Express server uses); served with `Content-Disposition` + no-store. Bundle contains the EA template (build asserted).
- `GET /api/mt5/compat` → same body as before.
- EA 2.13 behavior (transient 422/410 handling, quick-history window, deal dedupe) is client-side and unchanged.
- Verified artifacts: worker bundle smoke test exercised compat/EA-render/tRPC health/SPA fallback against the real `dist/worker/worker.js`.

## 6. AI job design on Workers

`queueAnalysisJob`/`queueRiskCoachJob` are unchanged. Dispatch now posts to `<AI_JOB_WORKER_BASE_URL>/api/ai-job-dispatch`; the Worker executes `runAiJob` in that invocation (client stays connected during provider I/O, no wall-clock cap) and answers `202` on completion. The atomic claim prevents double-processing on retries; the existing lease marks never-started jobs FAILED after 2 minutes and stuck RUNNING jobs after 16 minutes. Node dev (`pnpm dev`) still runs jobs in-process; a Node server can also register the Express twin route (`registerAiJobDispatch`). Cloudflare free-plan reality: provider responses should complete within the ~100 s dispatch / 120 s browser budget; longer jobs fail into the retryable FAILED state. Paid plan or Node hosting lifts that ceiling with no code change.

## 7. Environment separation and secrets

- `VITE_*` (browser): SUPABASE_URL/ANON_KEY, AUTH_REDIRECT_URL, new API_BASE_URL.
- `[vars]` (public): NODE_ENV, SUPABASE_STORAGE_BUCKET, SUPABASE_URL, AI_JOB_WORKER_BASE_URL.
- `wrangler secret`: SUPABASE_SERVICE_ROLE_KEY, AI_KEY_ENCRYPTION_SECRET.
- No secrets in the repo; `.env.example` documents each; guide explains `wrangler secret put`.

## 8. Security audit outcomes

- Same-origin API on the deployed Worker → no CORS needed; security headers (nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy, HSTS) reproduced on API and SPA responses; API responses are `no-store` with `CDN-Cache-Control: no-store`; unknown `/api/*` → JSON 404; oversize bodies → 413.
- Logs redact keys/tokens (no credential values are logged by any changed path).
- Service worker already bypasses `/api/` and `/storage/`.

## 9. Supabase audit status

- Migrations `0001`–`0020` present under `supabase/migrations`; no schema change required by hosting migration.
- RPC references validated (`schema:audit` + suite).
- Stale-schema guidance for operators: `NOTIFY pgrst, 'reload schema';` or Supabase dashboard → SQL → Reload schema cache (documented in the guide).
- No production data migration is performed by this change; RLS/ownership unchanged.

## 10. Verification performed (evidence)

- `tsc --noEmit` clean.
- Vitest: **354 passed** (333 prior suite + 21 Worker router tests; pre-existing sandbox-timezone exclusion unchanged).
- `pnpm build` clean: vite → `dist/public`, Node server → `dist/index.js`, Worker → `dist/worker/worker.js` (1631 KB, EA inlined + asserted).
- Bundle smoke (Node import of the real artifact): compat 200, EA 200 with correct origin endpoint and single guard token, tRPC `system.health` 200, invalid dispatch 400.
- `wrangler deploy` (live) is **not run**: no Cloudflare account credentials exist in this sandbox — that step is the user's, per the deployment guide.

## 11. Out-of-band steps (user), with exact commands

1. `corepack pnpm dlx wrangler login`
2. Set secrets: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`, `... AI_KEY_ENCRYPTION_SECRET`; set `[vars]` SUPABASE_URL + AI_JOB_WORKER_BASE_URL in `wrangler.toml`.
3. `corepack pnpm build && corepack pnpm dlx wrangler deploy` → verify `/api/mt5/compat`, `/api/mt5/ea`, browser sign-in, MT5 ping/batch, AI analysis.
4. Staging first: `wrangler deploy -c wrangler.staging.toml`.
5. Add custom domain in the dashboard; update Supabase Auth Redirect URLs; rebuild with `VITE_AUTH_REDIRECT_URL`; re-download the EA from the new origin once.
6. Rollback to Netlify at any time: restore `netlify/` + `netlify.toml` from the commit before this migration (`git checkout <sha> -- netlify.toml netlify/functions`) and redeploy Netlify; the live Netlify site is untouched until deleted in the Netlify dashboard.
