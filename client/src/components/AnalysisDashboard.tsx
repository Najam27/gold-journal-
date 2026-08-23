import React, { useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Bot,
  Filter,
  LineChart,
  RefreshCcw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/gold";
import { openJournalView } from "@/lib/journalViewNavigation";
import { trpc } from "@/lib/trpc";
import type {
  AnalysisFilters,
  AnalysisResult,
  MetricRow,
} from "@shared/analysisEngine";

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
                  <td>
                    <strong>{row.label}</strong>
                    <small className="analysis-subtext">
                      {row.confidence} confidence ·{" "}
                      {row.dataCompleteness.toFixed(0)}% data complete
                    </small>
                  </td>
                  <td className="data-text">{row.sample}</td>
                  <td>
                    <span
                      className={`evidence-pill evidence-${row.evidenceTier.toLowerCase().replaceAll(" ", "-")}`}
                    >
                      {row.evidenceTier}
                    </span>
                    <small className="analysis-subtext">
                      {row.winRateInterval[0].toFixed(0)}–
                      {row.winRateInterval[1].toFixed(0)}% Wilson CI
                    </small>
                  </td>
                  <td className="data-text">{row.winRate.toFixed(1)}%</td>
                  <td
                    className={`data-text ${row.expectancy >= 0 ? "positive" : "negative"}`}
                  >
                    {money(row.expectancy)}
                  </td>
                  <td className="data-text">
                    {row.profitFactor == null
                      ? "No losses"
                      : row.profitFactor.toFixed(2)}
                  </td>
                  <td className="data-text">{number(row.averageR, 2)}</td>
                  <td className="data-text negative">
                    {money(-row.maxDrawdown)}
                  </td>
                  <td className="data-text">{row.edgeScore}/100</td>
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
        <span className="section-label">EVIDENCE-BOUND SUMMARY</span>
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
  const aiConfig = trpc.analysis.config.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const aiMutation = trpc.analysis.ai.useMutation();
  const [aiJobId, setAiJobId] = useState<string | null>(null);
  const aiJob = trpc.aiJobs.status.useQuery(
    { jobId: aiJobId ?? "00000000-0000-0000-0000-000000000000" },
    {
      enabled: Boolean(aiJobId),
      refetchInterval: query => {
        const status = (query.state.data as any)?.status;
        return status === "QUEUED" || status === "RUNNING" ? 1_500 : false;
      },
    }
  );
  const analysis = query.data as AnalysisResult | undefined;
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
    if (!accountId) return;
    const started = await aiMutation.mutateAsync({ accountId, filters });
    if (started.ai.pending && started.ai.jobId) setAiJobId(started.ai.jobId);
  };
  const aiResult: any =
    aiJob.data?.status === "COMPLETED" ? aiJob.data.result : aiMutation.data;
  const aiPending = Boolean(
    aiResult?.ai?.pending &&
      (!aiJob.data ||
        aiJob.data.status === "QUEUED" ||
        aiJob.data.status === "RUNNING")
  );
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
              Average R delta{" "}
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
          <p>TOTAL R</p>
          <strong className="data-text">
            {number(analysis.overview.totalR, 2)}
          </strong>
          <span>{number(analysis.overview.averageR, 3)}R average</span>
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
        />
        <MetricTable title="LEVEL × SESSION" rows={analysis.levelSessions} />
        <MetricTable
          title="LEVEL × TIMEFRAME"
          rows={analysis.levelTimeframes}
        />
      </div>
      <div className="edge-grid">
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
              Duration median{" "}
              <b>
                {analysis.duration.medianMinutes == null
                  ? "—"
                  : `${analysis.duration.medianMinutes} min`}
              </b>
            </span>
            <span>
              Exit efficiency <b>Unavailable</b>
            </span>
          </div>
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
      <section className="panel">
        <div className="panel-title">
          <div>
            <span>AI EDGE ANALYST</span>
            <h3>Interpret the evidence</h3>
          </div>
          <Bot size={18} />
        </div>
        <p>
          AI receives aggregated metrics only. It does not receive credentials,
          JWTs, screenshots, or raw journal notes, and it cannot produce market
          signals.
        </p>
        {aiConfig.data && !aiConfig.data.configured && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <div>
              <strong>OpenRouter is not configured.</strong>
              <p>
                Add your personal OpenRouter key in Options to enable secure AI
                analysis.
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
        {aiConfig.error && (
          <div className="analysis-ai-empty">
            <AlertTriangle size={20} />
            <div>
              <strong>AI configuration status unavailable.</strong>
              <p>{aiConfig.error.message}</p>
            </div>
          </div>
        )}
        <Button
          size="lg"
          disabled={
            aiMutation.isPending ||
            aiPending ||
            aiConfig.isLoading ||
            aiConfig.data?.configured === false
          }
          onClick={() => void runAi()}
        >
          <Bot size={16} />
          {aiMutation.isPending
            ? "Starting secure AI review…"
            : aiPending
              ? "Analyzing in background…"
              : "Analyze my journal"}
        </Button>
        {aiPending && (
          <div className="analysis-ai-empty">
            <Bot size={20} />
            <p>
              AI analysis is processing securely in the background. This view
              will update when it completes.
            </p>
          </div>
        )}
        {aiJob.data?.status === "FAILED" && (
          <div className="analysis-ai-empty">
            <AlertTriangle size={20} />
            <p>{aiJob.data.message}</p>
          </div>
        )}
        {aiResult && !aiPending && <AiReport result={aiResult} />}
        {aiMutation.error && (
          <div className="analysis-ai-empty">
            <AlertTriangle size={20} />
            <div>
              <strong>AI analysis temporarily unavailable.</strong>
              <p>{aiMutation.error.message}</p>
            </div>
          </div>
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
