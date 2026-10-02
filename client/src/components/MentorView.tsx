import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Bot, CheckCircle2, Eye, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { formatMoney } from "@/lib/gold";
import { openJournalView } from "@/lib/journalViewNavigation";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import { AI_UI_COPY, analyzeJournal, type AiAnalysisOutcome } from "@/lib/ai/aiService";
import { isModelError, isRequestSizeError, uiStateForError, uiStateForErrorCode, type AiUiState } from "@/lib/ai/aiTypes";
import { Button } from "@/components/ui/button";
import { RiskMetric } from "@/components/journalPrimitives";
import { MentorBriefPanel } from "@/components/MentorBriefPanel";
import { assessTiltRisk } from "@shared/tiltGuard";
import type { AnalysisResult } from "@shared/analysisEngine";
import type { BehaviorConfig } from "@/lib/psychology";

/**
 * The AI Mentor view: deterministic mentor brief (no key needed) plus the
 * optional evidence-bound AI edge analyst. Extracted from the journal page so
 * the page stays a router, not a 3,300-line god component.
 */
export function MentorView({ account, behaviorConfig }: { account?: any; behaviorConfig?: Partial<BehaviorConfig>; trades?: any; stats?: any; user?: any }) {
  const aiSettings = useAiSettings();
  const behaviorEvidence = trpc.analysis.get.useQuery(
    { accountId: account?.id ?? 0, filters: {} },
    { enabled: Boolean(account?.id), staleTime: 30_000, refetchOnWindowFocus: false }
  );
  // Pre-trade circuit breaker: the 30 most recent trades, newest first from the
  // server, re-sorted chronologically inside the guard.
  const recentTrades = trpc.trades.list.useQuery(
    { accountId: account?.id ?? 0, page: 1, pageSize: 30 },
    { enabled: Boolean(account?.id), staleTime: 30_000, refetchOnWindowFocus: false }
  );
  const tilt = useMemo(() => {
    const list = (recentTrades.data as any)?.trades as any[] | undefined;
    if (!list?.length) return null;
    return assessTiltRisk(
      list.map(trade => ({
        tradeDate: trade.tradeDate,
        closeTime: trade.closeTime,
        result: trade.result,
        pnl: trade.pnl,
        risk: trade.risk,
        behaviors: trade.mistake,
      })),
      { dailyLossLimit: behaviorConfig?.maxDailyLoss ?? null }
    );
  }, [recentTrades.data, behaviorConfig?.maxDailyLoss]);
  const saveAiReport = trpc.analysis.saveAiReport.useMutation();
  const [ai, setAi] = useState<AiAnalysisOutcome | null>(null);
  const [mentorUiState, setMentorUiState] = useState<AiUiState>("ready");
  const [mentorStage, setMentorStage] = useState<string | null>(null);
  const mentorAbortRef = useRef<AbortController | null>(null);
  const pending = mentorUiState === "analyzing";
  const run = async () => {
    if (!account?.id || !behaviorEvidence.data || pending) return;
    mentorAbortRef.current?.abort();
    const controller = new AbortController();
    mentorAbortRef.current = controller;
    setAi(null);
    setMentorUiState("analyzing");
    setMentorStage(null);
    const mentorEvidence = behaviorEvidence.data as unknown as AnalysisResult & {
      representativeTrades?: readonly any[];
    };
    // analyzeJournal resolves failures as outcomes, but a throw from the
    // deterministic fallback construction must still land somewhere: without
    // this guard the view would sit on "analyzing" forever.
    let outcome: AiAnalysisOutcome;
    try {
      outcome = await analyzeJournal({
        analysis: mentorEvidence,
        trades: mentorEvidence.representativeTrades,
        feature: "mentor",
        signal: controller.signal,
        model: aiSettings.model ?? undefined,
        onProgress: progress => {
          if (controller.signal.aborted) return;
          setMentorStage(
            progress.phase === "chunk"
              ? `Analyzing your journal in batches (${progress.index} of ${progress.total})…`
              : progress.phase === "synthesis"
                ? "Synthesizing the batch summaries…"
                : "Preparing compact journal evidence…"
          );
        },
      });
    } catch (error) {
      setMentorStage(null);
      setMentorUiState(controller.signal.aborted ? "cancelled" : uiStateForError(error));
      return;
    }
    setMentorStage(null);
    if (controller.signal.aborted) {
      setMentorUiState("cancelled");
      return;
    }
    setAi(outcome);
    if (outcome.available && outcome.report) {
      setMentorUiState("success");
      try {
        await saveAiReport.mutateAsync({
          accountId: account.id,
          filters: {},
          feature: "mentor",
          // Labelled like the analyst path so history can tell a local
          // deterministic report from a provider-produced one.
          model: outcome.deterministic ? "deterministic-local" : outcome.model ?? "unknown",
          report: outcome.report,
        });
      } catch {
        // Historical persistence is best-effort; the report stays visible.
      }
    } else {
      setMentorUiState(uiStateForErrorCode(outcome.errorCode));
    }
  };
  const report = ai?.report;
  const behavior: any = (behaviorEvidence.data as any)?.behavior;
  return (
    <>
      <section className="section-heading">
        <div>
          <span className="eyebrow">BEHAVIORAL INTELLIGENCE</span>
          <h2>AI Edge Analyst</h2>
          <p>
            Interpretation runs from compact deterministic aggregates plus a small
            representative set of structured trade fields. No key, JWT, screenshot,
            or raw journal note is sent from this browser, and every request is
            measured against the model's token budget before it is sent.
          </p>
        </div>
      </section>
      {behaviorEvidence.data ? (
        <MentorBriefPanel analysis={behaviorEvidence.data as unknown as AnalysisResult} tilt={tilt} />
      ) : null}
      <section className="panel mentor-run">
        <div className="mentor-icon">
          <Bot size={30} />
        </div>
        <h3>Evidence-bound trading report</h3>
        <p>
          AI is optional and never gates deterministic Analysis. It cannot issue
          BUY/SELL signals or invent journal statistics.
        </p>
        {!aiSettings.configured && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <div>
              <strong>Groq is not configured in this browser.</strong>
              <p>
                Add your own Groq API key in Options. The key stays in
                this browser and requests go directly to Groq.
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
        {behavior && (
          <section className="analysis-ai-report" aria-label="Deterministic behavior baseline">
            <span className="section-label">DETERMINISTIC BEHAVIOR BASELINE</span>
            <p>
              This is saved journal evidence, not a diagnosis. High activity is a
              concentration signal only; FOMO, revenge, overtrading, or oversizing
              appear here only when you tagged the related trade.
            </p>
            <div className="risk-result-grid">
              <RiskMetric label="Behavior-tagged" value={`${behavior.coverage.taggedTrades}/${behavior.coverage.closedTrades}`} detail="Closed trades with saved process tags" />
              <RiskMetric label="Emotion captured" value={`${behavior.coverage.emotionTaggedTrades}/${behavior.coverage.closedTrades}`} detail="Closed trades with an emotion field" />
              <RiskMetric label="Avg trades / day" value={String(behavior.activity.averageTradesPerActiveDay)} detail={`${behavior.activity.activeDays} active PKT days`} />
              <RiskMetric label="Most active day" value={String(behavior.activity.maxTradesInDay)} detail={`${behavior.activity.concentratedDays} concentrated day(s), not proof of overtrading`} />
            </div>
            <div className="analysis-ai-columns">
              <section>
                <span className="section-label">SAVED PROCESS TAGS</span>
                {behavior.tags.length ? behavior.tags.slice(0, 6).map((item: any) => (
                  <article className="ai-evidence-card" key={item.label}>
                    <strong>{item.label}</strong>
                    <p>{item.sample} tagged trade(s) · {item.expectancy >= 0 ? "+" : ""}{formatMoney(item.expectancy)} average P&amp;L</p>
                    <small>{item.confidence} confidence · tag only, not a psychological conclusion</small>
                  </article>
                )) : <p>No behavior tags are saved yet. Tag FOMO, revenge, overtrading, oversizing, or custom behaviors on a trade to review them here.</p>}
              </section>
              <section>
                <span className="section-label">EMOTIONAL CONTEXT</span>
                {behavior.emotions.length ? behavior.emotions.slice(0, 6).map((item: any) => (
                  <article className="ai-evidence-card" key={item.label}>
                    <strong>{item.label}</strong>
                    <p>{item.sample} tagged trade(s) · {item.expectancy >= 0 ? "+" : ""}{formatMoney(item.expectancy)} average P&amp;L</p>
                    <small>{item.confidence} confidence · self-reported journal context</small>
                  </article>
                )) : <p>No emotion fields are saved yet. Add how you felt before, during, and after a trade for useful behavioral review.</p>}
              </section>
            </div>
            {behavior.limitations.length > 0 && (
              <div className="analysis-ai-empty">
                <ShieldAlert size={18} />
                <div><strong>Behavior evidence is incomplete.</strong>{behavior.limitations.map((item: string) => <p key={item}>{item}</p>)}</div>
              </div>
            )}
          </section>
        )}
        <div className="ai-action-row">
          <Button
            size="lg"
            disabled={pending || !account?.id || !aiSettings.configured}
            onClick={() => void run()}
          >
            {pending ? "Analyzing in your browser…" : "Analyze my journal"}
          </Button>
          {pending && (
            <Button
              variant="outline"
              size="lg"
              onClick={() => mentorAbortRef.current?.abort()}
            >
              Cancel
            </Button>
          )}
        </div>
        {pending && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <p>
              {mentorStage ?? "Analyzing in your browser…"} This browser is
              calling Groq directly, nothing is sent to Gold Journal servers, and
              you can cancel at any time.
            </p>
          </div>
        )}
        {!pending && ai && !ai.available && (
          <div className="analysis-ai-empty">
            <ShieldAlert size={20} />
            <div>
              <strong>{AI_UI_COPY[mentorUiState].title}</strong>
              <p>{ai.message ?? "Add your key in Options and retry."}</p>
              {aiSettings.configured && mentorUiState !== "not_configured" && (
                <Button variant="outline" size="sm" onClick={() => void run()}>
                  Retry
                </Button>
              )}
              {isModelError(ai.errorCode) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openJournalView("options")}
                >
                  Pick an available Groq model
                </Button>
              )}
              {isRequestSizeError(ai.errorCode) && (
                <p className="muted">
                  This journal period holds more data than one AI request may
                  carry. Narrow the date range and retry, or retry now and the app
                  will re-plan the request in smaller batches.
                </p>
              )}
            </div>
          </div>
        )}
        {report && (
          <div className="mentor-report">
            {ai?.reducedAfterTooLarge && (
              <p className="analysis-warning" role="status">
                That journal period needed more tokens than one request may carry,
                so the evidence was reduced to a representative set and the request
                was re-sent. The statistics still cover every trade in the
                selected period.
              </p>
            )}
            {ai?.requestMode === "chunked" && (
              <p className="analysis-warning" role="status">
                This journal has more distinct contexts than one request can carry,
                so the contexts were summarized in batches and then synthesized
                into this report. The statistics still cover every trade.
              </p>
            )}
            {ai?.requestStats && (
              // Measured before the request was sent: sizes and counts only, never
              // the key and never the journal contents.
              <p className="muted" role="status">
                Request measured against {ai.model}:{" "}
                {ai.requestStats.inputCharacters.toLocaleString()} characters · ~
                {ai.requestStats.estimatedInputTokens.toLocaleString()} input tokens
                (prompt budget {ai.requestStats.inputTokenBudget.toLocaleString()}) ·{" "}
                {ai.requestStats.outputTokenBudget.toLocaleString()} reserved output · ~
                {ai.requestStats.estimatedTotalTokens.toLocaleString()} estimated total ·{" "}
                {ai.requestStats.evidenceRows} evidence rows ·{" "}
                {ai.requestStats.trades} representative trades of{" "}
                {ai.requestStats.journalTrades.toLocaleString()}.
              </p>
            )}
            <div className="mentor-verdict">
              <span className="section-label">DIRECT, EVIDENCE-BOUND VERDICT</span>
              <p>{report.executiveSummary}</p>
            </div>
            <div className="mentor-report-grid">
              <section>
                <span className="section-label">STRONGEST EDGES</span>
                {report.strongestEdges.map((item: any) => (
                  <article className="mentor-card" data-mentor-level="strength" key={item.label}>
                    <div className="mentor-card-head">
                      <CheckCircle2 size={17} aria-hidden />
                      <h4>{item.label}</h4>
                    </div>
                    <p className="mentor-card-message">{item.claim}</p>
                    <small className="mentor-card-evidence">
                      {item.sample} trades · {item.confidence} confidence
                    </small>
                  </article>
                ))}
              </section>
              <section>
                <span className="section-label">NEXT HYPOTHESES</span>
                {report.edgeHypotheses.map((item: any) => (
                  <article className="mentor-card" data-mentor-level="watch" key={item.title}>
                    <div className="mentor-card-head">
                      <Eye size={17} aria-hidden />
                      <h4>{item.title}</h4>
                    </div>
                    <p className="mentor-card-message">{item.statement}</p>
                    <p className="mentor-card-action">
                      <b>Next test:</b> {item.nextTest}
                    </p>
                    <small className="mentor-card-evidence">{item.confidence} confidence</small>
                  </article>
                ))}
              </section>
            </div>
            <div className="mentor-report-grid">
              <section>
                <span className="section-label">WEAKEST CONTEXTS</span>
                {report.weakestContexts.length ? report.weakestContexts.map((item: any) => (
                  <article className="mentor-card" data-mentor-level="fix" key={`${item.label}-${item.claim}`}>
                    <div className="mentor-card-head">
                      <AlertTriangle size={17} aria-hidden />
                      <h4>{item.label}</h4>
                    </div>
                    <p className="mentor-card-message">{item.claim}</p>
                    <small className="mentor-card-evidence">{item.sample} trades · {item.confidence} confidence</small>
                  </article>
                )) : <p>No qualified weak context can be supported by this sample.</p>}
              </section>
              <section className="mentor-leaks">
                <span className="section-label">LEAKS AND BLIND SPOTS</span>
                {(report.behavioralLeaks.length ? report.behavioralLeaks : report.winLossDifferences.potentialLeaks).map((item: string) => <p key={item}>• {item}</p>)}
                {!report.behavioralLeaks.length && !report.winLossDifferences.potentialLeaks.length && <p>No behavioral conclusion can be supported from the saved fields.</p>}
                {[...report.dataQuality.missing, ...report.dataQuality.warnings].map((item: string) => <p key={item}>• {item}</p>)}
              </section>
            </div>
            <details className="analysis-details">
              <summary>Controlled experiments before changing your strategy</summary>
              {report.experiments.map((item: any) => <p key={item.name}><b>{item.name}:</b> {item.compare} Required sample: {item.requiredSample}. {item.caution}</p>)}
            </details>
          </div>
        )}
      </section>
    </>
  );
}
