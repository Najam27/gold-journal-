import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dbSource = readFileSync(new URL("./mt5Db.ts", import.meta.url), "utf8");
const routerSource = readFileSync(new URL("./goldRouter.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/0018_mt5_connection_owner_repair.sql", import.meta.url), "utf8");

describe("MT5 connection owner integrity", () => {
  it("normalizes a legacy connection owner from the canonical account owner before workspace or API-key use", () => {
    expect(dbSource).toContain("async function canonicalizeMt5ConnectionOwner");
    expect(dbSource).toContain("from(accounts).where(eq(accounts.id, connection.accountId))");
    expect(dbSource).toContain('set({ userId: owner[0].userId })');
    expect(dbSource).toContain("canonicalConnections = await Promise.all(connections.map(connection => canonicalizeMt5ConnectionOwner(db, connection)))");
    expect(dbSource).toContain("return canonicalizeMt5ConnectionOwner(db, hashed[0])");
    expect(dbSource).toContain("return canonicalizeMt5ConnectionOwner(db, { ...legacy[0], apiKey: fingerprint })");
  });

  it("lets an owner recover an existing account-scoped connection even when its legacy userId drifted", () => {
    expect(routerSource).toContain("where(and(eq(mt5Connections.id, connectionId), eq(mt5Connections.accountId, accountId)))");
    expect(routerSource).toContain("await db.update(mt5Connections).set({ userId }).where(eq(mt5Connections.id, found[0].id))");
    expect(routerSource).toContain("where(and(eq(mt5Connections.accountId, input.accountId), eq(mt5Connections.active, true)))");
  });

  it("repairs only mismatched MT5 connection owner metadata and never deletes account, position, trade, or key data", () => {
    expect(migration).toContain("update public.gj_mt5_connections as connection");
    expect(migration).toContain('connection."userId" is distinct from account."userId"');
    expect(migration).toContain("gj_mt5_connection_account_owner_fk");
    expect(migration).not.toMatch(/\bdelete\s+from\b/i);
    expect(migration).not.toMatch(/gj_(trades|mt5_live_positions)/i);
    expect(migration).not.toContain('"apiKey"');
  });
});
