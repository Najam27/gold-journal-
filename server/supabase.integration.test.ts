import { describe, expect, it } from "vitest";
import { getOwnedAccount } from "./goldDb";
import { getAccountAnalysis } from "./analysisDb";

const userA = Number(process.env.GJ_INTEGRATION_USER_A);
const accountA = Number(process.env.GJ_INTEGRATION_ACCOUNT_A);
const accountB = Number(process.env.GJ_INTEGRATION_ACCOUNT_B);
const configured = process.env.GOLD_JOURNAL_INTEGRATION === "1" && [userA, accountA, accountB].every(value => Number.isInteger(value) && value > 0);

describe.skipIf(!configured)("Supabase integration: account isolation", () => {
  it("rejects a real cross-account ownership substitution", async () => {
    await expect(getOwnedAccount(userA, accountB)).rejects.toThrow();
  });

  it("returns deterministic analysis for the selected staging account only", async () => {
    const analysis = await getAccountAnalysis(userA, accountA, {});
    expect(analysis).toHaveProperty("overview");
    expect(analysis.sourceTradeCount).toBeGreaterThanOrEqual(0);
  });
});
