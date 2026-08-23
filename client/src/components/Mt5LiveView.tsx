import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Check,
  ChevronDown,
  Copy,
  Download,
  Landmark,
  Link2,
  Plus,
  Radio,
  RefreshCcw,
  Trash2,
  WifiOff,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatMoney, formatRr, toNumber } from "@/lib/gold";
import { toast } from "sonner";

const EA_DOWNLOAD = "/api/mt5/ea";
const brokerOffsetOptions = Array.from(
  { length: 105 },
  (_, index) => -12 * 60 + index * 15
);
const formatBrokerOffset = (minutes: number) => {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
};
const pkt = (value?: string | Date | null) =>
  value
    ? new Date(value).toLocaleString("en-PK", {
        timeZone: "Asia/Karachi",
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
const masked = (key: string) =>
  key.length < 10 ? "••••••••" : `${key.slice(0, 4)}••••••••${key.slice(-3)}`;
const moneyOrDash = (value: string | number | null | undefined) =>
  value == null ? "—" : formatMoney(value);
function connectionState(connection: {
  active?: boolean;
  retiredAt?: string | Date | null;
  lastPing?: string | Date | null;
  syncHealth?: { state?: string; label?: string; message?: string };
}) {
  if (connection.retiredAt)
    return {
      label: "MT5 connection retired",
      tone: "offline",
      message: "This record was retained for account history. Issue a replacement key to resume live MT5 synchronization.",
    };
  if (connection.active === false)
    return {
      label: "MT5 connection paused",
      tone: "neutral",
      message: "Live terminal requests are paused until this connection is switched back on.",
    };
  const health = connection.syncHealth;
  if (health?.state)
    return {
      label: health.label || health.state,
      tone:
        health.state === "CONNECTED"
          ? "live"
          : health.state === "DEGRADED"
            ? "warning"
            : health.state === "STALE" || health.state === "OFFLINE"
              ? "offline"
              : "neutral",
      message: health.message || "",
    };
  if (!connection.lastPing)
    return {
      label: "Waiting for MT5",
      tone: "neutral",
      message:
        "Waiting for the first terminal contact. Confirm the read-only EA is attached, the exact origin is allowed in MT5 WebRequest settings, and the one-time API key matches this connection. Auto Trading may remain off.",
    };
  const elapsed = Date.now() - new Date(connection.lastPing).getTime();
  return elapsed <= 10_000
    ? {
        label: "MT5 connected",
        tone: "live",
        message: "Live contact received.",
      }
    : elapsed <= 60_000
      ? {
          label: "MT5 sync stale",
          tone: "warning",
          message: "Waiting for another terminal update.",
        }
      : {
          label: "MT5 offline",
          tone: "offline",
          message:
            "The connection record remains active while the terminal reconnects.",
        };
}
function CopyValue({ value, label }: { value: string; label: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Copy is unavailable in this browser.");
    }
  };
  return (
    <button
      className="mt5-copy"
      onClick={() => void copy()}
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
    >
      <Copy size={14} />
    </button>
  );
}

function AccountMetric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <article className={`mt5-account-metric ${tone}`}>
      <span>{label}</span>
      <strong className="data-text">{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function Mt5LiveView({ account, accounts, onJournalNow }: any) {
  const accountInput = useMemo(
    () => (account?.id ? { accountId: account.id } : undefined),
    [account?.id]
  );
  const [historyPage, setHistoryPage] = useState(1);
  useEffect(() => setHistoryPage(1), [account?.id]);
  const historyInput = useMemo(
    () =>
      account?.id
        ? { accountId: account.id, page: historyPage, pageSize: 20 }
        : undefined,
    [account?.id, historyPage]
  );
  const workspace = trpc.mt5.workspace.useQuery(accountInput!, {
    enabled: Boolean(accountInput),
    refetchInterval: 2_500,
    refetchOnWindowFocus: true,
  });
  const history = trpc.mt5.history.useQuery(historyInput!, {
    enabled: Boolean(historyInput),
    refetchInterval: 2_500,
    refetchOnWindowFocus: true,
  });
  const createConnection = trpc.mt5.createConnection.useMutation();
  const replaceConnection = trpc.mt5.replaceConnection.useMutation();
  const rotateConnectionKey = trpc.mt5.rotateConnectionKey.useMutation();
  const setActive = trpc.mt5.setConnectionActive.useMutation();
  const deleteConnection = trpc.mt5.deleteConnection.useMutation();
  const updateOffset = trpc.mt5.updateConnectionOffset.useMutation();
  const utils = trpc.useUtils();
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [linkAccountId, setLinkAccountId] = useState<number | undefined>(
    account?.id
  );
  const [brokerUtcOffsetMinutes, setBrokerUtcOffsetMinutes] = useState(180);
  const [newApiKey, setNewApiKey] = useState("");
  const [guideOpen, setGuideOpen] = useState(true);
  useEffect(() => {
    setLinkAccountId(account?.id);
  }, [account?.id]);
  const connections = workspace.data?.connections ?? [];
  const openPositions = workspace.data?.openPositions ?? [];
  const activeConnection = connections.find((connection: any) => connection.active && !connection.retiredAt);
  const positions = history.data?.positions ?? [];
  const historyTotal = history.data?.total;
  const recoveredMt5History =
    !activeConnection &&
    ((history.data?.total ?? 0) > 0 ||
      (workspace.data?.closedPositions?.length ?? 0) > 0);
  const availableAccounts = connections.length ? [] : [account].filter(Boolean);
  const serverUrl =
    typeof window === "undefined"
      ? "/api/mt5"
      : `${window.location.origin}/api/mt5`;
  const webRequestOrigin =
    typeof window === "undefined" ? "" : window.location.origin;
  const defaultConnectionLabel = `${account?.name || "MT5"} Live`;
  const refresh = () => {
    void utils.mt5.workspace.invalidate();
    void utils.mt5.history.invalidate();
  };
  const openAddConnection = () => {
    setLinkAccountId(account?.id);
    setLabel(value => value || defaultConnectionLabel);
    setAddOpen(true);
  };
  const saveConnection = async () => {
    if (!linkAccountId) return;
    try {
      const created = await createConnection.mutateAsync({
        accountId: linkAccountId,
        label: label.trim() || defaultConnectionLabel,
        brokerUtcOffsetMinutes,
      });
      setNewApiKey(created.apiKey);
      toast.success(
        "MT5 connection created. Copy the one-time key into the EA now."
      );
      setAddOpen(false);
      setLabel("");
      refresh();
    } catch (error: any) {
      toast.error(error.message || "Could not create MT5 connection.");
    }
  };
  const reconnectConnection = async () => {
    if (!account?.id || replaceConnection.isPending) return;
    try {
      const created = await replaceConnection.mutateAsync({
        accountId: account.id,
        label: defaultConnectionLabel,
        brokerUtcOffsetMinutes,
      });
      setNewApiKey(created.apiKey);
      toast.success(
        "Replacement MT5 key created. Copy it into the EA, then restart the EA once."
      );
      refresh();
    } catch (error: any) {
      toast.error(error.message || "Could not reconnect MT5 Live.");
    }
  };
  const rotateCurrentConnectionKey = async (connection: any) => {
    if (!account?.id || rotateConnectionKey.isPending) return;
    if (!window.confirm(`Issue a new API key for ${connection.label}? The old EA key stops working, but MT5 history and Trade Log records remain unchanged.`)) return;
    try {
      const rotated = await rotateConnectionKey.mutateAsync({
        accountId: account.id,
        connectionId: connection.id,
        confirmed: true,
      });
      setNewApiKey(rotated.apiKey);
      toast.success("New MT5 key issued. Paste it into the current EA download, then restart the EA.");
      refresh();
    } catch (error: any) {
      toast.error(error.message || "Could not issue a new MT5 key.");
    }
  };
  const healthPrefix =
    activeConnection?.syncHealth?.label || "MT5 status pending";
  const historyStatus = history.isError
    ? `History query failed: ${history.error?.message || "The server could not load MT5 history."}`
    : !activeConnection
      ? "Create a connection to begin sync."
      : activeConnection.lastHistoryStatus === "FAILED"
        ? `${healthPrefix} · History batch failed: ${activeConnection.lastHistoryMessage || "Check the EA log and connection."}`
        : activeConnection.lastHistorySync
          ? `${healthPrefix} · ${typeof historyTotal === "number" ? historyTotal : activeConnection.historySyncedCount} closed positions synced · ${pkt(activeConnection.lastHistorySync)} PKT`
          : activeConnection.lastHistoryAttempt
            ? `${healthPrefix} · ${activeConnection.lastHistoryMessage || "History batch received."} Waiting for completion.`
            : `${healthPrefix} · No historical batch has reached Gold Journal yet.`;
  return (
    <section className="mt5-live-view">
      <header className="section-heading mt5-heading">
        <div>
          <span className="eyebrow">DIRECT MT5 SYNC</span>
          <h2>MT5 Live</h2>
          <p>
            Live balances, equity, floating P&amp;L, open positions, and
            historical closes synchronize automatically into the linked Trade
            Log. The browser refreshes every 2.5 seconds; EA live updates run
            approximately every 3 seconds.
          </p>
        </div>
        {availableAccounts.length > 0 && (
          <Button onClick={openAddConnection}>
            <Plus size={16} /> Add connection
          </Button>
        )}
      </header>
      <section className="mt5-account-panel panel">
        <div className="mt5-section-head">
          <div>
            <span className="eyebrow">{account?.name || "ACTIVE ACCOUNT"}</span>
            <h3>MT5 account snapshot</h3>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void workspace.refetch();
              void history.refetch();
            }}
          >
            <RefreshCcw size={14} /> Refresh
          </Button>
        </div>
        {activeConnection?.balance == null ? (
          <div className="mt5-empty compact">
            <Landmark size={24} />
            <h3>
              {recoveredMt5History
                ? "MT5 history is present, but its connection is missing"
                : activeConnection?.syncHealth?.state === "DEGRADED"
                  ? "MT5 connected, but the live snapshot is not updating"
                  : "Waiting for MT5 account metrics"}
            </h3>
            <p>
              {recoveredMt5History
                ? "Your existing journaled MT5 trades are safe. Create a replacement connection below, download a fresh EA for this deployed site, copy its new key into the EA, then restart the EA once to restore live balance, equity, and margin updates."
                : activeConnection?.syncHealth?.message ||
                  "Download the EA from this page, then attach it to any chart. Its Experts tab first confirms this deployment endpoint, then balance, equity, free margin, and floating P&L appear after its next summary event."}
            </p>
          </div>
        ) : (
          <>
            <div className="mt5-account-grid">
              <AccountMetric
                label="Balance"
                value={moneyOrDash(activeConnection.balance)}
                detail={activeConnection.currency || "MT5 currency"}
                tone="gold"
              />
              <AccountMetric
                label="Equity"
                value={moneyOrDash(activeConnection.equity)}
                detail="Balance + floating P&L"
              />
              <AccountMetric
                label="Floating P&L"
                value={moneyOrDash(activeConnection.floatingPnl)}
                detail="Open position result"
                tone={
                  toNumber(activeConnection.floatingPnl) >= 0
                    ? "profit"
                    : "loss"
                }
              />
              <AccountMetric
                label="Free margin"
                value={moneyOrDash(activeConnection.freeMargin)}
                detail={`Margin ${moneyOrDash(activeConnection.margin)}`}
              />
            </div>
            <p className="mt5-account-detail">
              Login {activeConnection.mt5Login || "—"} ·{" "}
              {activeConnection.brokerServer || "MT5 terminal"} · Last snapshot{" "}
              {pkt(activeConnection.lastSummarySuccessAt)} PKT · Last terminal
              contact{" "}
              {pkt(activeConnection.lastContactAt || activeConnection.lastPing)}{" "}
              PKT
            </p>
            {activeConnection.syncHealth?.state !== "CONNECTED" && (
              <p className="mt5-health-detail" role="status">
                {activeConnection.syncHealth?.message}
              </p>
            )}
          </>
        )}
      </section>
      <section className="mt5-connection-section">
        <div className="mt5-section-head">
          <div>
            <span className="eyebrow">{account?.name || "ACTIVE ACCOUNT"}</span>
            <h3>MT5 connection</h3>
          </div>
          <span className="mt5-sync-indicator">
            <Activity size={14} />{" "}
            {workspace.isFetching ? "Refreshing…" : "Live refresh every 2.5s"}
          </span>
        </div>
        {connections.length ? (
          <div className="mt5-connection-grid">
            {connections.map((connection: any) => {
              const state = connectionState(connection);
              return (
                <article className="mt5-connection-card" key={connection.id}>
                  <header>
                    <div>
                      <span className={`mt5-status ${state.tone}`}>
                        <i /> {state.label}
                      </span>
                      <h4>{connection.label}</h4>
                      <small>{connection.accountName}</small>
                      {connection.connectionReference && <small>Connection ref {connection.connectionReference}</small>}
                    </div>
                    <label className="mt5-switch">
                      <input
                        type="checkbox"
                        checked={connection.active}
                        disabled={Boolean(connection.retiredAt)}
                        onChange={event =>
                          void setActive
                            .mutateAsync({
                              accountId: account.id,
                              connectionId: connection.id,
                              active: event.target.checked,
                            })
                            .then(refresh)
                            .catch((error: any) =>
                              toast.error(
                                error.message ||
                                  "Connection could not be updated."
                              )
                            )
                        }
                      />
                      <span />
                    </label>
                  </header>
                  <p className="mt5-health-detail" role="status">
                    {state.message}
                  </p>
                  {!connection.lastContactAt && !connection.lastPing && (
                    <div className="mt5-first-contact-recovery">
                      <strong>First-contact recovery</strong>
                      <p>
                        Download a fresh EA from this page, paste this connection&apos;s current API key, then remove and reattach the EA. The Experts tab prints an authenticated connection reference; it must match the reference shown on this card. If it differs, the EA key belongs to another account connection. If the original one-time key is unavailable, issue a replacement below; history remains unchanged.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rotateConnectionKey.isPending}
                        onClick={() => void rotateCurrentConnectionKey(connection)}
                      >
                        <RefreshCcw size={14} /> {rotateConnectionKey.isPending ? "Issuing…" : "Issue new API key"}
                      </Button>
                    </div>
                  )}
                  {connection.retiredAt && (
                    <div className="mt5-first-contact-recovery">
                      <strong>Retired connection recovery</strong>
                      <p>
                        This connection record and its MT5 history remain safely attached to this account. Issue a new key to reactivate the same account-scoped record; no trades are deleted.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={replaceConnection.isPending}
                        onClick={() => void reconnectConnection()}
                      >
                        <RefreshCcw size={14} /> {replaceConnection.isPending ? "Generating…" : "Issue replacement key"}
                      </Button>
                    </div>
                  )}
                  <div className="mt5-secret-row">
                    <span>SERVER URL</span>
                    <code>{serverUrl}</code>
                    <CopyValue value={serverUrl} label="Server URL" />
                  </div>
                  <label className="mt5-offset-field">
                    Broker server time
                    <select
                      aria-label={`Broker UTC offset for ${connection.label}`}
                      value={connection.brokerUtcOffsetMinutes ?? 180}
                      onChange={event =>
                        void updateOffset
                          .mutateAsync({
                            accountId: account.id,
                            connectionId: connection.id,
                            brokerUtcOffsetMinutes: Number(event.target.value),
                          })
                          .then(() => {
                            toast.success("Broker UTC offset updated.");
                            refresh();
                          })
                          .catch((error: any) =>
                            toast.error(
                              error.message ||
                                "Broker UTC offset could not be updated."
                            )
                          )
                      }
                    >
                      {brokerOffsetOptions.map(offset => (
                        <option value={offset} key={offset}>
                          {formatBrokerOffset(offset)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <footer>
                    <small>
                      {connection.lastContactAt || connection.lastPing
                        ? `Last contact ${pkt(connection.lastContactAt || connection.lastPing)} PKT · Last snapshot ${pkt(connection.lastSummarySuccessAt)} PKT`
                        : "Waiting for the first EA ping."}
                    </small>
                    <button
                      className="text-danger"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Retire ${connection.label}? Its current API key will stop working, but the account-scoped connection record, MT5 history, and Trade Log records will remain. You can issue a replacement key later.`
                          )
                        )
                          return;
                        void deleteConnection
                          .mutateAsync({
                            accountId: account.id,
                            connectionId: connection.id,
                            confirmed: true,
                          })
                          .then(() => {
                            toast.success("MT5 connection retired. Its history and record remain available for recovery.");
                            refresh();
                          })
                          .catch((error: any) =>
                            toast.error(
                              error.message || "Could not retire connection."
                            )
                          );
                      }}
                    >
                      <Trash2 size={14} /> Retire
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt5-empty">
            <Link2 size={28} />
            <h3>
              {recoveredMt5History
                ? "Reconnect MT5 Live"
                : "No MT5 connection yet"}
            </h3>
            <p>
              {recoveredMt5History
                ? "Trade history was received for this account, but the private connection record is unavailable. If Experts shows API authentication and sync success while this panel remains empty, that EA key belongs to a different Gold Journal account. Generate this account’s replacement key now; current journaled trades stay unchanged."
                : "Create one for this selected Gold Journal account, then copy its key into the Expert Advisor."}
            </p>
            <Button
              onClick={
                recoveredMt5History
                  ? () => void reconnectConnection()
                  : openAddConnection
              }
              disabled={!account?.id || replaceConnection.isPending}
            >
              <Plus size={16} />{" "}
              {replaceConnection.isPending
                ? "Generating…"
                : recoveredMt5History
                  ? `Reconnect ${account?.name || "this account"}`
                  : `Add connection for ${account?.name || "this account"}`}
            </Button>
          </div>
        )}
      </section>
      <section className={`mt5-guide panel ${guideOpen ? "open" : ""}`}>
        <button
          className="mt5-guide-toggle"
          onClick={() => setGuideOpen(!guideOpen)}
        >
          <div>
            <span className="eyebrow">SETUP GUIDE · READ-ONLY JOURNAL BRIDGE</span>
            <h3>How to connect MT5 and backfill history</h3>
          </div>
          <ChevronDown size={18} />
        </button>
        {guideOpen && (
          <ol>
            <li>
              <div>
                <strong>Replace the earlier EA build</strong>
                <p>
                  Gold Journal EA is read-only: it never opens, closes, modifies, or cancels trades. Download a fresh EA from this page. Its endpoint is generated from this deployed site, it writes a startup confirmation in the MT5 Experts tab, then sends the first compatibility heartbeat, balance, equity, floating P&amp;L,
                  and live positions approximately every 3 seconds, plus history
                  and close events using an explicit broker UTC offset whenever
                  available. Transient server errors now retry with bounded
                  backoff.
                </p>
              </div>
              <a
                className="button-link"
                href={EA_DOWNLOAD}
                download="GoldJournal_EA.mq5"
              >
                <Download size={15} /> Download current EA
              </a>
            </li>
            <li>
              <div>
                <strong>Install in MT5</strong>
                <p>
                  Copy it to{" "}
                  <code>
                    C:\Users\[YourName]\AppData\Roaming\MetaQuotes\Terminal\[ID]\MQL5\Experts\
                  </code>
                  . In MT5, open Navigator → Expert Advisors, right-click, then
                  Refresh. Configure only the generated endpoint and matching API key; do not add a Connection ID. Auto Trading/Algo Trading may remain off because this EA does not execute trades.
                </p>
              </div>
            </li>
            <li>
              <div>
                <strong>Set the broker UTC offset</strong>
                <p>
                  Choose the actual server-time offset for this connection
                  above. It is used only if an MT5 timestamp arrives without its
                  own offset; Gold Journal then classifies the resulting instant
                  in fixed PKT UTC+5.
                </p>
              </div>
            </li>
            <li>
              <div>
                <strong>Allow the server origin</strong>
                <p>
                  In MT5: Tools → Options → Expert Advisors. Enable “Allow
                  WebRequests for listed URL,” add the exact origin below, then
                  click OK. This WebRequest permission is required; trading permission is not.
                </p>
                <div className="mt5-inline-copy">
                  <code>{webRequestOrigin}</code>
                  <CopyValue value={webRequestOrigin} label="MT5 WebRequest origin" />
                </div>
                <p className="mt5-guide-note">The generated EA endpoint is <code>{serverUrl}</code>.</p>
              </div>
            </li>
            <li>
              <div>
                <strong>Restart the EA once</strong>
                <p>
                  Attach the EA to any chart and paste the matching API key. In
                  Experts, first confirm READ-ONLY MODE and API authentication,
                  then wait for summary, open-position, and history-sync lines.
                  Keep MT5 open until MT5 Live shows the snapshot and synced
                  positions; those trades then appear automatically in Trade Log.
                </p>
              </div>
            </li>
          </ol>
        )}
      </section>
      <section className="mt5-position-section">
        <div className="mt5-section-head">
          <div>
            <span className="eyebrow">{account?.name || "ACTIVE ACCOUNT"}</span>
            <h3>Open positions</h3>
          </div>
          <span className="mt5-live-dot">
            <Radio size={14} /> Live
          </span>
        </div>
        {openPositions.length ? (
          <div className="mt5-position-grid">
            {openPositions.map((position: any) => (
              <article
                key={position.ticket}
                className={`mt5-position-card ${toNumber(position.floatingPnl) >= 0 ? "profit" : "loss"}`}
              >
                <header>
                  <div>
                    <h4>{position.symbol}</h4>
                    <span
                      className={`side-badge ${position.direction.toLowerCase()}`}
                    >
                      {position.direction}
                    </span>
                  </div>
                  <strong
                    className={`data-text ${toNumber(position.floatingPnl) >= 0 ? "positive" : "negative"}`}
                  >
                    {formatMoney(position.floatingPnl)}
                  </strong>
                </header>
                <div className="mt5-metrics">
                  <span>
                    Risk <b>{formatMoney(position.riskUsd)}</b>
                  </span>
                  <span>
                    Reward <b>{formatMoney(position.rewardUsd)}</b>
                  </span>
                  <span>
                    R:R <b>{formatRr(position.riskUsd, position.rewardUsd)}</b>
                  </span>
                </div>
                <footer>
                  <span>Open {position.openPrice}</span>
                  <span>SL {position.slPrice || "—"}</span>
                  <span>TP {position.tpPrice || "—"}</span>
                  <span>
                    {position.lots} lots · {pkt(position.openTime)} PKT
                  </span>
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="mt5-empty compact">
            <WifiOff size={24} />
            <h3>No open positions in MT5</h3>
            <p>
              Positions will appear in both MT5 Live and Trade Log after an
              active connection receives data from the current EA download.
            </p>
          </div>
        )}
      </section>
      <section className="mt5-closed-section panel">
        <div className="mt5-section-head">
          <div>
            <span className="eyebrow">HISTORICAL CLOSED POSITIONS</span>
            <h3>MT5 trade history</h3>
            <p
              className={`mt5-history-status ${history.isError || activeConnection?.lastHistoryStatus === "FAILED" ? "error" : ""}`}
            >
              {historyStatus}
            </p>
            {(history.isError ||
              activeConnection?.lastHistoryStatus === "FAILED") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void workspace.refetch();
                  void history.refetch();
                }}
              >
                Retry history
              </Button>
            )}
            <button
              className="icon-button"
              onClick={() => {
                void workspace.refetch();
                void history.refetch();
              }}
              aria-label="Refresh MT5 history"
            >
              <RefreshCcw size={16} />
            </button>
          </div>
        </div>
        {positions.length ? (
          <>
            <div className="mt5-table-wrap">
              <table className="mt5-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Symbol</th>
                    <th>Direction</th>
                    <th>Open</th>
                    <th>Close</th>
                    <th>Risk</th>
                    <th>Reward</th>
                    <th>R:R</th>
                    <th>P&amp;L</th>
                    <th>Result</th>
                    <th>Trade Log</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position: any) => (
                    <tr key={position.ticket}>
                      <td>{pkt(position.closeTime)}</td>
                      <td>{position.symbol}</td>
                      <td>
                        <span
                          className={`side-badge ${position.direction.toLowerCase()}`}
                        >
                          {position.direction}
                        </span>
                      </td>
                      <td>{position.openPrice}</td>
                      <td>{position.closePrice}</td>
                      <td>{formatMoney(position.riskUsd)}</td>
                      <td>{formatMoney(position.rewardUsd)}</td>
                      <td>{formatRr(position.riskUsd, position.rewardUsd)}</td>
                      <td
                        className={`data-text ${toNumber(position.realizedPnl) >= 0 ? "positive" : "negative"}`}
                      >
                        {formatMoney(position.realizedPnl)}
                      </td>
                      <td>{position.result?.replace("_", " ")}</td>
                      <td>
                        <span className="mt5-journaled">
                          <Check size={13} />{" "}
                          {position.journaled ? "Synced" : "Syncing"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(history.data?.pageCount ?? 1) > 1 && (
              <div className="table-pagination">
                <span>
                  Page {history.data?.page} of {history.data?.pageCount} ·{" "}
                  {history.data?.total} closed positions
                </span>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={historyPage === 1 || history.isFetching}
                    onClick={() => setHistoryPage(page => page - 1)}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      historyPage >= (history.data?.pageCount ?? 1) ||
                      history.isFetching
                    }
                    onClick={() => setHistoryPage(page => page + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="mt5-no-closed">
            {history.isLoading
              ? "Loading MT5 history…"
              : history.isError
                ? "MT5 history could not be loaded. Use Retry history above after checking the connection and Supabase migration status."
                : "Historical MT5 closes appear after the current deployment-specific EA backfills them, then they are added automatically to Trade Log."}
          </p>
        )}
      </section>
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add MT5 connection</DialogTitle>
            <DialogDescription>
              Create one private API key for this selected Gold Journal account.
              You will copy it into the MT5 Expert Advisor.
            </DialogDescription>
          </DialogHeader>
          <div className="mt5-add-form">
            <label>
              Connection label
              <Input
                value={label}
                onChange={event => setLabel(event.target.value)}
                placeholder="GFT 10K Account"
              />
            </label>
            <label>
              Link to account
              <select
                value={linkAccountId ?? ""}
                onChange={event => setLinkAccountId(Number(event.target.value))}
              >
                <option value="">Select account</option>
                {availableAccounts.map((item: any) => (
                  <option value={item.id} key={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Broker server time
              <select
                aria-label="Broker UTC offset"
                value={brokerUtcOffsetMinutes}
                onChange={event =>
                  setBrokerUtcOffsetMinutes(Number(event.target.value))
                }
              >
                {brokerOffsetOptions.map(offset => (
                  <option value={offset} key={offset}>
                    {formatBrokerOffset(offset)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="dialog-actions">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!linkAccountId || createConnection.isPending}
              onClick={() => void saveConnection()}
            >
              {createConnection.isPending ? "Creating…" : "Create connection"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(newApiKey)}
        onOpenChange={open => {
          if (!open) setNewApiKey("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your MT5 API key now</DialogTitle>
            <DialogDescription>
              This key is shown once. Paste the Server URL into the EA Endpoint
              input and MT5 WebRequest allow-list, then paste this key into the
              EA ApiKey input.
            </DialogDescription>
          </DialogHeader>
          <div className="mt5-one-time-key">
            <span>SERVER URL</span>
            <code>{serverUrl}</code>
            <CopyValue value={serverUrl} label="Server URL" />
          </div>
          <div className="mt5-one-time-key">
            <span>API KEY</span>
            <code>{newApiKey}</code>
            <CopyValue value={newApiKey} label="MT5 API key" />
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setNewApiKey("")}>
              I copied the URL and key
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
