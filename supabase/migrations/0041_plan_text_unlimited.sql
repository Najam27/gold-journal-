-- Unlimit plan text fields: preBias, riskLimit, and behavioralFocus were
-- varchar(40/80), which rejected longer trader input at the database layer
-- even after the API stopped capping length. text has no length limit.
-- Additive and idempotent: widening varchar -> text never loses data.

alter table public.gj_daily_plans alter column "preBias" type text;
alter table public.gj_daily_plans alter column "riskLimit" type text;
alter table public.gj_daily_plans alter column "behavioralFocus" type text;
