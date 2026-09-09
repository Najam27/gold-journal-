/**
 * Cloudflare Worker request router for Gold Journal.
 *
 * Serves the exact Netlify Function surface on one origin:
 *   POST /api/mt5 and /mt5        - EA sync payloads (raw MQL5 JSON bodies)
 *   GET|HEAD /api/mt5/compat      - EA compatibility probe
 *   GET|HEAD /api/mt5/ea          - generated GoldJournal_EA.mq5 for this origin
 *   POST /api/trpc (+ GET queries)- tRPC application API (Supabase bearer auth)
 *   POST /api/ai-job-dispatch     - durable AI job start (runs under waitUntil)
 * Everything else: static assets from the `ASSETS` binding with an SPA
 * index.html fallback, exactly like the Netlify `/*` redirect.
 *
 * This module imports no Node built-ins and no platform types so it runs
 * unchanged under Node (Vitest) and workerd.
 */
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { runAiJob, parseAiJobDispatchRequest } from "../server/aiJobs";
import { buildUserContext, readAuthorizationHeader } from "../server/_core/context";
import { appRouter } from "../server/routers";
import { MT5_EA_MIN_VERSION, MT5_PAYLOAD_VERSION, ingestMt5Text } from "../server/mt5Ingest";
import { buildMt5Endpoint, hasPlausibleEaSource, renderMt5EaTemplate } from "../server/mt5EaCore";

const MT5_BODY_LIMIT_BYTES = 256 * 1024;
const TRPC_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

export type WorkerAssetBinding = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
export type WorkerEnv = {
  ASSETS: WorkerAssetBinding;
  NODE_ENV?: string;
  [key: string]: unknown;
};

const noStoreHeaders = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  "CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Authorization, Cookie",
};

function securityHeaders(env: WorkerEnv) {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  if (env.NODE_ENV === "production") headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function decorateResponse(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}

function apiHeaders(env: WorkerEnv) {
  return { ...securityHeaders(env), ...noStoreHeaders };
}

function contentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

async function readTextLimited(request: Request, limit: number): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const declared = contentLength(request);
  if (declared !== null && declared > limit) return { ok: false, response: json(413, { ok: false, code: "PAYLOAD_TOO_LARGE" }) };
  const text = await request.text();
  if (text.length > limit) return { ok: false, response: json(413, { ok: false, code: "PAYLOAD_TOO_LARGE" }) };
  return { ok: true, text };
}

async function handleMt5Ingest(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  const read = await readTextLimited(request, MT5_BODY_LIMIT_BYTES);
  if (!read.ok) return read.response;
  const outcome = await ingestMt5Text(read.text);
  return json(outcome.status, outcome.body, apiHeaders(env));
}

function handleMt5Compatibility(request: Request, env: WorkerEnv): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  return json(200, { ok: true, service: "gold-journal-mt5", minimumEaVersion: MT5_EA_MIN_VERSION, supportedPayloadVersion: MT5_PAYLOAD_VERSION }, apiHeaders(env));
}

function handleMt5EaDownload(request: Request, env: WorkerEnv, eaTemplateSource: string): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" });
  if (!hasPlausibleEaSource(eaTemplateSource)) {
    return json(503, { ok: false, code: "MT5_EA_TEMPLATE_UNAVAILABLE" }, apiHeaders(env));
  }
  const url = new URL(request.url);
  const endpoint = buildMt5Endpoint({
    forwardedHost: request.headers.get("x-forwarded-host") ?? undefined,
    host: request.headers.get("host") ?? "",
    forwardedProto: request.headers.get("x-forwarded-proto") ?? undefined,
    protocol: url.protocol.replace(":", ""),
  });
  const source = renderMt5EaTemplate(eaTemplateSource, endpoint);
  if (!source) {
    return json(400, { ok: false, code: "MT5_ENDPOINT_UNAVAILABLE" }, apiHeaders(env));
  }
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Disposition": 'attachment; filename="GoldJournal_EA.mq5"',
    ...apiHeaders(env),
  };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(source, { status: 200, headers });
}

