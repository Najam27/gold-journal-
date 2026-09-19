import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  History,
  Plus,
  Repeat,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, formatDate, getPktDateInput, sessions } from "@/lib/gold";
import { addPktDays, formatPktMonth, pktDateToTimestamp } from "@shared/pktDate";
import { BEHAVIORAL_OBJECTIVES, EMOTIONAL_STATES, PSYCHOLOGY_TRIGGERS, calculateTradingReadiness } from "@/lib/psychology";
import { trpc } from "@/lib/trpc";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  appliedRules,
  copiedDraftFromPlan,
  copiedFieldDiff,
  copySourceOptions,
  draftAsPlanSource,
  draftFromSavedPlan,
  emptyPlanDraft,
  findPreviousPlan,
  dayKey,
  planSessionStatus,
  planVsExecution,
  type PlanDraft,
  type PlanRule,
} from "@/lib/planWorkflow";
import { toast } from "sonner";

const dateInput = getPktDateInput;
export function planDateTimestamp(value: string) { return pktDateToTimestamp(value); }

/**
 * Plan & Execution, as a workflow rather than a questionnaire.
 *
 * Before the market: copy the previous session, change only what the market
 * changed, set the risk boundary, pick ONE behaviour to control, and save.
 * After the market: answer a short review, record what triggered you, and let
 * the journal classify the session against the plan it was traded against.
 *
 * Every existing field is still persisted. The ones that do not change a
 * decision, an execution measurement, or a behavioural pattern are moved behind
 * "Advanced planning details" and "Optional ratings" instead of being deleted.
 */

