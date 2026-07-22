-- =====================================================================
-- Gold Journal — Supabase schema
-- Run this in the Supabase SQL editor (Dashboard -> SQL -> New query).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.
-- =====================================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";

-- ---------- Helper: updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =====================================================================
-- accounts — a user can own multiple trading accounts
-- =====================================================================
create table if not exists public.accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  name            text not null default 'Main Account',
  starting_balance numeric not null default 0,
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists accounts_user_id_idx on public.accounts(user_id);

-- =====================================================================
-- trades
-- =====================================================================
create table if not exists public.trades (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  account_id         uuid not null references public.accounts(id) on delete cascade,
  trade_date         date not null default (now()::date),
  session            text,
  side               text,             -- Buy / Sell
  level              text,
  timeframe          text,
  setup_quality      text,
  confirmation_type  text,
  execution_type     text,
  market_condition   text,
  bias_alignment     text,             -- With Trend / Counter Trend
  sl_placement       text,
  tp_placement       text,
  patience_score     integer,          -- 1..5
  mistake            text,
  hold_quality       text,
  risk_amount        numeric default 0,
  reward_amount      numeric default 0,
  result             text,             -- Win / Loss / Break-even / Open
  pnl                numeric default 0,
  screenshot_path    text,             -- storage object path
  notes              text,
  emotion_before     text,
  emotion_during     text,
  emotion_after      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists trades_user_id_idx on public.trades(user_id);
create index if not exists trades_account_id_idx on public.trades(account_id);
create index if not exists trades_date_idx on public.trades(trade_date);

-- =====================================================================
-- cash_transactions — deposits / withdrawals
-- =====================================================================
create table if not exists public.cash_transactions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  account_id   uuid not null references public.accounts(id) on delete cascade,
  tx_date      date not null default (now()::date),
  type         text not null,          -- deposit / withdraw
  amount       numeric not null default 0,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists cash_user_id_idx on public.cash_transactions(user_id);
create index if not exists cash_account_id_idx on public.cash_transactions(account_id);

-- =====================================================================
-- skipped_trades
-- =====================================================================
create table if not exists public.skipped_trades (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  account_id    uuid not null references public.accounts(id) on delete cascade,
  trade_date    date not null default (now()::date),
  session       text,
  level         text,
  timeframe     text,
  direction     text,
  skip_reason   text,
  confidence    integer,               -- 1..5
  outcome       text,
  est_missed    numeric default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists skipped_user_id_idx on public.skipped_trades(user_id);
create index if not exists skipped_account_id_idx on public.skipped_trades(account_id);

-- =====================================================================
-- weekly_reviews
-- =====================================================================
create table if not exists public.weekly_reviews (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  account_id   uuid not null references public.accounts(id) on delete cascade,
  week_of      date not null default (now()::date),
  learned      text,
  pattern      text,
  improve      text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists reviews_user_id_idx on public.weekly_reviews(user_id);
create index if not exists reviews_account_id_idx on public.weekly_reviews(account_id);

-- =====================================================================
-- daily_plans — morning plan & end-of-day execution review
-- =====================================================================
create table if not exists public.daily_plans (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  account_id       uuid not null references public.accounts(id) on delete cascade,
  plan_date        date not null,
  pre_bias         text,
  key_levels       text,
  session_focus    text,
  plan_notes       text,
  rules_planned    jsonb default '[]'::jsonb,
  emotion_start    text,
  emotion_end      text,
  execution_score  integer,
  rules_followed   jsonb default '[]'::jsonb,
  what_went_well   text,
  what_went_wrong  text,
  lessons          text,
  overall_rating   integer,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, account_id, plan_date)
);
create index if not exists daily_plans_user_id_idx on public.daily_plans(user_id);
create index if not exists daily_plans_account_id_idx on public.daily_plans(account_id);
create index if not exists daily_plans_date_idx on public.daily_plans(plan_date);

-- =====================================================================
-- goals — per-account trading discipline targets
-- =====================================================================
create table if not exists public.goals (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  account_id        uuid not null references public.accounts(id) on delete cascade,
  title             text not null,
  type              text not null,
  period            text not null default 'daily',
  target_value      numeric not null default 0,
  comparison        text not null default 'gte',
  is_active         boolean not null default true,
  is_default        boolean not null default false,
  notify_on_breach  boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists goals_user_id_idx on public.goals(user_id);
create index if not exists goals_account_id_idx on public.goals(account_id);

-- =====================================================================
-- journal_meta — key/value store per user (custom option lists, prefs)
-- =====================================================================
create table if not exists public.journal_meta (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  key          text not null,
  value        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (user_id, key)
);
create index if not exists meta_user_id_idx on public.journal_meta(user_id);

-- ---------- updated_at triggers ----------
do $$
declare t text;
begin
  foreach t in array array['accounts','trades','cash_transactions','skipped_trades','weekly_reviews','daily_plans','goals','journal_meta']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I;', t);
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.set_updated_at();', t);
  end loop;
end $$;

-- =====================================================================
-- Grants — the API roles need table privileges in addition to RLS.
-- RLS decides *which rows* a user sees; GRANT decides whether the role
-- may touch the table at all. Without these, the client gets
-- "permission denied for table ...". Running the schema in the Supabase
-- SQL editor covers this via default privileges, but we grant explicitly
-- so the schema is self-contained and portable (local CLI, psql, etc.).
-- =====================================================================
grant usage on schema public to anon, authenticated;
do $$
declare t text;
begin
  foreach t in array array['accounts','trades','cash_transactions','skipped_trades','weekly_reviews','daily_plans','goals','journal_meta']
  loop
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated;', t);
  end loop;
end $$;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;

-- =====================================================================
-- Row Level Security — users can only see/modify their own rows
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['accounts','trades','cash_transactions','skipped_trades','weekly_reviews','daily_plans','goals','journal_meta']
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "own_select" on public.%I;', t);
    execute format('drop policy if exists "own_insert" on public.%I;', t);
    execute format('drop policy if exists "own_update" on public.%I;', t);
    execute format('drop policy if exists "own_delete" on public.%I;', t);
    execute format('create policy "own_select" on public.%I for select using (auth.uid() = user_id);', t);
    execute format('create policy "own_insert" on public.%I for insert with check (auth.uid() = user_id);', t);
    execute format('create policy "own_update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id);', t);
    execute format('create policy "own_delete" on public.%I for delete using (auth.uid() = user_id);', t);
  end loop;
end $$;

-- =====================================================================
-- Storage bucket for trade screenshots (private, per-user folders)
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('screenshots', 'screenshots', false)
on conflict (id) do nothing;

-- Policies: objects live under a folder named after the user's uid,
-- e.g. "<uid>/<trade_id>.png". Users may only touch their own folder.
drop policy if exists "screenshots_select" on storage.objects;
drop policy if exists "screenshots_insert" on storage.objects;
drop policy if exists "screenshots_update" on storage.objects;
drop policy if exists "screenshots_delete" on storage.objects;

create policy "screenshots_select" on storage.objects
  for select using (
    bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "screenshots_insert" on storage.objects
  for insert with check (
    bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "screenshots_update" on storage.objects
  for update using (
    bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "screenshots_delete" on storage.objects
  for delete using (
    bucket_id = 'screenshots' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- =====================================================================
-- Realtime — publish the tables so subscriptions work
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['accounts','trades','cash_transactions','skipped_trades','weekly_reviews','daily_plans','goals','journal_meta']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I;', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;
