-- Apply after 0013. User provider keys are encrypted before reaching this table.
-- There is intentionally no direct authenticated-client policy: the Netlify API
-- service role owns all reads and writes after it verifies the application user.

create table if not exists public.gj_ai_provider_settings (
  "userId" integer primary key references public.users(id) on delete cascade,
  "keyCiphertext" text not null,
  "keyIv" varchar(32) not null,
  "keyAuthTag" varchar(32) not null,
  "keyFingerprint" varchar(64) not null,
  "keyMask" varchar(40) not null,
  "model" varchar(160) not null,
  "updatedAt" timestamptz not null default now()
);

alter table public.gj_ai_provider_settings enable row level security;
revoke all on table public.gj_ai_provider_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.gj_ai_provider_settings to service_role;

comment on table public.gj_ai_provider_settings is 'Service-role-only encrypted per-user AI provider credentials; plaintext keys are never stored.';
