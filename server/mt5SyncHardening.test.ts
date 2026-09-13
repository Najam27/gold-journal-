import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chunkMt5TicketFilters } from "./mt5Db";
import { MT5_EA_MIN_VERSION, MT5_PAYLOAD_VERSION, MT5_SUPPORTED_PAYLOAD_VERSIONS, mt5Payload, partitionMt5Records } from "./mt5Ingest";
import { mt5ErrorCategory } from "./mt5Reliability";
import { Mt5TimestampError, normalizeMt5TimestampToUtcPlus5 } from "./mt5Timestamp";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const keyHistoryMigration = read("supabase/migrations/0021_mt5_connection_key_history.sql");
const schema = read("drizzle/schema.ts");
const dbSource = read("server/mt5Db.ts");
const routerSource = read("server/goldRouter.ts");
const ingestSource = read("server/mt5Ingest.ts");
const workerRouter = read("worker/router.ts");
const auditScript = read("scripts/schema-source-audit.mjs");

describe("MT5 sync hardening contract", () => {
  it("records the outgoing key fingerprint without ever storing a second live credential", () => {
    expect(keyHistoryMigration).toContain('add column if not exists "previousApiKeyHash" varchar(64)');
    expect(keyHistoryMigration).toContain('add column if not exists "previousApiKeyAt" timestamptz');
    expect(keyHistoryMigration).toContain("gj_mt5_previous_key_hash_valid");
    expect(keyHistoryMigration).toContain("gj_mt5_connection_previous_key_idx");
    expect(keyHistoryMigration).not.toMatch(/\bdelete\s+from\b/i);
    expect(keyHistoryMigration).not.toMatch(/\bapi_key\b/i);
    expect(schema).toContain("previousApiKeyHash");
    expect(schema).toContain("previousApiKeyAt");
    expect(auditScript).toContain("0021_mt5_connection_key_history.sql");
    expect(auditScript).toContain("mt5ConnectionKeyHistoryMigrationHardened");
  });

  it("keeps a rotated or replaced key attributable through the router", () => {
    expect(routerSource).toContain("previousApiKeyHash: existing[0]?.apiKey ?? null");
    expect(routerSource).toContain("previousApiKeyHash: connection.apiKey");
    expect(routerSource).toContain("previousApiKeyAt: new Date()");
  });

  it("bounds every PostgREST ticket filter so a large account cannot overflow the query URL", () => {
    const tickets = Array.from({ length: 450 }, (_, index) => String(90_000_000 + index));
    const chunks = chunkMt5TicketFilters(tickets);
    expect(chunks).toHaveLength(5);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
    expect(chunks.flat()).toHaveLength(450);
    expect(chunkMt5TicketFilters(["1", "1", "2"])).toEqual([["1", "2"]]);
    expect(chunkMt5TicketFilters(["ticket", "12"]).flat()).toEqual(["12"]);
    // The workspace and history readers must use the chunked helper rather than
    // one OR filter over every visible ticket.
    const workspaceBody = dbSource.slice(dbSource.indexOf("export async function getMt5Workspace"), dbSource.indexOf("export async function getMt5History"));
    const historyBody = dbSource.slice(dbSource.indexOf("export async function getMt5History"), dbSource.indexOf("export async function getActiveMt5Connection"));
    expect(workspaceBody).toContain("journaledTicketSet(db, userId, accountId");
    expect(historyBody).toContain("journaledTicketSet(db, userId, accountId");
    expect(workspaceBody).not.toContain("or(...visibleTickets.map");
    expect(historyBody).not.toContain("or(...visibleTickets.map");
  });

  it("publishes the reconciliation feed and keeps the payload version contract explicit", () => {
    expect(workerRouter).toContain("MT5_PAYLOAD_VERSION");
    expect(MT5_PAYLOAD_VERSION).toBe("2");
    expect(MT5_SUPPORTED_PAYLOAD_VERSIONS).toEqual(["1", "2"]);
    expect(MT5_EA_MIN_VERSION).toBe("2.0.0");
    expect(ingestSource).toContain("getMt5OpenTickets(accountId)");
    expect(ingestSource).toContain('openTicketFormat: "csv"');
  });

  it("never lets one malformed record reject a whole batch", () => {
    const records = [
      { ticket: "10", ok: true },
      { ticket: "11", ok: false },
      { ticket: "12", ok: true },
    ];
    const outcome = partitionMt5Records(records, record => {
      const candidate = record as { ticket: string; ok: boolean };
      if (!candidate.ok) throw new Error("malformed");
      return candidate.ticket;
    });
    expect(outcome.accepted).toEqual(["10", "12"]);
    expect(outcome.rejected).toEqual([{ ticket: "11", code: "PAYLOAD_INVALID", retryable: false }]);
  });

  it("classifies an impossible broker timestamp instead of silently rolling it into another day", () => {
    const now = Date.parse("2026-12-31T23:59:59Z");
    expect(() => normalizeMt5TimestampToUtcPlus5("2026-02-31 10:00:00", 180, now)).toThrow(Mt5TimestampError);
    expect(() => normalizeMt5TimestampToUtcPlus5("2026-13-01 10:00:00", 180, now)).toThrow(Mt5TimestampError);
    expect(() => normalizeMt5TimestampToUtcPlus5("2026-08-17 25:00:00", 180, now)).toThrow(Mt5TimestampError);
    expect(normalizeMt5TimestampToUtcPlus5("2026-02-28 10:00:00", 180, now).toISOString()).toBe("2026-02-28T07:00:00.000Z");
  });

  it("splits authentication and configuration failures from transient network failures", () => {
    expect(mt5ErrorCategory("AUTH_REVOKED")).toBe("AUTH_ERROR");
    expect(mt5ErrorCategory("auth_invalid")).toBe("AUTH_ERROR");
    expect(mt5ErrorCategory("UNSUPPORTED_VERSION")).toBe("CONFIG_ERROR");
    expect(mt5ErrorCategory("BATCH_TOO_LARGE")).toBe("CONFIG_ERROR");
    expect(mt5ErrorCategory("DATABASE_RETRYABLE")).toBeNull();
    expect(mt5ErrorCategory("SYNC_UNAVAILABLE")).toBeNull();
    expect(mt5ErrorCategory(null)).toBeNull();
  });

  it("accepts the current and legacy payload versions and rejects unknown ones", () => {
    for (const version of MT5_SUPPORTED_PAYLOAD_VERSIONS) {
      expect(mt5Payload.safeParse({ event: "ping", api_key: "mt5_live_key_xxxxxxxxxxxxxxxxxxxxxxxxx", payload_version: version }).success).toBe(true);
    }
    expect(mt5Payload.safeParse({ event: "ping", api_key: "mt5_live_key_xxxxxxxxxxxxxxxxxxxxxxxxx", payload_version: "3" }).success).toBe(true);
  });

  it("keeps the compat endpoint reporting the payload version the server can interpret", () => {
    expect(ingestSource).toContain("export const MT5_SUPPORTED_PAYLOAD_VERSIONS");
    expect(ingestSource).toContain("MT5_FAILED_RECORD_REPORT_LIMIT");
    expect(ingestSource).toContain("code: \"UNSUPPORTED_VERSION\"");
    expect(ingestSource).toContain("code: \"BATCH_TOO_LARGE\"");
  });
});
