# MT5 First-Contact Recovery Audit

**Author:** Manus AI  
**Date:** 2026-08-23  
**Scope:** Production MT5 connection that has journaled historical trades but remains in a first-contact waiting state.

## Evidence-Based Finding

The screenshot shows an active, selected-account connection record but no `lastPing` or live account snapshot. This differs from a missing connection record: the application has not accepted a current authenticated terminal request for this connection. The public production endpoint `POST https://topgjournal.netlify.app/api/mt5` responds with JSON through Netlify, confirming that the public route resolves to the API handler; the unauthenticated probe was deliberately rejected by payload validation.

The audited source previously allowed an optional `connection_id` field to reject a request even after its API key had already resolved the exact active connection. This value is not needed for authorization: the opaque API key is the only credential that identifies the owner and journal account. A stale client-side connection identifier can therefore create a no-contact state after a connection is recreated or a key is rotated. The repair makes API-key resolution authoritative and preserves backwards compatibility for older payloads.

> The official MQL5 documentation states that `WebRequest()` must use a URL listed under **Tools → Options → Expert Advisors**, returns `-1` for local request errors, and is synchronous. It also states that each Expert Advisor has its own timer queue and must start it through `EventSetTimer()`. [1] [2] [3]

## Repair

| Layer | Change | Effect |
|---|---|---|
| MT5 ingress | Ignores stale optional `connection_id` after a valid API key has resolved the connection. | A stale client-side identifier cannot block the first heartbeat or reroute data. |
| Protected connection controls | Adds confirmed API-key rotation scoped to the authenticated user, selected account, and selected connection. | The owner can recover from a lost/old one-time key without deleting historical positions or Trade Log records. |
| MT5 EA v2.5 | Removes the unnecessary Connection ID input/payload field. | New setup has only two values: the exact server URL and the matching current API key. |
| MT5 EA v2.5 | Adds terminal-connectivity, timer-start, and `WebRequest()` error diagnostics; transient failures retain bounded retry. | The MT5 Experts tab now shows whether MT5 is offline, WebRequest is not allowed, or the endpoint/key/payload was rejected. The API key is never logged. |
| MT5 Live | Adds a first-contact recovery panel whenever the selected connection has never contacted the server. | The user can issue a new key without deleting history, copy it once, and follow an exact restart sequence. |

## Deployment Acceptance Test

After deployment, download **EA v2.5** and use the recovery panel on the affected connection only if the existing one-time key is unavailable or belongs to an earlier connection. Copy the displayed server URL and new key, remove the old EA from the MT5 chart, attach v2.5 again, then wait one timer cycle.

| Expected result | Where to confirm |
|---|---|
| Compatibility heartbeat accepted | MT5 Live changes from **Waiting for MT5** to a current contact state. |
| Summary accepted | MT5 account snapshot shows balance, equity, floating P&L, and free margin. |
| Open positions accepted | MT5 Live open-position section updates without changing closed history. |
| History preserved | Existing Trade Log and MT5 history counts remain present before and after rotation. |
| WebRequest issue visible | MT5 Experts log reports a local MT5 error number and points to Expert Advisors WebRequest permission. |

## References

[1]: https://www.mql5.com/en/docs/network/webrequest "MQL5 Reference: WebRequest"
[2]: https://www.mql5.com/en/docs/eventfunctions/eventsettimer "MQL5 Reference: EventSetTimer"
[3]: https://www.mql5.com/en/docs/event_handlers/ontimer "MQL5 Reference: OnTimer"
