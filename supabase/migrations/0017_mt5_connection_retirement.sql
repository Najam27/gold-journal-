-- Preserve account-scoped MT5 connection history. Normal application controls
-- retire a connection instead of deleting its row; only an explicit account
-- deletion may remove it through the existing account foreign-key cascade.

alter table public.gj_mt5_connections add column if not exists "retiredAt" timestamptz;
alter table public.gj_mt5_connections add column if not exists "retiredReason" varchar(64);

alter table public.gj_mt5_connections drop constraint if exists gj_mt5_retired_state_valid;
alter table public.gj_mt5_connections add constraint gj_mt5_retired_state_valid
  check ((active = true and "retiredAt" is null and "retiredReason" is null) or (active = false));

create index if not exists gj_mt5_connection_active_retired_idx
  on public.gj_mt5_connections ("accountId", active, "retiredAt" desc);
