# MT5 Live Scope Observation — 23 August 2026

An authenticated production observation showed a single selected Gold Journal account named **orio** in the sidebar. The page shell displayed an account balance of `$0.00` while the user-provided MT5 Experts output from the same period showed successful API authentication, summary sync, open-position sync, and history acceptance.

The mismatch is not an MT5 terminal transport failure. The UI's workspace request is scoped to the selected journal account, while the EA ingress resolves its target only from the API key's connection row. The next audit steps must determine which account ID the successful key resolves to and ensure the user has a deterministic, non-destructive recovery path for the selected account.

No API key, password, personal token, or trade detail is recorded in this note.

Direct Supabase dashboard inspection could not be performed because the connected browser has no authenticated Supabase dashboard session. The audit therefore remains limited to production API behavior, authenticated Gold Journal UI behavior, executable source, and regression coverage unless the user later elects to provide dashboard access.

A repeat authenticated production check again showed **orio** as the only selected account and `$0.00` in the dashboard summary. This is consistent with the MT5 workspace query returning no connection/snapshot for the selected account, even though the terminal's API-key-scoped request sequence reports successful persistence elsewhere.

The account manager confirmed **orio** is the only account exposed to the authenticated UI and contains one existing journal trade. A direct browser navigation to the protected `accounts.list` tRPC route returned `Please login (10001)`, which confirms the application uses its runtime authenticated transport rather than a navigation cookie for protected requests. This is not evidence of a user-session timeout inside the running application, which visibly loaded the account manager and its journal data.

After the owner-normalization deployment, the authenticated MT5 Live page displayed an actual active connection card for the selected account instead of the previous missing-connection panel. Its state was `WAITING FOR MT5`, with no summary, open-position, or history contact recorded. This proves the prior UI invisibility is repaired; the remaining production state is now a key/contact lifecycle issue rather than a workspace-read failure.

## Full Production-Path Audit Findings

The PWA service worker explicitly bypasses `/api/` and `/storage/` requests, so it cannot cache a stale MT5 API response. The frontend uses a current Supabase bearer access token for tRPC calls and the authenticated production page successfully loaded the selected account and its journal, which rules out an unreported session expiry as the cause of the MT5 Live waiting state.

The public production homepage, `/api/mt5/compat`, and `/api/mt5/ea` each returned HTTP 200 after the Netlify deployment recovery. The direct internal function URL returning 404 is expected because the public `/api/*` redirect is the supported ingress path. Netlify's temporary build block was caused by value-based scans of a public storage-bucket identifier and public redirect origin, not a function bundle error; the narrow omission configuration retained scanning for all other keys.

The Supabase adapter has a 15-second bounded server-side request timeout. Static migration and RPC audits confirm the expected MT5 history/open/close RPC contracts are represented through migration 0018, but direct live Supabase schema inspection remains unavailable without an authenticated Supabase dashboard session. The visible active connection remains in first-contact waiting state, which is consistent with the current EA carrying a key that was superseded when the replacement/rotation flow reset connection contact fields.
