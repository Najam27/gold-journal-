import { afterEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
vi.mock("./supabaseAdmin", () => ({ getSupabaseAdmin: () => ({ rpc }) }));

import { consumeRateLimit } from "./rateLimit";

describe("distributed rate-limit failure injection", () => {
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
    rpc.mockReset();
  });

  it("fails closed when the shared RPC returns an error", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    rpc.mockResolvedValue({ data: null, error: { message: "database unavailable" } });
    await expect(consumeRateLimit("ai", 7, 1, 60_000)).resolves.toBe(false);
  });
});
