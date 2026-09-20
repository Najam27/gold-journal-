import React, { useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PRESENTATION_MISSING,
  TRADE_EVIDENCE_THEME,
  buildTradePresentation,
  resolveTone,
  type TradePresentation,
  type TradePresentationField,
  type TradeTone,
} from "@/lib/tradePresentation";

/**
 * The journal's single trade viewer.
 *
 * The dialog renders the canonical Trade Presentation Model — the same model the
 * share image and the PDF report render — instead of its own hand-written field
 * list. That is what keeps the three surfaces in step: a field the trader records
 * in Edit Trade appears here, on the shared card, and in the export, with one
 * label and one formatting rule. MT5 ticket numbers, storage keys, file names, and
 * audit timestamps are deliberately absent: they belong to synchronisation, not to
 * the trader's review of a trade.
 */

const TONE_COLORS: Record<string, string> = {
  positive: "var(--gj-positive, #157a4a)",
  negative: "var(--gj-negative, #b23030)",
  accent: "var(--gj-gold-text, #8a6a1f)",
  warning: "#a0570e",
};

function fieldColor(field: { tone?: TradeTone; value: string }) {
  return TONE_COLORS[resolveTone(field)];
}

function Field({ field }: { field: TradePresentationField }) {
  return (
    <div className="tp-field" data-field={field.key}>
      <span>{field.label}</span>
      <strong style={{ color: fieldColor(field) }}>{field.value}</strong>
    </div>
  );
}

function Section({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <section className="tp-section">
      <div className="tp-band" style={{ background: accent }}>{title}</div>
      {children}
    </section>
  );
}

/**
 * The complete canonical trade card, shared by the viewer and the print view.
 *
 * The KPI strip already carries the headline figures, so the tables below omit
 * those exact fields rather than repeating the same value twice — the identity
 * fields are shown once in the header for the same reason. Nothing is lost: every
 * omitted field is on screen in the strip above.
 */
