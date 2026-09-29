import React, { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Compass, Eye } from "lucide-react";
import { buildMentorBrief, type MentorInsight, type MentorInsightLevel } from "@shared/mentorEngine";
import type { TiltAssessment } from "@shared/tiltGuard";
import type { AnalysisResult } from "@shared/analysisEngine";

const LEVEL_META: Record<MentorInsightLevel, { icon: typeof Eye; label: string }> = {
  fix: { icon: AlertTriangle, label: "Fix first" },
  watch: { icon: Eye, label: "Watch" },
  strength: { icon: CheckCircle2, label: "Strength" },
};

function InsightCard({ insight }: { insight: MentorInsight }) {
  const meta = LEVEL_META[insight.level];
  const Icon = meta.icon;
  return (
    <article className="mentor-card" data-mentor-level={insight.level}>
      <div className="mentor-card-head">
        <Icon size={17} aria-hidden />
        <h4>{insight.title}</h4>
        <span className="mentor-level-badge">{meta.label}</span>
      </div>
      <p className="mentor-card-message">{insight.message}</p>
      <p className="mentor-card-action">
        <b>Do this:</b> {insight.action}
      </p>
      <small className="mentor-card-evidence">{insight.evidence}</small>
    </article>
  );
}

/**
 * Deterministic mentor brief: plain-language guidance computed from the
 * journal's own aggregates. It needs no AI key, never invents a number, and is
 * the same brief the AI Mentor receives as grounding when it is available.
 */
export function MentorBriefPanel({ analysis, tilt }: { analysis: AnalysisResult | null | undefined; tilt?: TiltAssessment | null }) {
  const brief = useMemo(() => (analysis ? buildMentorBrief(analysis, tilt ? { tilt } : {}) : null), [analysis, tilt]);
  if (!brief) return null;
  return (
    <section className="mentor-brief" aria-label="Mentor brief">
      <span className="section-label">MENTOR BRIEF — NO AI KEY NEEDED</span>
      <p className="mentor-headline">{brief.headline}</p>
      {brief.nextAction ? (
        <div className="mentor-priority" role="note">
          <Compass size={22} aria-hidden />
          <div>
            <strong>Your one priority</strong>
            <p>{brief.nextAction}</p>
          </div>
        </div>
      ) : null}
      {brief.insights.length ? (
        <>
          <span className="section-label" style={{ display: "block", marginTop: 20 }}>WHAT YOUR JOURNAL SAYS</span>
          <div className="mentor-insights">
            {brief.insights.map(item => <InsightCard key={item.title} insight={item} />)}
          </div>
        </>
      ) : (
        <p className="mentor-headline">Log and close a few trades first — the mentor reads closed trades, not intentions.</p>
      )}
    </section>
  );
}
