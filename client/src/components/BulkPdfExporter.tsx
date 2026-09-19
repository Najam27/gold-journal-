import React, { useEffect, useMemo, useState } from "react";
import { CalendarRange, FileDown, Image as ImageIcon } from "lucide-react";
import { jsPDF } from "jspdf";
import { useAuth } from "@/_core/hooks/useAuth";
import { getSelectedAccountId, subscribeSelectedAccount } from "@/lib/accountSelection";
import { fetchAllTradePages, selectBulkPdfTrades, summarizeBulkPdfTrades } from "@/lib/bulkPdf";
import { formatMoney, getPktDateInput, toNumber } from "@/lib/gold";
import { buildRunningBalances } from "@/lib/tradeLedger";
import { renderTradeLogPdf } from "@/lib/tradePdfReport";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

function dateInput(value: number | Date) { return getPktDateInput(value); }

/**
 * Whole-log PDF export.
 *
 * The document is rendered from `buildTradePdfModel` (the canonical complete
 * Trade Card model the viewer uses), not from a hand-picked field list, so every
 * recorded field of every selected trade reaches the file. Trade pages are
 * paginated, screenshots are embedded with their real format, and long notes or
 * emotions wrap instead of being truncated.
 */
export function BulkPdfExporter() {
  const { isAuthenticated, profileReady } = useAuth();
  const privateReady = profileReady ?? isAuthenticated;
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState<number | undefined>(() => getSelectedAccountId());
  const journal = trpc.journal.get.useQuery({ accountId }, { enabled: Boolean(privateReady && accountId), retry: false, refetchOnWindowFocus: false });
  const [allTime, setAllTime] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeSelectedAccount(setAccountId), []);
  useEffect(() => { const openExporter = () => setOpen(true); window.addEventListener("gold-journal:bulk-pdf", openExporter); return () => window.removeEventListener("gold-journal:bulk-pdf", openExporter); }, []);
  const account = journal.data?.activeAccount;
  const trades = journal.data?.trades ?? [];
  const selected = useMemo(() => account ? selectBulkPdfTrades(trades, account.id, allTime ? undefined : from, allTime ? undefined : to) : [], [trades, account?.id, allTime, from, to]);
  const summary = useMemo(() => summarizeBulkPdfTrades(selected), [selected]);
  const earliest = trades.length ? dateInput(trades.reduce((oldest: any, trade: any) => new Date(trade.tradeDate) < new Date(oldest.tradeDate) ? trade : oldest).tradeDate) : "";
  const latest = trades.length ? dateInput(trades.reduce((newest: any, trade: any) => new Date(trade.tradeDate) > new Date(newest.tradeDate) ? trade : newest).tradeDate) : "";
  const setCustom = () => { setAllTime(false); setFrom(value => value || earliest); setTo(value => value || latest); };

  const createPdf = async () => {
    if (!account) { toast.error("Choose a trading account before creating a report."); return; }
    setBusy(true);
    // Stable snapshot: the export keeps using the account, range, and opening
    // balance that were selected when the button was pressed, even if the trader
    // switches accounts while the remaining pages are still downloading.
    const snapshot = {
      accountId: account.id,
      accountName: account.name,
      openingBalance: toNumber(account.startingBalance) + toNumber(journal.data?.cashNet),
      allTime,
      from,
      to,
    };
    try {
      const reportTrades: any[] = await fetchAllTradePages(page => utils.trades.list.fetch({ accountId: snapshot.accountId, page, pageSize: 50, search: "" }));
      // Running balance is derived over the account's full ledger, so the figure
      // matches the Trade Log; the export range is then selected from that ledger.
      const ledger = buildRunningBalances(reportTrades, snapshot.openingBalance) as any[];
      const balanceById = new Map<number, number>(ledger.map(row => [row.id, row.runningBalance]));
      const reportSelected = selectBulkPdfTrades(ledger, snapshot.accountId, snapshot.allTime ? undefined : snapshot.from || undefined, snapshot.allTime ? undefined : snapshot.to || undefined);
      const reportSummary = summarizeBulkPdfTrades(reportSelected);
      if (!reportSelected.length) { toast.error("No trades match this export range."); return; }
      const dates = reportSelected.map((trade: any) => dateInput(trade.tradeDate)).sort();
      const rangeLabel = snapshot.allTime ? `${dates[0]} to ${dates[dates.length - 1]}` : `${snapshot.from || dates[0]} to ${snapshot.to || dates[dates.length - 1]}`;
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      await renderTradeLogPdf(pdf, {
        accountName: snapshot.accountName,
        rangeLabel,
        mode: snapshot.allTime ? "ALL_TIME" : "RANGE",
        summary: reportSummary,
        trades: reportSelected.map((trade: any) => ({ trade, runningBalance: balanceById.get(trade.id) ?? null })),
      });
      pdf.save(`GoldJournal_${snapshot.accountName.replace(/[^a-z0-9]+/gi, "-")}_${snapshot.allTime ? "Full-Log" : `${snapshot.from}_to_${snapshot.to}`}.pdf`);
      toast.success(`Complete trade-log PDF downloaded · ${reportSummary.total} trade${reportSummary.total === 1 ? "" : "s"}.`);
      setOpen(false);
    } catch (error: any) { toast.error(error.message || "The PDF report could not be generated."); } finally { setBusy(false); }
  };

  if (!isAuthenticated) return null;
  return <Dialog open={open} onOpenChange={setOpen}><DialogContent className="bulk-pdf-dialog"><DialogHeader><DialogTitle>Complete trade-log PDF</DialogTitle><DialogDescription>Download every selected trade as a complete trade card — all recorded fields, notes, emotions, checklist, and screenshot evidence — plus the period analysis and a P&amp;L calendar. The report contains only the active account.</DialogDescription></DialogHeader><div className="pdf-range-mode"><button className={allTime ? "active" : ""} onClick={() => setAllTime(true)}>Whole trade log</button><button className={!allTime ? "active" : ""} onClick={setCustom}><CalendarRange size={14} /> Custom date range</button></div>{!allTime && <div className="pdf-date-range"><label>From<Input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>To<Input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></div>}<div className="pdf-selection-summary"><span><b>{selected.length}</b> recent preview trade{selected.length === 1 ? "" : "s"}</span><span>Recent P&L <b className={summary.pnl >= 0 ? "positive" : "negative"}>{formatMoney(summary.pnl)}</b></span></div><div className="pdf-export-includes"><ImageIcon size={15} /><span>The report fetches every page only when you download it. Every selected trade becomes a complete trade card across as many pages as it needs, with available screenshot evidence attached, followed by analysis and daily P&amp;L calendar pages.</span></div><div className="dialog-actions"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || !account} onClick={createPdf}><FileDown size={15} />{busy ? "Building report…" : "Download complete PDF"}</Button></div></DialogContent></Dialog>;
}
