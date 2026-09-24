import React, { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCheck, ImagePlus, ListChecks, Plus, Settings, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatActualR, formatRr, results } from "@/lib/gold";
import {
  MISTAKE_CATEGORY_LABELS,
  MISTAKE_TAXONOMY,
  PRE_TRADE_GATE_ITEMS,
  TRADE_CLASSIFICATION_LABELS,
  TRADE_CLASSIFICATION_SUMMARY,
  previewTradeProcess,
  tradeProcessContext,
  type BehaviorConfig,
  type MistakeCategory,
} from "@/lib/psychology";
import { TradeOptionManager } from "@/components/TradeOptionManager";
import { trpc } from "@/lib/trpc";
import {
  activeOptionValues,
  splitTradeOptionValue,
  tradeOptionChoices,
  tradeOptionSelectChoices,
  toggleTradeOptionValue,
  useTradeOptionStore,
  type TradeOptionStore,
} from "@/lib/tradeOptions";
import { toast } from "sonner";

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={`field ${className}`} role="group" aria-label={label}><span>{label}</span>{children}</div>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="form-section modal-section"><span className="section-label">{title}</span><div className="field-grid">{children}</div></section>;
}

/**
 * Every Trade Log dropdown.
 *
 * The selectable values come from ONE canonical source — the managed option
 * rows for the category — instead of a hard-coded array merged with custom rows.
 * A value the trade already carries that is no longer active (disabled, or a
 * legacy/MT5 string) is added back as “<value> — Archived” so editing an old
 * trade never erases or silently replaces what was recorded.
 */
