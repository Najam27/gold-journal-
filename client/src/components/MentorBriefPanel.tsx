import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Compass, Eye } from "lucide-react";
import { buildMentorBrief, type MentorInsight, type MentorInsightLevel } from "@shared/mentorEngine";
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
    <article className="ai-evidence-card" data-mentor-level={insight.level}>
      <strong>
        <Icon size={15} aria-hidden /> {insight.title}
      </strong>
      <p>{insight.message}</p>
      <p>
        <b>Do this:</b> {insight.action}
      </p>
      <small>
        {meta.label} · {insight.evidence}
      </small>
    </article>
  );
}

/**
 * Deterministic mentor brief: plain-language guidance computed from the
 * journal's own aggregates. It needs no AI key, never invents a number, and is
 * the same brief the AI Mentor receives as grounding when it is available.
 */
export function MentorBriefPanel({ analysis }: { analysis: AnalysisResult | null | undefined }) {
  const brief = useMemo(() => (analysis ? buildMentorBrief(analysis) : null), [analysis]);
  if (!brief) return null;
  return (
    <section className="analysis-ai-report" aria-label="Mentor brief">
      <span className="section-label">MENTOR BRIEF — NO AI KEY NEEDED</span>
      <p>{brief.headline}</p>
      {brief.nextAction ? (
        <div className="analysis-ai-empty" role="note">
          <Compass size={20} />
          <div>
            <strong>Your one priority</strong>
            <p>{brief.nextAction}</p>
          </div>
        </div>
      ) : null}
      <div className="analysis-ai-columns">
        <section aria-label="Mentor insights">
          <span className="section-label">WHAT YOUR JOURNAL SAYS</span>
          {brief.insights.length ? (
            brief.insights.map(item => <InsightCard key={item.title} insight={item} />)
          ) : (
            <p>Log and close a few trades first — the mentor reads closed trades, not intentions.</p>
          )}
        </section>
      </div>
    </section>
  );
}