function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`}>
      <span>{label}</span>
      {children}
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  );
}

function Score({ label, value, onChange }: { label: string; value: number | null; onChange: (value: number) => void }) {
  return (
    <Field label={label}>
      <div className="score-strip">
        {[1, 2, 3, 4, 5].map(score => (
          <button type="button" key={score} className={value === score ? "selected" : ""} onClick={() => onChange(score)} aria-label={`${label}: ${score} out of 5`}>
            {score}
          </button>
        ))}
      </div>
    </Field>
  );
}

function Section({ number, title, copy, icon: Icon, children }: { number: string; title: string; copy: string; icon: typeof ClipboardCheck; children: React.ReactNode }) {
  return (
    <section className="professional-plan-section">
      <header>
        <Icon size={16} />
        <div>
          <span>{number} · {title}</span>
          <p>{copy}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function VerdictPicker({ label, value, onChange }: { label: string; value: string; onChange: (value: "" | "YES" | "PARTIALLY" | "NO") => void }) {
  const options: { value: "" | "YES" | "PARTIALLY" | "NO"; label: string }[] = [
    { value: "YES", label: "Yes" },
    { value: "PARTIALLY", label: "Partially" },
    { value: "NO", label: "No" },
  ];
  return (
    <Field label={label}>
      <div className="pill-options">
        {options.map(option => (
          <button type="button" key={option.value} className={value === option.value ? "selected" : ""} aria-pressed={value === option.value} onClick={() => onChange(value === option.value ? "" : option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

const READINESS_LABELS = { HIGH: "Ready", MODERATE: "Caution", LOW: "High risk", UNKNOWN: "Not assessed" } as const;

export function PlanExecutionEditor({ account, plans = [], trades = [], behaviorConfig, tradingRules = [], onManageRules, onSaved }: any) {
  const today = dateInput();
  const [planDate, setPlanDate] = useState(today);
  const [draft, setDraft] = useState<PlanDraft>(() => emptyPlanDraft(today));
  const [archiveSearch, setArchiveSearch] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [copySource, setCopySource] = useState<{ day: string; draft: PlanDraft } | null>(null);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const debouncedSearch = useDebouncedValue(archiveSearch, 300);

  const savePlan = trpc.plans.save.useMutation();
  const removePlan = trpc.plans.remove.useMutation();
  const savePlanReview = trpc.planReview.save.useMutation();
  const optionListsQuery = trpc.optionLists.list.useQuery();
  const saving = savePlan.isPending || savePlanReview.isPending;

  const ruleSource = tradingRules.length ? tradingRules : optionListsQuery.data ?? [];
  const activeRules = useMemo<PlanRule[]>(
    () => (ruleSource as any[])
      .filter(rule => rule.active && String(rule.category).toLowerCase() === "trading rule")
      .map(rule => ({ id: `option-${rule.id}`, text: rule.value, checked: true })),
    [ruleSource],
  );

  const selectedPlan = plans.find((plan: any) => dayKey(plan.planDate) === planDate) ?? null;
  const loadKey = `${planDate}:${selectedPlan?.id ?? "new"}`;
  const loadedRef = useRef("");

  // Opening a day loads exactly that day's saved record, results included.
  // Copying is the only action that overwrites the draft, and it pre-arms this
  // ref so the load cannot race the copy.
  useEffect(() => {
    if (loadedRef.current === loadKey) return;
    loadedRef.current = loadKey;
    setDraft(draftFromSavedPlan(selectedPlan, planDate));
    setCopySource(null);
    setNotice(null);
  }, [loadKey, planDate, selectedPlan]);

  // An empty rule list on a saved plan means "not chosen yet", so the trader's
  // active trading rules stand in as the default checklist.
  const effectiveRules = draft.rulesPlanned.length ? draft.rulesPlanned : activeRules;
  const rulesForSave = effectiveRules;
  const applied = appliedRules({ ...draft, rulesPlanned: effectiveRules });
  const readiness = calculateTradingReadiness({
    emotionalState: draft.emotionalState,
    energyLevel: draft.energyLevel,
    focusLevel: draft.focusLevel,
    confidenceLevel: draft.confidenceLevel,
    stressLevel: draft.stressLevel,
  });
  const execution = useMemo(
    () => planVsExecution({ plan: selectedPlan, trades, day: planDate, config: behaviorConfig }),
    [selectedPlan, trades, planDate, behaviorConfig],
  );
  const status = useMemo(() => planSessionStatus({ plan: selectedPlan, trades, day: planDate }), [selectedPlan, trades, planDate]);
  const previousPlan = useMemo(() => findPreviousPlan(plans as any[], planDate), [plans, planDate]);
  const copyOptions = useMemo(() => copySourceOptions(plans as any[], planDate), [plans, planDate]);
  const historyOptions = useMemo(() => copySourceOptions(plans as any[]), [plans]);
  const changedFields = useMemo(
    () => (copySource ? copiedFieldDiff(draft, copySource.draft).filter(entry => entry.changed) : []),
    [copySource, draft],
  );

  const archivedPlans = useMemo(() => {
    const needle = debouncedSearch.trim().toLowerCase();
    if (!needle) return [];
    // Search the STORED plan object, not just the fields on screen.
    return (plans as any[])
      .filter(plan => [
        dayKey(plan.planDate),
        plan.preBias,
        plan.keyLevels,
        plan.marketContext,
        plan.behavioralFocus,
        plan.longScenario,
        plan.shortScenario,
        plan.eventRisk,
        plan.noTradeCondition,
        plan.lessons,
        plan.tomorrowFocus,
        formatDate(plan.planDate),
      ].join(" ").toLowerCase().includes(needle))
      .slice(0, 12);
  }, [plans, debouncedSearch]);

  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const toggleSession = (value: string) =>
    setDraft(current => ({ ...current, sessionFocus: current.sessionFocus.includes(value) ? current.sessionFocus.filter(item => item !== value) : [...current.sessionFocus, value] }));
  const toggleRule = (id: string) =>
    setDraft(current => {
      const rules = (current.rulesPlanned.length ? current.rulesPlanned : activeRules).map(rule => (rule.id === id ? { ...rule, checked: !rule.checked } : rule));
      return { ...current, rulesPlanned: rules };
    });
  const toggleFollowed = (id: string) =>
    setDraft(current => {
      const exists = current.rulesFollowed.some(item => item.id === id);
      const rulesFollowed = exists
        ? current.rulesFollowed.map(item => (item.id === id ? { ...item, yes: !item.yes } : item))
        : [...current.rulesFollowed, { id, yes: true }];
      return { ...current, rulesFollowed };
    });
  const toggleTrigger = (key: string) =>
    setDraft(current => ({
      ...current,
      psychologyTriggers: current.psychologyTriggers.includes(key)
        ? current.psychologyTriggers.filter(item => item !== key)
        : [...current.psychologyTriggers, key],
    }));

  const applyCopy = (source: any, targetDay: string, mode: "copy" | "tomorrow") => {
    const sourceDay = dayKey(source.planDate);
    const existing = (plans as any[]).find(plan => dayKey(plan.planDate) === targetDay);
    if (existing && !window.confirm(`${formatDate(planDateTimestamp(targetDay))} already has a saved plan. Replace the fields on screen with the copied plan? Nothing is saved until you press Save plan.`)) return;
    const copied = mode === "copy"
      ? copiedDraftFromPlan(source, targetDay)
      : (() => {
          const next = copiedDraftFromPlan(source, targetDay);
          return { ...next, behavioralFocus: String(source.tomorrowFocus ?? "").trim() };
        })();
    // Arm the load effect so switching day cannot overwrite the copied draft.
    loadedRef.current = `${targetDay}:${existing?.id ?? "new"}`;
    setPlanDate(targetDay);
    setDraft(copied);
    setCopySource({ day: sourceDay, draft: copied });
    setNotice({
      tone: "info",
      text: mode === "tomorrow"
        ? `Tomorrow's draft is based on ${sourceDay ? formatDate(planDateTimestamp(sourceDay)) : "today"} and carries today's promised focus. Psychology check-in reset for the new day.`
        : `Copied from ${sourceDay ? formatDate(planDateTimestamp(sourceDay)) : "the previous session"}. Review today's changes before saving. Psychology check-in reset for today.`,
    });
  };

  const copyPrevious = () => {
    if (!previousPlan) {
      setNotice({ tone: "info", text: "There is no earlier saved plan to copy yet." });
      return;
    }
    applyCopy(previousPlan, planDate, "copy");
  };

  const prepareTomorrow = () => {
    const target = addPktDays(planDate, 1);
    applyCopy(draftAsPlanSource({ ...draft, rulesPlanned: rulesForSave }, planDateTimestamp(planDate), selectedPlan?.id ?? null), target, "tomorrow");
  };

  const save = async () => {
    if (!account) return;
    setNotice(null);
    const planDateValue = planDateTimestamp(planDate);
    const existingOpening = Array.isArray(selectedPlan?.emotionStart)
      ? selectedPlan.emotionStart
      : String(selectedPlan?.emotionStart ?? "").split("|").filter(Boolean);
    const payload = {
      accountId: account.id,
      planDate: planDateValue,
      preBias: draft.preBias,
      marketContext: draft.marketContext,
      keyLevels: draft.keyLevels,
      sessionFocus: draft.sessionFocus,
      eventRisk: draft.eventRisk,
      longScenario: draft.longScenario,
      shortScenario: draft.shortScenario,
      noTradeCondition: draft.noTradeCondition,
      invalidationLevel: draft.invalidationLevel,
      riskLimit: draft.riskLimit,
      maxTrades: draft.maxTrades ? Number(draft.maxTrades) : null,
      sizingPlan: draft.sizingPlan,
      planNotes: draft.planNotes,
      rulesPlanned: rulesForSave,
      emotionStart: draft.emotionalState ? [draft.emotionalState] : existingOpening,
      emotionEnd: draft.emotionEnd ? [draft.emotionEnd] : [],
      executionScore: draft.executionScore,
      rulesFollowed: draft.rulesFollowed,
      whatWentWell: draft.whatWentWell,
      whatWentWrong: draft.whatWentWrong,
      executionNotes: draft.executionNotes,
      planDeviation: draft.planDeviation,
      emotionalState: (draft.emotionalState || "") as "" | (typeof EMOTIONAL_STATES)[number],
      energyLevel: draft.energyLevel,
      focusLevel: draft.focusLevel,
      confidenceLevel: draft.confidenceLevel,
      stressLevel: draft.stressLevel,
      behavioralFocus: draft.behavioralFocus,
      psychologyRisk: draft.psychologyRisk,
      lessons: draft.lessons,
      tomorrowFocus: draft.tomorrowFocus,
      overallRating: draft.overallRating,
    };
    try {
      await savePlan.mutateAsync(payload);
      const review = await savePlanReview.mutateAsync({
        accountId: account.id,
        planDate: planDateValue,
        copiedFromPlanId: draft.copiedFromPlanId,
        copiedFromPlanDate: draft.copiedFromPlanDay ? planDateTimestamp(draft.copiedFromPlanDay) : null,
        psychologyTriggers: draft.psychologyTriggers,
        primaryPsychologyTrigger: draft.primaryPsychologyTrigger,
        behavioralObjectiveStatus: draft.behavioralObjectiveStatus || null,
        postSessionBehavioralReview: {
          followPlan: draft.followPlan || null,
          nextSessionChange: draft.nextSessionChange,
          triggerAction: draft.triggerAction,
        },
      });
      await onSaved?.();
      if (review?.warning) {
        setNotice({ tone: "info", text: review.warning });
        toast.info(review.warning);
        return;
      }
      const message = selectedPlan ? "Plan and review updated." : "Today's plan saved.";
      setNotice({ tone: "info", text: message });
      toast.success(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The plan could not be saved. Your inputs are still here—please try again.";
      setNotice({ tone: "error", text: message });
      toast.error(message);
    }
  };

  const beginNew = () => {
    let candidate = today;
    const savedDates = new Set((plans as any[]).map(plan => dayKey(plan.planDate)));
    while (savedDates.has(candidate)) candidate = addPktDays(candidate, 1);
    loadedRef.current = `${candidate}:new`;
    setPlanDate(candidate);
    setDraft(emptyPlanDraft(candidate));
    setCopySource(null);
    setNotice(null);
  };

  const removeSelected = async () => {
    if (!account || !selectedPlan || !window.confirm(`Remove the saved plan for ${formatDate(planDateTimestamp(planDate))}?`)) return;
    try {
      await removePlan.mutateAsync({ accountId: account.id, planId: selectedPlan.id, confirmed: true });
      await onSaved?.();
      beginNew();
      toast.success("Plan removed.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The plan could not be removed.");
    }
  };

  const rulesChecklist = (title: string, complete: number, rows: React.ReactNode, empty: React.ReactNode) => (
    <div className="professional-checklist field-span-full">
      <div className="checklist-head"><strong>{title}</strong><span>{complete}/{effectiveRules.length} checks</span></div>
      {effectiveRules.length ? rows : empty}
    </div>
  );

  const daysInMonth = new Date(Number(planDate.slice(0, 4)), Number(planDate.slice(5, 7)), 0).getDate();
  const monthPrefix = planDate.slice(0, 8);

  return (
    <>
      <section className="section-heading professional-plan-heading">
        <div>
          <span className="eyebrow">PLAN &amp; EXECUTION</span>
          <h2>Today's plan, and what actually happened</h2>
          <p>What is my plan, what will make me stay out, what is my risk boundary, which one behaviour am I controlling, and did I follow it?</p>
        </div>
        <div className="date-control plan-date-control">
          <Button variant="outline" onClick={copyPrevious}><Repeat size={15} /> Copy from previous day</Button>
          <label className="plan-copy-select">
            <span>Copy from</span>
            <select
              aria-label="Copy from date"
              value=""
              onChange={event => {
                const chosen = copyOptions.find(entry => entry.day === event.target.value);
                if (chosen) applyCopy(chosen.plan, planDate, "copy");
              }}
            >
              <option value="">{copyOptions.length ? "Select a saved date" : "No saved plans"}</option>
              {copyOptions.map(entry => (
                <option key={entry.day} value={entry.day}>{formatDate(planDateTimestamp(entry.day))}</option>
              ))}
            </select>
          </label>
          <Input type="date" value={planDate} aria-label="Plan date" onChange={event => setPlanDate(event.target.value)} />
          <Button variant="outline" onClick={() => { loadedRef.current = ""; setPlanDate(today); }}>Today</Button>
          <Button variant="outline" onClick={beginNew}><Plus size={15} /> New day</Button>
        </div>
      </section>

      <div className="plan-status-strip">
        <span className={`session-status ${status.tone}`}><b>{status.label}</b><small>{status.detail}</small></span>
        {execution.actual.trades > 0 && (
          <span className="session-status neutral">
            <b>{execution.adherence == null ? "Not scored" : `Plan adherence ${execution.adherence.toFixed(0)}%`}</b>
            <small>{execution.actual.trades} trade{execution.actual.trades === 1 ? "" : "s"} · {execution.actual.unplanned} unplanned · {execution.actual.violations} rule violation{execution.actual.violations === 1 ? "" : "s"}</small>
          </span>
        )}
        <Button variant="outline" className="plan-archive-toggle" onClick={() => setShowArchive(current => !current)}>
          <History size={15} /> Plan history
        </Button>
      </div>

      {notice && (
        <p className={notice.tone === "error" ? "plan-save-error" : "plan-copy-notice"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      )}

      {copySource && (
        <div className="plan-copy-basis">
          <div className="plan-copy-basis-head">
            <Repeat size={14} />
            <strong>Based on {formatDate(planDateTimestamp(copySource.day))}</strong>
            <span>· completely editable — the source plan is never changed</span>
          </div>
          {changedFields.length ? (
            <ul className="copy-changed-list">
              {changedFields.map(entry => (
                <li key={entry.key} className="changed">{entry.label} — changed</li>
              ))}
            </ul>
          ) : (
            <p className="copy-changed-list unchanged">Nothing changed yet from the copied plan.</p>
          )}
        </div>
      )}

      <div className={`plan-layout professional-plan-layout ${showArchive ? "archive-open" : ""}`}>
        <section className="panel mini-calendar">
          <div className="panel-title">
            <div><span>PLAN HISTORY</span><h3>{formatPktMonth(planDate.slice(0, 7))}</h3></div>
          </div>
          <label className="plan-archive-search">
            <Search size={14} />
            <Input value={archiveSearch} onChange={event => setArchiveSearch(event.target.value)} placeholder="Search plans" aria-label="Search saved protocols" />
          </label>
          {archiveSearch && (
            <div className="plan-search-results">
              {archivedPlans.length
                ? archivedPlans.map(plan => (
                    <button key={plan.id} className={dayKey(plan.planDate) === planDate ? "selected" : ""} onClick={() => setPlanDate(dayKey(plan.planDate))}>
                      <strong>{formatDate(plan.planDate)}</strong>
                      <span>{plan.preBias || "Neutral"} · {plan.keyLevels || plan.marketContext || "Saved plan"}</span>
                    </button>
                  ))
                : <p>No saved plan matches this search.</p>}
            </div>
          )}
          <div className="mini-day-grid">
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = `${monthPrefix}${String(index + 1).padStart(2, "0")}`;
              const recorded = (plans as any[]).some(plan => dayKey(plan.planDate) === day);
              return (
                <button key={day} className={`${planDate === day ? "selected" : ""} ${recorded ? "recorded" : ""}`} onClick={() => setPlanDate(day)}>
                  {index + 1}
                </button>
              );
            })}
          </div>
          <p className="plan-calendar-key"><i /> Saved plan</p>
          <div className="plan-history-list">
            {historyOptions.length ? historyOptions.slice(0, 8).map(entry => {
              const plan = entry.plan as any;
              const reviewed = planSessionStatus({ plan, trades, day: entry.day }).key === "REVIEWED";
              return (
                <article key={entry.day} className="plan-history-row">
                  <div>
                    <strong>{formatDate(planDateTimestamp(entry.day))}</strong>
                    <span>{plan.preBias || "Neutral"} · {plan.riskLimit ? formatMoney(plan.riskLimit) : "No limit"} · {plan.maxTrades ?? "—"} trades</span>
                    <small>{plan.behavioralFocus || "No behavioural objective recorded"}</small>
                  </div>
                  <div className="plan-history-actions">
                    <em className={reviewed ? "safe" : "watch"}>{reviewed ? "REVIEWED" : "OPEN"}</em>
                    <button type="button" onClick={() => setPlanDate(entry.day)}>Open</button>
                    <button type="button" onClick={() => applyCopy(plan, today, "copy")}>Copy to today</button>
                  </div>
                </article>
              );
            }) : <p className="dev-empty">No saved plans yet. Save today's plan and it becomes tomorrow's starting point.</p>}
          </div>
          <div className="session-readiness">
            <ShieldCheck size={17} />
            <div>
              <strong>{selectedPlan ? "Saved record loaded" : "Prepare before the open"}</strong>
              <span>{selectedPlan ? "Update only what actually changed." : "The plan becomes your review baseline."}</span>
            </div>
          </div>
        </section>

        <section className="panel plan-editor professional-plan-editor">
          <div className="plan-day-head">
            <div>
              <span className="eyebrow">{selectedPlan ? "SAVED SESSION RECORD" : "NEW SESSION RECORD"}</span>
              <h3>{new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Karachi", weekday: "long", day: "numeric", month: "long" }).format(new Date(planDateTimestamp(planDate)))}</h3>
            </div>
            <div className="plan-entry-actions">
              <Button variant="outline" disabled={!selectedPlan || removePlan.isPending} onClick={() => void removeSelected()}>
                <Trash2 size={15} /> {removePlan.isPending ? "Removing…" : "Remove"}
              </Button>
              <Button disabled={!account || saving} onClick={() => void save()}>{saving ? "Saving…" : selectedPlan ? "Update plan" : "Save plan"}</Button>
            </div>
          </div>

          <Section number="01" title="TODAY'S PLAN" copy="Bias, levels, scenarios, risk, and the rules that apply today. Everything else is one click away." icon={ClipboardCheck}>
            <div className="field-grid">
              <Field label="Working bias">
                <div className="pill-options">
                  {["Bullish", "Bearish", "Neutral", "Wait for confirmation"].map(value => (
                    <button type="button" key={value} className={draft.preBias === value ? "selected" : ""} onClick={() => set("preBias", value)}>{value}</button>
                  ))}
                </div>
              </Field>
              <Field label="Session focus">
                <div className="checkbox-cluster">
                  {sessions.map(value => (
                    <label key={value}>
                      <input type="checkbox" checked={draft.sessionFocus.includes(value)} onChange={() => toggleSession(value)} /> {value}
                    </label>
                  ))}
                </div>
              </Field>
              <Field label="Key levels" className="field-span-full">
                <Textarea value={draft.keyLevels} onChange={event => set("keyLevels", event.target.value)} rows={3} placeholder="Asia high/low, London open, HTF zones, premium / discount, liquidity pools…" />
              </Field>
              <Field label="High-impact event / news risk" className="field-span-full">
                <Textarea value={draft.eventRisk} onChange={event => set("eventRisk", event.target.value)} rows={2} placeholder="Release time, spread / volatility risk, or 'No scheduled risk'." />
              </Field>
              <Field label="Long scenario" className="field-span-full">
                <Textarea value={draft.longScenario} onChange={event => set("longScenario", event.target.value)} rows={2} placeholder="Only long if price accepts above ___, confirms ___, with target at ___." />
              </Field>
              <Field label="Short scenario" className="field-span-full">
                <Textarea value={draft.shortScenario} onChange={event => set("shortScenario", event.target.value)} rows={2} placeholder="Only short if price rejects ___, confirms ___, with target at ___." />
              </Field>
              <Field label="No-trade condition" className="field-span-full" hint="What makes me stay out today?">
                <Textarea value={draft.noTradeCondition} onChange={event => set("noTradeCondition", event.target.value)} rows={2} placeholder="Stand aside if structure is choppy, event risk is unresolved, or no A setup appears." />
              </Field>
              <Field label="Session loss limit ($)">
                <Input inputMode="decimal" value={draft.riskLimit} onChange={event => set("riskLimit", event.target.value)} placeholder="e.g. 150" />
              </Field>
              <Field label="Maximum trades">
                <Input type="number" min="1" max="99" value={draft.maxTrades} onChange={event => set("maxTrades", event.target.value)} placeholder="e.g. 3" />
              </Field>
              <Field label="Position-sizing rule" className="field-span-full">
                <Textarea value={draft.sizingPlan} onChange={event => set("sizingPlan", event.target.value)} rows={2} placeholder="Risk 0.5R on A setup; reduce after first loss; no size increase after loss." />
              </Field>
              {rulesChecklist(
                "Rules that apply today",
                applied.applied.length,
                effectiveRules.map(rule => (
                  <label key={rule.id}>
                    <input type="checkbox" checked={rule.checked} onChange={() => toggleRule(rule.id)} />
                    <span>{rule.text}</span>
                  </label>
                )),
                <div className="plan-rules-empty">
                  <p>No active Trading rules yet. Add your own rules once, then each new plan uses them as its baseline.</p>
                  {onManageRules ? <Button type="button" variant="outline" onClick={onManageRules}>Manage Trading rules</Button> : null}
                </div>,
              )}
              <Field label="Behavioural objective today" hint="Choose ONE. One objective beats fifteen.">
                <select value={draft.behavioralFocus} onChange={event => set("behavioralFocus", event.target.value)}>
                  <option value="">No single objective set</option>
                  {Array.from(new Set([...BEHAVIORAL_OBJECTIVES, draft.behavioralFocus].filter(Boolean))).map(value => (
                    <option key={value} value={value}>{value}</option>
                  ))}
                </select>
              </Field>
            </div>

            <button type="button" className="plan-advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced(current => !current)}>
              {showAdvanced ? "Hide advanced planning details" : "More planning details"}
            </button>
            {showAdvanced && (
              <div className="field-grid plan-advanced-grid">
                <Field label="Market context" className="field-span-full">
                  <Textarea value={draft.marketContext} onChange={event => set("marketContext", event.target.value)} rows={2} placeholder="Overnight structure, DXY / yields context, Asia range, liquidity condition…" />
                </Field>
                <Field label="Bias invalidation" className="field-span-full">
                  <Textarea value={draft.invalidationLevel} onChange={event => set("invalidationLevel", event.target.value)} rows={2} placeholder="The market condition that invalidates today's bias." />
                </Field>
                <Field label="Session thesis / game plan" className="field-span-full">
                  <Textarea value={draft.planNotes} onChange={event => set("planNotes", event.target.value)} rows={2} placeholder="The one execution priority that matters today." />
                </Field>
                <Field label="Psychological risk note" className="field-span-full">
                  <Textarea value={draft.psychologyRisk} onChange={event => set("psychologyRisk", event.target.value)} rows={2} placeholder="Example: impatience after a missed London setup, or the urge to recover yesterday's loss." />
                </Field>
                <Score label="Confidence" value={draft.confidenceLevel} onChange={value => set("confidenceLevel", value)} />
              </div>
            )}
          </Section>

          <Section number="02" title="PSYCHOLOGY CHECK-IN" copy="Ten seconds before the session. It guides the day and never blocks a trade." icon={ShieldCheck}>
            <div className="field-grid">
              <Field label="Emotional state">
                <div className="pill-options">
                  {["", ...EMOTIONAL_STATES].map(value => (
                    <button
                      type="button"
                      key={value || "unset"}
                      className={draft.emotionalState === value ? "selected" : ""}
                      onClick={() => set("emotionalState", value)}
                    >
                      {value || "Not set"}
                    </button>
                  ))}
                </div>
              </Field>
              <Score label="Energy" value={draft.energyLevel} onChange={value => set("energyLevel", value)} />
              <Score label="Focus" value={draft.focusLevel} onChange={value => set("focusLevel", value)} />
              <Score label="Stress" value={draft.stressLevel} onChange={value => set("stressLevel", value)} />
              <div className={`plan-readiness ${readiness.band === "HIGH" ? "safe" : readiness.band === "LOW" ? "risk" : "watch"} field-span-full`}>
                <ShieldCheck size={16} />
                <div>
                  <strong>Trading readiness · {READINESS_LABELS[readiness.band]}{readiness.score == null ? "" : ` (${readiness.score.toFixed(0)}/100)`}</strong>
                  <span>{readiness.guidance} This is guidance only — it never prevents you from trading.</span>
                </div>
              </div>
            </div>
          </Section>

          <Section number="03" title="SESSION REVIEW" copy="Record adherence before explaining P&L. A profitable trade can still break the plan, and a losing trade can still be executed correctly." icon={CheckCircle2}>
            {(execution.actual.trades > 0 || selectedPlan) && (
              <div className="plan-versus-strip field-span-full">
                <div>
                  <span>Planned</span>
                  <strong className="data-text">{execution.planned.maxTrades ?? "—"} trades</strong>
                  <small>{execution.planned.riskLimit == null ? "No loss limit saved" : `${formatMoney(execution.planned.riskLimit)} loss limit`} · {execution.planned.sessions.length ? execution.planned.sessions.join(", ") : "All sessions"}</small>
                  <small>{execution.planned.rulesApplied} of {execution.planned.rules} rules applied</small>
                </div>
                <div>
                  <span>Actual</span>
                  <strong className="data-text">{execution.actual.trades} trades</strong>
                  <small>{formatMoney(execution.actual.riskUsed)} risk used · {execution.actual.open} open</small>
                  <small>{execution.actual.unplanned} unplanned · {execution.actual.violations} rule violation{execution.actual.violations === 1 ? "" : "s"}</small>
                </div>
                <div className={execution.adherence != null && execution.adherence >= 80 ? "safe" : "watch"}>
                  <span>Review</span>
                  <strong className="data-text">{execution.adherence == null ? "—" : `${execution.adherence.toFixed(0)}%`}</strong>
                  <small>Plan adherence</small>
                  <small>{execution.reviewSaved ? "Review saved" : "Review not saved"}</small>
                </div>
              </div>
            )}
            {execution.deviations.length > 0 && (
              <ul className="plan-deviation-list field-span-full">
                {execution.deviations.map(note => <li key={note}>{note}</li>)}
              </ul>
            )}
            {execution.potentialBehaviouralDeviation && (
              <p className="plan-deviation-note field-span-full">{execution.potentialBehaviouralDeviation}</p>
            )}

            <div className="field-grid">
              <VerdictPicker label="Did I follow the plan?" value={draft.followPlan} onChange={value => set("followPlan", value)} />
              <VerdictPicker label="Did today's behavioural objective hold?" value={draft.behavioralObjectiveStatus} onChange={value => set("behavioralObjectiveStatus", value)} />
              <Field label="What went well?">
                <Textarea value={draft.whatWentWell} onChange={event => set("whatWentWell", event.target.value)} rows={2} placeholder="One execution strength to preserve." />
              </Field>
              <Field label="What went wrong?">
                <Textarea value={draft.whatWentWrong} onChange={event => set("whatWentWrong", event.target.value)} rows={2} placeholder="One process weakness, not a vague outcome complaint." />
              </Field>
              <Field label="Biggest deviation" hint="Write 'None' when execution followed the plan.">
                <Textarea value={draft.planDeviation} onChange={event => set("planDeviation", event.target.value)} rows={2} placeholder="State the deviation and why it happened." />
              </Field>
              <Field label="One lesson">
                <Textarea value={draft.lessons} onChange={event => set("lessons", event.target.value)} rows={2} placeholder="A precise rule, trigger, or setup observation." />
              </Field>
              <Field label="Tomorrow's focus" className="field-span-full">
                <Textarea value={draft.tomorrowFocus} onChange={event => set("tomorrowFocus", event.target.value)} rows={2} placeholder="One controllable adjustment for the next session." />
              </Field>
              {rulesChecklist(
                "Rule adherence",
                draft.rulesFollowed.filter(item => item.yes).length,
                effectiveRules.filter(rule => rule.checked).map(rule => {
                  const followed = draft.rulesFollowed.find(item => item.id === rule.id)?.yes ?? false;
                  return (
                    <label key={rule.id}>
                      <input type="checkbox" checked={followed} onChange={() => toggleFollowed(rule.id)} />
                      <span>{rule.text}</span>
                    </label>
                  );
                }),
                <p className="plan-rules-empty">No rules applied to this session, so rule adherence is not scored.</p>,
              )}
            </div>

            <div className="field-grid plan-psychology-review">
              <Field label="Emotional state after the session">
                <div className="pill-options">
                  {["", ...EMOTIONAL_STATES].map(value => (
                    <button type="button" key={value || "unset"} className={draft.emotionEnd === value ? "selected" : ""} onClick={() => set("emotionEnd", value)}>{value || "Not set"}</button>
                  ))}
                </div>
              </Field>
              <Field label="Biggest psychological mistake" hint="One selection. 'No significant trigger' is a valid answer." className="field-span-full">
                <select value={draft.primaryPsychologyTrigger} onChange={event => set("primaryPsychologyTrigger", event.target.value)}>
                  <option value="">Nothing selected</option>
                  {PSYCHOLOGY_TRIGGERS.map(trigger => <option key={trigger.key} value={trigger.key}>{trigger.label}</option>)}
                </select>
              </Field>
              <div className="field field-span-full">
                <span>What triggered me today?</span>
                <div className="trigger-chips">
                  {PSYCHOLOGY_TRIGGERS.map(trigger => (
                    <button
                      type="button"
                      key={trigger.key}
                      className={draft.psychologyTriggers.includes(trigger.key) ? "selected" : ""}
                      aria-pressed={draft.psychologyTriggers.includes(trigger.key)}
                      onClick={() => toggleTrigger(trigger.key)}
                    >
                      {trigger.label}
                    </button>
                  ))}
                </div>
                <small className="field-hint">Select every trigger that fired. This feeds the behavioural history, and it never claims a trigger caused an outcome.</small>
              </div>
              <Field label="What did you do because of it?" className="field-span-full">
                <Textarea value={draft.triggerAction} onChange={event => set("triggerAction", event.target.value)} rows={2} placeholder="Optional. Example: took the entry before the confirmation close." />
              </Field>
              <Field label="What will I do differently next session?" className="field-span-full">
                <Textarea value={draft.nextSessionChange} onChange={event => set("nextSessionChange", event.target.value)} rows={2} placeholder="One sentence." />
              </Field>
            </div>

            <details className="plan-optional-ratings">
              <summary>Optional ratings and notes</summary>
              <div className="field-grid">
                <Score label="Execution quality" value={draft.executionScore} onChange={value => set("executionScore", value)} />
                <Score label="Overall session rating" value={draft.overallRating} onChange={value => set("overallRating", value)} />
                <Field label="Execution narrative" className="field-span-full">
                  <Textarea value={draft.executionNotes} onChange={event => set("executionNotes", event.target.value)} rows={3} placeholder="What happened relative to the scenario map, entries, management, and exits?" />
                </Field>
              </div>
            </details>

            <div className="plan-review-actions">
              <Button variant="outline" onClick={prepareTomorrow}><ArrowRight size={15} /> Prepare tomorrow</Button>
              <Button disabled={!account || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save review"}</Button>
            </div>
          </Section>

          <div className="plan-save-footer">
            <CircleAlert size={15} />
            <span>Save the plan before the first trade and the review after the close—do not rewrite the original thesis. A copied plan stays fully editable, and the session it came from is never modified.</span>
          </div>
        </section>
      </div>
    </>
  );
}
