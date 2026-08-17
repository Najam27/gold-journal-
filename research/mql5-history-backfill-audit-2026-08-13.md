# MQL5 Historical Backfill Audit — 2026-08-13

The official MQL5 reference confirms that `HistorySelect(from, to)` creates the currently available deal and order lists, while `HistorySelectByPosition(position_id)` replaces that selection with deals and orders for one position. `HistoryDealGetTicket(index)` enumerates only the active selection. A position identifier (`DEAL_POSITION_ID`) is shared by all deals in that position lifecycle, whereas deal tickets identify individual fills.[1][2][3][4]

The previous EA loop mixed global deal-index traversal with `HistorySelectByPosition` inside the per-deal serializer. Although it attempted to restore the global selection, this design is fragile and emits one record per closing deal rather than one stable record per position. It also makes partial exits and multi-fill positions vulnerable to incomplete historical delivery.

The repair will first build a unique list of closed-position identifiers from the selected history, then select and summarize each position independently before batching. The position identifier becomes the stable deduplication key sent to Gold Journal. The final payload will aggregate realized P&L across the position’s exit deals, retain the opening-side and opening timestamp, and use the latest exit timestamp and price.

## References

[1]: https://www.mql5.com/en/docs/trading/historyselect "MQL5 Reference — HistorySelect"
[2]: https://www.mql5.com/en/docs/trading/historyselectbyposition "MQL5 Reference — HistorySelectByPosition"
[3]: https://www.mql5.com/en/docs/constants/tradingconstants/dealproperties "MQL5 Reference — Deal Properties"
[4]: https://www.mql5.com/en/docs/trading/historydealgetticket "MQL5 Reference — HistoryDealGetTicket"
