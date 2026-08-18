import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock("./supabaseAdmin", () => ({ getSupabaseAdmin: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("./userDb", () => ({ getUserByOpenId: mocks.getUserByOpenId, upsertUser: mocks.upsertUser }));

import { authenticateSupabaseAccessToken } from "./supabase";

describe("Supabase access-token authentication", () => {
  beforeEach(() => {
    mocks.getUser.mockReset();
    mocks.getUserByOpenId.mockReset();
    mocks.upsertUser.mockReset();
  });

  it("maps a verified Auth UUID through the application user record", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "auth-uuid", email: "trader@example.com", user_metadata: { full_name: "Trader" } } }, error: null });
    mocks.upsertUser.mockResolvedValue({ id: 7, openId: "auth-uuid", name: "Trader" });

    await expect(authenticateSupabaseAccessToken("token")).resolves.toMatchObject({ id: 7, openId: "auth-uuid", name: "Trader" });
    expect(mocks.getUser).toHaveBeenCalledWith("token");
    expect(mocks.upsertUser).toHaveBeenCalledWith(expect.objectContaining({ openId: "auth-uuid", email: "trader@example.com", loginMethod: "supabase" }));
    expect(mocks.getUserByOpenId).not.toHaveBeenCalled();
  });

  it("rejects an invalid token without touching application-user persistence", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { message: "invalid token" } });
    await expect(authenticateSupabaseAccessToken("bad-token")).resolves.toBeNull();
    expect(mocks.getUserByOpenId).not.toHaveBeenCalled();
    expect(mocks.upsertUser).not.toHaveBeenCalled();
  });
});
