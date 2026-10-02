-- AI report kind: analyst and mentor reports share one table, and the
-- de-duplication key was (user, account, data fingerprint) — so a mentor
-- report on the same dataset as an analyst report was silently dropped and
-- its edge/experiment rows were attached to the analyst report's id. The
-- report kind joins the fingerprint key so the two coexist, and history can
-- tell them apart. Existing rows default to 'analysis' (the original save
-- path). Additive and idempotent.

alter table public.gj_ai_reports add column if not exists "feature" varchar(16) not null default 'analysis';

alter table public.gj_ai_reports drop constraint if exists gj_ai_reports_owner_fingerprint_unique;
alter table public.gj_ai_reports add constraint gj_ai_reports_owner_fingerprint_unique unique ("userId", "accountId", "dataFingerprint", "feature");
