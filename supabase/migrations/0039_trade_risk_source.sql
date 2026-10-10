-- Risk provenance for the MT5 reconcile: records whether a trade's Risk
-- section came from MT5 auto-detection or from the trader's own hand.
--
-- The reconcile upsert keeps MT5-linked journal rows consistent with the
-- authoritative position, but it must never silently revert a manual Risk
-- edit (the Oct-10 editable-Risk UX promises "manual wins"). With this
-- column the reconcile's conflict SET skips entry/SL/TP/risk/reward on rows
-- marked 'manual'. Null = unknown (rows written before provenance existed);
-- treated as auto-detected, which is correct for every pre-existing
-- MT5-linked row because manual Risk editing did not exist before.
-- Additive and idempotent.
alter table public.gj_trades
  add column if not exists "riskSource" text;

update public.gj_trades
   set "riskSource" = 'mt5'
 where "riskSource" is null
   and "mt5Ticket" is not null;
