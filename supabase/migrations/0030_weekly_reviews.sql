-- Guided weekly review ritual: durable storage for completed weekly reviews.
--
-- CONTEXT: the weekly review wizard walks the trader through last week's
-- stats, biggest win/loss, mistake tally, one lesson, and one rule for next
-- week. The completed review is stored here so the "First 30 trades"
-- onboarding path can verify it, the trader can revisit past reviews, and the
-- rule-for-next-week survives across devices.
--
-- COLUMNS:
--   * weekStart / weekEnd — timestamptz bounds of the reviewed week (PKT
--     Monday 00:00 → Sunday 23:59:59.999). One review per account per week is
--     enforced by a unique index; re-doing a week replaces the row via
--     upsert rather than duplicating it.
--   * statsSnapshot — jsonb copy of the computed week summary (trade count,
--     win rate, net P&L, avg R, biggest win/loss, top mistakes) frozen at
--     review time, so the review stays truthful even if trades are edited
--     later.
--   * lesson / ruleForNextWeek — the trader's own words.
--
-- SAFETY: CREATE TABLE IF NOT EXISTS plus guarded index/constraint creation
-- keeps the migration idempotent. The unique index uses a date cast so two
-- reviews for the same calendar week collide even if the stored timestamps
-- differ by milliseconds.

do $$
begin
  if to_regclass('public.gj_weekly_reviews') is null then
    create table public.gj_weekly_reviews (
      id serial primary key,
      "userId" integer not null references public.users(id) on delete cascade,
      "accountId" integer not null references public.gj_accounts(id) on delete cascade,
      "weekStart" timestamp with time zone not null,
      "weekEnd" timestamp with time zone not null,
      "statsSnapshot" jsonb,
      lesson text,
      "ruleForNextWeek" text,
      "createdAt" timestamp with time zone not null default now(),
      "updatedAt" timestamp with time zone not null default now(),
      check ("weekEnd" > "weekStart")
    );
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'gj_weekly_reviews_owner_account_week_idx') then
    create index gj_weekly_reviews_owner_account_week_idx
      on public.gj_weekly_reviews ("userId", "accountId", "weekStart" desc);
  end if;

  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'gj_weekly_reviews_owner_account_week_unique') then
    create unique index gj_weekly_reviews_owner_account_week_unique
      on public.gj_weekly_reviews ("userId", "accountId", ("weekStart"::date));
  end if;
end
$$;
