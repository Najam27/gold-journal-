import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../../public/GoldJournal_EA.mq5", import.meta.url), "utf8");

describe("MT5 EA automatic recovery contract", () => {
  it("has no permanent dead state that would require deleting or re-attaching the EA", () => {
    expect(source).not.toContain("g_permanent_rejection");
    expect(source).not.toContain("g_api_rejected");
    expect(source).not.toContain("g_endpoint_rejected");
    // A rejection must schedule a bounded retry rather than latch forever.
    expect(source).toMatch(/g_requires_revalidation\s*=\s*true/);
    expect(source).toContain("g_next_retry_at = now + delay");
  });

  it("recovers automatically once a credential or endpoint probe succeeds", () => {
    expect(source).toContain("g_requires_revalidation = false");
    expect(source).toContain("resuming full synchronization");
    // The probe is always attempted, so a corrected key is picked up.
    expect(source).toMatch(/if\(g_requires_revalidation && expectedEvent != "compat" && expectedEvent != "ping"\) return false;/);
  });

  it("caps configuration retries far below any permanent lockout", () => {
    expect(source).toContain("MAX_CONFIG_RETRY_SECONDS = 300");
    expect(source).toContain("BackoffSeconds(g_config_failures, MAX_CONFIG_RETRY_SECONDS)");
  });

  it("treats 422, 429 and 5xx as transient and keeps retrying with bounded backoff", () => {
    expect(source).toMatch(/bool IsTransientStatus\(int status\)[\s\S]*?status == 422[\s\S]*?status == 429[\s\S]*?status == 500[\s\S]*?status == 504/);
    expect(source).toContain("MAX_RETRY_BACKOFF_SECONDS = 60");
    expect(source).toMatch(/int RetryDelaySeconds\(\) \{ return BackoffSeconds\(g_consecutive_failures, MAX_RETRY_BACKOFF_SECONDS\); \}/);
  });

  it("exposes an explicit connection state machine instead of a single failure flag", () => {
    ["EA_INIT", "EA_CONNECTING", "EA_CONNECTED", "EA_SYNCING", "EA_HEALTHY", "EA_RECONNECTING", "EA_ERROR"].forEach(state => {
      expect(source).toContain(state);
    });
  });

  it("sends a standalone heartbeat so a stale snapshot is never mistaken for live", () => {
    // Escaped inside the MQL5 string literal that builds the JSON payload.
    expect(source).toContain('\\"event\\":\\"ping\\"');
    expect(source).toContain("void SendHeartbeat()");
    expect(source).toMatch(/HeartbeatSeconds/);
  });

  it("keeps heavy payloads on a slower cadence than open positions", () => {
    expect(source).toContain("SummarySeconds");
    expect(source).toMatch(/if\(now >= g_next_summary_at\)/);
    expect(source).toMatch(/SendOpenPositions\(\);\s*\n\s*\/\/ The account snapshot/);
  });

  it("logs status, retry count, state and next retry without ever logging the key", () => {
    expect(source).toContain("state=%s; failures=%d; last_success=%s; next_retry=%s");
    expect(source).not.toMatch(/Print(?:Format)?\([^\n]*ApiKey/);
    expect(source).not.toContain("PASTE_ONCE_FROM_GOLD_JOURNAL\");");
  });

  it("keeps the trade-transaction listener passive and event-driven", () => {
    expect(source).toMatch(/void OnTradeTransaction\([\s\S]*?SendHistory\(false\);/);
    expect(source).toMatch(/if\(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY && entry != DEAL_ENTRY_INOUT\) return;/);
  });

  it("documents that a configuration error is recoverable without restarting MT5", () => {
    expect(source).toContain("The EA keeps retrying, so correcting the input and applying recovers it.");
  });
});
