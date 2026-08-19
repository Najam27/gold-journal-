import React, { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatMoney, getPktDateInput, getPktSession, sessions, toNumber } from "@/lib/gold";
import { pktDateToTimestamp } from "@shared/pktDate";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

function todayInput() { return getPktDateInput(); }
export function skippedTradeTimestamp(value: string) { return pktDateToTimestamp(value); }

function freshOpportunity() {
  return { date: todayInput(), session: getPktSession(), direction: "", reason: "", confidence: "", outcome: "", missed: "", notes: "" };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function MissedTradesView({ rows, account, refresh }: any) {
  const createSkipped = trpc.skipped.create.useMutation();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(freshOpportunity);
  const totalMissed = rows.reduce((sum: number, row: any) => sum + toNumber(row.estimatedMissed), 0);
  const openNew = () => { setForm(freshOpportunity()); setOpen(true); };
  const close = () => { setOpen(false); setForm(freshOpportunity()); };
  const save = async () => {
    if (!account) return;
    if (!form.direction || !form.reason.trim() || !form.outcome.trim() || !form.confidence) {
      toast.error("Select a direction and add the reason, confidence, and outcome before saving.");
      return;
    }
    try {
      await createSkipped.mutateAsync({ accountId: account.id, tradeDate: skippedTradeTimestamp(form.date), session: form.session, level: "", timeframe: "", direction: form.direction as "BUY" | "SELL", skipReason: form.reason.trim(), confidence: Number(form.confidence), outcome: form.outcome.trim(), estimatedMissed: Number(form.missed || 0), notes: form.notes });
      toast.success("Skipped trade logged.");
      close();
      refresh();
    } catch (error: any) {
      toast.error(error.message || "Skipped trade could not be saved.");
    }
  };

  return <><section className="section-heading"><div><span className="eyebrow">OPPORTUNITY REVIEW</span><h2>Missed / skipped trades</h2><p>Track what you saw, why you passed, and what happened afterwards.</p></div><Button onClick={openNew}><Plus size={16} /> Log Skipped Trade</Button></section><div className="stats-grid compact"><div className="stat-card"><span>Total skipped</span><strong className="data-text">{rows.length}</strong><small>Recorded opportunities</small></div><div className="stat-card"><span>Estimated missed</span><strong className="data-text">{formatMoney(totalMissed)}</strong><small>Potential, not realized</small></div><div className="stat-card"><span>Top reason</span><strong>{rows[0]?.skipReason || "—"}</strong><small>Based on entries</small></div></div><section className="panel">{rows.length ? <div className="trade-table-wrap"><table className="trade-table"><thead><tr><th>Date</th><th>Session</th><th>Direction</th><th>Reason</th><th>Confidence</th><th>Outcome</th><th>Est. missed</th></tr></thead><tbody>{rows.map((row: any) => <tr key={row.id}><td className="data-text">{formatDate(row.tradeDate)}</td><td>{row.session}</td><td>{row.direction}</td><td>{row.skipReason}</td><td>{row.confidence}/5</td><td>{row.outcome}</td><td className="positive data-text">{formatMoney(row.estimatedMissed)}</td></tr>)}</tbody></table></div> : <div className="empty-state"><strong>No skipped opportunities yet.</strong><p>Logging a skipped setup turns a moment of uncertainty into reviewable evidence.</p></div>}</section><Dialog open={open} onOpenChange={next => next ? setOpen(true) : close()}><DialogContent><DialogHeader><DialogTitle>Log skipped trade</DialogTitle><DialogDescription>Capture the missed opportunity without diluting the main trade log.</DialogDescription></DialogHeader><div className="stacked-fields"><Field label="Date"><Input type="date" value={form.date} onChange={event => setForm({ ...form, date: event.target.value })} /></Field><Field label="Session"><select value={form.session} onChange={event => setForm({ ...form, session: event.target.value })}>{sessions.map(item => <option key={item}>{item}</option>)}</select></Field><Field label="Direction"><select value={form.direction} onChange={event => setForm({ ...form, direction: event.target.value })}><option value="" disabled>Select direction</option><option value="BUY">BUY</option><option value="SELL">SELL</option></select></Field><Field label="Skip reason"><Input value={form.reason} placeholder="Why did you pass this setup?" onChange={event => setForm({ ...form, reason: event.target.value })} /></Field><Field label="Confidence (1–5)"><select value={form.confidence} onChange={event => setForm({ ...form, confidence: event.target.value })}><option value="" disabled>Select confidence</option>{[1, 2, 3, 4, 5].map(value => <option key={value} value={value}>{value}</option>)}</select></Field><Field label="Outcome"><Input value={form.outcome} placeholder="What happened afterwards?" onChange={event => setForm({ ...form, outcome: event.target.value })} /></Field><Field label="Estimated $ missed"><Input type="number" value={form.missed} placeholder="Optional" onChange={event => setForm({ ...form, missed: event.target.value })} /></Field><Field label="Notes"><Textarea value={form.notes} placeholder="What was missing from the setup or process?" onChange={event => setForm({ ...form, notes: event.target.value })} /></Field></div><div className="dialog-actions"><Button variant="outline" onClick={close}>Cancel</Button><Button disabled={createSkipped.isPending} onClick={() => void save()}>{createSkipped.isPending ? "Saving…" : "Save skipped trade"}</Button></div></DialogContent></Dialog></>;
}
