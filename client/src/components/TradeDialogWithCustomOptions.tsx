import React, { useRef, useState } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { executionTypes, formatRr, levels, results, sessions } from "@/lib/gold";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="form-section modal-section"><span className="section-label">{title}</span><div className="field-grid">{children}</div></section>;
}

function CustomSelect({ category, value, onChange, options, placeholder, multi = false }: { category: string; value: string; onChange: (value: string) => void; options: string[]; placeholder?: string; multi?: boolean }) {
  const [draft, setDraft] = useState("");
  const optionQuery = trpc.optionLists.list.useQuery();
  const addOption = trpc.optionLists.add.useMutation();
  const utils = trpc.useUtils();
  const customs = (optionQuery.data ?? []).filter((item: any) => item.category === category && item.active).map((item: any) => item.value);
  const behaviorChoices = category === "Mistake" ? ["FOMO", "Revenge", "Overtrading", "Oversize", "Early entry", "Late entry", "Over-risked", "Moved SL", "Closed early"] : [];
  const choices = Array.from(new Set([...options, ...behaviorChoices, ...customs]));
  const selectedTags = (value || "").split(/[|,;/]+/).map(tag => tag.trim()).filter(tag => tag && tag.toLowerCase() !== "none");
  const add = async () => {
    const next = draft.trim();
    if (!next) return;
    try {
      await addOption.mutateAsync({ category, value: next });
      await utils.optionLists.list.invalidate();
      onChange(next);
      setDraft("");
      toast.success(`${category} saved for future trades.`);
    } catch (error: any) {
      toast.error(error.message || `Could not save ${category}.`);
    }
  };
  const addTag = async () => {
    const next = draft.trim();
    if (!next) return;
    try {
      await addOption.mutateAsync({ category, value: next });
      await utils.optionLists.list.invalidate();
      onChange(selectedTags.some(item => item.toLowerCase() === next.toLowerCase()) ? selectedTags.join(" | ") : [...selectedTags, next].join(" | "));
      setDraft("");
      toast.success(`${category} option saved for future trades.`);
    } catch (error: any) {
      toast.error(error.message || `Could not save ${category} option.`);
    }
  };
  const toggleTag = (tag: string) => onChange(selectedTags.some(item => item.toLowerCase() === tag.toLowerCase()) ? selectedTags.filter(item => item.toLowerCase() !== tag.toLowerCase()).join(" | ") : [...selectedTags, tag].join(" | "));

  if (category === "Mistake" || multi) {
    return <div className="mistake-tags multi-select-tags"><div className="mistake-tag-grid">{choices.filter(item => item !== "None").map(item => <button type="button" key={item} className={selectedTags.some(tag => tag.toLowerCase() === item.toLowerCase()) ? "selected" : ""} onClick={() => toggleTag(item)}>{item}</button>)}</div><div className="journal-value-add"><Input aria-label={`Add custom ${category} option`} value={draft} maxLength={70} onChange={event => setDraft(event.target.value)} placeholder={`+ Add custom ${category} option`} /><button type="button" title={`Save custom ${category} option`} aria-label={`Save custom ${category} option`} disabled={addOption.isPending || !draft.trim()} onClick={() => void addTag()}><Plus size={14} /></button></div></div>;
  }

  return <div className="journal-value-control"><select value={value || ""} onChange={event => onChange(event.target.value)}><option value="">{placeholder || `Select ${category.toLowerCase()}`}</option>{choices.map(item => <option key={item} value={item}>{item}</option>)}</select><div className="journal-value-add"><Input aria-label={`Add custom ${category}`} value={draft} onChange={event => setDraft(event.target.value)} placeholder={`+ Add ${category}`} /><button type="button" title={`Save custom ${category}`} aria-label={`Save custom ${category}`} disabled={addOption.isPending || !draft.trim()} onClick={() => void add()}><Plus size={14} /></button></div></div>;
}

