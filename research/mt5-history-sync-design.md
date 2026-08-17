# MT5 Historical Sync and Account Metrics Design

The existing direct connection authenticates every event with the account-specific API key and performs ticket-level upserts. The expansion retains that trust boundary: the Expert Advisor never supplies a Gold Journal user or account identifier, and the server derives the account solely from the active API key.

The Expert Advisor will send a compact `summary` event with the latest MT5 balance, equity, margin, free margin, floating P&L, currency, and terminal login. It will also send bounded `history_batch` events after first attachment or a user-controlled EA refresh. Each batch is limited to fifty closed MT5 deals and upserts by `(accountId, ticket)`, making retries safe. The current five-requests-per-second API-key limit remains in force; the EA sends one batch on each timer cycle rather than flooding the endpoint.

Historical closed records will be shown through a protected paginated query. A closed MT5 record is not automatically inserted into the manual Gold Journal trade log; the trader must still select **Journal now**. This preserves analysis quality and avoids auto-filling fields that the terminal cannot know, such as setup context, behavior tags, or execution review.