function CustomSelect({
  category,
  label,
  value,
  onChange,
  store,
  placeholder,
  multi = false,
  onManage,
}: {
  category: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  store: TradeOptionStore;
  placeholder?: string;
  multi?: boolean;
  onManage?: (category: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const addOption = trpc.optionLists.add.useMutation();
  const utils = trpc.useUtils();
  const activeValues = useMemo(() => activeOptionValues(store, category), [store, category]);
  const choices = useMemo(
    () => (multi ? tradeOptionChoices(activeValues, value) : tradeOptionSelectChoices(activeValues, value)),
    [multi, activeValues, value]
  );
  const selectedTags = splitTradeOptionValue(value);
  const displayLabel = label ?? category;

  const save = async (next: string, nextValue: string) => {
    try {
      await addOption.mutateAsync({ category, value: next });
      await utils.optionLists.list.invalidate();
      onChange(nextValue);
      setDraft("");
      toast.success(`${next} saved for future trades.`);
    } catch (error: any) {
      toast.error(error?.message || `${category} could not be saved.`);
    }
  };

  // Adds the freshly saved token to the current value exactly once.
  const join = (token: string) => {
    if (selectedTags.some(item => item.toLowerCase() === token.toLowerCase())) return value;
    return toggleTradeOptionValue(value, token);
  };

  const addSingle = () => {
    const next = draft.trim();
    if (!next) return;
    void save(next, next);
  };

  const addTag = () => {
    const next = draft.trim();
    if (!next) return;
    void save(next, join(next));
  };

  const manage = onManage ? (
    <button
      type="button"
      className="journal-value-manage"
      aria-label={`Manage ${category} options`}
      title={`Manage ${displayLabel} options`}
      onClick={() => onManage(category)}
    >
      <Settings size={13} />
    </button>
  ) : null;

  const addRow = (
    <div className="journal-value-add">
      <Input
        aria-label={`Add custom ${category} option`}
        value={draft}
        onChange={event => setDraft(event.target.value)}
        placeholder={`+ Add ${displayLabel} option`}
        onKeyDown={event => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          if (multi) addTag();
          else addSingle();
        }}
      />
      <button
        type="button"
        title={`Save custom ${category} option`}
        aria-label={`Save custom ${category} option`}
        disabled={addOption.isPending || !draft.trim()}
        onClick={() => (multi ? addTag() : addSingle())}
      >
        <Plus size={14} />
      </button>
    </div>
  );

  if (category === "Mistake" || multi) {
    return (
      <div className="mistake-tags multi-select-tags">
        {store.isLoading ? (
          <p className="journal-value-note" role="status">Loading options…</p>
        ) : (
          <div className="mistake-tag-grid">
            {choices.map(choice => (
              <button
                type="button"
                key={choice.value}
                className={choice.selected ? "selected" : ""}
                aria-pressed={choice.selected}
                onClick={() => onChange(toggleTradeOptionValue(value, choice.value))}
              >
                {choice.archived ? `${choice.value} — Archived` : choice.value}
              </button>
            ))}
          </div>
        )}
        {addRow}
        {store.isError ? (
          <small className="journal-value-note" role="alert">Options could not be loaded — showing built-in defaults only.</small>
        ) : null}
        {manage ? <div className="journal-value-manage-row">{manage}<span>Manage options</span></div> : null}
      </div>
    );
  }

  return (
    <div className="journal-value-control">
      <div className="journal-select-row">
        <select value={value || ""} aria-label={displayLabel} disabled={store.isLoading} onChange={event => onChange(event.target.value)}>
          <option value="">{store.isLoading ? "Loading options…" : placeholder || `Select ${category.toLowerCase()}`}</option>
          {choices.map(choice => (
            <option key={choice.value} value={choice.value}>
              {choice.archived ? `${choice.value} — Archived` : choice.value}
            </option>
          ))}
        </select>
        {manage}
      </div>
      {addRow}
      {store.isError ? (
        <small className="journal-value-note" role="alert">Options could not be loaded — showing built-in defaults only.</small>
      ) : (
        manage ? <div className="journal-value-manage-row">{manage}<span>Manage options</span></div> : null
      )}
    </div>
  );
}

const TAXONOMY_CATEGORIES: MistakeCategory[] = ["EMOTIONAL", "EXECUTION", "ANALYTICAL", "ENVIRONMENTAL"];
const TAXONOMY_LABELS = new Map(MISTAKE_TAXONOMY.map(item => [item.label.toLowerCase(), item]));

/**
 * Behavioural mistake taxonomy.
 *
 * Tags are still written back into the existing `mistake` column as a
 * pipe-separated string, so historic tags, goal rules, and psychology
 * classification keep working untouched. The tag list itself now comes from the
 * managed "Mistake" options, which means built-in taxonomy tags can be renamed
 * or disabled while their documented aliases keep driving detection.
 */
function MistakeTaxonomy({ value, onChange, store, onManage }: { value: string; onChange: (value: string) => void; store: TradeOptionStore; onManage?: (category: string) => void }) {
  const [draft, setDraft] = useState("");
  const addOption = trpc.optionLists.add.useMutation();
  const utils = trpc.useUtils();
  const selected = splitTradeOptionValue(value);
  const selectedLower = selected.map(tag => tag.toLowerCase());
  const isSelected = (label: string) => selectedLower.includes(label.toLowerCase());
  const toggle = (label: string) => onChange(toggleTradeOptionValue(value, label));
  const activeValues = useMemo(() => activeOptionValues(store, "Mistake"), [store]);
  const customTags = useMemo(
    () => tradeOptionChoices(activeValues, value).filter(choice => choice.archived || !TAXONOMY_LABELS.has(choice.value.toLowerCase())),
    [activeValues, value]
  );
  const addTag = async () => {
    const next = draft.trim();
    if (!next) return;
    try {
      await addOption.mutateAsync({ category: "Mistake", value: next });
      await utils.optionLists.list.invalidate();
      onChange(isSelected(next) ? value : toggleTradeOptionValue(value, next));
      setDraft("");
      toast.success("Mistake option saved for future trades.");
    } catch (error: any) {
      toast.error(error?.message || "Could not save the mistake option.");
    }
  };
  return (
    <div className="taxonomy-wrap">
      {store.isLoading ? (
        <p className="journal-value-note" role="status">Loading options…</p>
      ) : (
        TAXONOMY_CATEGORIES.map(category => {
          const tags = activeValues.filter(item => TAXONOMY_LABELS.get(item.toLowerCase())?.category === category);
          if (!tags.length) return null;
          return (
            <div className="taxonomy-category" key={category}>
              <span>{MISTAKE_CATEGORY_LABELS[category].toUpperCase()}</span>
              <div className="taxonomy-group">
                {tags.map(tag => (
                  <button type="button" key={tag} className={isSelected(tag) ? "selected" : ""} aria-pressed={isSelected(tag)} onClick={() => toggle(tag)}>
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          );
        })
      )}
      {customTags.length > 0 && (
        <div className="taxonomy-category">
          <span>YOUR OWN TAGS</span>
          <div className="taxonomy-group">
            {customTags.map(choice => (
              <button type="button" key={choice.value} className={choice.selected ? "selected" : ""} aria-pressed={choice.selected} onClick={() => toggle(choice.value)}>
                {choice.archived ? `${choice.value} — Archived` : choice.value}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="journal-value-add">
        <Input
          aria-label="Add custom Mistake option"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="+ Add custom mistake tag"
          onKeyDown={event => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void addTag();
          }}
        />
        <button type="button" title="Save custom Mistake option" aria-label="Save custom Mistake option" disabled={addOption.isPending || !draft.trim()} onClick={() => void addTag()}>
          <Plus size={14} />
        </button>
      </div>
      {onManage ? (
        <div className="journal-value-manage-row">
          <button type="button" className="journal-value-manage" aria-label="Manage Mistake options" title="Manage Mistake options" onClick={() => onManage("Mistake")}>
            <Settings size={13} />
          </button>
          <span>Manage options</span>
        </div>
      ) : null}
      <p className="gate-footer">Only tag what actually happened. Untagged trades are treated as unevaluated, never as a breach.</p>
    </div>
  );
}

function PlanLinkSection({ form, patch, context }: { form: any; patch: (field: string, value: string) => void; context: ReturnType<typeof tradeProcessContext> }) {
  const checked = new Set(String(form.planChecklist || "").split("|").map((entry: string) => entry.trim()).filter(Boolean));
  const gateItems = PRE_TRADE_GATE_ITEMS.map(item => ({ id: item.id, label: item.label, checked: checked.has(item.id) }));
  const toggle = (id: string) => { const next = new Set(checked); if (next.has(id)) next.delete(id); else next.add(id); patch("planChecklist", Array.from(next).join("|")); };
  const preview = useMemo(() => previewTradeProcess({ tradeDate: `${form.tradeDate}T12:00:00+05:00`, result: form.result || "OPEN", pnl: form.pnl === "" ? 0 : Number(form.pnl), risk: form.risk === "" ? null : Number(form.risk), reward: form.reward === "" ? null : Number(form.reward), setupQuality: form.setupQuality, mistake: form.mistake, patienceScore: form.patienceScore === "" ? null : Number(form.patienceScore), holdQuality: form.holdQuality, planStatus: form.planStatus || null, planChecklist: checked.size ? gateItems : null }, context), [form.tradeDate, form.result, form.pnl, form.risk, form.reward, form.setupQuality, form.mistake, form.patienceScore, form.holdQuality, form.planStatus, form.planChecklist, context]);
  const tone = preview.classification === "NOT_EVALUATED" ? "" : preview.processCompliant ? "good" : "bad";
  return <Section title="Plan link & pre-trade gate">
    <Field label="Plan link" className="field-span-full"><div className="plan-status-options">{([["", "Not evaluated"], ["PLANNED", "Planned entry"], ["UNPLANNED", "Unplanned entry"]] as const).map(([value, label]) => <button type="button" key={value || "none"} className={(form.planStatus || "") === value ? "selected" : ""} onClick={() => patch("planStatus", value)}>{label}</button>)}</div><small className="field-hint">{context.plan ? `Today's plan allows ${context.maxTrades ?? "—"} trades${context.riskCeiling ? ` at ${context.riskCeiling.toFixed(2)} risk each` : ""}.${context.behavioralFocus ? ` Today's behavioural objective: ${context.behavioralFocus}.` : ""}` : "No session protocol is saved for this date, so plan adherence will be treated as unevaluated."}</small></Field>
    <Field label="Pre-trade checklist" className="field-span-full"><div className="gate-grid">{gateItems.map(item => <button type="button" key={item.id} className={item.checked ? "checked" : ""} aria-pressed={item.checked} onClick={() => toggle(item.id)}><ListChecks size={12} /> {item.label}</button>)}</div><p className="gate-footer"><span><ClipboardCheck size={12} /> {checked.size}/{PRE_TRADE_GATE_ITEMS.length} checks confirmed</span><span>Quick tap only — leave it blank to record “not evaluated”.</span></p></Field>
    <Field label="Process classification" className="field-span-full"><div className={`process-preview ${tone}`}><strong><ShieldCheck size={13} /> {TRADE_CLASSIFICATION_LABELS[preview.classification]}</strong><span>{TRADE_CLASSIFICATION_SUMMARY[preview.classification]}{preview.reasons.length ? ` ${preview.reasons[0]}` : ""}</span>{preview.ruleAdherence != null && <span>Rule adherence {preview.ruleAdherence.toFixed(0)}%</span>}{context.behavioralFocus && preview.processCompliant === false ? <span>Potential behavioural deviation against today's objective ({context.behavioralFocus}).</span> : null}</div></Field>
  </Section>;
}

/**
 * Screenshot evidence inside the trade dialog.
 *
 * Three states must stay distinguishable, because each means something different
 * to the save:
 *   - nothing stored and nothing chosen  -> the trade keeps no image;
 *   - an image is already stored         -> an ordinary field edit must leave it
 *                                           completely untouched, and it is
 *                                           restorable from private storage on
 *                                           every reload;
 *   - an explicit replace or remove      -> the same write that saves the trade
 *                                           swaps or clears the evidence.
 *
 * A bare file picker could not express "remove", which is why the previous flow
 * could neither replace nor delete an existing screenshot.
 */
function ScreenshotEvidence({ screenshot, setScreenshot, editing, removeScreenshot, setRemoveScreenshot, progress, uploading, fileRef }: any) {
  const storedUrl = !removeScreenshot && editing?.hasScreenshot ? editing?.screenshotUrl : undefined;
  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Use a JPG, PNG, or WEBP screenshot.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Screenshot must be 5MB or smaller.");
      return;
    }
    setScreenshot(file);
    setRemoveScreenshot(false);
  };
  return (
    <Section title="Screenshot">
      <input
        ref={fileRef}
        hidden
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={event => pick(event.target.files?.[0])}
      />
      {storedUrl ? (
        <div className="upload-box evidence-existing">
          <img src={storedUrl} alt="Screenshot evidence saved with this trade" />
          <div>
            <strong>Screenshot attached</strong>
            <span>Saved with this trade and restored on every reload.</span>
          </div>
          <div className="evidence-actions">
            <Button variant="outline" size="sm" type="button" onClick={() => fileRef.current?.click()}>
              Replace
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="danger-button"
              onClick={() => {
                setScreenshot(undefined);
                setRemoveScreenshot(true);
              }}
            >
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <>
          {removeScreenshot && editing?.hasScreenshot && (
            <div className="upload-box evidence-removed">
              <div>
                <strong>Screenshot will be removed when you save.</strong>
                <span>The stored image is deleted only after the update is accepted.</span>
              </div>
              <div className="evidence-actions">
                <Button variant="outline" size="sm" type="button" onClick={() => setRemoveScreenshot(false)}>
                  Keep it
                </Button>
              </div>
            </div>
          )}
          <div className="upload-box" onClick={() => fileRef.current?.click()}>
            <ImagePlus size={20} />
            <div>
              <strong>
                {screenshot
                  ? screenshot.name
                  : editing?.hasScreenshot
                    ? "Choose a replacement image"
                    : "Drag & drop or click to upload chart"}
              </strong>
              <span>
                {uploading
                  ? "Uploading to private storage…"
                  : "JPG, PNG or WEBP · 5MB maximum · stored before the trade is saved"}
              </span>
            </div>
          </div>
        </>
      )}
      {progress > 0 && (
        <div className="upload-progress">
          <i style={{ width: `${progress}%` }} />
        </div>
      )}
    </Section>
  );
}

export function TradeDialogWithCustomOptions({ open, setOpen, form, setForm, editing, onSave, pending, saveState, saveError, screenshot, setScreenshot, progress, plans, dayTrades, behaviorConfig }: any) {
  const fileRef = useRef<HTMLInputElement>(null);
  // Removal intent belongs to the dialog, because the dialog is the surface that
  // knows which image is currently stored and whether the user asked to drop it.
  // It travels back with the save so only an explicit removal clears evidence.
  const [removeStoredScreenshot, setRemoveStoredScreenshot] = useState(false);
  useEffect(() => {
    if (!open) setRemoveStoredScreenshot(false);
  }, [editing?.id, open]);
  const patch = (field: string, value: string) => setForm({ ...form, [field]: value });
  const selectDirection = form.direction || "";
  const selectResult = form.result || "";
  const store = useTradeOptionStore();
  const [manageCategory, setManageCategory] = useState<string | null>(null);
  const planContext = useMemo(() => tradeProcessContext({ day: form.tradeDate, trades: dayTrades ?? [], plans: plans ?? [], config: behaviorConfig as BehaviorConfig | undefined }), [form.tradeDate, dayTrades, plans, behaviorConfig]);
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="trade-dialog"><DialogHeader><DialogTitle>{editing ? "Edit trade" : "New trade"}</DialogTitle><DialogDescription>{editing ? "Update the journal detail and retain the original session." : "Session is detected from Pakistan Standard Time and can be overridden."}</DialogDescription></DialogHeader><p className="trade-custom-help">Every dropdown reads your managed option lists, including the built-in defaults. Use <b>+ Add</b> to save a reusable value, or the ⚙ control to rename, disable, or add options for that field.</p><div className="trade-form">
    <Section title="Trade details"><Field label="Date"><Input type="date" value={form.tradeDate} onChange={event => patch("tradeDate", event.target.value)} /></Field><Field label="Session"><CustomSelect category="Session" value={form.session} onChange={value => patch("session", value)} store={store} onManage={setManageCategory} /></Field><Field label="Direction"><select value={selectDirection} onChange={event => patch("direction", event.target.value)}><option value="" disabled>Select direction</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select></Field><Field label="Result"><select value={selectResult} onChange={event => patch("result", event.target.value)}><option value="" disabled>Select result</option>{results.map(item => <option key={item} value={item}>{item.replace("_", " ")}</option>)}</select></Field></Section>
    <Section title="Strategy"><Field label="Level / confluence"><CustomSelect multi category="Level" value={form.level} onChange={value => patch("level", value)} store={store} onManage={setManageCategory} /></Field><Field label="Timeframe"><CustomSelect category="Timeframe" value={form.timeframe} onChange={value => patch("timeframe", value)} store={store} onManage={setManageCategory} /></Field><Field label="Setup quality"><CustomSelect category="Setup quality" value={form.setupQuality} onChange={value => patch("setupQuality", value)} store={store} onManage={setManageCategory} /></Field><Field label="Confirmation signals"><CustomSelect multi category="Confirmation" value={form.confirmationType} onChange={value => patch("confirmationType", value)} store={store} onManage={setManageCategory} /></Field></Section>
    <Section title="Execution"><Field label="Execution type"><CustomSelect category="Execution type" value={form.executionType} onChange={value => patch("executionType", value)} store={store} onManage={setManageCategory} /></Field><Field label="Market conditions"><CustomSelect multi category="Market condition" value={form.marketCondition} onChange={value => patch("marketCondition", value)} store={store} onManage={setManageCategory} /></Field><Field label="Direction vs bias"><CustomSelect category="Bias alignment" value={form.biasAlignment} onChange={value => patch("biasAlignment", value)} store={store} onManage={setManageCategory} /></Field><Field label="SL placement"><CustomSelect category="SL placement" value={form.slPlacement} onChange={value => patch("slPlacement", value)} store={store} onManage={setManageCategory} /></Field><Field label="TP placement"><CustomSelect category="TP placement" value={form.tpPlacement} onChange={value => patch("tpPlacement", value)} store={store} onManage={setManageCategory} /></Field><Field label="Patience score (1–5)"><Input type="number" min="1" max="5" value={form.patienceScore} onChange={event => patch("patienceScore", event.target.value)} /></Field><Field label="Mistake / rule-break tags" className="field-span-full"><MistakeTaxonomy value={form.mistake || ""} onChange={value => patch("mistake", value)} store={store} onManage={setManageCategory} /></Field><Field label="Hold quality"><CustomSelect category="Hold quality" value={form.holdQuality} onChange={value => patch("holdQuality", value)} store={store} onManage={setManageCategory} /></Field></Section>
    <Section title="Risk"><Field label="Planned risk $"><Input type="number" min="0" step="0.01" value={form.risk} onChange={event => patch("risk", event.target.value)} /></Field><Field label="Planned reward $"><Input type="number" min="0" step="0.01" value={form.reward} onChange={event => patch("reward", event.target.value)} /></Field><Field label="Actual P&amp;L $"><Input type="number" step="0.01" value={form.pnl} placeholder="Realized profit/loss" onChange={event => patch("pnl", event.target.value)} /></Field><div className="rr-live"><span>PLANNED R:R</span><strong className="data-text">{formatRr(form.risk, form.reward)}</strong></div><div className="rr-live"><span>ACTUAL R</span><strong className="data-text">{formatActualR(form.risk, form.pnl)}</strong></div></Section>
    <PlanLinkSection form={form} patch={patch} context={planContext} />
    <ScreenshotEvidence screenshot={screenshot} setScreenshot={setScreenshot} editing={editing} removeScreenshot={removeStoredScreenshot} setRemoveScreenshot={setRemoveStoredScreenshot} progress={progress} uploading={pending && Boolean(screenshot)} fileRef={fileRef} />
    <Section title="Notes"><Field label="Trade notes" className="field-span-full"><Textarea className="journal-long-text" value={form.notes} rows={6} placeholder="What happened, how you felt, lessons… Write as much as the trade needs. Notes are never truncated." onChange={event => patch("notes", event.target.value)} /></Field></Section>
    <Section title="Emotions"><Field label="Before trade" className="field-span-full"><Textarea className="journal-long-text" value={form.emotionBefore} rows={4} placeholder="How were you feeling before entering? e.g. calm, focused, dar raha tha, nervous about news…" onChange={event => patch("emotionBefore", event.target.value)} /></Field><Field label="During trade" className="field-span-full"><Textarea className="journal-long-text" value={form.emotionDuring} rows={4} placeholder="What were you thinking while in the trade? e.g. confident in setup, wanted to exit early…" onChange={event => patch("emotionDuring", event.target.value)} /></Field><Field label="After trade" className="field-span-full"><Textarea className="journal-long-text" value={form.emotionAfter} rows={4} placeholder="How did you feel after closing? e.g. satisfied, frustrated, gussa aya, should have held longer…" onChange={event => patch("emotionAfter", event.target.value)} /></Field></Section>
  </div>
    {/*
      The save state machine, reported by the page from the REAL backend write:
      Idle -> Saving… -> Saved / Save failed. There is no local write and no
      queue, so "Saved" is only ever shown after Supabase confirmed the row, and
      a failure keeps the dialog open with the server's own reason.
    */}
    <div className="dialog-actions">
      {saveState === "error" && saveError ? (
        <p className="plan-save-error" role="alert">Save failed — {saveError}</p>
      ) : null}
      <Button variant="outline" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
      <Button disabled={pending} onClick={() => onSave({ removeScreenshot: removeStoredScreenshot })}>
        {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : editing ? "Save changes" : "Save trade"}
      </Button>
    </div>
    {manageCategory ? (
      <Dialog open onOpenChange={next => { if (!next) setManageCategory(null); }}>
        <DialogContent className="option-manager-dialog"><DialogHeader><DialogTitle>Manage options</DialogTitle><DialogDescription>Rename, disable, or add options for this field. Changes apply to every trade form immediately.</DialogDescription></DialogHeader><TradeOptionManager variant="dialog" initialCategory={manageCategory} onClose={() => setManageCategory(null)} /></DialogContent>
      </Dialog>
    ) : null}
  </DialogContent></Dialog>;
}
