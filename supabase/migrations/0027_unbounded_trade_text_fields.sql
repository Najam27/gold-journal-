-- Apply after 0026. Remove the artificial character budgets from Trade Log text.
--
-- Why: editing a trade failed whenever a free-text field grew past a column
-- width. The journal stores human descriptions — a Mistake explanation, a Level
-- / confluence list, an execution note, an emotional write-up — and a bounded
-- VARCHAR turned "the trader wrote more than the schema expected" into a save
-- error. The caps were an artifact of the original MySQL-shaped schema, not a
-- domain rule: nothing in the psychology engine, the analysis engine, the PDF
-- export, or the option store depends on a maximum width.
--
-- What changes:
--   gj_trades     the free-text columns below become `text`, which in
--                 PostgreSQL is the unbounded variable-length string type. The
--                 `default ''` values are preserved. `session` is included
--                 because it is an option-backed label with no check constraint,
--                 so a custom Session option must never be wider than the
--                 column it feeds.
--   gj_option_lists  "value" and "normalizedValue" become `text` as well, so a
--                 legitimate long custom option (for example a descriptive
--                 Mistake label) is not silently narrower than the trade column
--                 it feeds. Duplicate detection and category validation are
--                 unchanged: they live in the application layer and the unique
--                 ("userId","category","value") constraint is untouched.
--
-- Safety: `alter column ... type text` is a binary-coercible, in-place widening
-- of varchar to text. It is idempotent, never rewrites or truncates a value,
-- keeps every default and index, drops no column, deletes no row, and does not
-- touch P&L, MT5 tickets, screenshots, psychology, or analysis data. Every
-- existing row stays byte-for-byte identical; only the maximum length is gone.
--
-- Structured and security-sensitive fields are deliberately NOT changed:
--   direction, result, planStatus, session  bounded enums/labels
--   patienceScore, risk, reward, pnl, mfe, mae  numeric
--   mt5Ticket, clientMutationId, screenshotKey, screenshotName  identifiers

-- 1. Free-form trade journal text ---------------------------------------------
alter table public.gj_trades
  alter column "session" type text,
  alter column "level" type text,
  alter column "timeframe" type text,
  alter column "setupQuality" type text,
  alter column "executionType" type text,
  alter column "marketCondition" type text,
  alter column "biasAlignment" type text,
  alter column "confirmationType" type text,
  alter column "slPlacement" type text,
  alter column "tpPlacement" type text,
  alter column "mistake" type text,
  alter column "holdQuality" type text;

-- 2. Reusable option labels ----------------------------------------------------
alter table public.gj_option_lists
  alter column "value" type text,
  alter column "normalizedValue" type text;

-- 3. Document the contract for future readers ----------------------------------
comment on column public.gj_trades."session" is 'Free-text session label recorded with the trade. Unbounded so a custom session option can always be saved.';
comment on column public.gj_trades."level" is 'Free-text level / confluence recorded with the trade. Unbounded: never truncated.';
comment on column public.gj_trades."timeframe" is 'Free-text timeframe recorded with the trade. Unbounded: never truncated.';
comment on column public.gj_trades."setupQuality" is 'Free-text setup quality label. Unbounded: never truncated.';
comment on column public.gj_trades."executionType" is 'Free-text execution type. Unbounded: never truncated.';
comment on column public.gj_trades."marketCondition" is 'Free-text market condition tags. Unbounded: never truncated.';
comment on column public.gj_trades."biasAlignment" is 'Free-text bias-alignment label. Unbounded: never truncated.';
comment on column public.gj_trades."confirmationType" is 'Free-text confirmation signal tags. Unbounded: never truncated.';
comment on column public.gj_trades."slPlacement" is 'Free-text stop-loss placement note. Unbounded: never truncated.';
comment on column public.gj_trades."tpPlacement" is 'Free-text take-profit placement note. Unbounded: never truncated.';
comment on column public.gj_trades."mistake" is 'Pipe-separated behavioural mistake tags. Unbounded: history, custom tags, and psychology classification are never truncated.';
comment on column public.gj_trades."holdQuality" is 'Free-text position-management quality note. Unbounded: never truncated.';
comment on column public.gj_option_lists."value" is 'Reusable Trade Log option label. Unbounded free text; duplicates are prevented by the normalizedValue comparison key.';
