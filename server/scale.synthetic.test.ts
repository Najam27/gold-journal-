import { beforeEach, describe, expect, it } from "vitest";
import { consumeRateLimit, rateLimitTestHooks } from "./rateLimit";

describe("bounded synthetic scale smoke tests", () => {
  beforeEach(() => rateLimitTestHooks.reset());

  it("isolates 1,000 tenant identities under concurrent in-process requests", async () => {
    const accepted = await Promise.all(Array.from({ length: 1_000 }, (_, index) => Promise.resolve(consumeRateLimit("scale", `tenant-${index}`, 1, 60_000, 10_000))));
    expect(accepted.filter(Boolean)).toHaveLength(1_000);
    expect(rateLimitTestHooks.size()).toBe(1_000);
  });

  it("rejects repeated duplicate-event attempts for one scoped key without affecting other tenants", async () => {
    const duplicateResults = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve(consumeRateLimit("duplicate-ticket", "account-a:ticket-42", 1, 60_000, 20_000))));
    expect(duplicateResults.filter(Boolean)).toHaveLength(1);
    expect(duplicateResults.slice(1).every(value => !value)).toBe(true);
    expect(consumeRateLimit("duplicate-ticket", "account-b:ticket-42", 1, 60_000, 20_000)).toBe(true);
  });
});
