import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "supabase/migrations/0006_schema_integrity.sql"), "utf8");
const atomicMigration = readFileSync(join(process.cwd(), "supabase/migrations/0004_atomic_operations.sql"), "utf8");
const productionMt5Migration = readFileSync(join(process.cwd(), "supabase/migrations/0008_production_integrity_and_analysis.sql"), "utf8");
const mt5ArityRepair = readFileSync(join(process.cwd(), "supabase/migrations/0010_fix_mt5_rpc_trade_insert_arity.sql"), "utf8");
const tradeSummary = readFileSync(join(process.cwd(), "supabase/migrations/0005_trade_summary.sql"), "utf8");
const tradeSummaryHotfix = readFileSync(join(process.cwd(), "supabase/migrations/0007_fix_trade_summary_and_accounts.sql"), "utf8");
const schema = readFileSync(join(process.cwd(), "drizzle/schema.ts"), "utf8");

function splitSqlList(input: string) {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote && input[index - 1] !== "\\") quote = null;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) { values.push(input.slice(start, index).trim()); start = index + 1; }
  }
  values.push(input.slice(start).trim());
  return values.filter(Boolean);
}

function mt5TradeInsertArity(sql: string) {
  const match = sql.match(/insert into public\.gj_trades \(([^;]+?)\) values \(([^;]+?)\)\s+on conflict/s);
  if (!match) throw new Error("MT5 gj_trades insert not found");
  return { columns: splitSqlList(match[1]), values: splitSqlList(match[2]) };
}

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

  it("qualifies trade-summary columns and keeps the RPC service-role-only", () => {
    expect(tradeSummary).toContain("from public.gj_trades as trade");
    expect(tradeSummaryHotfix).toContain("from public.gj_trades as trade");
    expect(tradeSummaryHotfix).toContain('trade."result"');
    expect(tradeSummaryHotfix).toContain('trade."pnl"');
    expect(tradeSummaryHotfix).toContain('trade."userId"');
    expect(tradeSummaryHotfix).toContain('trade."accountId"');
    expect(tradeSummaryHotfix).toContain("revoke all on function public.gj_account_trade_summary(integer, integer) from public, anon, authenticated;");
    expect(tradeSummaryHotfix).toContain("grant execute on function public.gj_account_trade_summary(integer, integer) to service_role;");
    expect(tradeSummary).not.toContain('coalesce(sum("pnl")');
    expect(tradeSummaryHotfix).not.toContain('coalesce(sum("pnl")');
  });

  it("does not use PostgreSQL-reserved position as an unquoted RPC parameter", () => {
    expect(atomicMigration).toContain("position_payload jsonb");
    expect(atomicMigration).not.toMatch(/\n\s+position jsonb/);
    expect(atomicMigration).not.toMatch(/\bposition->>/);
  });

  it("keeps the MT5 RPC trade insert target/value arity aligned", () => {
    for (const [name, sql] of [["0004", atomicMigration], ["0008", productionMt5Migration], ["0010", mt5ArityRepair]] as const) {
      const { columns, values } = mt5TradeInsertArity(sql);
      expect(values, name).toHaveLength(columns.length);
    }
    expect(atomicMigration).toContain("\"tpPlacement\", \"mistake\", \"holdQuality\", \"patienceScore\"");
    expect(atomicMigration).toContain("'', '', '', '', '', '', '', '', '', '', '', null");
  });

  it("defines PostgreSQL-owned updatedAt triggers and matching Drizzle metadata", () => {
    expect(migration).toContain("create index if not exists \"gj_mt5_live_account_status_close_idx\"");
    expect(migration).toContain("create or replace function public.gj_set_updated_at()");
    expect(migration).toContain("create trigger gj_mt5_live_positions_updated_at");
    expect(schema).toContain("gj_notification_user_type_unique");
    expect(schema).toContain("gj_mt5_closed_position_complete");
  });
});
