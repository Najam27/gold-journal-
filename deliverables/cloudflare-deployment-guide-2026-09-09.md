# Gold Journal — Cloudflare Deployment Guide (non-privileged user)

**Date:** 2026-09-09
**Target:** Cloudflare Workers (free plan) with Workers static assets — one origin for the app and the API.
**Prereqs:** a Cloudflare account, the GitHub repository, and the Supabase project. No Netlify account is needed anymore. The production Netlify site keeps serving its last build until you finish step 7 (DNS switch); nothing below deletes or modifies it.

This guide is written for a normal (non-admin) Cloudflare user: every step uses the free plan and the `wrangler` CLI with your own API token. Everything costs $0.

---

## 1. One-time tooling

Install Node.js 22+ and enable the repository's package manager:

```bash
node --version        # expect v22.x
corepack enable       # pnpm comes from package.json's packageManager
cd /path/to/gold-journal
corepack pnpm install
```

Log in to Cloudflare from the CLI (opens a browser window):

```bash
corepack pnpm dlx wrangler login
```

Verify:

```bash
corepack pnpm dlx wrangler whoami
```

Expected log: your account email and account id. If the sandbox cannot open a browser, create an API token in **Cloudflare dashboard → My Profile → API Tokens → Create Token → Edit Cloudflare Workers** (template) and run:

```bash
corepack pnpm dlx wrangler login
# or for token-only environments:
export CLOUDFLARE_API_TOKEN=...   # never commit this
corepack pnpm dlx wrangler whoami
```

## 2. Environment variables

Copy `.env.example` to `.env.production` (or set them in your CI) — these are needed at **build time** for the browser bundle:

```bash
cp .env.example .env.production
# edit .env.production:
#   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
#   VITE_SUPABASE_ANON_KEY=<anon key from Supabase dashboard → Settings → API>
#   VITE_AUTH_REDIRECT_URL=https://app.yourdomain.com   (your real custom domain)
```

Leave `VITE_API_BASE_URL` blank — the app calls `/api` on its own origin.

## 3. Server variables on Cloudflare

Edit `wrangler.toml` and set the non-secret values:

```toml
[vars]
NODE_ENV = "production"
SUPABASE_STORAGE_BUCKET = "trade-screenshots"
SUPABASE_URL = "https://<project-ref>.supabase.co"
AI_JOB_WORKER_BASE_URL = "https://app.yourdomain.com"
```

`SUPABASE_URL` and `AI_JOB_WORKER_BASE_URL` are public identifiers, not credentials. Then set the two secrets (wrangler prompts for input, nothing is stored in the repo):

```bash
corepack pnpm dlx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
corepack pnpm dlx wrangler secret put AI_KEY_ENCRYPTION_SECRET
```

`AI_KEY_ENCRYPTION_SECRET` must match the value that was in use when users saved OpenRouter keys, otherwise their saved keys cannot be decrypted (the vault falls back to deriving from `SUPABASE_SERVICE_ROLE_KEY` only when unset — keep it set).

## 4. Build and deploy

```bash
corepack pnpm install
corepack pnpm check        # tsc --noEmit
corepack pnpm test         # full Vitest suite
corepack pnpm build        # vite → dist/public, Node server → dist/index.js,
                           # Worker bundle → dist/worker/worker.js (EA template
                           # inlined and verified; build fails if missing)
corepack pnpm dlx wrangler deploy
```

Expected success log:

```
Total Upload: xx KiB / gzip: yy KiB
Uploaded 1 of 1 scripts
Current Version ID: <uuid>
https://gold-journal.<your-subdomain>.workers.dev
```

Your app is now live on the free `*.workers.dev` URL. The Worker serves the frontend AND answers `/api/mt5`, `/api/mt5/ea`, `/api/mt5/compat`, `/api/trpc`, and `/api/ai-job-dispatch` on the same origin.

## 5. Staging (optional but recommended before DNS)

The repo includes `wrangler.staging.toml` (worker name `gold-journal-staging`):

```bash
corepack pnpm dlx wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c wrangler.staging.toml
corepack pnpm dlx wrangler secret put AI_KEY_ENCRYPTION_SECRET -c wrangler.staging.toml
# staging vars (non-secret): SUPABASE_URL, and optionally
#   AI_JOB_WORKER_BASE_URL = https://gold-journal-staging.<your-subdomain>.workers.dev
corepack pnpm dlx wrangler deploy -c wrangler.staging.toml
```

Because the frontend and API share the staging origin, no `VITE_` overrides are needed; add the staging origin to **Supabase Auth → URL Configuration → Redirect URLs** so email/magic-link callbacks return there. AI dispatch works against the same Supabase project (jobs are safe — each job claim is atomic), so staging exercises the complete flow.

## 6. Verification checklist (staging, then production)

Run these against the deployed origin (replace `https://gold-journal.<sub>.workers.dev` or your custom domain):

```bash
# API compat + headers
curl -i https://<origin>/api/mt5/compat
# expect: 200 {"ok":true,"service":"gold-journal-mt5",...} + Cache-Control: no-store
# EA download for THIS origin
curl -i https://<origin>/api/mt5/ea | head -20
# expect 200, Content-Disposition attachment, and
#   input string Endpoint = "https://<origin>/api/mt5";
curl -i https://<origin>/api/mt5/compat -X POST        # expect 405
curl -i https://<origin>/api/nope                       # expect 404 JSON
curl -I https://<origin>/journal                        # SPA deep link -> 200 index.html
```

