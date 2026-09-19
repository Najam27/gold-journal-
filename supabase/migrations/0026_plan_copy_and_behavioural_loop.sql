-- Apply after 0025. Additive plan-copy provenance and behavioural feedback loop.
--
-- Why: the daily plan already stores the planning fields, the pre-session
-- check-in, and the after-close scorecard. Two things were missing:
--   1. provenance — a plan built by copying a previous session had no record of
--      which session it was copied from, so the UI could not say "Based on …"
--      after a refresh; and
--   2. the behavioural loop — the selected psychological triggers, the verdict
--      on the single behavioural objective, and the short post-session
--      behavioural review had nowhere to live, so trigger history could not be
--      measured from real journal data.
--
-- This migration only adds nullable columns and checks that accept NULL. It
-- never deletes, moves, or rewrites a plan, trade, goal, or MT5 row, changes no
-- P&L value, and every existing row stays valid with NULL in the new columns.

-- 1. Copy provenance ---------------------------------------------------------
-- Which saved plan the draft was copied from. Recorded for context only: the
-- source row is never read at render time as a template, never mutated, and
-- never referenced by foreign key, so removing a source plan cannot break a
-- later session.

alter table public.gj_daily_plans add column if not exists "copiedFromPlanId" integer;
alter table public.gj_daily_plans add column if not exists "copiedFromPlanDate" timestamptz;

-- 2. Behavioural loop --------------------------------------------------------
-- psychologyTriggers          jsonb array of trigger keys selected after the session
-- primaryPsychologyTrigger    the single biggest psychological mistake of the session
-- behavioralObjectiveStatus   whether the one objective held: YES / PARTIALLY / NO
-- postSessionBehavioralReview jsonb object: follow-plan verdict, biggest deviation,
--                             next-session change, and what the trigger caused

alter table public.gj_daily_plans add column if not exists "psychologyTriggers" jsonb;
alter table public.gj_daily_plans add column if not exists "primaryPsychologyTrigger" varchar(60);
alter table public.gj_daily_plans add column if not exists "behavioralObjectiveStatus" varchar(16);
alter table public.gj_daily_plans add column if not exists "postSessionBehavioralReview" jsonb;

alter table public.gj_daily_plans drop constraint if exists gj_daily_plan_objective_status_valid;
alter table public.gj_daily_plans add constraint gj_daily_plan_objective_status_valid
  check ("behavioralObjectiveStatus" is null or "behavioralObjectiveStatus" in ('YES', 'PARTIALLY', 'NO'));

alter table public.gj_daily_plans drop constraint if exists gj_daily_plan_triggers_is_array;
alter table public.gj_daily_plans add constraint gj_daily_plan_triggers_is_array
  check ("psychologyTriggers" is null or jsonb_typeof("psychologyTriggers") = 'array');

alter table public.gj_daily_plans drop constraint if exists gj_daily_plan_review_is_object;
alter table public.gj_daily_plans add constraint gj_daily_plan_review_is_object
  check ("postSessionBehavioralReview" is null or jsonb_typeof("postSessionBehavioralReview") = 'object');

-- Rows written before this migration keep NULL in every new column: "not
-- recorded" is the honest state for a session that never answered these
-- questions, and the UI must show an empty state rather than fabricate one.

comment on column public.gj_daily_plans."psychologyTriggers" is 'Trigger keys selected in the post-session behavioural review; NULL when the session was not reviewed.';
comment on column public.gj_daily_plans."behavioralObjectiveStatus" is 'Verdict on the single behavioural objective for the session: YES, PARTIALLY, or NO.';
comment on column public.gj_daily_plans."copiedFromPlanId" is 'Saved plan this draft was copied from. Provenance only; never used as a live template.';
