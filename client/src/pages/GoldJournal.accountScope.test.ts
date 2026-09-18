import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readJournal = () =>
  readFileSync(resolve(process.cwd(), "client/src/pages/GoldJournal.tsx"), "utf8");

describe("Gold Journal account switching", () => {
  it("switches accounts with a cancel/drop transaction instead of invalidating every account query", () => {
    const source = readJournal();

    expect(source).toContain(
      'import { beginAccountSwitchForApp, invalidateAccountScopedQueries, payloadBelongsToAccount, refreshCurrentAccount, resolveActiveAccount } from "@/lib/accountScope";'
    );
    // The transaction order: mark the switch, publish the selection, then cancel
    // the previous account's in-flight requests and drop its cached payloads.
    expect(source).toMatch(
      /const switchAccount = React\.useCallback\([\s\S]*?setSwitchPending\(true\);[\s\S]*?setAccountId\(target\);[\s\S]*?setTradePage\(1\);[\s\S]*?setSelectedAccountId\(target\);[\s\S]*?beginAccountSwitchForApp\(target\)/
    );
    // Invalidating during a switch refetches the queries of the account being
    // left, which is the request storm that timed out the Trade Log.
    expect(source).not.toMatch(
      /const switchAccount = React\.useCallback\([\s\S]*?invalidateAccountScopedQueries\(utils\)/
    );
    expect(source).toContain("const refresh = () => refreshCurrentAccount(utils);");
  });

  it("resolves the active account through the guarded helper so a cold start cannot crash", () => {
    const source = readJournal();

    // An inline `data?.activeAccount?.id === accountId ? data.activeAccount`
    // matched on two undefineds and then dereferenced an undefined payload.
    expect(source).toMatch(
      /const account = resolveActiveAccount\(\s*data\?\.activeAccount,\s*ownedAccounts as \{ id: number \}\[\],\s*accountId\s*\)/
    );
    expect(source).not.toMatch(/data\.activeAccount/);
  });

  it("never renders a payload that belongs to the previous account", () => {
    const source = readJournal();

    // The client half of "old account data must never reach the new account UI":
    // React Query placeholder data and late responses still carry the previous
    // account's activeAccount.id, so the server payload, the reconciled payload,
    // and the durable local snapshot are all ownership-checked before `data`.
    expect(source).toMatch(
      /const journalPayload = payloadBelongsToAccount\(journalQuery\.data, accountId\)/
    );
    expect(source).toMatch(/const localSnapshot = payloadBelongsToAccount\(/);
    expect(source).toMatch(/const reconciledPayload = payloadBelongsToAccount\(/);
    expect(source).toMatch(/const data =\s*reconciledPayload \?\? journalPayload \?\? localSnapshot \?\? undefined;/);
  });

  it("renders the server payload reconciled with still-queued local edits, not the raw server payload", () => {
    const source = readJournal();

    // A trade the user just logged must not vanish from the dashboard, calendar,
    // goal math, or the Trade Log the instant the next journal read lands and
    // before the queue has drained. The reconciled payload is the server payload
    // with the queued mutations overlaid, so server data stays the base and
    // local intent is only ever layered on top of it.
    expect(source).toContain("localJournal.reconciled");
    expect(source).not.toMatch(/const data = journalPayload \?\? localSnapshot/);
    // Pending (unacknowledged) trades are labelled in the table and queued
    // deletes are hidden immediately, both driven by the queue itself.
    expect(source).toContain("localJournal.pendingDeletedIds");
    expect(source).toContain("localJournal.pendingTrades");
    expect(source).toMatch(/const serverPageTrades = \(tradeListQuery\.data\?\.trades \?\? \[\]\)\.filter\(/);
  });

  it("writes, updates, and deletes trades through the durable queue and only reports success once the backend confirms", () => {
    const source = readJournal();

    expect(source).toMatch(/kind: editing \? "trade\.update" : "trade\.create"/);
    expect(source).toMatch(/dispatch: async \(mutation: JournalMutation\) => \{[\s\S]*?canonicalTradeOutcome\(await createTrade\.mutateAsync\(payload\)\)/);
    // A delete is a queued journal write like any other, so it survives a reload
    // and is applied exactly once instead of being lost with one request.
    expect(source).toMatch(/kind: "trade\.delete"/);
    expect(source).not.toMatch(/await deleteTrade\.mutateAsync\(\{ tradeId: id \}\)/);
    // The screenshot is uploaded to persistent storage FIRST and its stable key
    // travels inside the trade payload, so the row and its evidence are one write.
    expect(source).toMatch(/uploadScreenshotDraft\.mutateAsync\(\{/);
    expect(source).toMatch(/evidence\.screenshotKey = uploaded\.key;/);
    expect(source).toMatch(/evidence\.screenshotRemoved = true;/);
    expect(source).not.toMatch(/Re-open it after sync to attach the screenshot/);
  });

  it("publishes every user-initiated switch through the shared account selection", () => {
    const source = readJournal();

    // A switch that only updates local state leaves the account manager, the
    // PDF exporter, the risk calculator, and the MT5 view on the previous
    // account, which is what made switching appear to do nothing.
    expect(source).toMatch(
      /const selectAccount = React\.useCallback\(\s*\(nextAccountId: number\) => \{[\s\S]*?switchAccount\(nextAccountId\);[\s\S]*?setSelectedAccountId\(nextAccountId\);/
    );
    expect(source).toContain("onAccount={selectAccount}");
    expect(source).toContain("onSwitchAccount={selectAccount}");
    expect(source).not.toContain("onAccount={switchAccount}");
    // The header switcher is rendered for every desktop/tablet width, so the
    // account can be changed even when the sidebar is icon-only.
    expect(source).toMatch(/<AccountSwitcher account=\{account\} accounts=\{accounts\} onAccount=\{onAccount\} \/>/);
    expect(source).toMatch(/aria-label="Active trading account"/);
  });

  it("loads the visible view's critical read first and the secondary surfaces afterwards", () => {
    const source = readJournal();

    // A switch must not fire every account-scoped query at once.
    expect(source).toMatch(/enabled: Boolean\([\s\S]*?\(journalIsCritical \|\| !switchPending\)/);
    expect(source).toMatch(/\(mt5IsCritical \|\| !switchPending\)/);
    expect(source).toMatch(/\(criticalView === "trades" \|\| !switchPending\)/);
    expect(source).toMatch(/const criticalView = view === "trades" \? "trades" : view === "mt5" \? "mt5" : "journal";/);
    // The switch ends when the critical read settles (with a failsafe), never on
    // a timer alone and never by leaving the secondary reads disabled.
    expect(source).toMatch(/const settled =\s*!critical\.isPlaceholderData && \(critical\.isSuccess \|\| critical\.isError\);/);
    expect(source).toMatch(/const timer = window\.setTimeout\(\(\) => setSwitchPending\(false\), 12_000\);/);
  });

  it("keeps the Trade Log list polling while MT5 live sync is visible", () => {
    const source = readJournal();

    expect(source).toMatch(
      /mt5\.workspace\.useQuery[\s\S]*?enabled: Boolean\(\s*profileReady &&\s*mt5WorkspaceInput &&\s*\(view === "trades" \|\| view === "mt5"\) &&\s*\(mt5IsCritical \|\| !switchPending\)/
    );
    expect(source).toMatch(/refetchInterval: view === "mt5" \? 2_500/);
  });

  it("renders the Trade Log from its own read instead of the composite journal payload", () => {
    const source = readJournal();

    // A slow or failed composite read must not replace the whole Trade Log with
    // a generic error: the paginated list is the Trade Log's critical read and
    // it carries its own scoped error.
    expect(source).toMatch(/const tradeLogHasList = view === "trades" && Boolean\(tradeListQuery\.data\);/);
    expect(source).toMatch(/const blockingLoading = tradeLogHasList \? false : journalLoading;/);
    expect(source).toMatch(/const blockingError = tradeLogHasList \? undefined : journalError;/);
    expect(source).toMatch(/listError=\{tradeListQuery\.error\}/);
    expect(source).toMatch(/Retry summary/);
  });

  it("reconciles stored MT5 positions from the workspace payload instead of the read paths", () => {
    const source = readJournal();

    // The read paths no longer write, so reconciliation is triggered by the
    // workspace payload (each position carries `journaled`) in bounded passes.
    expect(source).toContain("const syncMt5TradeLog = trpc.mt5.syncTradeLog.useMutation();");
    expect(source).toMatch(/syncMt5TradeLog\.mutateAsync\(\{ accountId, limit: 20 \}\)/);
    expect(source).toMatch(/position\?\.journaled === false/);
    expect(source).toMatch(/now - mt5ReconcileRef\.current\.at < 15_000/);
    expect(source).toMatch(/if \(!canceled && synchronized > 0\) refreshCurrentAccount\(utils\);/);
  });

  it("reports categorized errors and account-switch progress", () => {
    const source = readJournal();

    expect(source).toContain('import { JournalQueryError, SwitchingAccount } from "@/components/QueryError";');
    expect(source).toMatch(/<JournalQueryError[\s\S]*?error=\{blockingError\}[\s\S]*?onRetry=\{retryJournal\}/);
    expect(source).toMatch(/switchPending \? \(\s*<SwitchingAccount name=\{switchingAccountName\} \/>/);
    expect(source).toContain("Switching to {switchingAccountName}…");
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
});
