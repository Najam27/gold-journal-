import React, { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, Brain, ClipboardCheck, Minus, Pencil, Rows3, Target } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TradeDetailDialog } from "@/components/TradeDetailDialog";
import { formatActualR, formatMoney, toNumber } from "@/lib/gold";
import { formatPips, tradePips } from "@shared/pipMath";
import { LIVE_MODE, type TradeModeConfig } from "@/lib/tradeModeConfig";
import type { DayTradeSummary } from "@/lib/performanceSummary";
import { PKT_TIME_ZONE, pktDateToTimestamp } from "@shared/pktDate";
import { buildDayBehaviorReview, TRADE_CLASSIFICATION_LABELS, type BehaviorConfig } from "@/lib/psychology";

/**
 * Daily performance drill-down.
 *
 * Read-only: it renders whatever day summary the calendar computed from the
 * trades already held in the browser. It never fetches, mutates, or syncs, and
 * opening it cannot change journal, P&L, or MT5 state.
 */

type DayTrade = { tradeDate: Date | string | number; result?: string; pnl?: string | number | null; risk?: string | number | null; session?: string; direction?: string; symbol?: string; mt5Ticket?: string | number | null; localPending?: boolean; [key: string]: unknown };

function dayInstant(day: string) {
  try { return new Date(pktDateToTimestamp(day)); } catch { return null; }
}

