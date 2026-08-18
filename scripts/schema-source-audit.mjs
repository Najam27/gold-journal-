import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = path => readFileSync(join(root, path), "utf8");
const schema = read("drizzle/schema.ts");
const migrationDir = join(root, "supabase/migrations");
const migrations = readdirSync(migrationDir).filter(name => /^000[1-6]_.*\.sql$/.test(name)).sort();
const expectedMigrations = [
  "0001_source_gold_journal.sql",
  "0002_security_rls_and_storage.sql",
  "0003_scale_aggregates.sql",
  "0004_atomic_operations.sql",
  "0005_trade_summary.sql",
  "0006_schema_integrity.sql",
];
const expectedNames = [
  "gj_accounts_id_user_unique",
  "gj_trades_account_owner_fk",
  "gj_cash_account_owner_fk",
  "gj_goals_account_owner_fk",
  "gj_skipped_account_owner_fk",
  "gj_daily_plan_account_owner_fk",
  "gj_notification_account_owner_fk",
  "gj_mt5_connection_account_owner_fk",
  "gj_notification_user_type_unique",
  "gj_users_role_valid",
  "gj_cash_amount_positive",
  "gj_mt5_closed_position_complete",
  "gj_mt5_live_account_status_close_idx",
];
const migrationText = expectedMigrations.map(name => read(join("supabase/migrations", name))).join("\n");
const staleDrizzleArtifacts = readdirSync(join(root, "drizzle")).filter(name => /^\d{4}_.*\.sql$/.test(name) || name === "meta");
const missingMigrations = expectedMigrations.filter(name => !migrations.includes(name));
const missingInSchema = expectedNames.filter(name => !schema.includes(name));
const missingInMigrations = expectedNames.filter(name => !migrationText.includes(name));
const report = {
  migrationOrder: migrations,
  migrationOrderValid: JSON.stringify(migrations) === JSON.stringify(expectedMigrations),
  staleDrizzleArtifacts,
  staleDrizzleArtifactsRemoved: staleDrizzleArtifacts.length === 0,
  expectedNamesInDrizzleSchema: missingInSchema.length === 0,
  expectedNamesInSupabaseMigrations: missingInMigrations.length === 0,
  missingMigrations,
  missingInSchema,
  missingInMigrations,
  drizzleSchemaPresent: existsSync(join(root, "drizzle/schema.ts")),
};
console.log(JSON.stringify(report, null, 2));
if (!report.migrationOrderValid || !report.staleDrizzleArtifactsRemoved || !report.expectedNamesInDrizzleSchema || !report.expectedNamesInSupabaseMigrations || missingMigrations.length) process.exitCode = 1;
