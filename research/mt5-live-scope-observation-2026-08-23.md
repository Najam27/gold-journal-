# MT5 Live Scope Observation — 23 August 2026

An authenticated production observation showed a single selected Gold Journal account named **orio** in the sidebar. The page shell displayed an account balance of `$0.00` while the user-provided MT5 Experts output from the same period showed successful API authentication, summary sync, open-position sync, and history acceptance.

The mismatch is not an MT5 terminal transport failure. The UI's workspace request is scoped to the selected journal account, while the EA ingress resolves its target only from the API key's connection row. The next audit steps must determine which account ID the successful key resolves to and ensure the user has a deterministic, non-destructive recovery path for the selected account.

No API key, password, personal token, or trade detail is recorded in this note.

Direct Supabase dashboard inspection could not be performed because the connected browser has no authenticated Supabase dashboard session. The audit therefore remains limited to production API behavior, authenticated Gold Journal UI behavior, executable source, and regression coverage unless the user later elects to provide dashboard access.

A repeat authenticated production check again showed **orio** as the only selected account and `$0.00` in the dashboard summary. This is consistent with the MT5 workspace query returning no connection/snapshot for the selected account, even though the terminal's API-key-scoped request sequence reports successful persistence elsewhere.

The account manager confirmed **orio** is the only account exposed to the authenticated UI and contains one existing journal trade. A direct browser navigation to the protected `accounts.list` tRPC route returned `Please login (10001)`, which confirms the application uses its runtime authenticated transport rather than a navigation cookie for protected requests. This is not evidence of a user-session timeout inside the running application, which visibly loaded the account manager and its journal data.
