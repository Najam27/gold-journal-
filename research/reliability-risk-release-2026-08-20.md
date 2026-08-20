# Gold Journal Reliability and Live MT5 Risk Calculator Release

**Scope.** This release adds account-scoped offline replay for safe manual trade and cash creation, visible queued-save state, MT5 freshness and history diagnostics, bounded closed-position integrity checks, more scalable journal aggregate loading, and a dedicated Risk Calculator entry in the existing sidebar. It preserves fixed PKT business dates, account isolation, MT5 ownership, Edit/Delete behavior, and the existing no-order-placement product boundary.

## Reliability contract

The browser queues only **new manual trades** and **cash movements** when offline. Each queued item carries the authenticated subject, active account, and a UUID-like client mutation identifier. Replay occurs only after the same user and same account are active; destructive edits, deletes, screenshot uploads, and account changes are deliberately not queued. The additive database migration makes client mutation identifiers unique per `(userId, accountId)` for both safe write types, and the server returns the existing record when a replay identifier is repeated.

Trade Log pages already fetch a bounded visible page. The journal-wide aggregate response no longer creates signed screenshot URLs for every historical trade, because calendar, goals, and summary consumers do not need them. The visible Trade Log page remains responsible for its own bounded signed screenshot hydration.

MT5 Live now derives a client-safe connection health state from the latest EA contact and history status. Integrity diagnostics report stale MT5 contact, failed history batches, and a bounded count of closed terminal positions not yet represented in Trade Log. No diagnostic changes journal data.

## Risk Calculator contract

The upgraded downloadable Expert Advisor is **v2.3**. Its authenticated `summary` event reports the selected chart symbol by default, or the optional `RiskSymbol` input, plus broker-provided tick size, loss tick value, contract size, and minimum/maximum/step volume. The server persists these values only when the complete positive contract is present, and never accepts an account identifier from the terminal payload.

The calculator requires a trader-entered entry and different stop loss. It selects balance or live equity, computes the maximum cash risk from the user-selected percentage, computes loss per lot from the broker’s tick values, and rounds **down** to the reported volume step. It returns warnings instead of a lot size when live account data or broker constraints are missing, when the result is below the broker minimum, when free margin is not positive, or when requested risk is out of the supported 0–10% range. It never sends an MT5 order and does not replace the terminal’s final margin/order validation.

The optional AI Risk Coach reuses only server-side OpenRouter configuration. It receives a compact deterministic calculation result, has a 20-second deadline and per-user six-per-ten-minute limit, must return structured JSON, and is rejected if it emits BUY/SELL/long/short/timing/target language. It can provide process cautions and verification steps; it does not predict price, advise a trade direction, alter calculation math, or receive a browser-visible API key.

## Deployment order

1. Apply `0011_atomic_mt5_history_batch.sql`, `0012_mt5_open_trade_lifecycle.sql`, then **`0013_offline_replay_and_mt5_symbol_specs.sql`** in the Supabase SQL Editor, in that order. Migration 0013 is additive and introduces no client grants.
2. Configure server-side Netlify variables `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` only if AI Risk Coach should be available. Do not put an OpenRouter key in `VITE_*` variables or browser storage.
3. Deploy the GitHub `main` branch. The service-worker static cache changes from `v16` to `v17` so installed clients can activate the updated bundle.
4. Download the new EA v2.3 from MT5 Live/Risk Calculator, replace the old EA in MT5, retain the active connection API key and connection ID, and use the chart symbol or set `RiskSymbol` to the broker’s intended XAUUSD symbol. Wait for a new summary event before calculating a lot.

## Validation record

The focused suite covers offline queue scope/order/failure retention, broker risk rounding, broker-minimum refusal, free-margin warnings, risk limits, MT5 health states, no-key AI fallback, and authenticated MT5 broker-spec ingestion. Full validation passed: **76 test files, 246 tests passed, 2 intentionally skipped**, along with the source-schema audit, TypeScript check, production build, and service-worker syntax check.

The production package audit retains three known high advisories: two `xlsx` advisories that apply to untrusted spreadsheet **reading** while this app only exports workbook data, and the Express `path-to-regexp` advisory. The application routes use fixed `/api/*` paths rather than the multi-parameter route pattern described by that advisory. Replacing `xlsx` or moving to a framework major is a separate compatibility project and was not mixed into this release.

## References

[1]: https://www.mql5.com/en/docs/constants/environment_state/accountinformation "MQL5 Account Information"
[2]: https://www.mql5.com/en/docs/constants/environment_state/marketinfoconstants "MQL5 Symbol Properties"
[3]: https://openrouter.ai/docs/guides/features/structured-outputs "OpenRouter Structured Outputs"
