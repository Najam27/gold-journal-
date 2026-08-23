import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Gold Journal account switching", () => {
  it("uses the shared full account-scope invalidation helper for direct switches and refreshes", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/GoldJournal.tsx"), "utf8");

    expect(source).toContain('import { invalidateAccountScopedQueries } from "@/lib/accountScope";');
    expect(source).toMatch(/const switchAccount = React\.useCallback\([\s\S]*?setAccountId\(nextAccountId\);[\s\S]*?invalidateAccountScopedQueries\(utils\)/);
    expect(source).toContain("const refresh = () => invalidateAccountScopedQueries(utils);");
    expect(source).toContain("onAccount={switchAccount}");
  });

  it("keeps the Trade Log list polling while MT5 live sync is visible", () => {
    const source = readFileSync(resolve(process.cwd(), "client/src/pages/GoldJournal.tsx"), "utf8");

    expect(source).toMatch(/journal\.get\.useQuery[\s\S]*?refetchInterval:\s*view === "trades" \? 2_500 : view === "goals" \? 300_000 : false/);
    expect(source).toMatch(/mt5\.workspace\.useQuery[\s\S]*?refetchInterval:\s*view === "trades" \|\| view === "mt5" \? 2_500 : false/);
    expect(source).toMatch(/trpc\.trades\.list\.useQuery[\s\S]*?refetchInterval:\s*view === "trades" \? 2_500 : false/);
  });
});
