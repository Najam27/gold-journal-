-- Backfill Risk auto-detection for MT5-linked trades that were journaled
-- before entry/SL/TP prices were written onto the trade row (pre-2026-10-06
-- syncs only stored risk/reward/pnl), and clean up fake-zero risk/reward the
-- EA sends when it could not compute them (no SL/TP on the position).
--
-- Only fills fields that are currently NULL: a value the trader typed or a
-- previous sync wrote is never overwritten. Excursions are stored on the
-- trade as positive magnitudes (MFE +$250, MAE $180) while the position row
-- keeps signed extremes, so they are converted here.
update public.gj_trades t
set
  "entryPrice" = coalesce(t."entryPrice", p."openPrice"),
  "slPrice" = coalesce(t."slPrice", p."slPrice"),
  "tpPrice" = coalesce(t."tpPrice", p."tpPrice"),
  risk = coalesce(t.risk, nullif(p."riskUsd", 0)),
  reward = coalesce(t.reward, nullif(p."rewardUsd", 0)),
  mfe = coalesce(t.mfe, greatest(p."mfeUsd", 0)),
  mae = coalesce(t.mae, abs(least(p."maeUsd", 0)))
from public.gj_mt5_live_positions p
where t."mt5Ticket" is not null
  and t."accountId" = p."accountId"
  and t."mt5Ticket" = p.ticket
  and (
    t."entryPrice" is null or t."slPrice" is null or t."tpPrice" is null
    or t.risk is null or t.reward is null or t.mfe is null or t.mae is null
  );

-- Fake zeros: the EA sends 0 for risk/reward when there is no SL/TP to
-- compute them from. 0 is "unavailable", never a detected $0.00.
update public.gj_trades
set risk = null
where "mt5Ticket" is not null and risk = 0;

update public.gj_trades
set reward = null
where "mt5Ticket" is not null and reward = 0;