async function handleTrpc(request: Request, env: WorkerEnv): Promise<Response> {
  if (request.method !== "POST" && request.method !== "GET" && request.method !== "OPTIONS") {
    return json(405, { ok: false, code: "METHOD_NOT_ALLOWED" }, apiHeaders(env));
  }
  if (request.method === "POST") {
    // Probe a clone so the original body stream stays intact for the adapter.
    const read = await readTextLimited(request.clone(), TRPC_BODY_LIMIT_BYTES);
    if (!read.ok) return decorateResponse(read.response, apiHeaders(env));
  }
  const response = await fetchRequestHandler({
    req: request,
    router: appRouter,
    endpoint: "/api/trpc",
    createContext: async opts => {
      const { user, authError } = await buildUserContext(readAuthorizationHeader(opts.req));
      return { req: opts.req as never, res: opts.resHeaders, user, authError };
    },
  });
  return decorateResponse(response, apiHeaders(env));
}

/**
 * Durable AI job execution on the Worker.
 *
 * The job runs inline in this invocation (OpenRouter I/O keeps the invocation
 * alive while the dispatching server-side request stays connected; Cloudflare
 * places no wall-clock limit on an HTTP invocation whose client is connected).
 * The atomic QUEUED->RUNNING claim in runAiJob guarantees a job is never
 * processed twice even if a dispatcher retries after a network cut. Jobs that
 * are still cut off stay RUNNING and the status lease marks them FAILED after
 * sixteen minutes so the UI always reaches a terminal, retryable state.
 */
async function handleAiJobDispatch(request: Request, env: WorkerEnv): Promise<Response> {
  const bodyText = request.method === "POST" ? await request.text().catch(() => null) : null;
  const parsed = parseAiJobDispatchRequest(request.method, request.headers.get("X-Gold-Journal-AI-Dispatch"), bodyText);
  if (!parsed.ok) return json(parsed.status, { ok: false, message: parsed.message }, apiHeaders(env));
  try {
    await runAiJob(parsed.jobId, parsed.token);
  } catch (error) {
    console.warn("[ai-job] worker dispatch failed", JSON.stringify({ jobId: parsed.jobId, reason: error instanceof Error ? error.message : "unknown" }));
    return json(503, { ok: false, message: "AI job execution failed on this deployment." }, apiHeaders(env));
  }
  return new Response(null, { status: 202, headers: apiHeaders(env) });
}

function handleUnknownApiRoute(request: Request, env: WorkerEnv): Response {
  return json(404, { ok: false, code: "NOT_FOUND", route: new URL(request.url).pathname }, apiHeaders(env));
}

/** SPA static serving: exact assets first, index.html fallback for client routes. */
async function serveStaticAssets(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  let response = await env.ASSETS.fetch(request);
  if (response.status !== 404 || (request.method !== "GET" && request.method !== "HEAD")) return response;
  const fallbackRequest = new Request(`${url.origin}/index.html`, request);
  const fallback = await env.ASSETS.fetch(fallbackRequest);
  if (fallback.status === 200) return new Response(fallback.body, { status: 200, headers: fallback.headers });
  return response;
}

export async function handleWorkerRequest(request: Request, env: WorkerEnv, eaTemplateSource: string): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/api/mt5" || pathname === "/mt5") return await handleMt5Ingest(request, env);
    if (pathname === "/api/mt5/compat" || pathname === "/mt5/compat") return handleMt5Compatibility(request, env);
    if (pathname === "/api/mt5/ea" || pathname === "/mt5/ea") return handleMt5EaDownload(request, env, eaTemplateSource);
    if (pathname === "/api/trpc" || pathname.startsWith("/api/trpc/")) return await handleTrpc(request, env);
    if (pathname === "/api/ai-job-dispatch") return await handleAiJobDispatch(request, env);
    if (pathname.startsWith("/api/") || pathname.startsWith("/mt5/")) return handleUnknownApiRoute(request, env);

    return await serveStaticAssets(request, env);
  } catch (error) {
    console.error("[Worker] request failed", JSON.stringify({ path: new URL(request.url).pathname, reason: error instanceof Error ? error.message : "unknown" }));
    return json(500, { ok: false, code: "INTERNAL_ERROR" }, apiHeaders(env));
  }
}
