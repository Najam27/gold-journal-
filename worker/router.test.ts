import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWorkerRequest, type WorkerAssetBinding, type WorkerEnv } from "./router";
import { ingestMt5Text } from "../server/mt5Ingest";

vi.mock("../server/mt5Ingest", async importOriginal => {
  const actual = await importOriginal<typeof import("../server/mt5Ingest")>();
  return { ...actual, ingestMt5Text: vi.fn(async () => ({ status: 200, body: { ok: true, event: "ping", source: "mocked-ingest" } })) };
});

function makeEnv(assetResponse?: Response | ((request: Request) => Response)): WorkerEnv {
  const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
    if (assetResponse instanceof Response) return assetResponse;
    if (typeof assetResponse === "function") return assetResponse(new Request(request as RequestInfo));
    return new Response(null, { status: 404 });
  }) as unknown as WorkerAssetBinding["fetch"];
  return { ASSETS: { fetch: fetchMock }, NODE_ENV: "production" } as WorkerEnv;
}

const EA_SOURCE = "EA template\nstring HasConfiguredEndpoint() { return true; }\nconst Endpoint = \"__GOLD_JOURNAL_MT5_ENDPOINT__\";\n".padStart(2_000, "x");

beforeEach(() => {
  vi.mocked(ingestMt5Text).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MT5 API surface on the Worker", () => {
  it("answers the compatibility probe with no-store and security headers", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5/compat"), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; service: string; minimumEaVersion: string; supportedPayloadVersion: string };
    expect(body).toMatchObject({ ok: true, service: "gold-journal-mt5" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("renders the EA for the exact request origin (host + forwarded proto)", async () => {
    const response = await handleWorkerRequest(new Request("https://mt5-worker-host/api/mt5/ea", { headers: { host: "journal.trader.example", "x-forwarded-proto": "https" } }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(200);
    const source = await response.text();
    expect(source).toContain("https://journal.trader.example/api/mt5");
    expect(source).not.toContain("__GOLD_JOURNAL_MT5_ENDPOINT__");
    expect(response.headers.get("content-disposition")).toContain("GoldJournal_EA.mq5");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("prefers x-forwarded-host when present (proxied origins)", async () => {
    const response = await handleWorkerRequest(new Request("https://internal/api/mt5/ea", { headers: { host: "internal", "x-forwarded-host": "cdn.trader.example" } }), makeEnv(), EA_SOURCE);
    const source = await response.text();
    expect(source).toContain("https://cdn.trader.example/api/mt5");
  });

  it("rejects EA downloads with an unusable build-time template", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5/ea", { headers: { host: "app.example.com" } }), makeEnv(), "not-a-real-ea");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "MT5_EA_TEMPLATE_UNAVAILABLE" });
  });

  it("rejects EA downloads when no public host can be derived", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5/ea", { headers: {} }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "MT5_ENDPOINT_UNAVAILABLE" });
  });

  it("ingests raw MQL5 payloads (with NUL terminator) into the shared processor", async () => {
    const raw = '{"event":"ping","api_key":"123456789012345678901234","ea_version":"2.13.0","payload_version":"2"}\u0000';
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5", { method: "POST", body: raw }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, event: "ping" });
    expect(vi.mocked(ingestMt5Text)).toHaveBeenCalledWith(raw);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the legacy /mt5 alias working", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/mt5", { method: "POST", body: "{}" }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(200);
    expect(vi.mocked(ingestMt5Text)).toHaveBeenCalled();
  });

  it("returns 413 before parsing oversized MT5 payloads", async () => {
    const oversized = JSON.stringify({ event: "history_batch", positions: [] }).padEnd(300 * 1024, " ");
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5", { method: "POST", body: oversized }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "PAYLOAD_TOO_LARGE" });
    expect(vi.mocked(ingestMt5Text)).not.toHaveBeenCalled();
  });

  it("returns 405 for non-POST requests to the ingest route", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5"), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(405);
  });
});

describe("tRPC surface on the Worker", () => {
  it("runs public procedures (system.health) without network access", async () => {
    const input = encodeURIComponent(JSON.stringify({ "0": { json: { timestamp: 1_700_000_000_000 } } }));
    const response = await handleWorkerRequest(new Request(`https://app.example.com/api/trpc/system.health?batch=1&input=${input}`), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(200);
    const payload = await response.text();
    expect(payload).toContain('"ok":true');
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns UNAUTHORIZED for protected procedures without a bearer token (no Supabase call)", async () => {
    const input = encodeURIComponent(JSON.stringify({ "0": { json: { accountId: 1 } } }));
    const response = await handleWorkerRequest(new Request(`https://app.example.com/api/trpc/journal.get?batch=1&input=${input}`), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(401);
    const payload = await response.json() as Array<{ error: { json: { data: { code?: string } } } }>;
    expect(payload[0]?.error?.json?.data?.code).toBe("UNAUTHORIZED");
  });

  it("rejects oversized tRPC bodies with 413", async () => {
    const oversized = JSON.stringify({ json: {} }).padEnd(11 * 1024 * 1024, " ");
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/trpc", { method: "POST", body: oversized }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, code: "PAYLOAD_TOO_LARGE" });
  });
});

describe("server-side AI execution is retired", () => {
  it("no longer exposes the durable AI job dispatch route", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/ai-job-dispatch", { method: "POST", headers: { "X-Gold-Journal-AI-Dispatch": "opaque-dispatch-token-not-persisted-123", "content-type": "application/json" }, body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000001" }) }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "NOT_FOUND" });
  });
});

describe("static assets and SPA fallback", () => {
  it("passes through existing assets untouched", async () => {
    const asset = new Response("<html>app</html>", { status: 200, headers: { "content-type": "text/html" } });
    const env = makeEnv(asset);
    const response = await handleWorkerRequest(new Request("https://app.example.com/index.html"), env, EA_SOURCE);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>app</html>");
  });

  it("serves index.html for unknown GET client routes (SPA deep links)", async () => {
    let calls = 0;
    const env = makeEnv(() => {
      calls += 1;
      if (calls === 1) return new Response("not found", { status: 404 });
      return new Response("<html>spa</html>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const response = await handleWorkerRequest(new Request("https://app.example.com/journal/day/2026-09-09"), env, EA_SOURCE);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>spa</html>");
  });

  it("never rewrites non-GET misses to index.html", async () => {
    let calls = 0;
    const env = makeEnv(() => {
      calls += 1;
      return new Response("missing", { status: 404 });
    });
    const response = await handleWorkerRequest(new Request("https://app.example.com/some/post/route", { method: "POST", body: "x" }), env, EA_SOURCE);
    expect(response.status).toBe(404);
    expect(calls).toBe(1);
  });
});

describe("route table edges", () => {
  it("answers unknown API routes with JSON 404", async () => {
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/nonexistent"), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("omits HSTS when NODE_ENV is not production (preview parity)", async () => {
    const env = makeEnv() as WorkerEnv & { NODE_ENV: string };
    env.NODE_ENV = "development";
    const response = await handleWorkerRequest(new Request("https://preview.workers.dev/api/mt5/compat"), env, EA_SOURCE);
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("maps unexpected handler failures to a JSON 500", async () => {
    vi.mocked(ingestMt5Text).mockRejectedValueOnce(new Error("boom"));
    const response = await handleWorkerRequest(new Request("https://app.example.com/api/mt5", { method: "POST", body: "{}" }), makeEnv(), EA_SOURCE);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "INTERNAL_ERROR" });
  });
});
