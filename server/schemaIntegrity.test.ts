import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/0006_schema_integrity.sql"), "utf8");
const schema = readFileSync(join(process.cwd(), "drizzle/schema.ts"), "utf8");

describe("Supabase schema-integrity migration", () => {
  it("preflights incompatible rows before adding confirmed domain constraints", () => {
    expect(migration).toContain("existing data violates schema integrity checks");
    for (const name of [
      "gj_users_role_valid",
      "gj_accounts_starting_balance_nonnegative",
      "gj_trades_direction_valid",
      "gj_trades_result_valid",
      "gj_cash_amount_positive",
      "gj_skipped_confidence_valid",
      "gj_daily_plan_execution_score_valid",
      "gj_mt5_position_status_valid",
      "gj_mt5_closed_position_complete",
    ]) expect(migration).toContain(name);
  });

  it("protects RLS helper execution and notification deduplication", () => {
    expect(migration).toContain("revoke all on function public.current_journal_user_id() from public, anon");
    expect(migration).toContain('create unique index if not exists "gj_notification_user_type_unique"');
    expect(migration).toContain("group by \"userId\", \"type\" having count(*) > 1");
  });

  it("defines PostgreSQL-owned updatedAt triggers and matching Drizzle metadata", () => {
    expect(migration).toContain("create index if not exists \"gj_mt5_live_account_status_close_idx\"");
    expect(migration).toContain("create or replace function public.gj_set_updated_at()");
    expect(migration).toContain("create trigger gj_mt5_live_positions_updated_at");
    expect(schema).toContain("gj_notification_user_type_unique");
    expect(schema).toContain("gj_mt5_closed_position_complete");
  });
});
