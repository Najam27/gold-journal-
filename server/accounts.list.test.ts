import { describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "./_core/context";

const mocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("./db", () => ({ getDb: mocks.getDb }));

import { goldRouter } from "./goldRouter";

function createContext(): TrpcContext {
  return { user: { id: 7, openId: "user-7", email: "user@example.com", name: "User", loginMethod: "supabase", role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date() }, req: { headers: {} } as TrpcContext["req"], res: {} as TrpcContext["res"] };
}

describe("accounts.list", () => {
  it("returns only the authenticated user's safe account metadata", async () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const updatedAt = new Date("2026-01-02T00:00:00Z");
    const rows = [{ id: 12, userId: 7, name: "Primary Account", startingBalance: "100.00", createdAt, updatedAt }];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    mocks.getDb.mockResolvedValue({ select: vi.fn(() => ({ from })) });

    const result = await goldRouter.createCaller(createContext()).accounts.list();

    expect(result).toEqual([{ id: 12, name: "Primary Account", startingBalance: "100.00", createdAt, updatedAt }]);
    expect(result[0]).not.toHaveProperty("userId");
  });
});
