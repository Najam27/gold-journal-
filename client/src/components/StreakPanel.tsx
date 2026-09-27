import React, { useMemo } from "react";
import { Flame, Gauge, HeartHandshake, Scale, Crosshair } from "lucide-react";
import { computeStreaks, type StreakInfo } from "@/lib/streaks";
import { summarizeCalibration } from "@/lib/calibration";

interface StreakTradeLike {
  tradeDate: string | number | Date;
  pnl: number | string | null;
  result?: string | null;
  mistake?: string | null;
  planFollowScore?: number | string | null;
}

function StreakCard({ icon, label, info, detail }: { icon: React.ReactNode; label: string; info: StreakInfo; detail: string }) {
  return (
    <div className="streak-card">
      <span className="streak-icon">{icon}</span>
      <div>
        <strong>{info.current}<small> day{info.current === 1 ? "" : "s"}</small></strong>
        <span>{label}</span>
        <em>{detail}</em>
      </div>
    </div>
  );
}

/**
 * Streaks + self-rating calibration for the Psychology view. The streak engine
 * is pure PKT-day math; the calibration panel compares the trader's 1–5
 * plan-following self-ratings against the journal's computed adherence.
 */
export function StreakPanel({
  trades,
  maxTradesPerDay,
  computedAdherencePct,
}: {
  trades: StreakTradeLike[];
  maxTradesPerDay?: number | null;
  computedAdherencePct?: number | null;
}) {
  const streaks = useMemo(
    () => computeStreaks(trades, { maxTradesPerDay: maxTradesPerDay ?? null }),
    [trades, maxTradesPerDay],
  );
  const calibration = useMemo(
    () => summarizeCalibration(trades, computedAdherencePct ?? null),
    [trades, computedAdherencePct],
  );

  return (
    <section className="panel streak-panel">
      <header>
        <span><Flame size={15} /> Streaks & habits</span>
      </header>
      <div className="streak-grid">
        <StreakCard
          icon={<Flame size={16} />}
          label="Journaling streak"
          info={streaks.journaling}
          detail={`Best: ${streaks.journaling.best} day${streaks.journaling.best === 1 ? "" : "s"}`}
        />
        <StreakCard
          icon={<Gauge size={16} />}
          label="Green-day streak"
          info={streaks.greenDay}
          detail={`Best: ${streaks.greenDay.best} day${streaks.greenDay.best === 1 ? "" : "s"}`}
        />
        <StreakCard
          icon={<HeartHandshake size={16} />}
          label="Revenge-free"
          info={{ current: streaks.revengeFreeDays, best: streaks.revengeFreeDays }}
          detail="Days since last revenge trade"
        />
        <StreakCard
          icon={<Scale size={16} />}
          label="Disciplined sizing"
          info={{ current: streaks.disciplinedDays, best: streaks.disciplinedDays }}
          detail={maxTradesPerDay ? `Days within ${maxTradesPerDay}/day cap` : "No daily cap set"}
        />
      </div>
      {calibration.sample > 0 && (
        <div className="calibration-callout">
          <Crosshair size={16} />
          <div>
            <strong>Self-rating calibration</strong>
            <p>{calibration.message}</p>
            <small>
              Your average: {calibration.selfAdherencePct != null ? `${calibration.selfAdherencePct.toFixed(0)}%` : "—"}
              {" · "}Journal's computed adherence: {calibration.computedAdherencePct != null ? `${calibration.computedAdherencePct.toFixed(0)}%` : "—"}
              {" · "}{calibration.sample} rated trade{calibration.sample === 1 ? "" : "s"}
            </small>
          </div>
        </div>
      )}
    </section>
  );
}
