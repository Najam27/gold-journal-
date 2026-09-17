import React, { useEffect, useState, type ReactNode } from "react";
import { CircleDollarSign, Info, ShieldAlert } from "lucide-react";
import { Field, RiskMetric } from "@/components/journalPrimitives";
import { Input } from "@/components/ui/input";
import { getSelectedAccountId, subscribeSelectedAccount } from "@/lib/accountSelection";
import { formatMoney } from "@/lib/gold";
import { trpc } from "@/lib/trpc";
import {
  MAX_CUSTOM_RISK_PERCENT,
  MIN_CUSTOM_RISK_PERCENT,
  RISK_PROFILES,
  type RiskBasis,
  type RiskProfileId,
  type TradeDirection,
} from "@shared/riskCalculator";

/**
 * Deterministic, broker-aware position sizing.
 *
 * There is no AI anywhere in this panel: no key, no model, no provider call.
 * The browser only collects the user's own inputs and renders the arithmetic
 * result that `trpc.mt5.risk` computes on the authenticated backend from the
 * stored MT5 account metrics and broker contract specification.
 */

/** Price-distance text that stays readable for gold, FX, and index ticks. */
function price(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(Number(value).toFixed(5)).toString();
}

function count(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(Number(value).toFixed(2)).toLocaleString("en-US");
}

/** Money in the broker account's own currency, falling back to USD. */
function money(value: number | null | undefined, currency: string | null) {
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
    }).format(Number(value ?? 0));
  } catch {
    return formatMoney(value);
  }
}

/**
 * Risk percentages read as `1.00%` / `0.50%`, but a value with real extra
 * precision (for example 1.255%) is never rounded into a different number.
 */
const percentText = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const rounded = Number(Number(value).toFixed(4));
  const decimals = Number.isInteger(rounded * 100) ? 2 : 4;
  return `${rounded.toFixed(decimals)}%`;
};

