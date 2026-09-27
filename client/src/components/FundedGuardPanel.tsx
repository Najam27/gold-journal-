import React, { useEffect, useMemo, useState } from "react";
import { ShieldAlert, ShieldCheck, TriangleAlert } from "lucide-react";
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

interface FundedTradeLike {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
}

/**
 * Funded account guard for the Risk Calculator.
 *
 * Prop-firm drawdown rules expressed in percentages — the way firms actually
 * write them — with the dollar equivalents derived live. Daily drawdown is
 * the account killer: 5% of the day's starting balance at most firms (FTMO's
 * number), resetting at server midnight, counting floating P&L. Maximum
 * drawdown is typically 10%, static (from starting balance) or trailing
 * (locked from peak equity).
 *
 * The live section reads today's realized journal P&L (PKT day) and shows how
 * much of the daily allowance is already gone. This is a journal-side
 * guardrail — it cannot stop a broker from filling the next trade.
 */
export function FundedGuardPanel({ accountId }: { accountId?: number }) {
  const [accountSize, setAccountSize] = useState("");
  // "auto" reads the account size from the live account (MT5 equity, or the
  // journal account's starting balance when MT5 is not connected). Manual
  // entry stays available for firms whose challenge size differs from the
  // live balance.
  const [sizeMode, setSizeMode] = useState<"auto" | "manual">("auto");
  const [dailyPct, setDailyPct] = useState(String(DEFAULT_DAILY_DRAWDOWN_PCT));
  const [maxPct, setMaxPct] = useState(String(DEFAULT_MAX_DRAWDOWN_PCT));
  const [drawdownType, setDrawdownType] = useState<DrawdownType>("static");
  const [peakEquity, setPeakEquity] = useState("");
  // Day-start equity override: blank means "auto" (live equity minus today's
  // realized P&L — the journal-side estimate of where the day opened).
  const [dayStartOverride, setDayStartOverride] = useState("");
  // Tracks whether saved settings have been applied, so remote state never
  // clobbers the trader's in-progress edits.
  const [hydrated, setHydrated] = useState(false);

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
  const setGuardConfig = trpc.accounts.setGuardConfig.useMutation();

  // Hydrate once from saved settings.
  useEffect(() => {
    if (hydrated || !accountList.isSuccess) return;
    const funded = savedGuardConfig?.funded;
    if (funded) {
      setSizeMode(funded.sizeMode);
      setAccountSize(funded.accountSize != null ? String(funded.accountSize) : "");
      setDailyPct(String(funded.dailyDrawdownPct));
      setMaxPct(String(funded.maxDrawdownPct));
      setDrawdownType(funded.drawdownType);
      setDayStartOverride(funded.dayStartOverride);
      setPeakEquity(funded.peakEquity);
    }
    setHydrated(true);
  }, [hydrated, accountList.isSuccess, savedGuardConfig]);

  // Persist on change (debounced) so the Trade Log banner follows the guard.
  useEffect(() => {
    if (!hydrated || !accountId) return;
    const timer = setTimeout(() => {
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
      };
      setGuardConfig.mutate({
        accountId,
        guardConfig: { ...(savedGuardConfig ?? { enabled: false, accountSize: null, dailyLossLimit: null, maxDrawdownLimit: null, maxTradesPerDay: null }), funded },
      });
    }, 800);
    return () => clearTimeout(timer);
  }, [hydrated, accountId, sizeMode, accountSize, dailyPct, maxPct, drawdownType, dayStartOverride, peakEquity]);

  // Live account for auto-detect: MT5 workspace carries equity when a
  // connection is active.
  const mt5 = trpc.mt5.workspace.useQuery(
    { accountId: accountId ?? 0 },
    { enabled: Boolean(accountId), staleTime: 10_000, refetchOnWindowFocus: false },
  );
  const detectedSize = useMemo(() => {
    const ws = mt5.data as { account?: { equity?: number | null; balance?: number | null } } | undefined;
    const equity = Number(ws?.account?.equity);
    if (Number.isFinite(equity) && equity > 0) return equity;
    const balance = Number(ws?.account?.balance);
    if (Number.isFinite(balance) && balance > 0) return balance;
    return null;
  }, [mt5.data]);

  // Today's realized P&L from the journal (PKT calendar day, closed trades).
  const journal = trpc.journal.get.useQuery(
    { accountId: accountId ?? 0 },
    { enabled: Boolean(accountId), staleTime: 30_000, refetchOnWindowFocus: false },
  );
  const todayKey = getPktDateKey(new Date());
  const todayPnl = useMemo(() => {
    const trades = ((journal.data as { trades?: FundedTradeLike[] } | undefined)?.trades ?? []);
    return trades.reduce((sum, trade) => {
      if (String(trade.result ?? "").toUpperCase() === "OPEN") return sum;
      if (getPktDateKey(trade.tradeDate) !== todayKey) return sum;
      const pnl = Number(trade.pnl);
      return sum + (Number.isFinite(pnl) ? pnl : 0);
    }, 0);
  }, [journal.data, todayKey]);

  const size = sizeMode === "auto" ? (detectedSize ?? NaN) : Number(accountSize);
  const daily = Number(dailyPct);
  const max = Number(maxPct);
  const peak = Number(peakEquity);
  // Day-start equity: the firm's daily reference resets at server midnight
  // from the higher of balance/equity. Journal-side estimate = live equity
  // minus today's realized P&L; the trader can override it (e.g. from the
  // firm's dashboard at midnight).
  const overrideDayStart = Number(dayStartOverride);
  const autoDayStart =
    detectedSize != null ? detectedSize - todayPnl : null;
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

  const LevelIcon =
    evaluation?.level === "breached" ? ShieldAlert
    : evaluation?.level === "danger" || evaluation?.level === "caution" ? TriangleAlert
    : ShieldCheck;

  return (
    <details className="risk-explanation" open>
      <summary>Funded account guard — prop-firm drawdown in %</summary>
      <p className="risk-detail-note">
        Prop firms write drawdown rules in <strong>percentages, not dollars</strong> —
        and the two limits run on <strong>different clocks</strong>. The industry
        benchmark (FTMO 2-Step): <strong>5% daily</strong> of the day&rsquo;s
        starting equity (resets at server midnight, moves with the account),
        <strong>10% maximum</strong> pinned to the starting balance (static — the
        floor never moves) or trailing peak equity. Breach either and the
        account is terminated — no warnings.
      </p>

      <div className="risk-calculator-grid">
        <Field label="Account size">
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
              <div className="funded-size-auto" title="Read from the live account (MT5 equity when connected)">
                {detectedSize != null ? `$${detectedSize.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "Detecting…"}
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
        <Field label="Day-start equity ($)">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="100"
            placeholder={autoDayStart != null ? `Auto: ${autoDayStart.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "e.g. 102000"}
            title="The firm's daily reference — equity at server midnight. Auto = live equity minus today's realized P&L. Override it from your firm's dashboard if needed."
            value={dayStartOverride}
            onChange={event => setDayStartOverride(event.target.value)}
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
        {drawdownType === "trailing" && (
          <Field label="Peak equity so far ($)">
            <Input
              type="number"
              inputMode="decimal"
              min="0"
              step="100"
              placeholder="e.g. 108000"
              value={peakEquity}
              onChange={event => setPeakEquity(event.target.value)}
            />
          </Field>
        )}
      </div>

      {!valid ? (
        <p className="muted">
          {sizeMode === "auto" && detectedSize == null
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
