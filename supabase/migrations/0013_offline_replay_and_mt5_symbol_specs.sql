-- Apply after 0012. This migration is additive: it enables idempotent replay of
-- browser-queued manual writes and persists broker-provided symbol constraints
-- for risk calculation. It does not grant any client-side write authority.

alter table public.gj_trades add column if not exists "clientMutationId" varchar(64);
alter table public.gj_cash_movements add column if not exists "clientMutationId" varchar(64);
alter table public.gj_mt5_connections add column if not exists "riskSymbol" varchar(32);
alter table public.gj_mt5_connections add column if not exists "riskTickSize" numeric(18, 8);
alter table public.gj_mt5_connections add column if not exists "riskTickValueLoss" numeric(18, 8);
alter table public.gj_mt5_connections add column if not exists "riskContractSize" numeric(18, 8);
alter table public.gj_mt5_connections add column if not exists "riskVolumeMin" numeric(18, 8);
alter table public.gj_mt5_connections add column if not exists "riskVolumeMax" numeric(18, 8);
alter table public.gj_mt5_connections add column if not exists "riskVolumeStep" numeric(18, 8);
alter table public.gj_mt5_connections add column if not exists "riskSymbolUpdatedAt" timestamptz;

create unique index if not exists gj_trades_owner_account_client_mutation_unique
  on public.gj_trades ("userId", "accountId", "clientMutationId")
  where "clientMutationId" is not null;
create unique index if not exists gj_cash_owner_account_client_mutation_unique
  on public.gj_cash_movements ("userId", "accountId", "clientMutationId")
  where "clientMutationId" is not null;

alter table public.gj_mt5_connections drop constraint if exists gj_mt5_risk_tick_size_valid;
alter table public.gj_mt5_connections add constraint gj_mt5_risk_tick_size_valid check ("riskTickSize" is null or "riskTickSize" > 0);
alter table public.gj_mt5_connections drop constraint if exists gj_mt5_risk_tick_value_valid;
alter table public.gj_mt5_connections add constraint gj_mt5_risk_tick_value_valid check ("riskTickValueLoss" is null or "riskTickValueLoss" > 0);
alter table public.gj_mt5_connections drop constraint if exists gj_mt5_risk_volume_valid;
alter table public.gj_mt5_connections add constraint gj_mt5_risk_volume_valid check ("riskVolumeMin" is null or "riskVolumeMax" is null or "riskVolumeStep" is null or ("riskVolumeMin" > 0 and "riskVolumeMax" >= "riskVolumeMin" and "riskVolumeStep" > 0));
