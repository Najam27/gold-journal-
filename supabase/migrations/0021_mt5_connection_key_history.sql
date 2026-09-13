-- Additive MT5 connection key history.
--
-- Why: when a user rotates or replaces an MT5 key the old key stops
-- authenticating, and the previous code could not tell the difference between
-- "the terminal is offline" and "an EA is presenting a retired key". Keeping the
-- outgoing key *fingerprint* (never the key itself) lets the ingest path record
-- AUTH_REVOKED on the exact connection so MT5 Live can say "EA key retired /
-- paste the replacement key" instead of "MT5 offline".
--
-- This migration does not delete, move, or rewrite any connection, position,
-- trade, or API-key value.

alter table public.gj_mt5_connections add column if not exists "previousApiKeyHash" varchar(64);
alter table public.gj_mt5_connections add column if not exists "previousApiKeyAt" timestamptz;

alter table public.gj_mt5_connections drop constraint if exists gj_mt5_previous_key_hash_valid;
alter table public.gj_mt5_connections add constraint gj_mt5_previous_key_hash_valid
  check ("previousApiKeyHash" is null or "previousApiKeyHash" ~ '^[a-f0-9]{64}$');

create index if not exists gj_mt5_connection_previous_key_idx
  on public.gj_mt5_connections ("previousApiKeyHash")
  where "previousApiKeyHash" is not null;
