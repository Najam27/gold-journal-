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
});
