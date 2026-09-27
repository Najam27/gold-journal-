import React, { useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Filter,
  LineChart,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/gold";
import { openJournalView } from "@/lib/journalViewNavigation";
import { trpc } from "@/lib/trpc";
import { AI_PROVIDER_META } from "@shared/aiCore";
import { AI_UI_COPY, analyzeJournal, type AiAnalysisOutcome } from "@/lib/ai/aiService";
import { isModelError, isRequestSizeError, uiStateForErrorCode, type AiUiState } from "@/lib/ai/aiTypes";
import { useAiSettings } from "@/lib/ai/useAiSettings";
import type {
  AnalysisFilters,
  AnalysisResult,
  MetricRow,
} from "@shared/analysisEngine";
import { buildPlaybook, type PlaybookCard } from "@shared/playbook";

type Props = { accountId?: number; trades?: unknown[] };
const money = (value: number | null) =>
  value == null ? "—" : formatMoney(value);
const number = (value: number | null, digits = 2) =>
  value == null ? "—" : value.toFixed(digits);

function MetricTable({
  title,
  rows,
  empty = "Complete more context fields to evaluate this dimension.",
}: {
  title: string;
  rows: MetricRow[];
  empty?: string;
}) {
  return (
    <section className="panel analysis-table-panel">
      <div className="panel-title">
        <div>
          <span>{title}</span>
          <h3>
            {rows.length ? `${rows.length} contexts` : "Awaiting evidence"}
          </h3>
        </div>
        <LineChart size={17} />
      </div>
      {rows.length ? (
        <div className="trade-table-wrap">
          <table className="trade-table analysis-table">
            <thead>
              <tr>
                <th>Context</th>
                <th>Sample</th>
                <th>Evidence</th>
                <th>Win rate</th>
                <th>Expectancy</th>
                <th>PF</th>
                <th>Avg R</th>
                <th>Drawdown</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map(row => (
                <tr key={`${title}-${row.key}`}>
                  <td data-label="Context">
                    <strong>{row.label}</strong>
                    <small className="analysis-subtext">
                      {row.confidence} confidence ·{" "}
                      {row.dataCompleteness.toFixed(0)}% data complete
                    </small>
                  </td>
                  <td className="data-text" data-label="Sample"><span className="analysis-cell-value">{row.sample}</span></td>
                  <td data-label="Evidence">
                    <span className="analysis-cell-value">
                      <span
                        className={`evidence-pill evidence-${row.evidenceTier.toLowerCase().replaceAll(" ", "-")}`}
                      >
                        {row.evidenceTier}
                      </span>
                      <small className="analysis-subtext">
                        {row.winRateInterval[0].toFixed(0)}–
                        {row.winRateInterval[1].toFixed(0)}% Wilson CI
                      </small>
                    </span>
                  </td>
                  <td className="data-text" data-label="Win rate"><span className="analysis-cell-value">{row.winRate.toFixed(1)}%</span></td>
                  <td
                    data-label="Expectancy"
                    className={`data-text ${row.expectancy >= 0 ? "positive" : "negative"}`}
                  >
                    <span className="analysis-cell-value">{money(row.expectancy)}</span>
                  </td>
                  <td className="data-text" data-label="PF">
                    <span className="analysis-cell-value">
                      {row.profitFactor == null
                        ? "No losses"
                        : row.profitFactor.toFixed(2)}
                    </span>
                  </td>
                  <td className="data-text" data-label="Avg R"><span className="analysis-cell-value">{number(row.averageR, 2)}</span></td>
                  <td className="data-text negative" data-label="Drawdown">
                    <span className="analysis-cell-value">{money(-row.maxDrawdown)}</span>
                  </td>
                  <td className="data-text" data-label="Score"><span className="analysis-cell-value">{row.edgeScore}/100</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="edge-empty">{empty}</p>
      )}
    </section>
  );
}

function PlaybookCardView({ card, tone }: { card: PlaybookCard; tone: "trade" | "avoid" }) {
  // .edge-callout is a 30px-icon + content grid (see gold-overrides.css): the
  // icon must be the first child or the content div collapses into the 30px
  // icon column.
  const Icon = tone === "trade" ? TrendingUp : ShieldAlert;
  return (
    <article className={`edge-callout ${tone === "trade" ? "strong" : "weak"}`}>
      <Icon size={18} />
      <div>
        <span>
          {card.dimension.toUpperCase()} &middot; {card.evidenceTier}
        </span>
        <strong>{card.label}</strong>
        <p>{card.headline}</p>
        <p>
          <b>Playbook rule:</b> {card.action}
        </p>
        <small>
          {card.sample} trades &middot; {card.winRate.toFixed(0)}% win rate
          {card.profitFactor != null && Number.isFinite(card.profitFactor)
            ? ` \u00b7 PF ${card.profitFactor.toFixed(2)}`
            : ""}
        </small>
      </div>
    </article>
  );
}

/**
 * The trader's playbook: contexts to size up on, contexts to starve.
 * Deterministic - the same journal always yields the same two lists.
 */
function PlaybookSection({ analysis }: { analysis: AnalysisResult }) {
  const playbook = useMemo(() => buildPlaybook(analysis), [analysis]);
  if (!playbook.trade.length && !playbook.avoid.length) {
    return (
      <section aria-label="Playbook">
        <span className="section-label">YOUR PLAYBOOK</span>
        <p className="edge-empty">{playbook.note}</p>
      </section>
    );
  }
  return (
    <section aria-label="Playbook">
      <span className="section-label">YOUR PLAYBOOK - TRADE THE LIST, NOT YOUR MOOD</span>
      <div className="analysis-ai-columns">
        <section aria-label="Trade more of this">
          <span className="section-label">TRADE MORE OF THIS</span>
          {playbook.trade.map(card => (
            <PlaybookCardView key={`${card.dimension}-${card.label}`} card={card} tone="trade" />
          ))}
        </section>
        <section aria-label="Stop bleeding here">
          <span className="section-label">STOP BLEEDING HERE</span>
          {playbook.avoid.length ? (
            playbook.avoid.map(card => (
              <PlaybookCardView key={`${card.dimension}-${card.label}`} card={card} tone="avoid" />
            ))
          ) : (
            <p className="edge-empty">No context is bleeding badly enough to ban - yet.</p>
          )}
        </section>
      </div>
    </section>
  );
}


function EdgeCard({ label, row }: { label: string; row: MetricRow | null }) {
  return (
    <article className="edge-callout strong">
      <Sparkles size={18} />
      <div>
        <span>{label}</span>
        <strong>{row?.label ?? "Not enough evidence"}</strong>
        <p>
          {row
            ? `${row.sample} trades · ${row.evidenceTier} · ${row.expectancy >= 0 ? "+" : ""}${money(row.expectancy)} expectancy · ${row.edgeScore}/100`
            : "Use the filters and log more closed trades before interpreting this context."}
        </p>
      </div>
    </article>
  );
}

function AiReport({ result }: { result: any }) {
  const report = result?.ai?.report;
  if (!result?.ai?.available || !report)
    return (
      <div className="analysis-ai-empty">
        <Bot size={20} />
        <div>
          <strong>
            {result?.ai?.message ?? "AI analysis is not configured."}
          </strong>
          <p>
            The deterministic evidence engine remains available. AI output never
            gates the Analysis page.
          </p>
        </div>
      </div>
    );
  return (
    <div className="analysis-ai-report">
      <div className="analysis-ai-summary">
        <span className="section-label">
          {result.ai.deterministic
            ? "DETERMINISTIC SUMMARY · NO AI PROVIDER USED"
            : `EVIDENCE-BOUND SUMMARY · ${result.ai.model ?? "AI"}`}
        </span>
        <p>{report.executiveSummary}</p>
      </div>
      <div className="analysis-ai-columns">
        <section>
          <span className="section-label">STRONGEST EDGES</span>
          {report.strongestEdges.map((item: any) => (
            <article
              className="ai-evidence-card"
              key={`${item.label}-${item.claim}`}
            >
              <strong>{item.label}</strong>
              <p>{item.claim}</p>
              <small>
                {item.sample} trades · {item.confidence} confidence ·{" "}
                {item.evidence}
              </small>
            </article>
          ))}
        </section>
        <section>
          <span className="section-label">EDGE HYPOTHESES</span>
          {report.edgeHypotheses.map((item: any) => (
            <article className="ai-evidence-card" key={item.title}>
              <strong>{item.title}</strong>
              <p>{item.statement}</p>
              <small>
                {item.confidence} confidence · Next test: {item.nextTest}
              </small>
            </article>
          ))}
        </section>
      </div>
      <details className="analysis-details" open>
        <summary>Direct risk, behavior, and data review</summary>
        <div className="analysis-ai-columns">
          <section>
            <span className="section-label">WEAKEST CONTEXTS</span>
            {report.weakestContexts.length ? report.weakestContexts.map((item: any) => (
              <article className="ai-evidence-card" key={`${item.label}-${item.claim}`}>
                <strong>{item.label}</strong>
                <p>{item.claim}</p>
                <small>{item.sample} trades · {item.confidence} confidence · {item.evidence}</small>
              </article>
            )) : <p>No qualified weak context was found in this sample.</p>}
          </section>
          <section>
            <span className="section-label">BEHAVIORAL / PROCESS LEAKS</span>
            {(report.behavioralLeaks.length ? report.behavioralLeaks : report.winLossDifferences.potentialLeaks).map((item: string) => <p key={item}>• {item}</p>)}
            {!report.behavioralLeaks.length && !report.winLossDifferences.potentialLeaks.length && <p>No behavior leak can be supported by the saved data.</p>}
            <span className="section-label">DATA LIMITS</span>
            {[...report.dataQuality.missing, ...report.dataQuality.warnings].map((item: string) => <p key={item}>• {item}</p>)}
            {!report.dataQuality.missing.length && !report.dataQuality.warnings.length && <p>No material data-quality limitation was reported.</p>}
          </section>
        </div>
      </details>
      <details className="analysis-details">
        <summary>Personal playbook and experiments</summary>
        <div className="analysis-ai-columns">
          <section>
            <span className="section-label">PLAYBOOK</span>
            <p>
              <b>Best conditions:</b>{" "}
              {report.playbook.bestConditions.join("; ") ||
                "Insufficient evidence."}
            </p>
            <p>
              <b>Weak conditions:</b>{" "}
              {report.playbook.weakConditions.join("; ") ||
                "Insufficient evidence."}
            </p>
            <p>
              <b>Next experiments:</b>{" "}
              {report.playbook.nextExperiments.join("; ") || "None proposed."}
            </p>
          </section>
          <section>
            <span className="section-label">CONTROLLED EXPERIMENTS</span>
            {report.experiments.map((item: any) => (
              <p key={item.name}>
                <b>{item.name}:</b> {item.compare} Required sample:{" "}
                {item.requiredSample}.
              </p>
            ))}
          </section>
        </div>
      </details>
    </div>
  );
}

export function AnalysisDashboard({ accountId }: Props) {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [session, setSession] = useState("");
  const [timeframe, setTimeframe] = useState("");
  const [level, setLevel] = useState("");
  const [setup, setSetup] = useState("");
  const [direction, setDirection] = useState("");
  const [result, setResult] = useState("");
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [previousStart, setPreviousStart] = useState("");
  const [previousEnd, setPreviousEnd] = useState("");
  const filters = useMemo<AnalysisFilters>(
    () => ({
      startDate: startDate || null,
      endDate: endDate || null,
      session: session || null,
      timeframe: timeframe || null,
      level: level || null,
      setup: setup || null,
      direction: direction ? (direction as "BUY" | "SELL") : null,
      result: result ? (result as AnalysisFilters["result"]) : null,
    }),
    [startDate, endDate, session, timeframe, level, setup, direction, result]
  );
  const query = trpc.analysis.get.useQuery(
    { accountId: accountId ?? 0, filters },
    {
      enabled: Boolean(accountId),
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    }
  );
  const aiSettings = useAiSettings();
  const [aiOutcome, setAiOutcome] = useState<AiAnalysisOutcome | null>(null);
  const [aiUiState, setAiUiState] = useState<AiUiState>("ready");
  const [aiStage, setAiStage] = useState<string | null>(null);
  const aiRunning = aiUiState === "analyzing";
  const aiAbortRef = useRef<AbortController | null>(null);
  const saveAiReport = trpc.analysis.saveAiReport.useMutation();
  const analysis = query.data as AnalysisResult | undefined;
  const representativeTrades = (query.data as { representativeTrades?: readonly any[] } | undefined)?.representativeTrades;
  const comparisonQuery = trpc.analysis.compare.useQuery(
    {
      accountId: accountId ?? 0,
      current: filters,
      previous: {
        ...filters,
        startDate: previousStart || null,
        endDate: previousEnd || null,
      },
    },
    {
      enabled: Boolean(
        accountId && compareEnabled && previousStart && previousEnd
      ),
      refetchOnWindowFocus: false,
    }
  );
  const selectOptions = (rows: MetricRow[] | undefined) =>
    (rows ?? [])
      .map(row => row.label)
      .filter(Boolean)
      .slice(0, 100);
  const clearFilters = () => {
    setStartDate("");
    setEndDate("");
    setSession("");
    setTimeframe("");
    setLevel("");
    setSetup("");
    setDirection("");
    setResult("");
    setPreviousStart("");
    setPreviousEnd("");
    setCompareEnabled(false);
  };
  const runAi = async () => {
    if (!accountId || !analysis || aiRunning) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiOutcome(null);
    setAiUiState("analyzing");
    setAiStage(null);
    const outcome = await analyzeJournal({
      analysis,
      trades: representativeTrades,
      feature: "analysis",
      signal: controller.signal,
      model: aiSettings.model ?? undefined,
      onProgress: progress => {
        if (controller.signal.aborted) return;
        setAiStage(
          progress.phase === "chunk"
            ? `Analyzing your journal in batches (${progress.index} of ${progress.total})…`
            : progress.phase === "synthesis"
              ? "Synthesizing the batch summaries…"
              : "Preparing compact journal evidence…"
        );
      },
    });
    setAiStage(null);
    if (controller.signal.aborted) {
      setAiUiState("cancelled");
      return;
    }
    setAiOutcome(outcome);
    if (outcome.available && outcome.report) {
      setAiUiState("success");
      try {
        await saveAiReport.mutateAsync({
          accountId,
          filters,
          // A deterministic report is labelled as such so history can tell the
          // two apart without pretending a provider produced it.
          model: outcome.deterministic ? "deterministic-local" : outcome.model ?? "unknown",
          report: outcome.report,
        });
      } catch {
        // Historical persistence is best-effort; the browser report stays visible.
      }
    } else {
      setAiUiState(uiStateForErrorCode(outcome.errorCode));
    }
  };
  const cancelAi = () => {
    aiAbortRef.current?.abort();
    setAiStage(null);
    setAiUiState("cancelled");
  };
  if (!accountId)
    return (
      <section className="panel">
        <p>Select an account to begin deterministic analysis.</p>
      </section>
    );
  if (query.isLoading)
    return (
      <div className="page-loader">
        <div />
        <span>Building evidence from your closed trades…</span>
      </div>
    );
  if (query.isError)
    return (
      <section className="panel query-error">
        <ShieldAlert size={22} />
        <div>
          <h2>Analysis could not load.</h2>
          <p>{query.error.message}</p>
          <Button onClick={() => void query.refetch()}>
            <RefreshCcw size={15} /> Try again
          </Button>
        </div>
      </section>
    );
  if (!analysis) return null;
  return (
    <>
      <section className="section-heading">
        <div>
          <span className="eyebrow">TRADER PERFORMANCE TERMINAL</span>
          <h2>Analysis & Edge Development</h2>
          <p>
            Deterministic facts come first. AI can interpret the supplied
            evidence, but it cannot create a statistic or a trading signal.
          </p>
        </div>
        <div className="edge-sample">
          <BarChart3 size={17} />
          <span className="data-text">
            {analysis.period.sample} closed trades · {analysis.timezone} buckets
          </span>
        </div>
      </section>
      <section className="panel analysis-filter-panel">
        <div className="panel-title">
          <div>
            <span>ACTIVE DATA SCOPE</span>
            <h3>
              <Filter size={16} /> Filter the evidence
            </h3>
          </div>
          <Button variant="outline" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
        <div className="analysis-filter-grid">
          <label>
            <span>Start</span>
            <Input
              type="date"
              value={startDate}
              onChange={event => setStartDate(event.target.value)}
            />
          </label>
          <label>
            <span>End</span>
            <Input
              type="date"
              value={endDate}
              onChange={event => setEndDate(event.target.value)}
            />
          </label>
          <label>
            <span>Session</span>
            <select
              value={session}
              onChange={event => setSession(event.target.value)}
            >
              <option value="">All sessions</option>
              {selectOptions(analysis.sessions).map(value => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Timeframe</span>
            <select
              value={timeframe}
              onChange={event => setTimeframe(event.target.value)}
            >
              <option value="">All timeframes</option>
              {selectOptions(analysis.timeframes).map(value => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Level</span>
            <select
              value={level}
              onChange={event => setLevel(event.target.value)}
            >
              <option value="">All levels</option>
              {selectOptions(analysis.levels).map(value => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Setup</span>
            <select
              value={setup}
              onChange={event => setSetup(event.target.value)}
            >
              <option value="">All setups</option>
              {selectOptions(analysis.setups).map(value => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Direction</span>
            <select
              value={direction}
              onChange={event => setDirection(event.target.value)}
            >
              <option value="">Both directions</option>
              <option>BUY</option>
              <option>SELL</option>
            </select>
          </label>
          <label>
            <span>Result</span>
            <select
              value={result}
              onChange={event => setResult(event.target.value)}
            >
              <option value="">All results</option>
              <option>WIN</option>
              <option>LOSS</option>
              <option>BREAK_EVEN</option>
              <option>OPEN</option>
            </select>
          </label>
        </div>
        <p className="analysis-filter-note">
          Active filters are applied to deterministic metrics and are included
          in any AI request. OPEN trades are never included in performance
          calculations.
        </p>
        <div className="analysis-compare-toggle">
          <label>
            <input
              type="checkbox"
              checked={compareEnabled}
              onChange={event => setCompareEnabled(event.target.checked)}
            />{" "}
            Compare with another period
          </label>
          {compareEnabled && (
            <div className="analysis-compare-fields">
              <label>
                <span>Previous start</span>
                <Input
                  type="date"
                  value={previousStart}
                  onChange={event => setPreviousStart(event.target.value)}
                />
              </label>
              <label>
                <span>Previous end</span>
                <Input
                  type="date"
                  value={previousEnd}
                  onChange={event => setPreviousEnd(event.target.value)}
                />
              </label>
            </div>
          )}
        </div>
      </section>
      {compareEnabled && comparisonQuery.data && (
        <section className="panel analysis-compare-panel">
          <div className="panel-title">
            <div>
              <span>PERIOD COMPARISON</span>
              <h3>Current vs previous selected range</h3>
            </div>
            <LineChart size={17} />
          </div>
          <div className="metric-list">
            <span>
              Win rate delta{" "}
              <b>{comparisonQuery.data.delta.overview.winRate.toFixed(2)} pp</b>
            </span>
            <span>
              Expectancy delta{" "}
              <b>{money(comparisonQuery.data.delta.overview.expectancy)}</b>
            </span>
            <span>
              Profit factor delta{" "}
              <b>
                {comparisonQuery.data.delta.overview.profitFactor == null
                  ? "—"
                  : comparisonQuery.data.delta.overview.profitFactor.toFixed(2)}
              </b>
            </span>
            <span>
              Average actual R delta{" "}
              <b>{number(comparisonQuery.data.delta.overview.averageR, 3)}</b>
            </span>
            <span>
              Drawdown delta{" "}
              <b>{money(comparisonQuery.data.delta.overview.maxDrawdown)}</b>
            </span>
          </div>
        </section>
      )}
      <section className="stats-grid analysis-overview-grid">
        <div className="stat-card stat-gold">
          <p>EDGE SCORE</p>
          <strong className="data-text">
            {analysis.overview.edgeScore}/100
          </strong>
          <span>
            {analysis.overview.evidenceTier} · {analysis.overview.confidence}{" "}
            confidence
          </span>
        </div>
        <div className="stat-card stat-green">
          <p>EXPECTANCY</p>
          <strong className="data-text">
            {money(analysis.overview.expectancy)}
          </strong>
          <span>
            {number(analysis.overview.expectancyR, 3)}R per closed trade
          </span>
        </div>
        <div className="stat-card stat-neutral">
          <p>PROFIT FACTOR</p>
          <strong className="data-text">
            {analysis.overview.profitFactor == null
              ? "No losses"
              : analysis.overview.profitFactor.toFixed(2)}
          </strong>
          <span>
            {analysis.overview.grossProfit.toFixed(2)} gross profit ·{" "}
            {analysis.overview.grossLoss.toFixed(2)} loss
          </span>
        </div>
        <div className="stat-card stat-red">
          <p>MAX DRAWDOWN</p>
          <strong className="data-text">
            {money(-analysis.overview.maxDrawdown)}
          </strong>
          <span>{analysis.overview.drawdownCount} drawdown periods</span>
        </div>
        <div className="stat-card stat-neutral">
          <p>AVERAGE ACTUAL R</p>
          <strong className="data-text">
            {number(analysis.execution.averageActualR, 3)}R
          </strong>
          <span>{analysis.execution.actualRAvailable} risk-defined closed trades</span>
        </div>
        <div className="stat-card stat-gold">
          <p>AVERAGE PLANNED R:R</p>
          <strong className="data-text">
            {analysis.execution.averagePlannedR == null ? "—" : `1 : ${number(analysis.execution.averagePlannedR, 3)}`}
          </strong>
          <span>{analysis.execution.plannedRAvailable} trades with planned risk and reward</span>
        </div>
        <div className="stat-card stat-neutral">
          <p>AVERAGE TARGET CAPTURE</p>
          <strong className="data-text">
            {analysis.execution.averageTargetCapture == null ? "—" : `${number(analysis.execution.averageTargetCapture, 1)}%`}
          </strong>
          <span>Actual P&amp;L ÷ planned reward</span>
        </div>
      </section>
      <section className="edge-callouts">
        <EdgeCard label="TOP EDGE" row={analysis.edgeCards.top} />
        <EdgeCard
          label="WEAKEST QUALIFIED CONTEXT"
          row={analysis.edgeCards.weak}
        />
        <EdgeCard
          label="MOST CONSISTENT"
          row={analysis.edgeCards.mostConsistent}
        />
        <EdgeCard label="BEST R-MULTIPLE" row={analysis.edgeCards.bestR} />
      </section>
      <PlaybookSection analysis={analysis} />
      <MetricTable title="SESSION ANALYSIS" rows={analysis.sessions} />
      <MetricTable title="TIMEFRAME ANALYSIS" rows={analysis.timeframes} />
      <MetricTable title="LEVEL ANALYSIS" rows={analysis.levels} />
      <MetricTable
        title="SETUP / STRATEGY ANALYSIS"
        rows={analysis.setups}
        empty="No setup value is stored on the selected trades. The engine will not guess a strategy from notes."
      />
      <div className="edge-grid edge-grid-combos">
        <MetricTable
          title="SESSION × TIMEFRAME"
          rows={analysis.sessionTimeframes}
          empty="No session × timeframe pair has 2+ closed trades yet."
        />
        <MetricTable
          title="LEVEL × SESSION"
          rows={analysis.levelSessions}
          empty="No level × session pair has 2+ closed trades yet. Fill both the level and session fields on your trades to populate this."
        />
        <MetricTable
          title="LEVEL × TIMEFRAME"
          rows={analysis.levelTimeframes}
          empty="No level × timeframe pair has 2+ closed trades yet."
        />
        <MetricTable title="DIRECTION" rows={analysis.directions} />
        <MetricTable title="DAY / UTC" rows={analysis.days} />
        <MetricTable title="HOUR / UTC" rows={analysis.hours} />
      </div>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>WIN vs LOSS</span>
            <h3>What separates observed outcomes?</h3>
          </div>
          <BarChart3 size={17} />
        </div>
        <div className="analysis-secondary-grid">
          <div className="metric-list">
            <span>
              Winner average P&L{" "}
              <b className="positive">
                {money(analysis.winLoss.winners.averagePnl)}
              </b>
            </span>
            <span>
              Winner average R{" "}
              <b>{number(analysis.winLoss.winners.averageR, 3)}</b>
            </span>
            <span>
              Loser average P&L{" "}
              <b className="negative">
                {money(analysis.winLoss.losers.averagePnl)}
              </b>
            </span>
            <span>
              Loser average R{" "}
              <b>{number(analysis.winLoss.losers.averageR, 3)}</b>
            </span>
          </div>
          <div className="metric-list">
            {analysis.winLoss.dimensions.map(item => (
              <span key={item.dimension}>
                {item.dimension}{" "}
                <b>
                  {item.winnerContext ?? "—"} vs {item.loserContext ?? "—"}
                </b>
              </span>
            ))}
          </div>
        </div>
        <p className="analysis-filter-note">
          These are observed context leaders, not causal explanations. Small
          samples remain hypothesis-level evidence.
        </p>
      </section>
      <section className="analysis-secondary-grid">
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>STREAK & DRAWDOWN</span>
              <h3>Sequence evidence</h3>
            </div>
            <AlertTriangle size={17} />
          </div>
          <div className="metric-list">
            <span>
              Current streak{" "}
              <b>
                {analysis.streaks.current.length
                  ? `${analysis.streaks.current.length} ${analysis.streaks.current.type}`
                  : "None"}
              </b>
            </span>
            <span>
              Longest win streak <b>{analysis.streaks.longestWin}</b>
            </span>
            <span>
              Longest loss streak <b>{analysis.streaks.longestLoss}</b>
            </span>
            <span>
              Drawdown duration <b>{analysis.drawdown.durationTrades} trades</b>
            </span>
            <span>
              Recovery duration <b>{analysis.drawdown.recoveryTrades} trades</b>
            </span>
          </div>
        </section>
        <section className="panel">
          <div className="panel-title">
            <div>
              <span>RISK & TRADE MANAGEMENT</span>
              <h3>Execution evidence</h3>
            </div>
            <LineChart size={17} />
          </div>
          <div className="metric-list">
            <span>
              Risk coverage <b>{analysis.risk.available} trades</b>
            </span>
            <span>
              Average risk <b>{money(analysis.risk.average)}</b>
            </span>
            <span>
              Risk consistency{" "}
              <b>
                {analysis.risk.consistency == null
                  ? "—"
                  : `${(analysis.risk.consistency * 100).toFixed(0)}%`}
              </b>
            </span>
            <span>
              Planned R:R average{" "}
              <b>{analysis.execution.averagePlannedR == null ? "—" : `1 : ${number(analysis.execution.averagePlannedR, 3)}`}</b>
            </span>
            <span>
              Actual R average{" "}
              <b>{analysis.execution.averageActualR == null ? "—" : `${number(analysis.execution.averageActualR, 3)}R`}</b>
            </span>
            <span>
              Reached / exceeded target{" "}
              <b>{analysis.execution.targetCaptureAvailable ? `${analysis.execution.reachedOrExceededTarget}/${analysis.execution.targetCaptureAvailable}` : "—"}</b>
            </span>
            <span>
              Profitable below target{" "}
              <b>{analysis.execution.targetCaptureAvailable ? `${analysis.execution.profitableBelowTarget}/${analysis.execution.targetCaptureAvailable}` : "—"}</b>
            </span>
            <span>
              Duration median{" "}
              <b>
                {analysis.duration.medianMinutes == null
                  ? "—"
                  : `${analysis.duration.medianMinutes} min`}
              </b>
            </span>
            <span>Target capture <b>{analysis.execution.medianTargetCapture == null ? "—" : `${number(analysis.execution.medianTargetCapture, 1)}% median`}</b></span>
          </div>
          <p className="analysis-filter-note">{analysis.execution.message}</p>
        </section>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>JOURNAL QUALITY</span>
            <h3>{analysis.journalQuality.completeness.toFixed(0)}% complete</h3>
          </div>
          <ShieldAlert size={17} />
        </div>
        <p>
          {analysis.journalQuality.complete} complete closed trades ·{" "}
          {analysis.journalQuality.incomplete} incomplete. Missing fields reduce
          analysis confidence but do not alter performance math.
        </p>
        <div className="analysis-warning-list">
          {analysis.journalQuality.warnings.slice(0, 8).map(item => (
            <span key={item.field}>
              <AlertTriangle size={14} />
              {item.message}
            </span>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>MFE / MAE</span>
            <h3>
              {analysis.mfeMae.available
                ? `${analysis.mfeMae.available} trades available`
                : "Not available"}
            </h3>
          </div>
          <LineChart size={17} />
        </div>
        <p>{analysis.mfeMae.message}</p>
      </section>
      <section className="panel ai-surface">
        <div className="panel-title">
          <div>
            <span>AI EDGE ANALYST</span>
            <h3>Interpret the evidence</h3>
          </div>
          <Bot size={18} />
        </div>
        <p>
          AI receives complete aggregated metrics plus a small deterministic set
          of structured trade fields. It never receives credentials, JWTs,
          screenshots, or raw journal notes, and it cannot produce market
          signals. Every request is measured against the model's token budget
          before it is sent.
        </p>
        {!aiSettings.configured && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <div>
              <strong>No AI provider is configured in this browser.</strong>
              <p>
                Add your own Google Gemini or Groq API key in Options. The key stays
                in this browser and requests go straight to the provider.
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
        <div className="ai-action-row">
          <Button
            size="lg"
            disabled={aiRunning || !aiSettings.configured}
            onClick={() => void runAi()}
          >
            <Bot size={16} />
            {aiRunning
              ? "Analyzing in your browser…"
              : aiOutcome
                ? "Re-analyze my journal"
                : "Analyze my journal"}
          </Button>
          {aiRunning && (
            <Button variant="outline" size="lg" onClick={cancelAi}>
              Cancel
            </Button>
          )}
        </div>
        {aiRunning && (
          <div className="analysis-ai-empty ai-loading" role="status">
            <Bot size={20} />
            <p>
              {aiStage ?? "Analyzing in your browser…"} This browser is calling your
              configured AI provider directly, nothing is sent to Gold Journal
              servers, and you can cancel at any time.
            </p>
          </div>
        )}
        {!aiRunning && aiUiState !== "success" && aiUiState !== "ready" && (
          <div className="analysis-ai-empty">
            <AlertTriangle size={20} />
            <div>
              <strong>{AI_UI_COPY[aiUiState].title}</strong>
              <p>{aiOutcome?.message ?? AI_UI_COPY[aiUiState].body}</p>
              {aiOutcome?.warning && <p className="muted">{aiOutcome.warning}</p>}
              {aiSettings.configured && aiUiState !== "not_configured" && (
                <Button variant="outline" size="sm" onClick={() => void runAi()}>
                  Retry
                </Button>
              )}
              {isModelError(aiOutcome?.errorCode) && (
                <Button variant="outline" size="sm" onClick={() => openJournalView("options")}>
                  Pick an available model
                </Button>
              )}
              {aiOutcome?.errorCode === "invalid_key" && (
                <Button variant="outline" size="sm" onClick={() => openJournalView("options")}>
                  Fix AI key
                </Button>
              )}
              {isRequestSizeError(aiOutcome?.errorCode) && (
                <p className="muted">
                  Tip: narrow Start date / End date above, or retry — the app will
                  re-plan the request in smaller batches.
                </p>
              )}
            </div>
          </div>
        )}
        {aiOutcome && !aiRunning && aiOutcome.available && (
          <>
            {aiOutcome.deterministic && (
              <p className="analysis-warning" role="status">
                No AI provider could produce a report, so this is the complete
                deterministic report built from your own journal calculations.
                {aiOutcome.providerErrors?.length
                  ? ` Tried: ${aiOutcome.providerErrors
                      .map(item => `${AI_PROVIDER_META[item.provider].label} (${item.code.replace(/_/g, " ")})`)
                      .join(", ")}.`
                  : ""}
              </p>
            )}
            {!aiOutcome.deterministic && aiOutcome.providerErrors?.length ? (
              <p className="analysis-warning" role="status">
                Automatic fallback used:{" "}
                {aiOutcome.provider
                  ? AI_PROVIDER_META[aiOutcome.provider].label
                  : "another provider"}{" "}
                answered after{" "}
                {aiOutcome.providerErrors.map(item => AI_PROVIDER_META[item.provider].label).join(", ")}{" "}
                failed for this request.
              </p>
            ) : null}
            {aiOutcome.repairs?.length ? (
              <p className="muted" role="status">
                {aiOutcome.repairs.join(" ")}
              </p>
            ) : null}
            {aiOutcome.modelRepairedFrom && (
              <p className="analysis-warning" role="status">
                {aiOutcome.modelRepairedFrom} is no longer offered by Groq. This
                report used {aiOutcome.model}, and that selection has been saved.
              </p>
            )}
            {aiOutcome.schemaFallback && (
              <p className="analysis-warning" role="status">
                Groq rejected the strict response schema for this model, so the
                analysis was retried in JSON mode and validated locally before it
                was accepted.
              </p>
            )}
            {aiOutcome.reducedAfterTooLarge && (
              <p className="analysis-warning" role="status">
                That journal period needed more tokens than one request may carry,
                so the evidence was reduced to a representative set and the request
                was re-sent. The performance statistics still cover every trade in
                the selected period.
              </p>
            )}
            {aiOutcome.requestMode === "chunked" && (
              <p className="analysis-warning" role="status">
                This journal has more distinct contexts than one request can carry,
                so the contexts were summarized in batches and then synthesized into
                a single report. The statistics still cover every trade.
              </p>
            )}
            {aiOutcome.requestStats && (
              // Measured before the request was sent: sizes and counts only, never
              // the key and never the journal contents.
              <p className="muted" role="status">
                Request measured against {aiOutcome.model}:{" "}
                {aiOutcome.requestStats.inputCharacters.toLocaleString()} characters ·
                ~{aiOutcome.requestStats.estimatedInputTokens.toLocaleString()} input tokens
                (prompt budget {aiOutcome.requestStats.inputTokenBudget.toLocaleString()}) ·{" "}
                {aiOutcome.requestStats.outputTokenBudget.toLocaleString()} reserved output ·{" "}
                ~{aiOutcome.requestStats.estimatedTotalTokens.toLocaleString()} estimated total ·{" "}
                {aiOutcome.requestStats.evidenceRows} evidence rows ·{" "}
                {aiOutcome.requestStats.trades} representative trades of{" "}
                {aiOutcome.requestStats.journalTrades.toLocaleString()}.
              </p>
            )}
            <AiReport result={{ ai: aiOutcome }} />
          </>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>EXIT EFFICIENCY</span>
            <h3>How much of the move you kept</h3>
          </div>
          <Sparkles size={18} />
        </div>
        {analysis.exitEfficiency.available ? (
          <>
            <div className="metric-list">
              <span>
                Captured <b>{analysis.exitEfficiency.averageCapturedPct != null ? `${analysis.exitEfficiency.averageCapturedPct.toFixed(0)}%` : "—"}</b>
                {" "}of the available move on average (median {analysis.exitEfficiency.medianCapturedPct != null ? `${analysis.exitEfficiency.medianCapturedPct.toFixed(0)}%` : "—"})
              </span>
              <span>
                Left on the table <b>{analysis.exitEfficiency.totalLeftOnTable != null ? money(analysis.exitEfficiency.totalLeftOnTable) : "—"}</b>
                {" "}across {analysis.exitEfficiency.sample} trade{analysis.exitEfficiency.sample === 1 ? "" : "s"} with excursion data
              </span>
              {analysis.exitEfficiency.averageHeatPct != null && (
                <span>
                  Heat endured <b>{analysis.exitEfficiency.averageHeatPct.toFixed(0)}%</b> of planned risk on average
                </span>
              )}
              {analysis.exitEfficiency.earlyExitCount > 0 && (
                <span>
                  <b>{analysis.exitEfficiency.earlyExitCount}</b> winner{analysis.exitEfficiency.earlyExitCount === 1 ? "" : "s"} exited with less than half the move captured
                </span>
              )}
              {analysis.exitEfficiency.averageLeftOnTableR != null && (
                <span>
                  Left on the table <b>{analysis.exitEfficiency.averageLeftOnTableR.toFixed(1)}R</b> per winner on average
                  (median {analysis.exitEfficiency.medianLeftOnTableR != null ? `${analysis.exitEfficiency.medianLeftOnTableR.toFixed(1)}R` : "—"})
                </span>
              )}
              {analysis.exitEfficiency.averageMfeR != null && (
                <span>
                  Average MFE <b>{analysis.exitEfficiency.averageMfeR.toFixed(1)}R</b>
                  {analysis.exitEfficiency.averageActualR != null && (
                    <> vs <b>{analysis.exitEfficiency.averageActualR.toFixed(1)}R</b> actually captured</>
                  )}
                </span>
              )}
              {analysis.exitEfficiency.averageMaeR != null && (
                <span>
                  Average heat <b>{analysis.exitEfficiency.averageMaeR.toFixed(1)}R</b> of adverse excursion per trade
                </span>
              )}
              {analysis.exitEfficiency.reached2RThenLostCount > 0 && (
                <span>
                  <b>{analysis.exitEfficiency.reached2RThenLostCount}</b> losing trade{analysis.exitEfficiency.reached2RThenLostCount === 1 ? "" : "s"} reached 2R+ in your favor at some point — the move existed, the exit didn't hold it
                </span>
              )}
            </div>
            <p className="analysis-note">{analysis.exitEfficiency.message}</p>
          </>
        ) : (
          <p className="analysis-note">{analysis.exitEfficiency.message}</p>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>EDGE DEVELOPMENT</span>
            <h3>Rolling and decay evidence</h3>
          </div>
          <Sparkles size={18} />
        </div>
        <div className="metric-list">
          {analysis.rolling.map(row => (
            <span key={row.window}>
              Last {row.window}{" "}
              <b>
                {row.sample} trades · {row.winRate.toFixed(1)}% ·{" "}
                {money(row.expectancy)} expectancy
              </b>
            </span>
          ))}
          <span>
            Trend <b>{analysis.decay.direction}</b>
          </span>
        </div>
        {analysis.warnings.map(warning => (
          <p className="analysis-warning" key={warning}>
            {warning}
          </p>
        ))}
      </section>
    </>
  );
}