In the browser, verify: sign in / sign-up with email confirmation and magic link return, trade creation + screenshot upload, MT5 Live: create connection → copy key → **download the EA from the same page** → in MT5 add `https://<origin>` to **Tools → Options → Expert Advisors → Allow WebRequest** → attach EA → expect clean Experts-tab status and live open-position rows; close a trade → history sync row appears in Trade Log; UI theme check in light + dark mode (dropdowns/popovers/menus readable in both). In Options: AI key Test → Save → run an Analysis and a Risk Coach question → both reach COMPLETED.

Watch live logs while testing:

```bash
corepack pnpm dlx wrangler tail
```

## 7. Cut over the custom domain

1. In Cloudflare dashboard add your domain to the account (free plan), or keep the `*.workers.dev` URL.
2. **Workers & Pages → your worker → Settings → Domains & Routes → Add** a custom domain, e.g. `app.yourdomain.com` (Cloudflare handles the certificate; add a CNAME to the worker if prompted).
3. Update `wrangler.toml`: `AI_JOB_WORKER_BASE_URL = "https://app.yourdomain.com"`; redeploy: `corepack pnpm dlx wrangler deploy`.
4. Update Supabase Auth Redirect URLs + Site URL to the custom domain; rebuild the frontend with `VITE_AUTH_REDIRECT_URL=https://app.yourdomain.com` and redeploy.
5. Re-download the EA once from the new origin and restart it in MT5 (the EA endpoint always matches the origin that issued the key).
6. In your domain registrar (if not Cloudflare DNS) point the host at Cloudflare nameservers/CNAME as shown in the dashboard.

**Do not delete or redeploy the Netlify site yet.** Keep it running until you have completed a full week of MT5 + AI use on the Cloudflare origin (see rollback below).

## 8. Rollback to Netlify (if ever needed)

The last Netlify-serving commit is the parent of the migration commit (`git log --oneline`; migration commit message starts with `feat: migrate hosting to Cloudflare`). To restore Netlify configuration:

```bash
git log --oneline -3
# find the commit BEFORE the cloudflare migration commit, e.g. abc1234
git checkout abc1234 -- netlify.toml netlify/functions
git commit -m "chore: restore Netlify hosting config for rollback"
```

Then trigger a Netlify deploy from that branch/commit in the Netlify dashboard (build command `pnpm build`, publish `dist/public`, functions `netlify/functions`), and repoint DNS. The live Netlify production site was never modified by any step in this guide; it keeps serving until you delete it in the Netlify dashboard.

## 9. Troubleshooting

| Symptom | Cause / check |
| --- | --- |
| `curl /api/mt5/compat` returns 1101/empty | Worker script upload failed — check `wrangler deploy` output; the build script fails the build if the EA template is missing from the bundle. |
| EA downloads but MT5 says endpoint rejected | The EA was downloaded from a different origin than the `WebRequest()` allow-list; re-download from the page that shows the key, or add both origins. |
| `POST /api/mt5` returns 401 | Wrong/rotated API key for that connection; create a replacement key in MT5 Live. |
| `POST /api/mt5` returns 429 | Rate limit (5/1000 ms per key) or shared limiter RPC unavailable (fails closed). |
| MT5 history shows "MIGRATION_REQUIRED_0008" style failure | Supabase RPC schema cache is stale: Supabase dashboard → SQL → `NOTIFY pgrst, 'reload schema';` |
| AI job stays QUEUED then FAILED "could not be started" | `AI_JOB_WORKER_BASE_URL` unset or unreachable from the worker; verify the `[vars]` value is the canonical origin and `wrangler tail` shows the dispatch POST. |
| AI job RUNNING then FAILED "taking too long" | The provider response outlasted the dispatch budget (2-min browser/100-s dispatch ceiling on free Workers). Retry; for guaranteed long jobs run the Node server with `AI_JOB_INLINE_FALLBACK=true` (full provider timeout) or use Workers paid (no code change). |
| Browser can't sign in via email link | Supabase Redirect URLs missing the deployed origin; confirm `VITE_AUTH_REDIRECT_URL` matches and redeploy after changing it. |
| `wrangler deploy` errors `compatibility_date` | Set `compatibility_date` to today's date (format YYYY-MM-DD) in `wrangler.toml`. |
| Saved AI keys fail after migration | `AI_KEY_ENCRYPTION_SECRET` differs from the value used previously; set the same secret and re-put the wrangler secret, or users re-save keys in Options. |
| Free plan daily limit (Error 1027) | 100,000 requests/day shared by app, MT5 pings, and AI dispatch. MT5 syncs are batched (5 events/1000 ms per key) — a single trader is far below the cap. |
| Logs needed for support | `corepack pnpm dlx wrangler tail` (live), Cloudflare dashboard → Workers → your worker → Logs. Log lines never include API keys, service-role keys, access tokens, or passwords (redaction was verified in the audit). |

## 10. Files that make up the Cloudflare target

| File | Purpose |
| --- | --- |
| `worker/index.ts` | Worker entry (inlines the EA template at build time) |
| `worker/router.ts` | Platform-neutral request router (MT5, tRPC, AI dispatch, SPA assets) |
| `worker/router.test.ts` | 21 Vitest tests for the Worker surface |
| `scripts/build-worker.mjs` | esbuild Worker bundle + post-build verification |
| `wrangler.toml` / `wrangler.staging.toml` | Production/staging Worker configs |
| `server/mt5EaCore.ts` | Pure EA rendering helpers shared by Node and the Worker |
| `server/aiJobs.ts` | Queue + `parseAiJobDispatchRequest` + `registerAiJobDispatch` (Express twin) |
| `server/_core/context.ts` | Shared bearer-auth context for Express and fetch adapters |
| `server/mt5Ingest.ts` | Shared MT5 payload processing incl. raw-body parse (`ingestMt5Text`) |
