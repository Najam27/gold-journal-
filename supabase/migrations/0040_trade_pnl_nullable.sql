-- P&L is unknown until it is recorded: an open trade, or a trade the trader
-- saved without a P&L, must store NULL and render as "—", never as a fake
-- $0.00. The column was NOT NULL DEFAULT 0, which forced every unknown
-- outcome to read as break-even. Additive and idempotent.
alter table public.gj_trades alter column "pnl" drop not null;
alter table public.gj_trades alter column "pnl" drop default;
