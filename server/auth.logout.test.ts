import { describe, expect, it, vi } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(): { ctx: TrpcContext; clearCookie: ReturnType<typeof vi.fn> } {
  const clearCookie = vi.fn();
  const user: AuthenticatedUser = {
    id: 1,
    openId: "supabase-user-uuid",
    email: "sample@example.com",
    name: "Sample User",
    loginMethod: "supabase",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  const ctx: TrpcContext = {
    user,
    req: { headers: {} } as TrpcContext["req"],
    res: { clearCookie } as unknown as TrpcContext["res"],
  };
  return { ctx, clearCookie };
}

describe("Supabase auth procedures", () => {
  it("returns the mapped Supabase user from auth.me", async () => {
    const { ctx } = createAuthContext();
    await expect(appRouter.createCaller(ctx).auth.me()).resolves.toMatchObject({ openId: "supabase-user-uuid", loginMethod: "supabase" });
  });

  it("surfaces a controlled profile-sync error when token verification infrastructure fails", async () => {
    const { ctx } = createAuthContext();
    ctx.authError = new Error("secret service detail must not leak");
    await expect(appRouter.createCaller(ctx).auth.me()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "Secure profile sync is temporarily unavailable." });
  });

  it("returns sign-out compatibility success without managing a server cookie", async () => {
    const { ctx, clearCookie } = createAuthContext();
    await expect(appRouter.createCaller(ctx).auth.logout()).resolves.toEqual({ success: true });
    expect(clearCookie).not.toHaveBeenCalled();
  });
});
