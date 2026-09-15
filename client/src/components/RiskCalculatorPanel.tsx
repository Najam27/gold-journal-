import { useEffect, useRef, useState } from "react";
import { Bot, CircleDollarSign, ShieldAlert } from "lucide-react";
import { Field, RiskMetric } from "@/components/journalPrimitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSelectedAccountId, subscribeSelectedAccount } from "@/lib/accountSelection";
import { AI_UI_COPY, coachRisk, type AiRiskCoachOutcome } from "@/lib/ai/aiService";
import { uiStateForErrorCode, type AiUiState } from "@/lib/ai/aiTypes";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import { formatMoney } from "@/lib/gold";
import { openJournalView } from "@/lib/journalViewNavigation";
import { trpc } from "@/lib/trpc";

/**
 * Live broker-sized position guide. The deterministic calculation runs on the
 * authenticated backend against stored MT5 facts; the optional risk-process
 * review runs in this browser against the user's own Google AI Studio key.
 */
export function RiskCalculatorPanel() {
  // Position sizing must follow the active account, so the panel subscribes to
  // the shared selection instead of reading it once at render time.
  const [accountId, setAccountId] = useState<number | undefined>(() => getSelectedAccountId());
  useEffect(() => subscribeSelectedAccount(setAccountId), []);
  const [basis, setBasis] = useState<"EQUITY" | "BALANCE">("EQUITY");
  const [riskPercent, setRiskPercent] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const aiSettings = useAiSettings();
  const [coachOutcome, setCoachOutcome] = useState<AiRiskCoachOutcome | null>(null);
  const [coachUiState, setCoachUiState] = useState<AiUiState>("ready");
  const coachAbortRef = useRef<AbortController | null>(null);
  const validInput = Boolean(
    accountId &&
      Number(riskPercent) > 0 &&
      Number(entryPrice) > 0 &&
      Number(stopLoss) > 0 &&
      Number(entryPrice) !== Number(stopLoss)
  );
  const input = {
    accountId: accountId || 0,
    basis,
    riskPercent: Number(riskPercent),
    entryPrice: Number(entryPrice),
    stopLoss: Number(stopLoss),
  };
  const calculation = trpc.mt5.risk.useQuery(input, {
    enabled: validInput,
    refetchOnWindowFocus: false,
    staleTime: 2_000,
  });
  const result = calculation.data;
  const pending = coachUiState === "analyzing";
  const aiUnavailable = !aiSettings.configured;
  const startCoach = async () => {
    if (aiUnavailable || !result || pending) return;
    coachAbortRef.current?.abort();
    const controller = new AbortController();
    coachAbortRef.current = controller;
    setCoachOutcome(null);
    setCoachUiState("analyzing");
    const outcome = await coachRisk({
      calculation: result,
      signal: controller.signal,
      model: aiSettings.model ?? undefined,
    });
    if (controller.signal.aborted) {
      setCoachUiState("cancelled");
      return;
    }
    setCoachOutcome(outcome);
    setCoachUiState(
      outcome.available && outcome.coach ? "success" : uiStateForErrorCode(outcome.errorCode)
    );
  };
  return (
    <section className="panel risk-calculator-panel">
      <div className="mt5-section-head">
        <div>
          <span className="eyebrow">LIVE MT5 RISK CALCULATOR</span>
          <h3>Broker-sized XAUUSD position guide</h3>
          <p>
            Uses this account’s latest MT5 balance, equity, free margin,
            tick-loss value, and volume step. It does not send or place an
            order.
          </p>
        </div>
        <span className="risk-calculator-badge">
          <CircleDollarSign size={15} /> No execution
        </span>
      </div>
      <div className="risk-calculator-grid">
        <Field label="Capital basis">
          <select
            value={basis}
            onChange={event =>
              setBasis(event.target.value as "EQUITY" | "BALANCE")
            }
          >
            <option value="EQUITY">Live equity</option>
            <option value="BALANCE">Balance</option>
          </select>
        </Field>
        <Field label="Risk %">
          <Input
            type="number"
            min="0.01"
            max="10"
            step="0.01"
            value={riskPercent}
            onChange={event => setRiskPercent(event.target.value)}
          />
        </Field>
        <Field label="Entry price">
          <Input
            type="number"
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
            min="0"
            step="0.01"
            placeholder="e.g. 2344.00"
            value={stopLoss}
            onChange={event => setStopLoss(event.target.value)}
          />
        </Field>
      </div>
      {!validInput ? (
        <p className="muted">
          Select risk %, then enter a different entry and stop-loss price to
          calculate volume.
        </p>
      ) : calculation.isLoading ? (
        <p className="muted">Checking live broker constraints…</p>
      ) : result ? (
        <>
          <div className="risk-result-grid">
            <RiskMetric
              label="Risk amount"
              value={formatMoney(result.riskAmount)}
              detail={String(result.riskPercent) + "% of " + result.basis.toLowerCase()}
              tone="gold"
            />
            <RiskMetric
              label="Suggested lots"
              value={result.lots ? result.lots.toFixed(2) : "—"}
              detail={result.symbol || "Broker symbol pending"}
            />
            <RiskMetric
              label="Actual risk"
              value={result.actualRisk ? formatMoney(result.actualRisk) : "—"}
              detail={String(result.stopTicks || 0) + " stop ticks"}
              tone={result.valid ? "profit" : "loss"}
            />
            <RiskMetric
              label="Free margin"
              value={formatMoney(result.freeMargin)}
              detail="Verify broker margin before order"
            />
            <RiskMetric
              label="Stop distance"
              value={String(result.stopDistance || "—")}
              detail={`${result.stopTicks || 0} broker ticks`}
            />
            <RiskMetric
              label="Loss per lot"
              value={result.lossPerLot ? formatMoney(result.lossPerLot) : "—"}
              detail="At the specified stop"
            />
            <RiskMetric
              label="Risk budget used"
              value={`${result.riskBudgetUtilization.toFixed(1)}%`}
              detail="Actual risk ÷ requested risk"
              tone={result.riskBudgetUtilization >= 99 ? "profit" : "gold"}
            />
            <RiskMetric
              label="Risk / free margin"
              value={result.freeMarginRiskPercent == null ? "—" : `${result.freeMarginRiskPercent.toFixed(2)}%`}
              detail="Not a broker margin estimate"
            />
          </div>
          {result.warnings.length > 0 && (
            <div className="analysis-ai-empty">
              <ShieldAlert size={18} />
              <p>{result.warnings.join(" ")}</p>
            </div>
          )}
          <div className="risk-verification">
            <strong>Before you act</strong>
            {result.verification.map((step: string) => (
              <p key={step}>{step}</p>
            ))}
          </div>
          {aiUnavailable && (
            <div className="analysis-ai-empty">
              <ShieldAlert size={18} />
              <div>
                <strong>Google AI is not configured in this browser.</strong>
                <p>
                  Add your own Google AI Studio key in Options. The key stays in this
                  browser and never reaches Gold Journal servers.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openJournalView("options")}
                >
                  Open Options
                </Button>
              </div>
            </div>
          )}
          <div className="dialog-actions">
            <Button
              variant="outline"
              disabled={!result.valid || pending || aiUnavailable}
              onClick={() => void startCoach()}
            >
              <Bot size={15} />{" "}
              {pending ? "Reviewing in your browser…" : "AI risk coach review"}
            </Button>
            {pending && (
              <Button
                variant="outline"
                onClick={() => coachAbortRef.current?.abort()}
              >
                Cancel
              </Button>
            )}
          </div>
          {pending && (
            <div className="analysis-ai-empty">
              <Bot size={18} />
              <p>
                This browser is calling Google AI directly. Nothing is sent to
                Gold Journal servers.
              </p>
            </div>
          )}
          {coachOutcome?.available && coachOutcome.coach && (
            <div className="analysis-ai-report">
              <span className="section-label">
                AI RISK PROCESS REVIEW · {coachOutcome.coach.readiness}
              </span>
              <p>{coachOutcome.coach.summary}</p>
              {coachOutcome.coach.cautions.map((item: string) => (
                <p key={item}>• {item}</p>
              ))}
              {coachOutcome.coach.verificationSteps.map((item: string) => (
                <p key={item}>Verify: {item}</p>
              ))}
            </div>
          )}
          {!pending && coachOutcome && !coachOutcome.available && (
            <div className="analysis-ai-empty">
              <ShieldAlert size={18} />
              <div>
                <strong>{AI_UI_COPY[coachUiState].title}</strong>
                <p>{coachOutcome.message}</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="analysis-ai-empty">
          <ShieldAlert size={18} />
          <p>{calculation.error?.message || "Live MT5 risk data is unavailable."}</p>
        </div>
      )}
    </section>
  );
}
