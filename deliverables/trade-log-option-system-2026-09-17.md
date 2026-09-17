# Trade Log option system — single canonical store

**Date:** 2026-09-17
**Scope:** Trade Log dropdowns (`gj_option_lists`), New/Edit Trade dialog, Options page, option manager UI.

## Problem

The Trade Log mixed two option sources: hard-coded arrays in the trade dialog
(`["A+", "A", "B"]`, session/timeframe/level lists, `behaviorChoices`) and rows in
`gj_option_lists` that only held *custom* values. Because of that:

- a Gold Journal default could not be renamed, disabled, or managed at all;
- a disabled default silently came back on the next form open;
- the Options page kept its own hard-coded category list and a second,
  custom-only management UI.

## Model

`gj_option_lists` is the single source of selectable values.

| Column | Purpose |
| --- | --- |
| `id` | stable identity; never changes when an option is renamed |
| `userId`, `category`, `value` | ownership + the editable label |
| `normalizedValue` | case/whitespace-insensitive duplicate key |
| `isDefault` | provenance only: "Gold Journal provided this initially". Still fully editable |
| `seedKey` | deterministic identity of a seeded default, so a rename never re-creates the original label |
| `active` | `false` = archived: hidden from new selections, never deleted |

`isDefault` deliberately does **not** mean "cannot edit".

## Seeding (`server/tradeOptions.ts`)

`ensureDefaultTradeOptions` runs on `optionLists.list` (and before an add) and is
non-destructive and idempotent:

1. An account that already has a seeded row is left alone.
2. A default whose normalized value already exists is **adopted**: the existing
   row is marked as the Gold Journal default and its `active` flag is kept
   exactly as it was, so a value the trader had disabled is never re-enabled.
3. Only genuinely missing defaults are inserted, guarded by
   `onConflictDoNothing` on `(userId, category, value)` with a per-row retry.

The seed key carries an FNV-1a digest of the normalized value. A slug alone maps
both `"A+"` and `"A"` to `a`, which would have made two distinct Setup-quality
defaults share one seed key and silently drop one of them.

## UI

- `client/src/components/TradeOptionManager.tsx` — one manager used from the
  Options page (panel), the floating *Rules & lists* dialog, and the gear control
  beside every Trade Log dropdown. Defaults and custom options are listed,
  renamed, disabled, and re-enabled identically; nothing is ever deleted.
- `client/src/lib/tradeOptions.ts` — derives every dropdown from the one cached
  `optionLists.list` query. Managed rows are authoritative as soon as a category
  is seeded; the registry defaults are only a fallback for a category that has
  not been seeded yet (or an unreachable store), so no dropdown is ever empty and
  a disabled option is never resurrected.
- A recorded value that no longer matches an active option is shown as
  `"<value> — Archived"`, so a historical trade stays visible and editable after
  a rename or a disable. Renaming an option never rewrites a saved trade.
- `client/src/pages/GoldJournal.tsx` — the Options page's hard-coded category
  array and custom-only pill list are gone; it renders the canonical manager.

## Verification

- `pnpm check` — clean.
- `pnpm test` — 618 passed, 2 skipped, 0 failed (99 files).
- New coverage: registry integrity and seed keys
  (`shared/tradeOptionCategories.test.ts`), selection/archived/multi-select
  helpers (`client/src/lib/tradeOptions.test.ts`), idempotent, adopting,
  ownership-scoped seeding against an in-memory query adapter
  (`server/tradeOptions.test.ts`), and the mounted manager
  (`client/src/components/TradeOptionManager.test.tsx`).
- Updated: `client/src/pages/OptionsView.test.tsx` now exercises the shared
  manager (add / disable / rename / confirmed clear) instead of the removed
  duplicate UI.

## Deployment requirement

Apply **`supabase/migrations/0024_trade_option_system.sql`** before using the
option manager. It is additive: it adds the four columns, backfills
`normalizedValue`, and adds the two indexes. It never deletes a row and never
rewrites a `value`, so existing trades keep the labels they were recorded with.
