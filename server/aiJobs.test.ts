import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_JOB_DISPATCH_PATH, aiJobTestHooks, dispatchAiJob, parseAiJobDispatchRequest, queueAnalysisJob } from "./aiJobs";

const originalInlineFallback = process.env.AI_JOB_INLINE_FALLBACK;
const originalWorkerBase = process.env.AI_JOB_WORKER_BASE_URL;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const restore = (key: string, original: string | undefined) => { if (original !== undefined) process.env[key] = original; else delete process.env[key]; };
  restore("AI_JOB_INLINE_FALLBACK", originalInlineFallback);
  restore("AI_JOB_WORKER_BASE_URL", originalWorkerBase);
  restore("NODE_ENV", originalNodeEnv);
});

describe("durable AI job dispatch", () => {
  beforeEach(() => {
    delete process.env.AI_JOB_INLINE_FALLBACK;
    delete process.env.AI_JOB_WORKER_BASE_URL;
    delete process.env.NODE_ENV;
  });

  it("hashes an opaque dispatch token before persistence", () => {
    const token = "dispatch-token-used-only-by-the-background-worker";
    const hash = aiJobTestHooks.tokenHash(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(aiJobTestHooks.tokenHash(token)).toBe(hash);
  });

  it("posts durable AI work to the canonical deployment dispatch route", async () => {
    process.env.AI_JOB_WORKER_BASE_URL = "https://journal.example.com/";
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const dispatch = { id: "00000000-0000-0000-0000-000000000001", token: "opaque-dispatch-token-not-persisted-123" };
    await dispatchAiJob(dispatch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://journal.example.com${AI_JOB_DISPATCH_PATH}`);
    expect((init as RequestInit).headers).toMatchObject({ "X-Gold-Journal-AI-Dispatch": dispatch.token });
    expect((init as RequestInit).body).toBe(JSON.stringify({ jobId: dispatch.id }));
  });

  it("throws when the dispatch endpoint does not accept the job", async () => {
    process.env.AI_JOB_WORKER_BASE_URL = "https://journal.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const dispatch = { id: "00000000-0000-0000-0000-000000000001", token: "opaque-dispatch-token-not-persisted-123" };
    await expect(dispatchAiJob(dispatch)).rejects.toThrow(/could not be started/);
  });

  it("allows inline processing only when explicitly enabled on a long-running process", () => {
    // Undefined serverless environments must never auto-enable inline
    // dispatch: a sandbox freezes after the response and jobs stay QUEUED.
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(false);

    process.env.NODE_ENV = "production";
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(false);

    process.env.NODE_ENV = "development";
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(true);

    delete process.env.NODE_ENV;
    process.env.AI_JOB_INLINE_FALLBACK = "true";
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(true);

    process.env.AI_JOB_INLINE_FALLBACK = "false";
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(false);
  });

  it("throws a deployment error when no worker origin is configured and inline is off", async () => {
    process.env.NODE_ENV = "production";
    const dispatch = { id: "00000000-0000-0000-0000-000000000002", token: "opaque-dispatch-token-not-persisted-456" };
    await expect(dispatchAiJob(dispatch)).rejects.toThrow(/unavailable/);
  });

  it("runs inline through the in-process timer when explicitly allowed", async () => {
    process.env.AI_JOB_INLINE_FALLBACK = "true";
    const dispatch = { id: "00000000-0000-0000-0000-000000000003", token: "opaque-dispatch-token-not-persisted-789" };
    const fetchMock = vi.fn(async () => { throw new Error("must not dispatch over HTTP"); });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    try {
      await dispatchAiJob(dispatch);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps queue helpers exported for the router", async () => {
    // queueAnalysisJob requires Supabase; only assert the export exists so the
    // worker entry keeps compiling against the same surface.
    expect(typeof queueAnalysisJob).toBe("function");
  });
});

describe("dispatch endpoint input validation (shared by Worker and Express)", () => {
  it("accepts a POST with a valid token header and job id body", () => {
    const parsed = parseAiJobDispatchRequest("POST", "opaque-dispatch-token-not-persisted-123", JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000001" }));
    expect(parsed).toEqual({ ok: true, jobId: "00000000-0000-0000-0000-000000000001", token: "opaque-dispatch-token-not-persisted-123" });
  });

  it("accepts an already-parsed object body (Express JSON middleware)", () => {
    const parsed = parseAiJobDispatchRequest("POST", "opaque-dispatch-token-not-persisted-123", { jobId: "00000000-0000-0000-0000-000000000001" });
    expect(parsed.ok).toBe(true);
  });

  it("rejects wrong methods, malformed bodies, and invalid tokens", () => {
    expect(parseAiJobDispatchRequest("GET", "token-12345678901234567890123456789012345678901234567890123456", "{}").ok).toBe(false);
    expect(parseAiJobDispatchRequest("POST", "not-a-valid-token", "{}").ok).toBe(false);
    expect(parseAiJobDispatchRequest("POST", "opaque-dispatch-token-not-persisted-123", "{bad json").ok).toBe(false);
    expect(parseAiJobDispatchRequest("POST", "opaque-dispatch-token-not-persisted-123", JSON.stringify({ jobId: "not-a-uuid" })).ok).toBe(false);
    expect(parseAiJobDispatchRequest("POST", "opaque-dispatch-token-not-persisted-123", "not json at all").ok).toBe(false);
  });
});