function formatDayLabel(day: string) {
  const instant = dayInstant(day);
  if (!instant) return day;
  return new Intl.DateTimeFormat("en-GB", { timeZone: PKT_TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(instant);
}

function formatClock(value: Date | string | number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: PKT_TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function tradeTone(result: string, pnl: number) {
  if (result === "WIN") return "positive";
  if (result === "LOSS") return "negative";
  return pnl > 0 ? "positive" : pnl < 0 ? "negative" : "neutral";
}

export function DayTradesDialog({ mode = LIVE_MODE, day, summary, plans, behaviorConfig, onOpenChange, onEdit }: { mode?: TradeModeConfig; day: string | null; summary: DayTradeSummary<any> | null; plans?: any[]; behaviorConfig?: BehaviorConfig; onOpenChange: (open: boolean) => void; onEdit?: (trade: any) => void }) {
  const [viewedTrade, setViewedTrade] = useState<any>(null);
  const open = Boolean(day && summary && summary.count > 0);
  useEffect(() => { if (!open) setViewedTrade(null); }, [open]);
  // Testing Mode renders results in pips. The summary numbers are unit-
  // agnostic ($ Live, pips Testing); only the formatting branches.
  const isPips = mode.pnlUnit === "pips";
  const unitMoney = (value: number | string | null | undefined) =>
    isPips ? formatPips(toNumber(value)) : formatMoney(value);
  // A trade row's result in Testing is pips derived from entry/exit.
  const rowPips = (trade: DayTrade): number | null =>
    tradePips({ direction: trade?.direction, entryPrice: trade?.entryPrice as number | string | null, exitPrice: (trade as any)?.exitPrice as number | string | null });
  // Chronological order keeps a day readable even when the journal arrives newest-first.
  const rows = useMemo(() => [...(summary?.trades ?? [])].sort((a: DayTrade, b: DayTrade) => new Date(a.tradeDate).getTime() - new Date(b.tradeDate).getTime()), [summary]);
  // Read-only behavioural review of the same day: execution, psychology, and classification.
  // Every figure comes from the trades already loaded in the browser plus the saved plan.
  const review = useMemo(() => (day ? buildDayBehaviorReview(day, summary?.trades ?? [], plans, behaviorConfig) : null), [day, summary, plans, behaviorConfig]);
  if (!day || !summary) return null;
  const { tone, pnl, count, wins, losses, breakEven, open: openCount, openPnl, winRate, totalRisk, totalReward, riskTrades, rewardTrades, averagePnl, averageR } = summary;
  const trend = tone === "positive" ? <ArrowUpRight size={16} /> : tone === "negative" ? <ArrowDownRight size={16} /> : <Minus size={16} />;
  // Average patience score for this day, when the trader rated it.
  const patienceValues = rows.map((trade: DayTrade) => Number(trade.patienceScore)).filter((value: number) => Number.isFinite(value) && value > 0);
  const patienceAverage = patienceValues.length ? patienceValues.reduce((sum: number, value: number) => sum + value, 0) / patienceValues.length : null;
  return <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`day-trades-dialog ${tone}`}>
        <DialogHeader className="day-dialog-head">
          <span className="eyebrow">DAILY PERFORMANCE</span>
          <DialogTitle>{formatDayLabel(day)}</DialogTitle>
          <DialogDescription>{count} trade{count === 1 ? "" : "s"} recorded on this Pakistan-time trading day · {PKT_TIME_ZONE}</DialogDescription>
        </DialogHeader>
        <section className={`day-dialog-total ${tone}`}>
          <div><span>{isPips ? "Daily pips" : "Daily P&L"}</span><strong className={`data-text ${tone}`}>{unitMoney(pnl)}</strong></div>
          <div><span>Trades</span><strong className="data-text">{count}</strong></div>
          <div><span>Wins</span><strong className="data-text positive">{wins}</strong></div>
          <div><span>Losses</span><strong className="data-text negative">{losses}</strong></div>
          <div><span>Win rate</span><strong className="data-text">{winRate.toFixed(0)}%</strong></div>
          {breakEven > 0 && <div><span>Break-even</span><strong className="data-text">{breakEven}</strong></div>}
          {openCount > 0 && <div><span>Open</span><strong className="data-text">{openCount}</strong></div>}
        </section>
        <section className="day-dialog-metrics">
          {riskTrades > 0 && <span>Total risk <b className="data-text">{formatMoney(totalRisk)}</b></span>}
          {rewardTrades > 0 && <span>Total reward <b className="data-text">{formatMoney(totalReward)}</b></span>}
          {averageR !== null && !isPips && <span>Average R <b className="data-text">1 : {averageR.toFixed(2)}</b></span>}
          <span>{isPips ? "Average pips" : "Average trade"} <b className={`data-text ${averagePnl >= 0 ? "positive" : "negative"}`}>{unitMoney(averagePnl)}</b></span>
          {openCount > 0 && <span>Unrealized <b className={`data-text ${openPnl >= 0 ? "positive" : "negative"}`}>{unitMoney(openPnl)}</b></span>}
        </section>
        {review && <section className="day-behavior">
          <div className="day-behavior-grid">
            <div className={`day-behavior-card ${review.session.planAdherence.adherence != null && review.session.planAdherence.adherence >= 80 ? "safe" : "risk"}`}>
              <header><span>EXECUTION RESULT</span><Target size={14} /></header>
              <ul>
                <li><span>Plan adherence</span><b>{review.session.planAdherence.adherence == null ? "Not evaluated" : `${review.session.planAdherence.adherence.toFixed(0)}%`}</b></li>
                <li><span>Discipline score</span><b>{review.session.discipline == null ? "Not evaluated" : `${review.session.discipline.toFixed(0)} / 100`}</b></li>
                <li><span>Rule violations</span><b>{review.violations.length}</b></li>
                <li><span>Unplanned trades</span><b>{review.unplannedTrades}</b></li>
                <li><span>Pre-trade gate</span><b>{review.gateAverage == null ? "Not evaluated" : `${review.gateAverage}%`}</b></li>
              </ul>
            </div>
            {mode.showPsychology && (
              <div className="day-behavior-card">
                <header><span>PSYCHOLOGY</span><Brain size={14} /></header>
                <ul>
                  <li><span>Dominant emotion</span><b>{review.dominantEmotion ?? "Not recorded"}</b></li>
                  <li><span>Pre-session state</span><b>{review.emotionalState ?? "Not recorded"}</b></li>
                  <li><span>Behavioural objective</span><b>{review.behavioralFocus ?? "Not set"}</b></li>
                  <li><span>FOMO</span><b>{review.tags.includes("FOMO") ? "Tagged" : "None tagged"}</b></li>
                  <li><span>Revenge</span><b>{review.tags.includes("REVENGE") ? "Tagged" : "None tagged"}</b></li>
                  <li><span>Overconfidence</span><b>{review.tags.includes("OVERCONFIDENCE") ? "Tagged" : "None tagged"}</b></li>
                  <li><span>Patience average</span><b>{patienceAverage == null ? "Not rated" : `${patienceAverage.toFixed(1)} / 5`}</b></li>
                </ul>
              </div>
            )}
            <div className="day-behavior-card">
              <header><span>TRADE CLASSIFICATION</span><ClipboardCheck size={14} /></header>
              <ul>
                {(Object.keys(review.classifications) as (keyof typeof review.classifications)[]).filter(key => (review.classifications[key] ?? 0) > 0).map(key => <li key={key}><span><span className={`day-class-chip ${key === "GOOD_WIN" || key === "GOOD_LOSS" ? "safe" : "risk"}`}>{TRADE_CLASSIFICATION_LABELS[key]}</span></span><b className="data-text">{review.classifications[key]}</b></li>)}
              </ul>
            </div>
          </div>
          <p className="day-behavior-lesson"><b>Lesson: </b>{review.lesson || review.reviewed ? review.lesson || "No written lesson was saved for this session." : "No session review was saved for this day, so this is an execution-only read."}</p>
          {review.duplicateWarnings.length > 0 && <p className="day-behavior-lesson">{review.duplicateWarnings.join(" ")}</p>}
        </section>}
        <section className="day-dialog-trades">
          <header><span>TRADES ON THIS DAY</span><small>{trend} {tone === "positive" ? "Profitable day" : tone === "negative" ? "Losing day" : "Flat day"}</small></header>
          <ul className="day-trade-list">
            {rows.map((trade: DayTrade, index: number) => {
              const result = String(trade.result || "OPEN");
              // Testing rows render derived pips; Live rows render the $ P&L.
              // A null P&L is unknown, never $0.00: the numeric is only for
              // tone, the raw value goes to the formatter (which renders "—").
              const pips = isPips ? rowPips(trade) : null;
              const tradePnl = isPips ? (pips ?? 0) : toNumber(trade.pnl);
              const tradePnlDisplay = isPips ? pips : trade.pnl;
              const clock = formatClock(trade.tradeDate);
              const symbol = trade.symbol ? String(trade.symbol) : "";
              const ticket = trade.mt5Ticket ? String(trade.mt5Ticket) : "";
              const context = [trade.session, clock].filter(Boolean).join(" · ");
              const meta = [symbol, ticket ? `MT5 #${ticket}` : ""].filter(Boolean).join(" · ");
              const risk = toNumber(trade.risk);
              const subLabel = result === "OPEN" ? "unrealized" : risk > 0 ? `risk ${formatMoney(risk)}` : "";
              return <li key={String(trade.id ?? index)} className="day-trade-row">
                <button type="button" className="day-trade-main" aria-label={`View ${result.replace("_", " ")} trade at ${clock || "an unrecorded time"}: ${isPips ? formatPips(pips) : formatMoney(tradePnlDisplay)}${result === "OPEN" ? " unrealized" : ""}`} onClick={() => setViewedTrade(trade)}>
                  <span className="day-trade-lead">
                    <span className={`side-badge ${String(trade.direction || "").toLowerCase()}`}>{trade.direction || "—"}</span>
                    <span className={`result-badge ${result.toLowerCase()}`}>{result.replace("_", " ")}</span>
                  </span>
                  <span className="day-trade-body">
                    {context && <small>{context}</small>}
                    {meta && <small>{meta}</small>}
                    {trade.localPending && <small className="day-trade-flag">Pending sync</small>}
                  </span>
                  <span className={`day-trade-pnl data-text ${tradeTone(result, tradePnl)}`}>
                    <b>{isPips ? formatPips(pips) : formatMoney(tradePnlDisplay)}</b>
                    {subLabel && <em>{subLabel}</em>}
                    {risk > 0 && !isPips && <em>{formatActualR(trade.risk, trade.pnl)}</em>}
                  </span>
                </button>
                {onEdit && <Button variant="outline" size="sm" className="day-trade-edit" aria-label={`Edit ${result.replace("_", " ")} trade`} onClick={() => onEdit(trade)}><Pencil size={14} /> Edit</Button>}
              </li>;
            })}
          </ul>
        </section>
        <p className="day-dialog-note"><Rows3 size={13} /> Read-only drill-down of the trades already loaded in this browser. Local, unsynced trades stay listed until they sync.</p>
      </DialogContent>
    </Dialog>
    <TradeDetailDialog mode={mode} trade={viewedTrade} open={Boolean(viewedTrade)} onOpenChange={(next: boolean) => !next && setViewedTrade(null)} />
  </>;
}
