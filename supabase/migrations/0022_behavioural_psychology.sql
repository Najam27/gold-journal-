-- Apply after 0021. Additive behavioural / psychology layer.
--
-- Why: Gold Journal already stores everything needed to judge process quality
-- (setup quality, mistake tags, planned risk, emotions, plan reviews), but there
-- was no place to save the pre-trade gate, the planned-vs-unplanned marker, the
-- daily psychological check-in, or the per-trader behavioural configuration.
--
-- This migration only adds nullable columns, one new owner-scoped table, and
-- checks that accept NULL. It never deletes, moves, or rewrites a trade, plan,
-- goal, or MT5 row, and it does not change any existing P&L value.

-- 1. Trade-level process evidence -------------------------------------------

alter table public.gj_trades add column if not exists "planStatus" varchar(24);
alter table public.gj_trades add column if not exists "planChecklist" jsonb;

alter table public.gj_trades drop constraint if exists gj_trades_plan_status_valid;
alter table public.gj_trades add constraint gj_trades_plan_status_valid
  check ("planStatus" is null or "planStatus" in ('PLANNED', 'UNPLANNED', 'NOT_EVALUATED'));

-- Rows created by MT5 synchronisation stay NULL on purpose: "not evaluated" is
-- the honest state for a trade that has no manual behavioural record yet.

-- 2. Pre-session psychological check-in on the existing daily plan ----------

alter table public.gj_daily_plans add column if not exists "emotionalState" varchar(40);
alter table public.gj_daily_plans add column if not exists "energyLevel" integer;
alter table public.gj_daily_plans add column if not exists "focusLevel" integer;
alter table public.gj_daily_plans add column if not exists "confidenceLevel" integer;
alter table public.gj_daily_plans add column if not exists "stressLevel" integer;
alter table public.gj_daily_plans add column if not exists "behavioralFocus" varchar(80);
alter table public.gj_daily_plans add column if not exists "psychologyRisk" text;

alter table public.gj_daily_plans drop constraint if exists gj_daily_plan_readiness_scale_valid;
alter table public.gj_daily_plans add constraint gj_daily_plan_readiness_scale_valid
  check (
    ("energyLevel" is null or "energyLevel" between 1 and 5)
    and ("focusLevel" is null or "focusLevel" between 1 and 5)
    and ("confidenceLevel" is null or "confidenceLevel" between 1 and 5)
    and ("stressLevel" is null or "stressLevel" between 1 and 5)
  );

alter table public.gj_daily_plans drop constraint if exists gj_daily_plan_emotional_state_valid;
alter table public.gj_daily_plans add constraint gj_daily_plan_emotional_state_valid
  check (
    "emotionalState" is null
    or "emotionalState" in ('Calm', 'Neutral', 'Anxious', 'Frustrated', 'Overconfident', 'Tired')
  );

-- 3. Per-trader behavioural configuration -----------------------------------
-- Holds the identity statement, the configurable discipline-score weights, and
-- the cooldown / risk thresholds. One row per user, created on first save.

create table if not exists public.gj_trader_profiles (
  "userId" integer primary key references public.users(id) on delete cascade,
  "identityStatement" text,
  "disciplineWeights" jsonb,
  "behaviorConfig" jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

alter table public.gj_trader_profiles enable row level security;

drop policy if exists "trader profiles owner access" on public.gj_trader_profiles;
create policy "trader profiles owner access" on public.gj_trader_profiles
  for all using (public.journal_user_is("userId"))
  with check (public.journal_user_is("userId"));

revoke all on table public.gj_trader_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_trader_profiles to service_role;

comment on table public.gj_trader_profiles is 'Per-user behavioural configuration: identity statement, discipline-score weights, and cooldown thresholds.';

-- 4. Supporting index for behavioural reporting -----------------------------

create index if not exists gj_trades_owner_account_plan_status_idx
  on public.gj_trades ("userId", "accountId", "planStatus")
  where "planStatus" is not null;