export function TradeDialogWithCustomOptions({ open, setOpen, form, setForm, editing, onSave, pending, screenshot, setScreenshot, progress }: any) {
  const fileRef = useRef<HTMLInputElement>(null);
  const patch = (field: string, value: string) => setForm({ ...form, [field]: value });
  const selectDirection = form.direction || "";
  const selectResult = form.result || "";

  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="trade-dialog"><DialogHeader><DialogTitle>{editing ? "Edit trade" : "New trade"}</DialogTitle><DialogDescription>{editing ? "Update the journal detail and retain the original session." : "Session is detected from Pakistan Standard Time and can be overridden."}</DialogDescription></DialogHeader><p className="trade-custom-help">Use the <b>+ Add</b> control below any journal field to save a custom reusable option for future trades. Fields shown as chips allow multiple selections.</p><div className="trade-form"><Section title="Trade details"><Field label="Date"><Input type="date" value={form.tradeDate} onChange={event => patch("tradeDate", event.target.value)} /></Field><Field label="Session"><CustomSelect category="Session" value={form.session} onChange={value => patch("session", value)} options={sessions} /></Field><Field label="Direction"><select value={selectDirection} onChange={event => patch("direction", event.target.value)}><option value="" disabled>Select direction</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select></Field><Field label="Result"><select value={selectResult} onChange={event => patch("result", event.target.value)}><option value="" disabled>Select result</option>{results.map(item => <option key={item} value={item}>{item.replace("_", " ")}</option>)}</select></Field></Section><Section title="Strategy"><Field label="Level / confluence"><CustomSelect multi category="Level" value={form.level} onChange={value => patch("level", value)} options={levels} /></Field><Field label="Timeframe"><CustomSelect category="Timeframe" value={form.timeframe} onChange={value => patch("timeframe", value)} options={["1m", "5m", "15m", "H1", "4H"]} /></Field><Field label="Setup quality"><CustomSelect category="Setup quality" value={form.setupQuality} onChange={value => patch("setupQuality", value)} options={["A+", "A", "B"]} /></Field><Field label="Confirmation signals"><CustomSelect multi category="Confirmation" value={form.confirmationType} onChange={value => patch("confirmationType", value)} options={["BOS", "CHoCH", "Liquidity sweep", "Engulfing", "Rejection", "Displacement"]} /></Field></Section><Section title="Execution"><Field label="Execution type"><CustomSelect category="Execution type" value={form.executionType} onChange={value => patch("executionType", value)} options={executionTypes} /></Field><Field label="Market conditions"><CustomSelect multi category="Market condition" value={form.marketCondition} onChange={value => patch("marketCondition", value)} options={["Trending", "Ranging", "Volatile", "News-driven", "Low liquidity"]} /></Field><Field label="Direction vs bias"><CustomSelect category="Bias alignment" value={form.biasAlignment} onChange={value => patch("biasAlignment", value)} options={["Aligned", "Counter-trend", "Neutral"]} /></Field><Field label="SL placement"><CustomSelect category="SL placement" value={form.slPlacement} onChange={value => patch("slPlacement", value)} options={["Below swing", "Above swing", "Structure", "Fixed points"]} /></Field><Field label="TP placement"><CustomSelect category="TP placement" value={form.tpPlacement} onChange={value => patch("tpPlacement", value)} options={["Prior high", "Prior low", "Liquidity", "R multiple"]} /></Field><Field label="Patience score (1–5)"><Input type="number" min="1" max="5" value={form.patienceScore} onChange={event => patch("patienceScore", event.target.value)} /></Field><Field label="Mistake / rule-break tags"><CustomSelect category="Mistake" value={form.mistake} onChange={value => patch("mistake", value)} options={["None", "Early entry", "Late entry", "Over-risked", "Moved SL", "Closed early"]} /></Field><Field label="Hold quality"><CustomSelect category="Hold quality" value={form.holdQuality} onChange={value => patch("holdQuality", value)} options={["Excellent", "Good", "Average", "Poor"]} /></Field></Section><Section title="Risk"><Field label="Risk $"><Input type="number" min="0" step="0.01" value={form.risk} onChange={event => patch("risk", event.target.value)} /></Field><Field label="Reward $"><Input type="number" min="0" step="0.01" value={form.reward} onChange={event => patch("reward", event.target.value)} /></Field><Field label="P&L $"><Input type="number" step="0.01" value={form.pnl} placeholder="Realized profit/loss" onChange={event => patch("pnl", event.target.value)} /></Field><div className="rr-live"><span>LIVE R:R</span><strong className="data-text">{formatRr(form.risk, form.reward)}</strong></div></Section><Section title="Screenshot"><div className="upload-box" onClick={() => fileRef.current?.click()}><ImagePlus size={20} /><div><strong>{screenshot ? screenshot.name : "Drag & drop or click to upload chart"}</strong><span>JPG, PNG or WEBP · 5MB maximum</span></div><input ref={fileRef} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { toast.error("Use a JPG, PNG, or WEBP screenshot."); return; } if (file.size > 5 * 1024 * 1024) { toast.error("Screenshot must be 5MB or smaller."); return; } setScreenshot(file); }} /></div>{progress > 0 && <div className="upload-progress"><i style={{ width: `${progress}%` }} /></div>}</Section><Section title="Notes"><Field label="Trade notes" className="field-span-full"><Textarea value={form.notes} rows={4} placeholder="What happened, how you felt, lessons…" onChange={event => patch("notes", event.target.value)} /></Field></Section><Section title="Emotions"><Field label="Before trade" className="field-span-full"><Textarea value={form.emotionBefore} placeholder="How were you feeling before entering? e.g. calm, focused, dar raha tha, nervous about news…" onChange={event => patch("emotionBefore", event.target.value)} /></Field><Field label="During trade" className="field-span-full"><Textarea value={form.emotionDuring} placeholder="What were you thinking while in the trade? e.g. confident in setup, wanted to exit early…" onChange={event => patch("emotionDuring", event.target.value)} /></Field><Field label="After trade" className="field-span-full"><Textarea value={form.emotionAfter} placeholder="How did you feel after closing? e.g. satisfied, frustrated, gussa aya, should have held longer…" onChange={event => patch("emotionAfter", event.target.value)} /></Field></Section></div><div className="dialog-actions"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={pending} onClick={onSave}>{pending ? "Saving…" : editing ? "Save changes" : "Save trade"}</Button></div></DialogContent></Dialog>;
}
