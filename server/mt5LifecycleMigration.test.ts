import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/0012_mt5_open_trade_lifecycle.sql", import.meta.url), "utf8");

describe("MT5 OPEN-to-CLOSED journal migration", () => {
  it("persists one account-ticket journal identity for both OPEN and CLOSED payloads", () => {
    expect(migration).toContain("create or replace function public.gj_sync_mt5_position");
    expect(migration).toContain("if target_status not in ('OPEN', 'CLOSED') then");
    expect(migration).toContain("insert into public.gj_trades");
    expect(migration).not.toContain("if target_status = 'CLOSED' then\n    insert into public.gj_trades");
    expect(migration).toContain('on conflict ("accountId", "mt5Ticket") do update set');
  });

  it("keeps final close rows terminal while allowing the first OPEN payload to create the journal row", () => {
    expect(migration).toContain("if existing_status = 'CLOSED' then\n    return false;");
    expect(migration).toContain('"result" = excluded."result"');
    expect(migration).toContain('"pnl" = excluded."pnl"');
  });
});
