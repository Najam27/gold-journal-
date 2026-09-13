import React, { useState } from "react";
import { Activity, CircleDollarSign, Download, Eye, FileSpreadsheet, FileText, ImageDown, Plus, RefreshCcw, Settings2, Share2, ShieldAlert, Trash2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { TradeDetailDialog } from "@/components/TradeDetailDialog";
import { formatActualR, formatDate, formatMoney, formatRr, results, toNumber } from "@/lib/gold";
import { buildRunningBalances } from "@/lib/tradeLedger";
import { copyTradeCardPng, createTradeCardPng, downloadTradeCardPng, shareTradeCardPng } from "@/lib/tradeCardPng";
import { toast } from "sonner";

function StatCard({ label, value, detail, tone = "gold" }: { label: string; value: React.ReactNode; detail: string; tone?: string }) {
  return <div className={`stat-card stat-${tone}`}><p>{label}</p><strong className="data-text">{value}</strong><span>{detail}</span></div>;
}
function EmptyState({ title, copy, action }: { title: string; copy: string; action?: React.ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3><p>{copy}</p>{action}</div>;
}

function BaseTradeLogWithViewer({ stats, trades, allTrades, pagination, listLoading, listError, onRetry, account, dangerGoals, mt5LivePositions = [], mt5Summary, mt5Syncing = false, hasMt5Connection = false, search, resultFilter, setSearch, setResultFilter, onPage, onNew, onDuplicate, onEdit, onDelete, onCash, onCsv, onExcel, onPdf, onClear }: any) {
  const [viewedTrade, setViewedTrade] = useState<any>();
  const [exportingTradeId, setExportingTradeId] = useState<number | string | null>(null);
  const openingBalance = stats.balance - allTrades.reduce((sum: number, trade: any) => sum + toNumber(trade.pnl), 0);
  const balanceById = new Map(buildRunningBalances(allTrades, openingBalance).map(row => [row.id, row.runningBalance]));
  const page = pagination?.page ?? 1;
  const pageSize = pagination?.pageSize ?? 12;
  const total = pagination?.total ?? 0;
  const pageCount = pagination?.pageCount ?? 1;
  const brokerMetric = (value: unknown) => value == null ? "—" : formatMoney(value as string | number);
  const linkedBrokerBalance = hasMt5Connection ? (mt5Summary?.balance ?? null) : null;
  const balanceForTrade = (trade: any) => hasMt5Connection ? linkedBrokerBalance : (balanceById.get(trade.id) || 0);
  const exportTrade = async (trade: any, action: "download" | "share") => {
    setExportingTradeId(trade.id);
    try {
      const image = await createTradeCardPng(trade);
      if (action === "download") { downloadTradeCardPng(image.blob, image.filename); toast.success("Trade card PNG downloaded."); return; }
      const copied = await copyTradeCardPng(image.blob);
      if (copied) { toast.success("Trade card image copied. Paste it anywhere you want to share it."); return; }
      const shared = await shareTradeCardPng(image.blob, image.filename);
      if (shared) toast.success("Trade card ready to share.");
      else { downloadTradeCardPng(image.blob, image.filename); toast.success("Image copy and sharing are unavailable here, so the PNG was downloaded."); }
    } catch (error: any) {
      if (error?.name !== "AbortError") toast.error(error?.message || "Trade card could not be exported.");
    } finally { setExportingTradeId(null); }
  };
  return <>
    <section className="trade-header"><div className="trade-title"><span className="eyebrow">{account?.name || "Loading account"}</span><h2>Execution, not memory.</h2><p>Every record is private to your account and updates across connected devices.</p></div><div className="header-actions">{!hasMt5Connection && <><Button variant="outline" onClick={() => onCash("DEPOSIT")}><CircleDollarSign size={15} /> Deposit</Button><Button variant="outline" onClick={() => onCash("WITHDRAW")}><Wallet size={15} /> Withdraw</Button></>}<Button variant="outline" onClick={onDuplicate} disabled={!allTrades[0]}><RefreshCcw size={15} /> Duplicate last</Button><Button variant="outline" onClick={onPdf}><FileText size={15} /> PDF</Button><Button onClick={onNew}><Plus size={16} /> New Trade</Button></div></section>
    <section className="stats-grid">{mt5Summary?.balance != null ? <><StatCard label="MT5 balance" value={<AnimatedNumber value={toNumber(mt5Summary.balance)} format={formatMoney} />} detail={mt5Summary.currency || "Broker account"} /><StatCard label="MT5 equity" value={<AnimatedNumber value={toNumber(mt5Summary.equity)} format={formatMoney} />} detail="Balance + floating P&L" tone="neutral" /><StatCard label="MT5 floating P&L" value={<AnimatedNumber value={toNumber(mt5Summary.floatingPnl)} format={formatMoney} />} detail={mt5Syncing ? "Synchronizing Trade Log…" : "Live broker value"} tone={toNumber(mt5Summary.floatingPnl) >= 0 ? "green" : "red"} /></> : <StatCard label="Journal balance" value={<AnimatedNumber value={stats.balance} format={formatMoney} />} detail="Starting balance + movements + P&L" />}<StatCard label="Win rate" value={`${stats.winRate.toFixed(1)}%`} detail={`${stats.wins} wins · ${stats.losses} losses`} tone={stats.winRate >= 50 ? "green" : "neutral"} /><StatCard label="Total P&L" value={<AnimatedNumber value={stats.pnl} format={formatMoney} />} detail="Closed and open MT5 positions" tone={stats.pnl >= 0 ? "green" : "red"} /><StatCard label="Total trades" value={String(stats.total)} detail={hasMt5Connection ? "MT5 + journal history" : "Current account history"} tone="neutral" /></section>
    {hasMt5Connection && mt5LivePositions.length > 0 && <section className="mt5-live-strip"><header><span><Activity size={14} /> MT5 LIVE POSITIONS</span><small>Logged automatically · updates with MT5</small></header><div>{mt5LivePositions.map((position: any) => <article key={position.ticket} className={toNumber(position.floatingPnl) >= 0 ? "profit" : "loss"}><strong>{position.symbol}</strong><span className={`side-badge ${position.direction.toLowerCase()}`}>{position.direction}</span><b className={`data-text ${toNumber(position.floatingPnl) >= 0 ? "positive" : "negative"}`}>{formatMoney(position.floatingPnl)}</b></article>)}</div></section>}
    {dangerGoals.length > 0 && <section className="goal-alert-strip"><ShieldAlert size={17} /><div><strong>{dangerGoals.some((entry: any) => entry.status === "BREACHED") ? "Goal breached" : "Goal at risk"}</strong><span>{dangerGoals.slice(0, 2).map((entry: any) => `${entry.goal.name}: ${entry.status === "BREACHED" ? "threshold breached" : "near threshold"} (${entry.current} / ${entry.targetLabel}).`).join(" · ")}</span></div></section>}
    <section className="panel trade-panel"><div className="toolbar"><div className="search-field"><Activity size={16} /><Input placeholder="Search session, level, note…" value={search} onChange={event => setSearch(event.target.value)} /></div><select value={resultFilter} onChange={event => setResultFilter(event.target.value)}><option value="ALL">All results</option>{results.map(result => <option key={result} value={result}>{result.replace("_", " ")}</option>)}</select><div className="toolbar-push"><Button variant="outline" onClick={onCsv}><Download size={14} /> CSV</Button><Button variant="outline" onClick={onExcel}><FileSpreadsheet size={14} /> Excel</Button><Button variant="outline" className="danger-button" onClick={onClear}><Trash2 size={14} /> Clear all</Button></div></div>
      {listError ? <div className="empty-state"><h3>Trade list needs attention.</h3><Button onClick={onRetry}>Try again</Button></div> : listLoading && !trades.length ? <div className="page-loader"><div /><span>Loading your secure trade log…</span></div> : trades.length ? <><div className="trade-table-wrap"><table className="trade-table"><thead><tr><th>#</th><th>Date</th><th>Session</th><th>Side</th><th>Bias</th><th>Level</th><th>Setup</th><th>Execution</th><th>Planned risk</th><th>Planned R:R</th><th>Result</th><th>Actual P&amp;L</th><th>Actual R</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{trades.map((trade: any, index: number) => { const result = String(trade.result || "OPEN"); return <tr key={trade.id}><td className="muted">{total - ((page - 1) * pageSize + index)}</td><td className="data-text">{formatDate(trade.tradeDate)}</td><td>{trade.session}</td><td><span className={`side-badge ${String(trade.direction || "").toLowerCase()}`}>{trade.direction}</span></td><td><span className="context-pill">{trade.biasAlignment || "—"}</span></td><td>{trade.level || "—"}</td><td>{trade.setupQuality || "—"}</td><td>{trade.executionType || "—"}</td><td className="data-text">{formatMoney(trade.risk)}</td><td className="data-text">{formatRr(trade.risk, trade.reward)}</td><td><span className={`result-badge ${result.toLowerCase()}`}>{result.replace("_", " ")}</span></td><td className={`data-text pnl ${toNumber(trade.pnl) >= 0 ? "positive" : "negative"}`}><AnimatedNumber value={toNumber(trade.pnl)} format={formatMoney} /></td><td className={`data-text ${toNumber(trade.pnl) >= 0 ? "positive" : "negative"}`}>{formatActualR(trade.risk, trade.pnl)}</td><td><div className="row-actions"><button title="View trade" aria-label={`View trade from ${formatDate(trade.tradeDate)}`} onClick={() => setViewedTrade(trade)}><Eye size={16} /></button><button title="Download trade card PNG" aria-label={`Download trade card PNG from ${formatDate(trade.tradeDate)}`} disabled={exportingTradeId === trade.id} onClick={() => void exportTrade(trade, "download")}><ImageDown size={16} /></button><button title="Share trade card" aria-label={`Share trade card from ${formatDate(trade.tradeDate)}`} disabled={exportingTradeId === trade.id} onClick={() => void exportTrade(trade, "share")}><Share2 size={16} /></button><button title="Edit trade" aria-label={`Edit trade from ${formatDate(trade.tradeDate)}`} onClick={() => onEdit(trade)}><Settings2 size={16} /></button><button title="Delete trade" aria-label={`Delete trade from ${formatDate(trade.tradeDate)}`} onClick={() => onDelete(trade.id)}><Trash2 size={16} /></button></div></td></tr>; })}</tbody></table></div>{pageCount > 1 && <div className="table-pagination"><span>Page {page} of {pageCount} · {total} trades</span><div><Button variant="outline" size="sm" disabled={page === 1 || listLoading} onClick={() => onPage(page - 1)}>Previous</Button><Button variant="outline" size="sm" disabled={page === pageCount || listLoading} onClick={() => onPage(page + 1)}>Next</Button></div></div>}</> : <EmptyState title={search || resultFilter !== "ALL" ? "No trades match this filter." : "Your trade log is ready."} copy={search || resultFilter !== "ALL" ? "Clear or adjust the filters to see another part of your journal." : "MT5 history and live positions will be logged automatically once the terminal sends them."} action={!search && resultFilter === "ALL" ? <Button onClick={onNew}><Plus size={16} /> Log first trade</Button> : undefined} />}
    </section>
    <TradeDetailDialog trade={viewedTrade} balance={balanceForTrade(viewedTrade || {})} balanceLabel={hasMt5Connection ? "Current MT5 balance" : "Running balance"} open={Boolean(viewedTrade)} onOpenChange={(open: boolean) => !open && setViewedTrade(undefined)} />
  </>;
}

export function TradeLogWithViewer(props: any) { return <BaseTradeLogWithViewer {...props} />; }
