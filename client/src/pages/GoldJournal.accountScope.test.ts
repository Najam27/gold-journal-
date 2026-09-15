import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readJournal = () =>
  readFileSync(resolve(process.cwd(), "client/src/pages/GoldJournal.tsx"), "utf8");

describe("Gold Journal account switching", () => {
  it("uses the shared full account-scope invalidation helper for direct switches and refreshes", () => {
    const source = readJournal();

    expect(source).toContain('import { invalidateAccountScopedQueries, resolveActiveAccount } from "@/lib/accountScope";');
    expect(source).toMatch(/const switchAccount = React\.useCallback\([\s\S]*?setAccountId\(nextAccountId\);[\s\S]*?invalidateAccountScopedQueries\(utils\)/);
    expect(source).toContain("const refresh = () => invalidateAccountScopedQueries(utils);");
  });

  it("resolves the active account through the guarded helper so a cold start cannot crash", () => {
    const source = readJournal();

    // An inline `data?.activeAccount?.id === accountId ? data.activeAccount`
    // matched on two undefineds and then dereferenced an undefined payload.
    expect(source).toMatch(/const account = resolveActiveAccount\(\s*data\?\.activeAccount,\s*ownedAccounts as \{ id: number \}\[\],\s*accountId\s*\)/);
    expect(source).not.toMatch(/data\.activeAccount/);
  });

  it("publishes every user-initiated switch through the shared account selection", () => {
    const source = readJournal();

    // A switch that only updates local state leaves the account manager, the
    // PDF exporter, the risk calculator, and the MT5 view on the previous
    // account, which is what made switching appear to do nothing.
    expect(source).toMatch(/const selectAccount = React\.useCallback\(\s*\(nextAccountId: number\) => \{[\s\S]*?switchAccount\(nextAccountId\);[\s\S]*?setSelectedAccountId\(nextAccountId\);/);
    expect(source).toContain("onAccount={selectAccount}");
    expect(source).toContain("onSwitchAccount={selectAccount}");
    expect(source).not.toContain("onAccount={switchAccount}");
    // The header switcher is rendered for every desktop/tablet width, so the
    // account can be changed even when the sidebar is icon-only.
    expect(source).toMatch(/<AccountSwitcher account=\{account\} accounts=\{accounts\} onAccount=\{onAccount\} \/>/);
    expect(source).toMatch(/aria-label="Active trading account"/);
  });

  it("keeps the composite journal read off the live cadence so the app stays responsive", () => {
    const source = readJournal();

    // journal.get is a nine-query composite read; polling it every 2.5 s was the
    // main cause of the sluggish dashboard.
    expect(source).toMatch(/journal\.get\.useQuery\(queryInput, \{[\s\S]*?refetchInterval: journalRefetchInterval/);
    expect(source).toMatch(/if \(view === "trades" \|\| view === "mt5"\) return 20_000;/);
    expect(source).toMatch(/mt5\.workspace\.useQuery[\s\S]*?refetchInterval: view === "mt5" \? 2_500 : view === "trades" \? 10_000 : false/);
    expect(source).toMatch(/trpc\.trades\.list\.useQuery\(tradeListInput!, \{[\s\S]*?refetchInterval: view === "trades" \? 10_000 : false/);
    expect(source).toContain("staleTime: 5_000");
    expect(source).not.toMatch(/journal\.get\.useQuery\(queryInput, \{\s*enabled[\s\S]{0,200}?refetchInterval:\s*\n?\s*view === "trades" \? 2_500/);
  });

  it("keeps the Trade Log list polling while MT5 live sync is visible", () => {
    const source = readJournal();

    expect(source).toMatch(/mt5\.workspace\.useQuery[\s\S]*?enabled: Boolean\(\s*profileReady && mt5WorkspaceInput && \(view === "trades" \|\| view === "mt5"\)/);
    expect(source).toMatch(/refetchInterval: view === "mt5" \? 2_500/);
  });
});
