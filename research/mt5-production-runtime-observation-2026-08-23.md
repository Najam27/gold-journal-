# MT5 Production Runtime Observation — 23 August 2026

An authenticated observation on `https://topgjournal.netlify.app` showed the selected Gold Journal account **orion** with retained MT5 historical records but no MT5 connection row. The MT5 Live screen rendered the recovery state, including **Reconnect MT5 Live**, and stated that the historical records remain safe while a replacement connection/key is generated.

At the time of observation, the public deployment was still serving the previous **EA v2.6** guide and static download flow. This is expected before Netlify deploys the pending authoritative per-deployment EA-download release. The authenticated account view and the current terminal log together establish that the immediate terminal rejection was caused by the missing/replaced connection key, not a failed `WebRequest()` transport.

No API key, account credential, or private trade details were recorded in this note.
