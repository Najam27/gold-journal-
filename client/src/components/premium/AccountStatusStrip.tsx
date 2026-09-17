import React from "react";
import { Cloud, CloudOff, RefreshCcw } from "lucide-react";

type Mt5ConnectionHealth = {
  state?: string;
  label?: string;
  message?: string;
};

type Mt5ConnectionSignal = {
  active?: boolean;
  syncHealth?: Mt5ConnectionHealth | null;
};

/**
 * Terminal states where MT5 needs the trader to act (or is plainly not
 * talking to Gold Journal). They are reported in the "loss" tone so a dead
 * terminal can never be mistaken for a live one.
 */
const MT5_ATTENTION_STATES = new Set(["OFFLINE", "AUTH_ERROR", "CONFIG_ERROR", "MISSING"]);

/**
 * The Trade Log is a table view, so it only needs the account identity and
 * whether the links behind it are up — the balance/equity/P&L breakdown already
 * lives in the stat cards directly below and in full on MT5 Live.
 *
 * The MT5 signal comes from the server's `syncHealth` (fresh terminal contact
 * plus a current snapshot), NOT from the existence of a connection record: a
 * linked-but-offline terminal used to read as "MT5 connected" forever. Every
 * value is passed in from the existing journal/MT5 query layer; this component
 * derives nothing and invents no numbers.
 */
export function AccountStatusStrip({
  accountName,
  mt5Connection,
  online,
  syncing,
}: {
  accountName: string;
  mt5Connection?: Mt5ConnectionSignal | null;
  online: boolean;
  syncing: boolean;
}) {
  const health = mt5Connection?.syncHealth ?? undefined;
  const state = String(health?.state ?? "").toUpperCase();
  const linked = Boolean(mt5Connection);
  const connected = linked && state === "CONNECTED";
  const label = connected ? "MT5 connected" : health?.label || (linked ? "Waiting for MT5" : "MT5 not connected");
  const tone = connected ? "profit" : !linked || MT5_ATTENTION_STATES.has(state) ? "loss" : "warn";

  return (
    <section className="account-strip" aria-label={`${accountName} connection status`}>
      <div className="account-strip-id">
        <span>ACCOUNT</span>
        <strong>{accountName}</strong>
      </div>
      <div className="account-strip-signals">
        <span
          className={`connection-pill ${tone}`}
          title={connected ? health?.message : health?.message || "MT5 has not contacted Gold Journal yet."}
        >
          <i aria-hidden="true" />
          {label}
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
