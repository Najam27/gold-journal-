-- Gold Journal: durable AI evidence and experiment history
-- Apply after 0008. Runtime access is service-role-only; the browser never receives direct table access.

create table if not exists public.gj_ai_reports (
  id serial primary key,
  "userId" integer not null,
  "accountId" integer not null,
  "analysisVersion" varchar(40) not null,
  "dataFingerprint" varchar(64) not null,
  "model" varchar(160) not null,
  "report" jsonb not null,
  "evidenceManifest" jsonb not null,
  "createdAt" timestamptz not null default now(),
  constraint gj_ai_reports_id_owner_unique unique (id, "userId", "accountId"),
  constraint gj_ai_reports_owner_fingerprint_unique unique ("userId", "accountId", "dataFingerprint"),
  constraint gj_ai_reports_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts (id, "userId") on delete cascade,
  constraint gj_ai_reports_report_object check (jsonb_typeof("report") = 'object'),
  constraint gj_ai_reports_manifest_array check (jsonb_typeof("evidenceManifest") = 'array')
);

create index if not exists gj_ai_reports_owner_account_date_idx on public.gj_ai_reports ("userId", "accountId", "createdAt" desc);

create table if not exists public.gj_ai_edge_history (
  id serial primary key,
  "reportId" integer not null,
  "userId" integer not null,
  "accountId" integer not null,
  "evidenceId" varchar(24) not null,
  "dimension" varchar(80) not null,
  "context" varchar(160) not null,
  "expectancy" numeric(14,6) not null,
  "sample" integer not null,
  "evidenceTier" varchar(80) not null,
  "confidence" varchar(16) not null,
  "claimType" varchar(32) not null,
  "createdAt" timestamptz not null default now(),
  constraint gj_ai_edge_history_report_owner_fk foreign key ("reportId", "userId", "accountId") references public.gj_ai_reports (id, "userId", "accountId") on delete cascade,
  constraint gj_ai_edge_history_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts (id, "userId") on delete cascade,
  constraint gj_ai_edge_history_report_evidence_unique unique ("reportId", "evidenceId"),
  constraint gj_ai_edge_history_sample_valid check ("sample" >= 0),
  constraint gj_ai_edge_history_confidence_valid check ("confidence" in ('HIGH', 'MEDIUM', 'LOW')),
  constraint gj_ai_edge_history_claim_type_valid check ("claimType" in ('FACT', 'HYPOTHESIS', 'RECOMMENDATION FOR TESTING'))
);

create index if not exists gj_ai_edge_history_owner_account_date_idx on public.gj_ai_edge_history ("userId", "accountId", "createdAt" desc);

create table if not exists public.gj_ai_experiment_history (
  id serial primary key,
  "reportId" integer not null,
  "userId" integer not null,
  "accountId" integer not null,
  "name" varchar(160) not null,
  "compare" text not null,
  "measure" jsonb not null,
  "requiredSample" integer not null,
  "caution" text not null,
  "status" varchar(24) not null default 'PLANNED',
  "outcome" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint gj_ai_experiment_history_report_owner_fk foreign key ("reportId", "userId", "accountId") references public.gj_ai_reports (id, "userId", "accountId") on delete cascade,
  constraint gj_ai_experiment_history_report_name_unique unique ("reportId", "name"),
  constraint gj_ai_experiment_history_account_owner_fk foreign key ("accountId", "userId") references public.gj_accounts (id, "userId") on delete cascade,
  constraint gj_ai_experiment_history_sample_valid check ("requiredSample" >= 0),
  constraint gj_ai_experiment_history_status_valid check ("status" in ('PLANNED', 'RUNNING', 'COMPLETED', 'CANCELLED')),
  constraint gj_ai_experiment_history_measure_array check (jsonb_typeof("measure") = 'array')
);

create index if not exists gj_ai_experiment_history_owner_account_date_idx on public.gj_ai_experiment_history ("userId", "accountId", "createdAt" desc);

alter table public.gj_ai_reports enable row level security;
alter table public.gj_ai_edge_history enable row level security;
alter table public.gj_ai_experiment_history enable row level security;
revoke all on table public.gj_ai_reports, public.gj_ai_edge_history, public.gj_ai_experiment_history from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_reports, public.gj_ai_edge_history, public.gj_ai_experiment_history to service_role;
grant usage, select on sequence public.gj_ai_reports_id_seq, public.gj_ai_edge_history_id_seq, public.gj_ai_experiment_history_id_seq to service_role;

comment on table public.gj_ai_reports is 'Immutable server-generated AI reports with deterministic evidence manifest.';
comment on table public.gj_ai_edge_history is 'Historical evidence rows extracted from validated AI reports.';
comment on table public.gj_ai_experiment_history is 'User-account-scoped experiments proposed by validated AI reports.';
