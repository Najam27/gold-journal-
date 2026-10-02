import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { Field, RiskMetric } from "@/components/journalPrimitives";
import { Input } from "@/components/ui/input";
import { getPktDateKey } from "@shared/pktDate";
import {
  DEFAULT_DAILY_DRAWDOWN_PCT,
  DEFAULT_MAX_DRAWDOWN_PCT,
  evaluateFundedGuard,
  type DrawdownType,
} from "@/lib/fundedGuard";
import type { FundedGuardSettings, GuardConfig } from "@/lib/guardMode";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface FundedTradeLike {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
}

interface Mt5ConnectionLike {
  active?: boolean;
  retiredAt?: string | null;
  balance?: number | string | null;
  equity?: number | string | null;
  floatingPnl?: number | string | null;
  lastContactAt?: string | null;
  lastPing?: string | null;
  brokerServer?: string | null;
}

const numOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Funded account guard for the Risk Calculator.
 *
 * Prop-firm drawdown rules expressed in percentages — the way firms actually
 * write them — with the dollar equivalents derived live. Daily drawdown is
 * the account killer: 5% of the day's starting equity at most firms (FTMO's
 * number), resetting at server midnight, counting floating P&L. Maximum
 * drawdown is typically 10%, static (pinned to starting balance) or trailing
 * (locked from peak equity).
 *
 * The MT5 snapshot auto-fills starting balance and current equity from the
 * live connection; the guard auto-saves per account and the Trade Log banner
 * reads the same saved settings. This is a journal-side guardrail — it
 * cannot stop a broker from filling the next trade.
 */
