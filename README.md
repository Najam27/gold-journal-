# Gold Journal

A production-ready **XAUUSD (Gold) trading journal** — a fully static web app
(HTML5 + Bootstrap 5 + vanilla JS) backed entirely by **Supabase** (Auth,
Postgres with Row Level Security, and Storage). No build step, no server code.

Dark trading-desk theme, cloud-synced across every device, real-time sync,
multi-account support, analytics, PnL calendar, weekly reviews, an AI mentor,
and full CSV / Excel / PDF export.

---

## Features

- **Auth** — email/password (sign up with strength meter, sign in, forgot
  password, show/hide password), **Continue with Google** (PKCE OAuth),
  persistent sessions with auto-refresh, and specific error messages.
- **Trade Log** — animated stat strip, searchable/filterable table with
  column toggles, new/edit/view trade modals, screenshot upload (drag & drop),
  deposit/withdraw, duplicate-last-trade, running balance, and a date-range
  PDF report generator.
- **Missed / Skipped Trades** — log what you passed on and why, with outcome
  tracking and estimated $ missed.
- **Analysis** — auto-generated charts (equity curve, win/loss split, P&L by
  session/level/confirmation, win rate by setup, common mistakes) + demo data.
- **PnL** — monthly calendar heatmap of daily profit/loss.
- **Weekly Review** — structured weekly reflection with saved history.
- **AI Mentor** — bring your own OpenRouter key (session-only, never stored in
  the DB) to get a written performance review of your trades.
- **Options** — profile & change-password, danger zone, and full customisation
  of every dropdown option list (synced to the cloud).
- **Reliability** — toast notifications, loading skeletons, offline banner with
  auto-retry, confirmation dialogs, form validation, and duplicate-submit
  protection throughout.
- **Realtime** — changes sync live across tabs/devices via Supabase Realtime.

---

## Setup

### 1. Create a Supabase project

1. Go to <https://supabase.com>, create a project.
2. Open **SQL Editor → New query**, paste the contents of
   [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates all
   tables (`accounts`, `trades`, `cash_transactions`, `skipped_trades`,
   `weekly_reviews`, `journal_meta`), Row Level Security policies, the private
   `screenshots` storage bucket, and enables Realtime.

### 2. Add your credentials

Open [`js/config.js`](js/config.js) and set:

```js
export const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_KEY";
```

Find both under **Project Settings → API**. The **anon** key is safe to ship in
a static site — it is protected by Row Level Security. **Never** put the
`service_role` key here.

> Alternatively, define `window.__GJ_SUPABASE_URL__` and
> `window.__GJ_SUPABASE_ANON_KEY__` before `app.js` loads (e.g. injected at
> deploy time) and leave `config.js` untouched.

### 3. (Optional) Enable Google sign-in

In Supabase **Authentication → Providers → Google**, add your Google OAuth
client ID/secret, and add your site URL (and `http://localhost:*` for local
dev) to **Authentication → URL Configuration → Redirect URLs**.

### 4. Run locally

It's a static site — serve the folder with anything:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

### 5. Deploy

Deploy the repository root as a static site (Netlify, Vercel, Cloudflare Pages,
GitHub Pages, …). No build command is required — just publish the root
directory. Make sure your deployed URL is added to Supabase's redirect URLs.

---

## Project structure

```
index.html            App shell + splash + CDN deps
css/styles.css        Theme
js/
  config.js           Supabase URL / anon key
  supabaseClient.js   Client singleton + error mapping
  store.js            Data layer (CRUD, balances, realtime, offline)
  auth.js             Auth screen + flows
  app.js              Boot, shell, navigation, sidebar
  ui.js               Toasts, dialogs, formatting helpers
  modal.js            Animated modal
  export.js           CSV / Excel / PDF export
  defaults.js         Default dropdown option lists
  pages/              One module per page
supabase/schema.sql   Database schema + RLS + storage + realtime
```

## Notes on data model

- Every table is scoped to `auth.uid()` via RLS, so users only ever see their
  own rows.
- Balances are computed client-side from a time-ordered ledger of trades +
  cash transactions on top of each account's `starting_balance`.
- Screenshots are stored under `screenshots/<user_id>/<account_id>/<ts>.<ext>`
  in a **private** bucket; the app fetches short-lived signed URLs to display
  them.
