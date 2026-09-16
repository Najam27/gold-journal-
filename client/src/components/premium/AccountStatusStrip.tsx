import { Cloud, CloudOff, RefreshCcw } from "lucide-react";

/**
 * The Trade Log is a table view, so it only needs the account identity and
 * whether the links behind it are up — the balance/equity/P&L breakdown already
 * lives in the stat cards directly below and in full on MT5 Live.
 *
 * Every value is passed in from the existing journal/MT5 query layer: this
 * component derives nothing and invents no numbers.
 */
export function AccountStatusStrip({
  accountName,
  mt5Connected,
  online,
  syncing,
}: {
  accountName: string;
  mt5Connected: boolean;
  online: boolean;
  syncing: boolean;
}) {
  return (
    <section className="account-strip" aria-label={`${accountName} connection status`}>
      <div className="account-strip-id">
        <span>ACCOUNT</span>
        <strong>{accountName}</strong>
      </div>
      <div className="account-strip-signals">
        <span className={`connection-pill ${mt5Connected ? "profit" : "loss"}`}>
          <i aria-hidden="true" />
          {mt5Connected ? "MT5 connected" : "MT5 not connected"}
        </span>
        <span className={`connection-pill ${online ? "live" : "warn"}`}>
          {online ? <Cloud size={13} /> : <CloudOff size={13} />}
          {online ? "Cloud synced" : "Offline — local data"}
        </span>
        {syncing && (
          <span className="connection-pill muted" role="status">
            <RefreshCcw size={13} /> Syncing
          </span>
        )}
      </div>
    </section>
  );
}