export function FundedGuardPanel({ accountId }: { accountId?: number }) {
  const [accountSize, setAccountSize] = useState("");
  const [sizeMode, setSizeMode] = useState<"auto" | "manual">("auto");
  const [dailyPct, setDailyPct] = useState(String(DEFAULT_DAILY_DRAWDOWN_PCT));
  const [maxPct, setMaxPct] = useState(String(DEFAULT_MAX_DRAWDOWN_PCT));
  const [drawdownType, setDrawdownType] = useState<DrawdownType>("static");
  const [peakEquity, setPeakEquity] = useState("");
  const [dayStartOverride, setDayStartOverride] = useState("");
  // Starting balance override: the MT5 snapshot balance is the *current*
  // balance (profits/losses baked in), not the funded account's initial
  // balance. The trader types the true starting balance once from the firm's
  // dashboard; blank means "auto from MT5".
  const [startingBalanceOverride, setStartingBalanceOverride] = useState("");
  const [hydratedAccountId, setHydratedAccountId] = useState<number | null>(null);
  // Field values as last hydrated/saved for the current account. The persist
  // effect compares against this so hydration itself never triggers a save.
  const hydratedFieldsRef = useRef("");
  const hadSavedFundedRef = useRef(false);
  const savedSnapshotRef = useRef<{ balance: number | null; equity: number | null }>({ balance: null, equity: null });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const utils = trpc.useUtils();

  // Persisted funded-guard settings (per account). The Trade Log banner reads
  // these, so the guard configured here protects the whole journal.
  const accountList = trpc.accounts.list.useQuery(undefined, {
    enabled: Boolean(accountId),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const savedGuardConfig = useMemo(() => {
    const list = (accountList.data ?? []) as Array<{ id: number; guardConfig?: unknown }>;
    const found = list.find(a => a.id === accountId);
    return (found?.guardConfig ?? null) as GuardConfig | null;
  }, [accountList.data, accountId]);
  const setGuardConfig = trpc.accounts.setGuardConfig.useMutation({
    onSuccess: async () => {
      setSaveState("saved");
      // The Trade Log banner reads guardConfig from the account list — refresh
      // it so the banner follows the guard without a page reload.
      await utils.accounts.list.invalidate();
    },
    onError: error => {
      setSaveState("error");
      toast.error(error.message || "Could not save the funded guard.");
    },
  });

  // Hydrate from the selected account's saved settings. Keyed by account:
  // switching accounts re-hydrates, so one account's field values can never
  // be carried into another account's saved config.
  useEffect(() => {
    if (!accountId || !accountList.isSuccess) return;
    if (hydratedAccountId === accountId) return;
    const funded = savedGuardConfig?.funded;
    const next = {
      sizeMode: funded?.sizeMode ?? "auto",
      accountSize: funded?.accountSize != null ? String(funded.accountSize) : "",
      dailyPct: funded ? String(funded.dailyDrawdownPct) : String(DEFAULT_DAILY_DRAWDOWN_PCT),
      maxPct: funded ? String(funded.maxDrawdownPct) : String(DEFAULT_MAX_DRAWDOWN_PCT),
      drawdownType: funded?.drawdownType ?? "static",
      // Older saves may lack newer fields — default to blank (auto).
      dayStartOverride: funded?.dayStartOverride ?? "",
      peakEquity: funded?.peakEquity ?? "",
      startingBalanceOverride: funded?.startingBalanceOverride ?? "",
    };
    setSizeMode(next.sizeMode);
    setAccountSize(next.accountSize);
    setDailyPct(next.dailyPct);
    setMaxPct(next.maxPct);
    setDrawdownType(next.drawdownType);
    setDayStartOverride(next.dayStartOverride);
    setPeakEquity(next.peakEquity);
    setStartingBalanceOverride(next.startingBalanceOverride);
    hydratedFieldsRef.current = JSON.stringify(next);
    hadSavedFundedRef.current = Boolean(funded);
    if (funded) savedSnapshotRef.current = { balance: funded.mt5Balance ?? null, equity: funded.mt5Equity ?? null };
    setHydratedAccountId(accountId);
  }, [accountId, accountList.isSuccess, savedGuardConfig, hydratedAccountId]);

  // MT5 snapshot: auto-fetch starting balance and current equity from the
  // live connection (the EA's summary). Balance = the account's snapshot
  // balance, equity = balance + floating P&L.
  const mt5 = trpc.mt5.workspace.useQuery(
    { accountId: accountId ?? 0 },
    { enabled: Boolean(accountId), staleTime: 10_000, refetchOnWindowFocus: false },
  );
  const mt5Snapshot = useMemo(() => {
    const connections = ((mt5.data as { connections?: Mt5ConnectionLike[] } | undefined)?.connections ?? []);
    const active = connections.find(c => c.active && !c.retiredAt) ?? connections[0] ?? null;
    if (!active) return null;
    return {
      balance: numOrNull(active.balance),
      equity: numOrNull(active.equity),
      floatingPnl: Number(active.floatingPnl),
      lastContactAt: active.lastContactAt ?? active.lastPing ?? null,
      brokerServer: active.brokerServer ?? null,
    };
  }, [mt5.data]);

  // Today's realized P&L from the journal (PKT calendar day, closed trades).
  const journal = trpc.journal.get.useQuery(
    { accountId: accountId ?? 0 },
    { enabled: Boolean(accountId), staleTime: 30_000, refetchOnWindowFocus: false },
  );
  const todayKey = getPktDateKey(new Date());
  const { todayPnl, allTimePnl } = useMemo(() => {
    const trades = ((journal.data as { trades?: FundedTradeLike[] } | undefined)?.trades ?? []);
    let today = 0;
    let allTime = 0;
    for (const trade of trades) {
      if (String(trade.result ?? "").toUpperCase() === "OPEN") continue;
      const pnl = Number(trade.pnl);
      if (!Number.isFinite(pnl)) continue;
      allTime += pnl;
      if (getPktDateKey(trade.tradeDate) === todayKey) today += pnl;
    }
    return { todayPnl: today, allTimePnl: allTime };
  }, [journal.data, todayKey]);

  const journalStartingBalance = useMemo(() => {
    const list = (accountList.data ?? []) as Array<{ id: number; startingBalance?: unknown }>;
    const found = list.find(a => a.id === accountId);
    return numOrNull(found?.startingBalance);
  }, [accountList.data, accountId]);
  // Starting balance: the trader's manual entry wins (the funded account's
  // initial balance), then the MT5 snapshot balance, then the journal
  // account's starting balance. MT5's balance is the *current* balance, not
  // the initial one — that is why it must be editable.
  const overrideStartingBalance = Number(startingBalanceOverride);
  const startingBalance =
    startingBalanceOverride.trim() !== "" && Number.isFinite(overrideStartingBalance) && overrideStartingBalance > 0
      ? overrideStartingBalance
      : (mt5Snapshot?.balance ?? journalStartingBalance);
  const currentEquity = mt5Snapshot?.equity ?? (startingBalance != null ? startingBalance + allTimePnl : null);

  const size = sizeMode === "auto" ? (startingBalance ?? NaN) : Number(accountSize);
  const daily = Number(dailyPct);
  const max = Number(maxPct);
  const peak = Number(peakEquity);
  // Day-start equity: the firm's daily reference resets at server midnight.
  // Auto = current equity minus today's realized P&L; override from the
  // firm's dashboard when the firm uses the higher of balance/equity.
  const overrideDayStart = Number(dayStartOverride);
  const autoDayStart = currentEquity != null ? currentEquity - todayPnl : null;
  const dayStartEquity =
    dayStartOverride.trim() !== "" && Number.isFinite(overrideDayStart) && overrideDayStart > 0
      ? overrideDayStart
      : autoDayStart;
  const valid =
    Number.isFinite(size) && size > 0 &&
    Number.isFinite(daily) && daily > 0 && daily <= 20 &&
    Number.isFinite(max) && max > 0 && max <= 50 &&
    dayStartEquity != null && dayStartEquity > 0 &&
    (drawdownType === "static" || (Number.isFinite(peak) && peak > 0) || peakEquity.trim() === "");

  const evaluation = useMemo(
    () =>
      valid
        ? evaluateFundedGuard(
            {
              accountSize: size,
              dayStartEquity,
              dailyDrawdownPct: daily,
              maxDrawdownPct: max,
              drawdownType,
              peakEquity: drawdownType === "trailing" && Number.isFinite(peak) && peak > 0 ? peak : null,
            },
            todayPnl,
          )
        : null,
    [valid, size, dayStartEquity, daily, max, drawdownType, peak, todayPnl],
  );

  // Persist on change (debounced) so the Trade Log banner follows the guard.
  // The MT5 snapshot is saved too, so the banner can use live equity even
  // when it cannot reach MT5 itself. Two guards keep this honest:
  //  - it runs only for the account the fields were hydrated from, so an
  //    account switch can never write the previous account's values into
  //    the newly selected account;
  //  - it saves only after the trader actually edits a field (or, for an
  //    already-configured guard, when the MT5 snapshot moves) — merely
  //    opening the tab must not arm the guard with defaults.
  useEffect(() => {
    if (!accountId || hydratedAccountId !== accountId) return;
    const fields = { sizeMode, accountSize, dailyPct, maxPct, drawdownType, dayStartOverride, peakEquity, startingBalanceOverride };
    const fieldsJson = JSON.stringify(fields);
    const fieldsChanged = fieldsJson !== hydratedFieldsRef.current;
    const balance = mt5Snapshot?.balance ?? null;
    const equity = mt5Snapshot?.equity ?? null;
    const snapshotChanged = balance !== savedSnapshotRef.current.balance || equity !== savedSnapshotRef.current.equity;
    if (!fieldsChanged && !(snapshotChanged && hadSavedFundedRef.current)) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = setTimeout(() => {
      const manualSize = Number(accountSize);
      const funded: FundedGuardSettings = {
        enabled: true,
        accountSize: sizeMode === "manual" && Number.isFinite(manualSize) && manualSize > 0 ? manualSize : null,
        sizeMode,
        dailyDrawdownPct: Number(dailyPct) || DEFAULT_DAILY_DRAWDOWN_PCT,
        maxDrawdownPct: Number(maxPct) || DEFAULT_MAX_DRAWDOWN_PCT,
        drawdownType,
        dayStartOverride,
        peakEquity,
        startingBalanceOverride,
        mt5Balance: balance,
        mt5Equity: equity,
        snapshotAt: mt5Snapshot ? new Date().toISOString() : null,
      };
      hydratedFieldsRef.current = fieldsJson;
      savedSnapshotRef.current = { balance, equity };
      hadSavedFundedRef.current = true;
      setGuardConfig.mutate({
        accountId,
        guardConfig: {
          ...(savedGuardConfig ?? { enabled: false, accountSize: null, dailyLossLimit: null, maxDrawdownLimit: null, maxTradesPerDay: null }),
          funded,
        },
      });
    }, 800);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydratedAccountId, accountId, sizeMode, accountSize, dailyPct, maxPct, drawdownType, dayStartOverride, peakEquity, startingBalanceOverride, mt5Snapshot?.balance, mt5Snapshot?.equity]);

  const LevelIcon =
    evaluation?.level === "breached" ? ShieldAlert
    : evaluation?.level === "danger" || evaluation?.level === "caution" ? TriangleAlert
    : ShieldCheck;

  const money = (n: number | null | undefined) =>
    n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  return (
    <details className="risk-explanation funded-guard" open>
      <summary>
        Funded account guard — prop-firm drawdown in %
        <span className={`funded-save-state ${saveState}`}>
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved ✓" : saveState === "error" ? "Save failed" : ""}
        </span>
      </summary>
      <p className="risk-detail-note">
        Prop firms write drawdown rules in <strong>percentages, not dollars</strong> — and the
        two limits run on <strong>different clocks</strong>. The industry benchmark (FTMO
        2-Step): <strong>5% daily</strong> of the day&rsquo;s starting equity (resets at
        server midnight), <strong>10% maximum</strong> pinned to the starting balance
        (static — the floor never moves) or trailing peak equity. Breach either and the
        account is terminated — no warnings. The guard auto-saves: the Trade Log banner
        watches the same limits.
      </p>

      <div className="funded-guard-grid">
        <section className="funded-guard-col funded-guard-snapshot" aria-label="MT5 account snapshot">
          <h4>
            <RefreshCw size={13} /> MT5 snapshot
            {mt5Snapshot ? <span className="funded-live-badge">Live</span> : null}
          </h4>
          <dl>
            <div className="funded-balance-edit">
              <dt>
                <label htmlFor="funded-starting-balance">Starting balance</label>
                {startingBalanceOverride.trim() !== "" && (
                  <button
                    type="button"
                    className="funded-reset-link"
                    onClick={() => setStartingBalanceOverride("")}
                    title="Clear and use the MT5 snapshot balance again"
                  >
                    auto
                  </button>
                )}
              </dt>
              <dd>
                <Input
                  id="funded-starting-balance"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="100"
                  placeholder={
                    mt5Snapshot?.balance != null
                      ? `MT5: ${mt5Snapshot.balance.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                      : "e.g. 5000"
                  }
                  title="Your funded account's initial balance (from the firm's dashboard). MT5 only reports the current balance, so type the true starting balance here once."
                  value={startingBalanceOverride}
                  onChange={event => setStartingBalanceOverride(event.target.value)}
                />
              </dd>
            </div>
            <div>
              <dt>Current equity</dt>
              <dd>{money(currentEquity)}</dd>
            </div>
            <div>
              <dt>Floating P&amp;L</dt>
              <dd className={Number.isFinite(mt5Snapshot?.floatingPnl) && (mt5Snapshot?.floatingPnl ?? 0) < 0 ? "neg" : "pos"}>
                {mt5Snapshot && Number.isFinite(mt5Snapshot.floatingPnl)
                  ? `${mt5Snapshot.floatingPnl < 0 ? "−" : "+"}$${Math.abs(mt5Snapshot.floatingPnl).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                  : "—"}
              </dd>
            </div>
          </dl>
          <p className="funded-snapshot-note">
            {mt5Snapshot
              ? `Equity auto-fetched from MT5${mt5Snapshot.brokerServer ? ` (${mt5Snapshot.brokerServer})` : ""}. Starting balance is the account's initial balance — type it once from your firm's dashboard.`
              : "No live MT5 connection — using the journal account's starting balance."}
          </p>
          <Field label="Account size (static max-DD reference)">
            <div className="funded-size-row">
              <div className="funded-size-toggle" role="group" aria-label="Account size source">
                <button
                  type="button"
                  className={sizeMode === "auto" ? "active" : ""}
                  onClick={() => setSizeMode("auto")}
                >
                  Auto
                </button>
                <button
                  type="button"
                  className={sizeMode === "manual" ? "active" : ""}
                  onClick={() => setSizeMode("manual")}
                >
                  Manual
                </button>
              </div>
              {sizeMode === "auto" ? (
                <div className="funded-size-auto" title="Starting balance from the MT5 snapshot (or the journal account)">
                  {startingBalance != null ? money(startingBalance) : "Detecting…"}
                </div>
              ) : (
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="100"
                  placeholder="e.g. 100000"
                  value={accountSize}
                  onChange={event => setAccountSize(event.target.value)}
                />
              )}
            </div>
          </Field>
        </section>

        <section className="funded-guard-col funded-guard-rules" aria-label="Drawdown rules">
          <h4>Drawdown rules</h4>
          <div className="funded-rules-fields">
            <Field label="Daily drawdown %">
              <Input
                type="number"
                inputMode="decimal"
                min="0.5"
                max="20"
                step="0.5"
                value={dailyPct}
                onChange={event => setDailyPct(event.target.value)}
              />
            </Field>
            <Field label="Max drawdown %">
              <Input
                type="number"
                inputMode="decimal"
                min="1"
                max="50"
                step="0.5"
                value={maxPct}
                onChange={event => setMaxPct(event.target.value)}
              />
            </Field>
            <Field label="Max drawdown type">
              <select
                value={drawdownType}
                onChange={event => setDrawdownType(event.target.value as DrawdownType)}
              >
                <option value="static">Static — from starting balance</option>
                <option value="trailing">Trailing — locks from peak equity</option>
              </select>
            </Field>
            <Field label="Day-start equity ($)">
              <Input
                type="number"
                inputMode="decimal"
                min="0"
                step="100"
                placeholder={autoDayStart != null ? `Auto: ${autoDayStart.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "e.g. 102000"}
                title="The firm's daily reference — equity at server midnight. Auto = current equity minus today's realized P&L. Override it from your firm's dashboard if needed."
                value={dayStartOverride}
                onChange={event => setDayStartOverride(event.target.value)}
              />
            </Field>
            {drawdownType === "trailing" && (
              <Field label="Peak equity so far ($)">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="100"
                  placeholder={currentEquity != null ? `Auto: ${currentEquity.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "e.g. 108000"}
                  value={peakEquity}
                  onChange={event => setPeakEquity(event.target.value)}
                />
              </Field>
            )}
          </div>
        </section>
      </div>

      {!valid ? (
        <p className="muted">
          {sizeMode === "auto" && startingBalance == null
            ? "Waiting for the live account — connect MT5 or switch to Manual to type the size."
            : "Enter your firm\u2019s drawdown percentages to see the guard."}
        </p>
      ) : (
        evaluation && (
          <>
            <div className="risk-result-grid">
              <RiskMetric
                label="Daily loss limit"
                value={`$${evaluation.dailyLossLimit.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                detail={`${daily}% of day-start $${dayStartEquity.toLocaleString("en-US", { maximumFractionDigits: 2 })} — floor $${evaluation.dailyFloor.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                tone={evaluation.level === "clear" ? "profit" : "loss"}
              />
              <RiskMetric
                label="Max loss limit"
                value={`$${evaluation.maxLossLimit.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                detail={`${max}% ${drawdownType === "static" ? `of starting $${size.toLocaleString("en-US")} — fixed` : "of peak equity — trails up"} · floor $${evaluation.maxDrawdownFloor.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
              />
              <RiskMetric
                label="Max risk per trade"
                value={`$${evaluation.maxRiskPerTrade.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
                detail="30% of daily allowance — one trade must never end the day"
                tone="gold"
              />
              <RiskMetric
                label="Today's usage"
                value={`${evaluation.dailyUsedPct.toFixed(0)}%`}
                detail={
                  journal.isLoading
                    ? "Reading today's journal P&L…"
                    : `Realized P&L today: $${todayPnl.toLocaleString("en-US", { maximumFractionDigits: 2 })} · $${evaluation.dailyRemaining.toLocaleString("en-US", { maximumFractionDigits: 2 })} left`
                }
                tone={evaluation.level === "clear" ? "profit" : "loss"}
              />
            </div>

            <div
              className={`risk-warning-panel ${evaluation.level === "clear" ? "caution" : ""}`}
              role={evaluation.level === "clear" ? "status" : "alert"}
            >
              <LevelIcon size={18} />
              <div>
                <strong>
                  {evaluation.level === "breached"
                    ? "Daily drawdown breached"
                    : evaluation.level === "danger"
                      ? "Danger — almost at the daily limit"
                      : evaluation.level === "caution"
                        ? "Caution — daily limit in sight"
                        : "Guard status"}
                </strong>
                <p>{evaluation.message}</p>
                <p className="risk-warning-detail">
                  {evaluation.stopsBeforeDailyBreach} full stop
                  {evaluation.stopsBeforeDailyBreach === 1 ? "" : "s"} at the
                  per-trade ceiling ends the day. Counts open floating P&L at
                  most firms — the journal only sees closed trades, so leave a
                  buffer.
                </p>
              </div>
            </div>
          </>
        )
      )}
    </details>
  );
}
