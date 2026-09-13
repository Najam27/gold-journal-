import React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatActualR, formatDate, formatMoney, formatRr, toNumber } from "@/lib/gold";

/**
 * The journal's single trade viewer. The Trade Log opens it from a table row and
 * the P&L calendar's daily drill-down opens the same dialog from a trade card,
 * so both entry points always show one identical viewer (and its fields) rather
 * than two parallel trade-detail implementations.
 */
function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="trade-detail"><span>{label}</span><strong>{value || "—"}</strong></div>;
}

export function TradeDetailDialog({ trade, balance, balanceLabel = "Running balance", open, onOpenChange }: any) {
  if (!trade) return null;
  const pnl = toNumber(trade.pnl);
  const result = String(trade.result || "OPEN").replace("_", " ");
  const ticket = trade.mt5Ticket ? String(trade.mt5Ticket) : "";
  const symbol = trade.symbol ? String(trade.symbol) : "";
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="trade-view-dialog"><DialogHeader><DialogTitle>Trade card</DialogTitle><DialogDescription>{formatDate(trade.tradeDate)} · {trade.session} · {trade.direction} · {result}</DialogDescription></DialogHeader><article className="trade-card-detail"><header><span className={`side-badge ${String(trade.direction || "").toLowerCase()}`}>{trade.direction}</span><span className={`result-badge ${String(trade.result || "OPEN").toLowerCase()}`}>{result}</span><b className={`data-text ${pnl >= 0 ? "positive" : "negative"}`}>{formatMoney(pnl)}</b></header><section className="trade-detail-grid"><Detail label="Trade date" value={formatDate(trade.tradeDate)} />{symbol && <Detail label="Symbol" value={symbol} />}{ticket && <Detail label="MT5 ticket" value={`#${ticket}`} />}<Detail label="Session" value={trade.session} /><Detail label="Direction" value={trade.direction} /><Detail label="Result" value={result} /><Detail label="Level" value={trade.level} /><Detail label="Timeframe" value={trade.timeframe} /><Detail label="Setup quality" value={trade.setupQuality} /><Detail label="Confirmation" value={trade.confirmationType} /><Detail label="Execution type" value={trade.executionType} /><Detail label="Market condition" value={trade.marketCondition} /><Detail label="Bias alignment" value={trade.biasAlignment} /><Detail label="SL placement" value={trade.slPlacement} /><Detail label="TP placement" value={trade.tpPlacement} /><Detail label="Mistake" value={trade.mistake} /><Detail label="Hold quality" value={trade.holdQuality} /><Detail label="Patience score" value={trade.patienceScore ? `${trade.patienceScore}/5` : "—"} /><Detail label="Planned risk" value={formatMoney(trade.risk)} /><Detail label="Planned reward" value={formatMoney(trade.reward)} /><Detail label="Planned R:R" value={formatRr(trade.risk, trade.reward)} /><Detail label="Actual P&L" value={formatMoney(trade.pnl)} /><Detail label="Actual R" value={formatActualR(trade.risk, trade.pnl)} /><Detail label={balanceLabel} value={balance == null ? "—" : formatMoney(balance)} /></section><section className="trade-notes"><div><span>EMOTION BEFORE</span><p>{trade.emotionBefore || "No entry recorded."}</p></div><div><span>EMOTION DURING</span><p>{trade.emotionDuring || "No entry recorded."}</p></div><div><span>EMOTION AFTER</span><p>{trade.emotionAfter || "No entry recorded."}</p></div><div><span>JOURNAL NOTES</span><p>{trade.notes || "No notes recorded."}</p></div></section>{trade.screenshotUrl && <section className="trade-evidence"><span>SCREENSHOT EVIDENCE</span><img src={trade.screenshotUrl} alt={`Trade screenshot from ${formatDate(trade.tradeDate)}`} /></section>}</article></DialogContent></Dialog>;
}
