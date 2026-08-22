import { afterEach, describe, expect, it } from "vitest";
import { aiJobTestHooks } from "./aiJobs";

const originalBaseUrl = process.env.AI_JOB_WORKER_BASE_URL;
const originalUrl = process.env.URL;
const originalDeployUrl = process.env.DEPLOY_PRIME_URL;

afterEach(() => {
  if (originalBaseUrl) process.env.AI_JOB_WORKER_BASE_URL = originalBaseUrl; else delete process.env.AI_JOB_WORKER_BASE_URL;
  if (originalUrl) process.env.URL = originalUrl; else delete process.env.URL;
  if (originalDeployUrl) process.env.DEPLOY_PRIME_URL = originalDeployUrl; else delete process.env.DEPLOY_PRIME_URL;
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
});
