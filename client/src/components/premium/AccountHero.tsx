import {
  Activity,
  Cloud,
  CloudOff,
  Gauge,
  Landmark,
  RefreshCcw,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { AnimatedNumber } from "@/components/motion/AnimatedNumber";
import { Premium3DBackground } from "@/components/premium/Premium3DBackground";
import { TiltCard } from "@/components/premium/TiltCard";
import { formatMoney } from "@/lib/gold";

type Metric = {
  label: string;
  value: number;
  detail: string;
  tone?: "gold" | "positive" | "negative" | "info" | "live";
  icon?: "wallet" | "trend" | "gauge" | "target";
  /** Money by default; the percentage metrics pass their own formatter. */
  format?: (value: number) => string;
};

const formatPercent = (value: number) => `${value.toFixed(1)}%`;

export type AccountHeroProps = {
  accountName: string;
  balanceLabel: string;
  balance: number;
  equity: number | null;
  floatingPnl: number | null;
  todayPnl: number;
  todayTrades: number;
  todayWinRate: number;
  winRate: number;
  totalTrades: number;
  online: boolean;
  mt5Connected: boolean;
  syncing: boolean;
};

const ICONS = {
  wallet: Landmark,
  trend: TrendingUp,
  gauge: Gauge,
  target: Target,
} as const;

function HeroMetric({ label, value, detail, tone = "gold", icon = "wallet", format }: Metric) {
  const Icon = ICONS[icon];
  return (
    <div className={`hero-metric ${tone}`}>
      <span>
        <Icon size={13} /> {label}
      </span>
      <strong className="data-text">
        <AnimatedNumber value={value} format={format ?? formatMoney} />
      </strong>
      <small>{detail}</small>
    </div>
  );
}

/**
 * The dashboard hero: one premium surface that answers "where does the account
 * stand right now?" before the dense tables start.
 *
 * Every figure is passed in from the existing journal/MT5 query layer — this
 * component derives nothing and invents no numbers. The 3D layer is lazy,
 * optional, and falls back to a static gradient.
 */
export function AccountHero({
  accountName,
  balanceLabel,
  balance,
  equity,
  floatingPnl,
  todayPnl,
  todayTrades,
  todayWinRate,
  winRate,
  totalTrades,
  online,
  mt5Connected,
  syncing,
}: AccountHeroProps) {
  const todayPositive = todayPnl >= 0;
  const equityValue = equity ?? balance;

  return (
    <TiltCard className="account-hero-shell" max={1.6} lift={3}>
      <section className="account-hero" aria-label={`${accountName} account overview`}>
        <Premium3DBackground tone="gold" className="account-hero-3d" />
        <div className="account-hero-head">
          <div className="account-hero-id">
            <span className="hero-badge">
              <Activity size={12} /> LIVE ACCOUNT OVERVIEW
            </span>
            <h2>{accountName}</h2>
            <p>
              Balance, equity and today&apos;s result for the active account. Figures update
              as the journal and the MT5 terminal report them.
            </p>
          </div>
          <div className="hero-status-row">
            <span className={`hero-status ${mt5Connected ? "on" : "off"}`}>
              <i /> {mt5Connected ? "MT5 CONNECTED" : "MT5 NOT CONNECTED"}
            </span>
            <span className={`hero-status ${online ? "on" : "off"}`}>
              {online ? <Cloud size={13} /> : <CloudOff size={13} />}
              {online ? "SYNCED TO CLOUD" : "OFFLINE — LOCAL DATA"}
            </span>
            {syncing && (
              <span className="hero-status">
                <RefreshCcw size={13} /> Syncing
              </span>
            )}
          </div>
        </div>
        <div className="account-hero-metrics">
          <HeroMetric
            label={balanceLabel}
            value={balance}
            detail="Reported account balance"
            tone="gold"
            icon="wallet"
          />
          <HeroMetric
            label="Equity"
            value={equityValue}
            detail={floatingPnl == null ? "Journal balance" : "Balance + floating P&L"}
            tone="live"
            icon="gauge"
          />
          <HeroMetric
            label="Today's P&L"
            value={todayPnl}
            detail={`${todayTrades} trade${todayTrades === 1 ? "" : "s"} today · ${todayWinRate.toFixed(0)}% win rate`}
            tone={todayPositive ? "positive" : "negative"}
            icon={todayPositive ? "trend" : "target"}
          />
          <HeroMetric
            label="Account win rate"
            value={winRate}
            format={formatPercent}
            detail={`${totalTrades} trade${totalTrades === 1 ? "" : "s"} recorded · all-time`}
            tone="info"
            icon="trend"
          />
        </div>
        {floatingPnl != null && !Number.isNaN(floatingPnl) && (
          <p className={`account-hero-floating ${floatingPnl >= 0 ? "positive" : "negative"}`}>
            {floatingPnl >= 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
            Floating P&amp;L {formatMoney(floatingPnl)} across open MT5 positions
          </p>
        )}
      </section>
    </TiltCard>
  );
}
