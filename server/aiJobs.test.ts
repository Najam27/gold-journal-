import { afterEach, describe, expect, it } from "vitest";
import { aiJobTestHooks } from "./aiJobs";

const originalBaseUrl = process.env.AI_JOB_WORKER_BASE_URL;
const originalUrl = process.env.URL;
const originalDeployUrl = process.env.DEPLOY_PRIME_URL;
const originalInlineFallback = process.env.AI_JOB_INLINE_FALLBACK;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalBaseUrl) process.env.AI_JOB_WORKER_BASE_URL = originalBaseUrl; else delete process.env.AI_JOB_WORKER_BASE_URL;
  if (originalUrl) process.env.URL = originalUrl; else delete process.env.URL;
  if (originalDeployUrl) process.env.DEPLOY_PRIME_URL = originalDeployUrl; else delete process.env.DEPLOY_PRIME_URL;
  if (originalInlineFallback) process.env.AI_JOB_INLINE_FALLBACK = originalInlineFallback; else delete process.env.AI_JOB_INLINE_FALLBACK;
  if (originalNodeEnv) process.env.NODE_ENV = originalNodeEnv; else delete process.env.NODE_ENV;
});

describe("durable AI job dispatch", () => {
  it("hashes an opaque dispatch token before persistence", () => {
    const token = "dispatch-token-used-only-by-the-background-worker";
    const hash = aiJobTestHooks.tokenHash(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(aiJobTestHooks.tokenHash(token)).toBe(hash);
  });

  it("uses an explicit server worker base URL without trusting request headers", () => {
    process.env.AI_JOB_WORKER_BASE_URL = "https://topgjournal.netlify.app/";
    expect(aiJobTestHooks.workerOrigin()).toBe("https://topgjournal.netlify.app");
  });

  it("allows inline processing only when explicitly enabled on a long-running process", () => {
    delete process.env.AI_JOB_WORKER_BASE_URL;
    delete process.env.URL;
    delete process.env.DEPLOY_PRIME_URL;
    delete process.env.AI_JOB_INLINE_FALLBACK;
    delete process.env.NODE_ENV;
    // Netlify does not define NODE_ENV; an undefined environment must never
    // silently auto-enable inline dispatch (the functions sandbox freezes
    // after the response and jobs would stay QUEUED forever).
    expect(aiJobTestHooks.workerOrigin()).toBe("");
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(false);

    process.env.NODE_ENV = "production";
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(false);

    // Explicit opt-in is honored (operators with a long-running process
    // server can enable inline AI jobs deliberately), including in
    // production.
    process.env.AI_JOB_INLINE_FALLBACK = "true";
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(true);
  });

  it("never auto-enables inline dispatch in an undefined Netlify environment", () => {
    delete process.env.AI_JOB_WORKER_BASE_URL;
    delete process.env.URL;
    delete process.env.DEPLOY_PRIME_URL;
    delete process.env.AI_JOB_INLINE_FALLBACK;
    delete process.env.NODE_ENV;
    expect(aiJobTestHooks.allowInlineWorkerFallback()).toBe(false);
  });
});