/** Label block for controls that are not bound to a single native input. */
function ControlBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field risk-control-block">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function RiskCalculatorPanel() {
  // Position sizing must follow the active account, so the panel subscribes to
  // the shared selection instead of reading it once at render time.
  const [accountId, setAccountId] = useState<number | undefined>(() => getSelectedAccountId());
  useEffect(() => subscribeSelectedAccount(setAccountId), []);
  const [basis, setBasis] = useState<RiskBasis>("EQUITY");
  const [riskProfile, setRiskProfile] = useState<RiskProfileId>("STANDARD");
  const [customRiskPercent, setCustomRiskPercent] = useState("1.25");
  const [direction, setDirection] = useState<TradeDirection>("BUY");
  const [entryPrice, setEntryPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");

  const activeProfile = RISK_PROFILES.find(profile => profile.id === riskProfile) ?? RISK_PROFILES[2];
  const customValue = Number(customRiskPercent);
  const customRiskValid =
    customRiskPercent.trim() !== "" &&
    Number.isFinite(customValue) &&
    customValue >= MIN_CUSTOM_RISK_PERCENT &&
    customValue <= MAX_CUSTOM_RISK_PERCENT;
  const riskPercent = activeProfile.riskPercent ?? (customRiskValid ? customValue : NaN);

  const entry = Number(entryPrice);
  const stop = Number(stopLoss);
  const target = takeProfit.trim() === "" ? null : Number(takeProfit);
  const validInput = Boolean(
    accountId &&
      Number.isFinite(riskPercent) &&
      riskPercent >= MIN_CUSTOM_RISK_PERCENT &&
      riskPercent <= MAX_CUSTOM_RISK_PERCENT &&
      Number.isFinite(entry) &&
      entry > 0 &&
      Number.isFinite(stop) &&
      stop > 0 &&
      entry !== stop
  );

  const calculation = trpc.mt5.risk.useQuery(
    {
      accountId: accountId || 0,
      basis,
      riskProfile,
      riskPercent: riskPercent,
      direction,
      entryPrice: entry,
      stopLoss: stop,
      takeProfit: target != null && Number.isFinite(target) && target > 0 ? target : null,
    },
    { enabled: validInput, refetchOnWindowFocus: false, staleTime: 2_000 }
  );
  const result = calculation.data;

  return (
    <section className="panel risk-calculator-panel">
      <div className="mt5-section-head">
        <div>
          <span className="eyebrow">DETERMINISTIC RISK CALCULATOR</span>
          <h3>Broker-aware position sizing</h3>
          <p>
            Pure arithmetic over this account&rsquo;s live MT5 balance, equity,
            free margin, and broker contract specification. No AI is involved,
            and no order is ever sent.
          </p>
        </div>
        <span className="risk-calculator-badge">
          <CircleDollarSign size={15} /> No execution
        </span>
      </div>

      <div className="risk-calculator-grid">
        <ControlBlock label="Instrument">
          <div className="risk-static-value" title="Symbol reported by the active MT5 connection">
            {result?.symbol || "Awaiting MT5"}
          </div>
        </ControlBlock>
        <ControlBlock label="Direction">
          <div className="risk-segment" role="radiogroup" aria-label="Trade direction">
            {(["BUY", "SELL"] as TradeDirection[]).map(option => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={direction === option}
                className={`risk-segment-option ${option === "BUY" ? "buy" : "sell"} ${
                  direction === option ? "active" : ""
                }`}
                onClick={() => setDirection(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </ControlBlock>
        <Field label="Capital basis">
          <select value={basis} onChange={event => setBasis(event.target.value as RiskBasis)}>
            <option value="EQUITY">Live equity</option>
            <option value="BALANCE">Balance</option>
          </select>
        </Field>
        <Field label="Entry price">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="e.g. 2350.00"
            value={entryPrice}
            onChange={event => setEntryPrice(event.target.value)}
          />
        </Field>
        <Field label="Stop loss">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="e.g. 2344.00"
            value={stopLoss}
            onChange={event => setStopLoss(event.target.value)}
          />
        </Field>
        <Field label="Take profit (optional)">
          <Input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder="Optional"
            value={takeProfit}
            onChange={event => setTakeProfit(event.target.value)}
          />
        </Field>
      </div>

      <fieldset className="risk-profile-fieldset">
        <legend>Risk profile</legend>
        <div className="risk-profile-grid" role="radiogroup" aria-label="Risk profile">
          {RISK_PROFILES.map(profile => {
            const selected = riskProfile === profile.id;
            return (
              <button
                key={profile.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`risk-profile-option ${selected ? "active" : ""}`}
                onClick={() => setRiskProfile(profile.id)}
              >
                <span className="risk-profile-head">
                  <span className="risk-profile-label">{profile.label}</span>
                  <span className="risk-profile-value">
                    {profile.riskPercent == null
                      ? `${MIN_CUSTOM_RISK_PERCENT}–${MAX_CUSTOM_RISK_PERCENT}%`
                      : percentText(profile.riskPercent)}
                  </span>
                </span>
                <span className="risk-profile-detail">{profile.description}</span>
              </button>
            );
          })}
        </div>
        <p className="risk-profile-note">
          These are configurable application presets, not universal trading
          advice. The profile only supplies the risk percentage; the position
          size is always derived from your stop and the broker contract.
        </p>
      </fieldset>

      {activeProfile.riskPercent == null && (
        <div className="risk-custom-row">
          <Field label="Custom risk %">
            <Input
              type="number"
              inputMode="decimal"
              min={MIN_CUSTOM_RISK_PERCENT}
              max={MAX_CUSTOM_RISK_PERCENT}
              step="0.01"
              value={customRiskPercent}
              aria-invalid={!customRiskValid}
              onChange={event => setCustomRiskPercent(event.target.value)}
            />
          </Field>
          <p className={`risk-custom-hint ${customRiskValid ? "" : "invalid"}`}>
            {customRiskValid
              ? `Using ${percentText(customValue)} of the selected capital basis.`
              : `Enter a risk between ${MIN_CUSTOM_RISK_PERCENT}% and ${MAX_CUSTOM_RISK_PERCENT}%.`}
          </p>
        </div>
      )}

      {!validInput ? (
        <p className="muted">
          {activeProfile.riskPercent == null && !customRiskValid
            ? "Enter a valid custom risk percentage to calculate a position size."
            : "Select a risk profile, then enter an entry price and a different stop loss to calculate volume."}
        </p>
      ) : calculation.isLoading ? (
        <p className="muted" role="status">
          Calculating broker risk…
        </p>
      ) : calculation.error ? (
        <div className="risk-warning-panel" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Risk data could not be calculated</strong>
            <p>{calculation.error.message || "The broker risk request failed."}</p>
          </div>
        </div>
      ) : result && !result.dataAvailable ? (
        <div className="risk-warning-panel" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>Broker risk data unavailable</strong>
            <p>Connect MT5 to calculate broker-accurate position size.</p>
            {result.errors.map(message => (
              <p key={message} className="risk-warning-detail">
                {message}
              </p>
            ))}
            <p className="risk-warning-detail">
              Broker data is required for accurate position sizing. No generic
              value is substituted for a missing broker specification.
            </p>
          </div>
        </div>
      ) : result ? (
        <>
          <div className="risk-result-grid">
            <RiskMetric
              label="Risk amount"
              value={money(result.riskAmount, result.currency)}
              detail={`${percentText(result.riskPercent)} of ${
                result.basis === "EQUITY" ? "equity" : "balance"
              }`}
              tone="gold"
            />
            <RiskMetric
              label="Risk profile"
              value={result.riskProfileLabel}
              detail={`${percentText(result.riskPercent)} · ${result.direction}`}
            />
            <RiskMetric
              label="Position size"
              value={result.lots > 0 ? `${result.lots} lots` : "—"}
              detail={result.symbol ? `${result.symbol} · ${result.direction}` : "Broker symbol pending"}
            />
            <RiskMetric
              label="Actual risk"
              value={result.actualRisk ? money(result.actualRisk, result.currency) : "—"}
              detail={`${count(result.stopTicks)} broker ticks at the stop`}
              tone={result.valid ? "profit" : "loss"}
            />
            <RiskMetric
              label="Stop distance"
              value={`${price(result.stopDistance)} price units`}
              detail={`${count(result.stopTicks)} broker ticks`}
            />
            <RiskMetric
              label="Loss per lot"
              value={result.lossPerLot ? money(result.lossPerLot, result.currency) : "—"}
              detail="Stop ticks × broker tick value"
            />
            <RiskMetric
              label="Free margin"
              value={money(result.freeMargin, result.currency)}
              detail={`Capital reserved to hold a position · ${result.currency ?? "account currency"}`}
            />
            <RiskMetric
              label="Risk / free margin"
              value={result.freeMarginRiskPercent == null ? "—" : `${result.freeMarginRiskPercent.toFixed(2)}%`}
              detail="Risk vs reserved capital — not the same number"
            />
            <RiskMetric
              label="Risk budget used"
              value={`${result.riskBudgetUtilization.toFixed(1)}%`}
              detail="Actual risk ÷ requested risk"
              tone={result.riskBudgetUtilization >= 99 ? "profit" : "gold"}
            />
            {result.riskRewardRatio != null && (
              <RiskMetric
                label="Risk / reward"
                value={`1 : ${result.riskRewardRatio.toFixed(2)}`}
                detail={`${price(result.rewardDistance)} price units to target`}
              />
            )}
            {result.potentialProfit != null && (
              <RiskMetric
                label="Potential profit"
                value={money(result.potentialProfit, result.currency)}
                detail="Final broker-adjusted volume at the target"
              />
            )}
          </div>

          {result.belowBrokerMinimum && (
            <div className="risk-warning-panel" role="alert">
              <ShieldAlert size={18} />
              <div>
                <strong>WARNING</strong>
                <p>The broker&rsquo;s minimum volume would exceed your selected risk budget.</p>
                <p className="risk-warning-detail">
                  Calculated risk: {money(result.riskAmount, result.currency)}
                </p>
                <p className="risk-warning-detail">
                  Minimum executable risk: {money(result.minimumExecutableRisk, result.currency)} (
                  {result.minimumExecutableLots} lots)
                </p>
                <p className="risk-warning-detail">
                  Consider increasing stop distance or reducing the selected risk profile. The
                  position is never raised to the broker minimum automatically.
                </p>
              </div>
            </div>
          )}

          {!result.belowBrokerMinimum && result.errors.length > 0 && (
            <div className="risk-warning-panel" role="alert">
              <ShieldAlert size={18} />
              <div>
                <strong>No executable position size</strong>
                {result.errors.map(message => (
                  <p key={message} className="risk-warning-detail">
                    {message}
                  </p>
                ))}
              </div>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="risk-warning-panel caution" role="status">
              <ShieldAlert size={18} />
              <div>
                <strong>Check before you act</strong>
                {result.warnings.map(message => (
                  <p key={message} className="risk-warning-detail">
                    {message}
                  </p>
                ))}
              </div>
            </div>
          )}

          <div className="risk-verification">
            <strong>Before you act</strong>
            {result.verification.map((step: string) => (
              <p key={step}>{step}</p>
            ))}
          </div>

          <details className="risk-explanation">
            <summary>How this was calculated</summary>
            <div className="risk-detail-grid">
              <span>
                Capital basis <b>{result.basis === "EQUITY" ? "Equity" : "Balance"}</b>
              </span>
              <span>
                Capital <b>{money(result.capital, result.currency)}</b>
              </span>
              <span>
                Selected risk <b>{percentText(result.riskPercent)} ({result.riskProfileLabel})</b>
              </span>
              <span>
                Maximum risk <b>{money(result.riskAmount, result.currency)}</b>
              </span>
              <span>
                Entry <b>{price(entry)}</b>
              </span>
              <span>
                Stop <b>{price(stop)}</b>
              </span>
              <span>
                Stop distance <b>{price(result.stopDistance)} price units</b>
              </span>
              <span>
                Broker distance <b>{count(result.stopTicks)} ticks</b>
              </span>
              <span>
                Broker tick size <b>{price(result.broker?.tickSize)}</b>
              </span>
              <span>
                Broker tick value <b>{money(result.broker?.tickValueLoss, result.currency)} per lot</b>
              </span>
              <span>
                Loss per lot <b>{money(result.lossPerLot, result.currency)}</b>
              </span>
              <span>
                Calculated position <b>{result.rawLots} lots</b>
              </span>
              <span>
                Final broker-adjusted position <b>{result.lots} lots</b>
              </span>
              <span>
                Actual risk <b>{money(result.actualRisk, result.currency)}</b>
              </span>
              {result.takeProfit != null && (
                <span>
                  Take profit <b>{price(result.takeProfit)}</b>
                </span>
              )}
            </div>
            <p className="risk-detail-note">
              Risk amount = capital × selected risk. Stop ticks = stop distance ÷
              broker tick size. Loss per lot = stop ticks × broker tick value.
              Position size = risk amount ÷ loss per lot, then rounded down to
              the broker volume step so the requested risk is never exceeded.
            </p>
          </details>

          <details className="risk-explanation">
            <summary>Broker calculation details</summary>
            <div className="risk-detail-grid">
              <span>
                Symbol <b>{result.symbol ?? "—"}</b>
              </span>
              <span>
                Account balance <b>{money(result.account?.balance, result.currency)}</b>
              </span>
              <span>
                Account equity <b>{money(result.account?.equity, result.currency)}</b>
              </span>
              <span>
                Used margin <b>{money(result.account?.margin, result.currency)}</b>
              </span>
              <span>
                Free margin <b>{money(result.account?.freeMargin, result.currency)}</b>
              </span>
              <span>
                Tick size <b>{price(result.broker?.tickSize)}</b>
              </span>
              <span>
                Tick value <b>{money(result.broker?.tickValueLoss, result.currency)}</b>
              </span>
              <span>
                Contract size <b>{price(result.broker?.contractSize)}</b>
              </span>
              <span>
                Volume min <b>{price(result.broker?.volumeMin)}</b>
              </span>
              <span>
                Volume max <b>{price(result.broker?.volumeMax)}</b>
              </span>
              <span>
                Volume step <b>{price(result.broker?.volumeStep)}</b>
              </span>
              <span>
                Minimum executable risk <b>{money(result.minimumExecutableRisk, result.currency)}</b>
              </span>
            </div>
            <p className="risk-detail-note">
              <Info size={13} /> These values are read from the active MT5
              connection. They are never substituted with defaults for a
              different broker or instrument.
            </p>
          </details>
        </>
      ) : (
        <p className="muted">Enter your levels to calculate a position size.</p>
      )}
    </section>
  );
}
