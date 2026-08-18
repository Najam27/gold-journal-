import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const rls = readFileSync(join(process.cwd(), "supabase/migrations/0002_security_rls_and_storage.sql"), "utf8");
const integrity = readFileSync(join(process.cwd(), "supabase/migrations/0006_schema_integrity.sql"), "utf8");

const tables = [
  "users",
  "gj_accounts",
  "gj_trades",
  "gj_cash_movements",
  "gj_goals",
  "gj_skipped_trades",
  "gj_daily_plans",
  "gj_option_lists",
  "gj_notification_settings",
  "gj_notification_history",
  "gj_mt5_connections",
  "gj_mt5_live_positions",
];

describe("Supabase RLS and Storage policy source", () => {
  it("enables RLS on every application table", () => {
    for (const table of tables) expect(rls).toContain(`alter table public.${table} enable row level security;`);
  });

  it("uses the explicit Auth UUID to application-user mapping", () => {
    expect(rls).toContain('where "openId" = auth.uid()::text');
    expect(rls).toContain("public.current_journal_user_id()");
    expect(rls).toContain("public.owns_journal_account");
  });

  it("keeps screenshots private and helper execution least-privileged", () => {
    expect(rls).toContain("bucket_id = 'trade-screenshots'");
    expect(rls).toContain("public.owns_screenshot_folder");
    expect(integrity).toContain("revoke all on function public.owns_screenshot_folder(text) from public, anon");
  });
});
