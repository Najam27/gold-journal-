import React, { useEffect, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Brain,
  CircleAlert,
  Eye,
  Flame,
  Gauge,
  Info,
  LifeBuoy,
  ListChecks,
  Save,
  ShieldCheck,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/gold";
import { BEHAVIORAL_OBJECTIVE_STATUS_LABELS, type TraderDevelopment } from "@/lib/psychology";

/**
 * Goals-page "trader development" block.
 *
 * It answers the question the discipline system exists for — "am I becoming a
 * more disciplined trader?" — from saved journal data only. It never rewrites
 * P&L, never diagnoses psychology, and always labels an interpretation as an
 * interpretation.
 */

const number = (value: number | null | undefined, digits = 0) => (value == null ? "—" : value.toFixed(digits));

function tone(value: number | null | undefined, target = 70) {
  if (value == null) return "neutral";
  if (value >= target) return "safe";
  if (value >= target - 20) return "watch";
  return "risk";
}

function Stat({ label, value, detail, tone: cardTone = "neutral" }: { label: string; value: string; detail: string; tone?: string }) {
  return (
    <article className={`dev-stat ${cardTone}`}>
      <span>{label}</span>
      <strong className="data-text">{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Panel({ title, eyebrow, icon: Icon, children, actions }: { title: string; eyebrow: string; icon: typeof Target; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="dev-panel panel">
      <header className="dev-panel-head">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        <div className="dev-panel-head-actions">
          {actions}
          <Icon size={17} />
        </div>
      </header>
      {children}
    </section>
  );
}

export function TraderDevelopmentPanel({
  report,
  identityStatement,
  onSaveIdentity,
  pending = false,
}: {
  report: TraderDevelopment;
  identityStatement?: string;
  onSaveIdentity?: (statement: string) => Promise<void> | void;
  pending?: boolean;
}) {
  const [statement, setStatement] = useState(identityStatement ?? "");
  // The page leads with the decision-oriented summary; the full analytics stay
  // one click away instead of being forced on every visit.
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => setStatement(identityStatement ?? ""), [identityStatement]);

  const hasSessions = report.sessions.length > 0;
  const focus = report.focus;
  const focusActive = Boolean(focus && focus.score < focus.target && focus.label !== "Process consistency");
  const today = report.today ?? report.latest;
  const plan = today?.plan ?? null;
  const adherence = today?.planAdherence ?? null;
  const streaks = [
    { label: "Risk-rule streak", value: report.streaks.risk },
    { label: "No-revenge streak", value: report.streaks.noRevenge },
    { label: "No-FOMO streak", value: report.streaks.noFomo },
    { label: "Plan-adherence streak", value: report.streaks.planAdherence },
    { label: "No-overtrading streak", value: report.streaks.noOvertrading },
    { label: "Journal-completion streak", value: report.streaks.journal },
  ];
  const weeklyRows = [
    { label: "Discipline", value: report.weekly.discipline, target: 75 },
    { label: "Plan adherence", value: report.weekly.planAdherence, target: 85 },
    { label: "Risk discipline", value: report.weekly.riskDiscipline, target: 90 },
    { label: "Emotional control", value: report.weekly.emotionalControl, target: 75 },
    { label: "FOMO control", value: report.weekly.fomo, target: 85 },
    { label: "Revenge control", value: report.weekly.revenge, target: 90 },
    { label: "Overtrading control", value: report.weekly.overtrading, target: 85 },
  ];
  const behavioral = report.behavioralPnl;
  const feedback = report.behavioralFeedback;
  // The four answers the summary leads with, derived from saved sessions only.
  const improvement = (() => {
    if (report.weekly.biggestImprovement) return `${report.weekly.biggestImprovement.label} up ${report.weekly.biggestImprovement.delta.toFixed(0)}%`;
    if (report.focus?.trend != null) return `${report.focus.label} ${report.focus.trend >= 0 ? "up" : "down"} ${Math.abs(report.focus.trend).toFixed(0)}%`;
    return "Not enough reviewed sessions to compare yet";
  })();
  const repeating = feedback.repeatedTrigger
    ? `${feedback.repeatedTrigger.label} in ${feedback.repeatedTrigger.sessions} of the last ${feedback.sessions} sessions`
    : hasSessions ? "No trigger has repeated in the current window" : "Waiting for a reviewed session";
  const violationLinked = feedback.violationLinkedTriggers.length
    ? feedback.violationLinkedTriggers.slice(0, 2).map(entry => `${entry.label} in ${entry.violations} session${entry.violations === 1 ? "" : "s"} with a rule break`).join(" · ")
    : "No trigger is linked to a rule break yet";

  return (
    <section className="dev-workspace control-workspace">
      <header className="dev-header">
        <div>
          <span className="eyebrow">TRADER DEVELOPMENT</span>
          <h2>Am I becoming a more disciplined trader?</h2>
          <p>
            Every figure here is derived from your saved trades, session protocols, and pre-trade check-ins. Outcome is measured, but process is what
            this page trains.
          </p>
        </div>
        <div className={`dev-score ${tone(report.discipline.score, 70)}`}>
          <span>DISCIPLINE SCORE</span>
          <strong className="data-text">{number(report.discipline.score)}</strong>
          <small>{hasSessions ? `${report.totals.sessions} session${report.totals.sessions === 1 ? "" : "s"} evaluated` : "Waiting for a completed session"}</small>
        </div>
      </header>

      <section className="dev-brief">
        <div className="dev-brief-grid">
          <article className="dev-brief-card safe">
            <span>WHAT IS IMPROVING</span>
            <strong>{improvement}</strong>
            <small>{report.weekly.sessions ? `${report.weekly.sessions} session${report.weekly.sessions === 1 ? "" : "s"} in the current window` : "Waiting for evaluated sessions"}</small>
          </article>
          <article className="dev-brief-card watch">
            <span>WHAT IS REPEATING</span>
            <strong>{repeating}</strong>
            <small>{feedback.taggedSessions ? `${feedback.taggedSessions} of the last ${feedback.sessions} sessions recorded a trigger` : "No trigger has been recorded yet"}</small>
          </article>
          <article className="dev-brief-card risk">
            <span>TRIGGERS BESIDE RULE BREAKS</span>
            <strong>{violationLinked}</strong>
            <small>{feedback.note}</small>
          </article>
          <article className="dev-brief-card neutral">
            <span>CURRENT BEHAVIOURAL OBJECTIVE</span>
            <strong>{feedback.focusLabel ?? "Not set"}</strong>
            <small>{feedback.focusStatus ? BEHAVIORAL_OBJECTIVE_STATUS_LABELS[feedback.focusStatus] : "Set one objective per session to measure it."}{feedback.objectiveHoldRate == null ? "" : ` · held ${feedback.objectiveHoldRate.toFixed(0)}% of reviewed sessions`}</small>
          </article>
        </div>
        <div className={`dev-readiness ${report.readiness.band === "HIGH" ? "safe" : report.readiness.band === "LOW" ? "risk" : "watch"}`}>
          <Activity size={16} />
          <div>
            <strong>Trading readiness {report.readiness.score == null ? "—" : `${report.readiness.score.toFixed(0)}/100`}</strong>
            <span>{report.readiness.guidance} Guidance only — it never blocks a trade.</span>
          </div>
        </div>
      </section>

      <button type="button" className="dev-details-toggle" aria-expanded={showDetails} onClick={() => setShowDetails(current => !current)}>
        {showDetails ? "Hide detailed analytics" : "View detailed analytics"}
      </button>

      {showDetails && (
        <>
      <section className="dev-stat-grid">
        <Stat label="DISCIPLINE" value={number(report.discipline.score)} detail="Weighted, process-first" tone={tone(report.discipline.score, 70)} />
        <Stat label="PLAN ADHERENCE" value={report.planAdherence == null ? "—" : `${report.planAdherence.toFixed(0)}%`} detail="Planned vs executed" tone={tone(report.planAdherence, 80)} />
        <Stat label="RISK DISCIPLINE" value={report.riskDiscipline == null ? "—" : `${report.riskDiscipline.toFixed(0)}%`} detail="Inside the risk ceiling" tone={tone(report.riskDiscipline, 85)} />
        <Stat label="EMOTIONAL CONTROL" value={report.emotionalControl == null ? "—" : `${report.emotionalControl.toFixed(0)}%`} detail="Trigger-tagged sessions" tone={tone(report.emotionalControl, 75)} />
      </section>

      <div className="dev-columns">
        <Panel title="Why this score" eyebrow="SCORING MODEL" icon={Gauge}>
          <div className="dev-breakdown">
            {report.discipline.breakdown.map(entry => (
              <div className="dev-breakdown-row" key={entry.key}>
                <span>{entry.label}</span>
                <i>
                  <b style={{ width: `${entry.value ?? 0}%` }} className={tone(entry.value, 70)} />
                </i>
                <strong className="data-text">{entry.value == null ? "—" : entry.value.toFixed(0)}</strong>
                <em>{entry.effectiveWeight > 0 ? `${entry.effectiveWeight.toFixed(0)}% weight` : "no data"}</em>
              </div>
            ))}
          </div>
          <p className="dev-note">
            Risk adherence, plan adherence, setup adherence, execution discipline, overtrading control, journal/review habit, and psychological control
            are weighted 25/20/20/15/10/5/5. A component without data is excluded and the remaining weights are renormalised, so an unscored area never
            silently lowers the total.
          </p>
        </Panel>

        <Panel title={focusActive ? focus!.label : "No recurring weakness detected"} eyebrow="CURRENT BEHAVIORAL FOCUS" icon={Brain}>
          {focusActive && focus ? (
            <>
              <div className="dev-focus">
                <div>
                  <span>Current</span>
                  <strong className="data-text">{focus.score.toFixed(0)}%</strong>
                </div>
                <div>
                  <span>Target</span>
                  <strong className="data-text">{focus.target.toFixed(0)}%</strong>
                </div>
                <div>
                  <span>{focus.sessions}-session trend</span>
                  <strong className={`data-text ${focus.trend == null ? "" : focus.trend >= 0 ? "positive" : "negative"}`}>
                    {focus.trend == null ? "—" : `${focus.trend >= 0 ? "+" : ""}${focus.trend.toFixed(0)}%`}
                  </strong>
                </div>
              </div>
              <p className="dev-recommendation">{focus.recommendation}</p>
              {focus.others.length > 0 && (
                <ul className="dev-list compact">
                  {focus.others.map(item => (
                    <li key={item.key}>
                      <span>{item.label}</span>
                      <b className="data-text">{item.score.toFixed(0)}%</b>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="dev-empty">
              {hasSessions
                ? "No tagged rule break is repeating in the current window. Keep saving one behavioural objective per session so a new weakness is detected early."
                : "Save a session protocol and tag what went wrong on a trade. Recurring patterns appear here once there is real data."}
            </p>
          )}
          {report.cooldown.status !== "CLEAR" && (
            <div className={`dev-cooldown ${report.cooldown.status === "SESSION_COMPLETE" ? "risk" : "watch"}`}>
              <LifeBuoy size={16} />
              <div>
                <strong>{report.cooldown.status === "SESSION_COMPLETE" ? "SESSION COMPLETE" : "COOLDOWN"}</strong>
                <span>{report.cooldown.message}</span>
                <ul className="dev-list compact">
                  {report.cooldown.actions.map(action => (
                    <li key={action}>
                      <span>{action}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Panel>
      </div>

      <div className="dev-columns">
        <Panel title={today ? today.day : "No session yet"} eyebrow="TODAY'S PLAN" icon={ListChecks}>
          {plan ? (
            <ul className="dev-list">
              <li>
                <span>Daily stop</span>
                <b className="data-text">{plan.riskLimit ? formatMoney(plan.riskLimit) : "Not set"}</b>
              </li>
              <li>
                <span>Max trades</span>
                <b className="data-text">{plan.maxTrades ?? "Not set"}</b>
              </li>
              <li>
                <span>Allowed sessions</span>
                <b>{Array.isArray(plan.sessionFocus) && plan.sessionFocus.length ? (plan.sessionFocus as string[]).join(", ") : "All sessions"}</b>
              </li>
              <li>
                <span>Invalid condition</span>
                <b>{plan.noTradeCondition || "Not recorded"}</b>
              </li>
              <li>
                <span>Behavioural objective</span>
                <b>{today?.behavioralFocus || "Not set"}</b>
              </li>
              <li>
                <span>Emotional state</span>
                <b>{today?.emotionalState || "Not recorded"}</b>
              </li>
            </ul>
          ) : (
            <p className="dev-empty">No protocol saved for this day yet. The Plan &amp; Execution page records it before the session opens.</p>
          )}
          <p className="dev-note">Readiness guidance is in the behavioural summary above. It is guidance only and never blocks a trade.</p>
        </Panel>

        <Panel title="Planned vs executed" eyebrow="EXECUTION" icon={Target}>
          {adherence ? (
            <>
              <div className="dev-versus">
                <div>
                  <span>Planned</span>
                  <strong className="data-text">{adherence.plannedTrades ?? "—"} trades</strong>
                  <small>{adherence.plannedRisk == null ? "No risk limit saved" : `${formatMoney(adherence.plannedRisk)} planned risk`}</small>
                </div>
                <div>
                  <span>Actual</span>
                  <strong className="data-text">{adherence.actualTrades} trades</strong>
                  <small>{formatMoney(adherence.actualRisk)} risk used</small>
                </div>
                <div className={adherence.adherence != null && adherence.adherence >= 80 ? "safe" : "watch"}>
                  <span>Adherence</span>
                  <strong className="data-text">{adherence.adherence == null ? "—" : `${adherence.adherence.toFixed(0)}%`}</strong>
                  <small>{adherence.unplannedTrades} unplanned · {adherence.violations} violations</small>
                </div>
              </div>
              {adherence.notes.length > 0 && (
                <ul className="dev-list compact">
                  {adherence.notes.map(note => (
                    <li key={note}>
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              )}
              {today?.reviewed ? (
                <p className="dev-note">
                  Session review saved. Execution rating {plan?.executionScore ?? "—"}/5 · session rating {plan?.overallRating ?? "—"}/5.
                </p>
              ) : (
                <p className="dev-note">No post-session review is saved for this day yet, so the journal/review component is partial.</p>
              )}
            </>
          ) : (
            <p className="dev-empty">Plan-versus-execution appears once a protocol and a trade exist on the same day.</p>
          )}
        </Panel>
      </div>

      <div className="dev-columns">
        <Panel title="Outcome vs process" eyebrow="REVIEW" icon={BadgeCheck}>
          <div className="dev-classifications">
            {[
              { key: "GOOD_WIN", label: "Good wins", detail: "Valid process, profit", value: report.counts.GOOD_WIN, tone: "safe" },
              { key: "BAD_WIN", label: "Bad wins", detail: "Profit, poor process", value: report.counts.BAD_WIN, tone: "risk" },
              { key: "GOOD_LOSS", label: "Good losses", detail: "Valid process, loss", value: report.counts.GOOD_LOSS, tone: "safe" },
              { key: "BAD_LOSS", label: "Bad losses", detail: "Poor process, loss", value: report.counts.BAD_LOSS, tone: "risk" },
            ].map(item => (
              <div key={item.key} className={`dev-classification ${item.tone}`}>
                <span>{item.label}</span>
                <strong className="data-text">{item.value}</strong>
                <small>{item.detail}</small>
              </div>
            ))}
          </div>
          <div className="dev-pnl-split">
            <div>
              <span>Total P&amp;L</span>
              <strong className={`data-text ${behavioral.totalPnl >= 0 ? "positive" : "negative"}`}>{formatMoney(behavioral.totalPnl)}</strong>
            </div>
            <div>
              <span>Process-compliant</span>
              <strong className={`data-text ${behavioral.processCompliantPnl >= 0 ? "positive" : "negative"}`}>{formatMoney(behavioral.processCompliantPnl)}</strong>
            </div>
            <div>
              <span>Rule-violation</span>
              <strong className={`data-text ${behavioral.ruleViolationPnl >= 0 ? "positive" : "negative"}`}>{formatMoney(behavioral.ruleViolationPnl)}</strong>
            </div>
          </div>
          <p className="dev-note">
            {behavioral.note} {behavioral.notEvaluated > 0 ? `${behavioral.notEvaluated} trade${behavioral.notEvaluated === 1 ? "" : "s"} (${formatMoney(behavioral.notEvaluatedPnl)}) are marked not evaluated and excluded from the compliance rate.` : ""}
          </p>
        </Panel>

        <Panel title="Behavioural reinforcement" eyebrow="DISCIPLINE STREAKS" icon={Flame}>
          <div className="dev-streaks">
            {streaks.map(streak => (
              <div key={streak.label} className={streak.value > 0 ? "safe" : "neutral"}>
                <strong className="data-text">{streak.value}</strong>
                <span>{streak.label}</span>
              </div>
            ))}
          </div>
          <p className="dev-note">
            {report.streaks.riskLabel} Streaks count consecutive evaluated sessions from the most recent one backwards and reset on the first breach.
          </p>
        </Panel>
      </div>

      <Panel
        title={`Last ${report.weekly.sessions} session${report.weekly.sessions === 1 ? "" : "s"}`}
        eyebrow="WEEKLY PSYCHOLOGY"
        icon={TrendingUp}
      >
        <div className="dev-weekly">
          {weeklyRows.map(row => (
            <div key={row.label} className={tone(row.value, row.target)}>
              <span>{row.label}</span>
              <strong className="data-text">{row.value == null ? "—" : `${row.value.toFixed(0)}%`}</strong>
              <i>
                <b style={{ width: `${row.value ?? 0}%` }} />
              </i>
            </div>
          ))}
        </div>
        <div className="dev-weekly-summary">
          <div className="safe">
            <TrendingUp size={15} />
            <span>Biggest improvement</span>
            <strong>{report.weekly.biggestImprovement ? `${report.weekly.biggestImprovement.label} +${report.weekly.biggestImprovement.delta.toFixed(0)}%` : "Not enough history yet"}</strong>
          </div>
          <div className="risk">
            <TrendingDown size={15} />
            <span>Biggest weakness</span>
            <strong>{report.weekly.biggestWeakness ? `${report.weekly.biggestWeakness.label} ${report.weekly.biggestWeakness.value.toFixed(0)}%` : "Not enough history yet"}</strong>
          </div>
          <div className="watch">
            <Eye size={15} />
            <span>Next week focus</span>
            <strong>{report.weekly.nextWeekFocus ?? "Keep saving a focus per session"}</strong>
          </div>
        </div>
        {report.weekly.observed.length > 0 && (
          <ul className="dev-list compact">
            {report.weekly.observed.map(line => (
              <li key={line}>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="dev-columns">
        <Panel title="What the data repeats" eyebrow="OBSERVED PATTERNS" icon={Info}>
          {report.insights.length ? (
            <ul className="dev-insights">
              {report.insights.map(insight => (
                <li key={insight.text} className={insight.kind === "OBSERVED" ? "observed" : "interpretation"}>
                  <em>{insight.kind === "OBSERVED" ? "OBSERVED" : "INTERPRETATION"}</em>
                  <span>{insight.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="dev-empty">No recurring pattern is measurable yet. Observations appear once several sessions have been tagged.</p>
          )}
        </Panel>

        <Panel
          title="Trading identity"
          eyebrow="IDENTITY CONSISTENCY"
          icon={ShieldCheck}
          actions={onSaveIdentity ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void onSaveIdentity(statement.trim())}>
              <Save size={14} /> {pending ? "Saving…" : "Save"}
            </Button>
          ) : undefined}
        >
          {onSaveIdentity ? (
            <Input
              aria-label="Trading identity statement"
              value={statement}
              maxLength={400}
              placeholder="I am a trader who follows the plan even when the outcome is uncomfortable."
              onChange={event => setStatement(event.target.value)}
            />
          ) : (
            <p className="dev-empty">{identityStatement || "Define your identity statement to track consistency against it."}</p>
          )}
          <div className="dev-identity">
            <strong className="data-text">{report.identity.score == null ? "—" : `${report.identity.score.toFixed(0)}%`}</strong>
            <ul className="dev-list compact">
              {report.identity.checks.length ? (
                report.identity.checks.map(check => (
                  <li key={check.label}>
                    <span>{check.label}</span>
                    <b className="data-text">{check.value == null ? "—" : `${check.value.toFixed(0)}%`}</b>
                  </li>
                ))
              ) : (
                <li>
                  <span>Consistency is measured across your last ten evaluated sessions.</span>
                </li>
              )}
            </ul>
          </div>
          {!report.identity.statement && !onSaveIdentity && (
            <p className="dev-note">
              <CircleAlert size={13} /> Save an identity statement to measure behaviour against it.
            </p>
          )}
        </Panel>
      </div>
        </>
      )}
    </section>
  );
}