export function TradePresentationView({ model, heading = "Trade card", balanceLabel }: { model: TradePresentation; heading?: string; balanceLabel?: string }) {
  const kpiKeys = new Set(model.kpis.map(kpi => kpi.key));
  const fieldsOf = (id: string) => (model.sections.find(section => section.id === id)?.fields ?? [])
    .filter(field => !field.inHeader && !kpiKeys.has(field.key))
    // The running-balance row is labelled by whoever opened the viewer ("Current
    // MT5 balance" on a connected broker account), matching the Trade Log.
    .map(field => (field.key === "runningBalance" && balanceLabel ? { ...field, label: balanceLabel } : field));
  const identity = model.identity;
  const processReview = fieldsOf("discipline").find(field => field.key === "processReview");
  return (
    <article className="trade-presentation">
      <header className="tp-head">
        <div className="tp-identity">
          <span className="tp-date">{heading.toUpperCase()} · {identity.idLabel === PRESENTATION_MISSING ? "Trade" : `#${identity.idLabel}`}</span>
          <p className="tp-line">{[identity.tradeDate, identity.symbol, identity.session, identity.direction, identity.result].filter(value => value !== PRESENTATION_MISSING).join(" · ")}</p>
        </div>
        <b className={`tp-pnl data-text ${identity.pnlValue >= 0 ? "positive" : "negative"}`}>{identity.pnl}</b>
      </header>

      <div className="tp-kpis">
        {model.kpis.map(kpi => (
          <div className="tp-kpi" key={kpi.key} data-kpi={kpi.key}>
            <span>{kpi.label}</span>
            <b style={{ color: TONE_COLORS[kpi.tone] }}>{kpi.value}</b>
          </div>
        ))}
      </div>

      <Section title="1 · Trade overview" accent={model.sections[0]?.accent ?? "#2F5C9E"}>
        <div className="tp-fields">{fieldsOf("overview").map(field => <Field field={field} key={field.key} />)}</div>
      </Section>

      <Section title="2 · Strategy" accent={model.sections.find(section => section.id === "strategy")?.accent ?? "#7C4DBE"}>
        <div className="tp-fields">{fieldsOf("strategy").map(field => <Field field={field} key={field.key} />)}</div>
      </Section>

      <Section title="3 · Execution" accent={model.sections.find(section => section.id === "execution")?.accent ?? "#0E7C86"}>
        <div className="tp-fields">{fieldsOf("execution").map(field => <Field field={field} key={field.key} />)}</div>
      </Section>

      <Section title="4 · Risk & performance" accent={model.sections.find(section => section.id === "risk")?.accent ?? "#A97B12"}>
        <div className="tp-fields">{fieldsOf("risk").map(field => <Field field={field} key={field.key} />)}</div>
      </Section>

      <Section title="5 · Plan & discipline" accent={model.sections.find(section => section.id === "discipline")?.accent ?? "#3B4CC0"}>
        <div className="tp-fields">
          {fieldsOf("discipline").filter(field => field.key !== "processReview" && field.key !== "processClassification").map(field => <Field field={field} key={field.key} />)}
        </div>
        <div className="tp-process">
          <strong style={{ color: TONE_COLORS[model.classification.tone] ?? "inherit" }} data-classification={model.classification.key}>
            {model.classification.label}
          </strong>
          {model.classification.summary ? <span className="tp-field-note">{model.classification.summary}</span> : null}
          <p>{processReview?.value ?? PRESENTATION_MISSING}</p>
        </div>
      </Section>

      <Section title="6 · Pre-trade checklist" accent={model.sections.find(section => section.id === "checklist")?.accent ?? "#5C6BC0"}>
        <ul className="tp-checklist">
          {model.checklist.map(item => (
            <li className={`tp-check ${item.confirmed ? "confirmed" : ""}`} key={item.label}>
              <b style={{ color: item.confirmed ? TONE_COLORS.positive : item.recorded ? TONE_COLORS.negative : "var(--gj-dim)" }}>{item.confirmed ? "✓" : "✗"}</b>
              <span>{item.label}{item.recorded ? "" : " — not recorded"}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="7 · Mistakes & behaviour" accent={model.sections.find(section => section.id === "mistakes")?.accent ?? "#C2453E"}>
        <div className="tp-fields">{fieldsOf("mistakes").map(field => <Field field={field} key={field.key} />)}</div>
      </Section>

      <Section title="8 · Psychology" accent={model.sections.find(section => section.id === "psychology")?.accent ?? "#A34FC0"}>
        <div className="tp-blocks">
          {fieldsOf("psychology").map(field => (
            <div className="tp-block" key={field.key}>
              <span>{field.label}</span>
              <strong>{field.value === PRESENTATION_MISSING ? "No entry recorded." : field.value}</strong>
            </div>
          ))}
        </div>
      </Section>

      <Section title="9 · Journal notes" accent={model.sections.find(section => section.id === "journal")?.accent ?? "#5C6672"}>
        <div className="tp-note">
          <span>Trade notes</span>
          <strong style={{ whiteSpace: "pre-wrap" }}>{model.journalNotes.trim() ? model.journalNotes : "No notes recorded."}</strong>
        </div>
      </Section>

      <Section title={`10 · ${TRADE_EVIDENCE_THEME.title}`} accent={TRADE_EVIDENCE_THEME.accent}>
        <div className="tp-evidence">
          {model.evidence.url ? (
            <img src={model.evidence.url} alt={`Trade screenshot from ${identity.tradeDate}`} />
          ) : (
            <p className="tp-empty">
              {model.evidence.hasScreenshot
                ? "A screenshot is stored for this trade, but it could not be loaded just now."
                : "No screenshot attached to this trade."}
            </p>
          )}
        </div>
      </Section>
    </article>
  );
}

/** The Trade Log / day-drill-down entry point for the canonical trade card. */
export function TradeDetailDialog({ trade, balance, balanceLabel, open, onOpenChange }: any) {
  const model = useMemo(() => (trade ? buildTradePresentation(trade, { runningBalance: balance ?? null }) : null), [trade, balance]);
  if (!trade || !model) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="trade-view-dialog">
        <DialogHeader>
          <DialogTitle>Trade card</DialogTitle>
          <DialogDescription>{model.identity.line || balanceLabel}</DialogDescription>
        </DialogHeader>
        <TradePresentationView model={model} balanceLabel={balanceLabel} />
      </DialogContent>
    </Dialog>
  );
}
