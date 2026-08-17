# tRPC HTML Response Repair — 17 August 2026

## Root Cause

The recorded failing request was `GET /api/trpc/mt5.workspace` from the managed preview. It returned **HTTP 502**, `content-type: text/html`, and the proxy header `x-e2b-error-code: PROXY_SANDBOX_NOT_FOUND`. The API route was not returning application HTML and there was no authentication or tRPC routing contract failure: earlier and later identical authenticated tRPC batch requests returned HTTP 200 with `application/json` envelopes. The preview sandbox had been terminated, and the outer proxy rendered its HTML error page.

## Repair

The development server was restarted to restore the preview API. The tRPC fetch wrapper now checks the response content type before the tRPC parser runs. A non-JSON response from a terminated preview proxy now produces the recoverable message: **“The local preview API was temporarily unavailable. The preview server has been restarted; please retry the request.”** Other non-JSON responses produce a generic safe retry message. Valid JSON responses retain existing bearer/session handling and `credentials: include` behavior.

## Validation

Focused coverage verifies JSON success handling, the exact terminated-preview HTML 502 case, and an unexpected HTML 200 case. Full validation passed: **42 Vitest files / 129 tests**, TypeScript `--noEmit`, production build, and service-worker syntax. PWA cache generation advances from `v12` to `v13`.

This repair changes only preview/client error handling. It does not modify tRPC procedures, authentication, database writes, MT5 ingestion, trading data, or fixed UTC+5 behavior.
