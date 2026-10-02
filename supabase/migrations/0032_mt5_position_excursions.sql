-- MT5 position excursions: the highest unrealized gain (MFE) and worst
-- unrealized loss (MAE) observed in a position's floating P&L while it was
-- open. The server folds every open-position sync sample into these columns,
-- so a journaled trade can carry its excursions automatically instead of the
-- trader typing them from memory. Additive and idempotent.

alter table public.gj_mt5_live_positions add column if not exists "mfeUsd" numeric(14,2);
alter table public.gj_mt5_live_positions add column if not exists "maeUsd" numeric(14,2);
