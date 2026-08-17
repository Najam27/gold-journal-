import { beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit, rateLimitTestHooks } from "./rateLimit";

describe("scoped rate limiter", () => {
  beforeEach(() => rateLimitTestHooks.reset());

  it("allows up to the endpoint limit and rejects the next request in the window", () => {
    expect(consumeRateLimit("test", "user-a", 2, 1_000, 10_000)).toBe(true);
    expect(consumeRateLimit("test", "user-a", 2, 1_000, 10_001)).toBe(true);
    expect(consumeRateLimit("test", "user-a", 2, 1_000, 10_002)).toBe(false);
    expect(consumeRateLimit("test", "user-b", 2, 1_000, 10_002)).toBe(true);
  });

  it("opens a new window after expiry and bounds bucket storage", () => {
    expect(consumeRateLimit("test", "user-a", 1, 1_000, 20_000)).toBe(true);
    expect(consumeRateLimit("test", "user-a", 1, 1_000, 21_000)).toBe(true);
    for (let index = 0; index < 10_020; index += 1) consumeRateLimit("test", `user-${index}`, 1, 60_000, 30_000);
    expect(rateLimitTestHooks.size()).toBeLessThanOrEqual(10_000);
  });
});
