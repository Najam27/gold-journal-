-- Durable, server-only AI work records for Netlify Background Functions.
-- Job payloads contain only filters or deterministic risk-calculation context.

create table if not exists public.gj_ai_jobs (
  id varchar(36) primary key,
  "userId" integer not null references public.users(id) on delete cascade,
  "accountId" integer not null references public.gj_accounts(id) on delete cascade,
  "kind" varchar(24) not null,
  "status" varchar(24) not null default 'QUEUED',
  "dispatchHash" varchar(64) not null,
  payload jsonb not null,
  result jsonb,
  "errorMessage" varchar(500),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "completedAt" timestamptz,
  constraint gj_ai_jobs_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts(id, "userId") on delete cascade,
  constraint gj_ai_jobs_kind_valid check ("kind" in ('ANALYSIS', 'RISK_COACH')),
  constraint gj_ai_jobs_status_valid check ("status" in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'))
);

create index if not exists gj_ai_jobs_owner_status_created_idx on public.gj_ai_jobs ("userId", "status", "createdAt" desc);
alter table public.gj_ai_jobs enable row level security;
revoke all on table public.gj_ai_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_jobs to service_role;
comment on table public.gj_ai_jobs is 'Service-role-only durable work queue for user-owned asynchronous AI analysis and risk coaching.';
