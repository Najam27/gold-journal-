/**
 * The deterministic mentor brief: plain-language, newbie-first guidance derived
 * from the same aggregates the Analysis view renders. It runs entirely on the
 * device with no AI key, and the AI Mentor receives it as grounding context so
 * even the LLM's coaching stays traceable to real numbers.
 *
 * Mentor philosophy encoded here:
 * - Expectancy first: a newbie must learn that one number (avg $ per trade)
 *   matters more than win rate.
 * - One thing at a time: `nextAction` names the single highest-leverage fix.
 * - Honest but kind: problems are named plainly, never as character judgments.
 * - Every claim carries its evidence string so the trader can verify it.
 */
import type { AnalysisResult, MetricRow } from "./analysisEngine";

export type MentorInsightLevel = "strength" | "watch" | "fix";

export interface MentorInsight {
  level: MentorInsightLevel;
  title: string;
  /** Plain language. No unexplained jargon. */
  message: string;
  /** One concrete thing to do. */
  action: string;
  /** The numbers behind the claim, e.g. "12 trades · -$18.40 avg". */
  evidence: string;
}

export interface MentorBrief {
  sample: number;
  readiness: "COLLECTING" | "FORMING" | "MEANINGFUL";
  headline: string;
  insights: MentorInsight[];
  /** The single highest-leverage action, or null when there is nothing to say. */
  nextAction: string | null;
}

const money = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
const avg = (row: MetricRow) => `${row.sample} trades · ${money(row.expectancy)} avg`;

function readinessFor(sample: number): MentorBrief["readiness"] {
  if (sample >= 30) return "MEANINGFUL";
  if (sample >= 10) return "FORMING";
  return "COLLECTING";
}

/**
 * Builds the brief. Pure and deterministic: the same analysis always yields the
 * same brief, which is what makes it safe to show before any AI is involved.
 */
export function buildMentorBrief(analysis: AnalysisResult): MentorBrief {
  const overview = analysis.overview;
  const sample = overview.sample;
  const readiness = readinessFor(sample);
  const insights: MentorInsight[] = [];

  // 1. Sample honesty — the first lesson every newbie needs.
  if (readiness === "COLLECTING") {
    insights.push({
      level: "watch",
      title: "Still collecting data",
      message: `With ${sample} closed trade${sample === 1 ? "" : "s"}, no pattern in your journal is proven yet — not the wins, not the losses. Judge your process (did you follow the plan?), never the scoreboard.`,
      action: "Keep journaling every trade with risk, screenshot, and one honest notes line until you reach 30 closed trades.",
      evidence: `${sample} closed trades · 30 needed for a meaningful read`,
    });
  } else if (readiness === "FORMING") {
    insights.push({
      level: "watch",
      title: "Patterns forming, not proven",
      message: `At ${sample} trades your tendencies are visible but a single good or bad week can still flip every number. Trust direction, not precision.`,
      action: "Do not change your strategy yet — change one behaviour at a time and keep collecting.",
      evidence: `${sample} closed trades · 30 needed for a meaningful read`,
    });
  }

  if (!sample) {
    return {
      sample,
      readiness,
      headline: "Your journal is empty — the mentor wakes up after your first closed trades.",
      insights,
      nextAction: insights[0]?.action ?? null,
    };
  }

  // 2. Expectancy: the one number that matters.
  const exp = overview.expectancy;
  insights.push({
    level: exp > 0 ? "strength" : exp < 0 ? "fix" : "watch",
    title: "Your expectancy",
    message:
      exp > 0
        ? `Every closed trade makes you ${money(exp)} on average. That is the whole game: repeat the process that produced it and protect it from behaviour leaks.`
        : exp < 0
          ? `Every closed trade costs you ${money(Math.abs(exp))} on average. This is a process problem, not a luck problem — the fixes below are ordered by impact.`
          : "Your average trade is exactly breakeven. You are paying the market for education — tighten one leak below and expectancy turns positive.",
    action:
      exp > 0
        ? "Write down the 3 rules that produced these trades and trade nothing outside them this week."
        : "Pick the first FIX below and work only on that for the next 10 trades.",
    evidence: `${sample} trades · ${money(exp)} expectancy · ${overview.winRate.toFixed(1)}% win rate`,
  });

  // 3. Trading after losses — the classic newbie account-killer.
  const afterLoss = analysis.streaks.afterLoss;
  if (afterLoss && afterLoss.sample >= 5 && afterLoss.expectancy < 0 && exp >= 0) {
    insights.push({
      level: "fix",
      title: "Losses change your trading",
      message: `Trades taken after a loss lose ${money(Math.abs(afterLoss.expectancy))} on average, while your overall expectancy is ${money(exp)}. The loss isn't the problem — what you do right after it is.`,
      action: "After any losing trade, stand up for 10 minutes before even looking at a chart. Make it a written rule in today's plan.",
      evidence: `${avg(afterLoss)} after losses vs ${money(exp)} overall`,
    });
  }

  // 4. Sizing up when hurt.
  const risk = analysis.risk;
  if (risk.afterLosses != null && risk.afterWins != null && risk.afterLosses > risk.afterWins * 1.25 && risk.afterWins > 0) {
    insights.push({
      level: "fix",
      title: "You size up after losses",
      message: `Your average risk after a loss (${money(risk.afterLosses)}) is bigger than after a win (${money(risk.afterWins)}). That is revenge sizing: larger bets placed with a worse mindset.`,
      action: "Set one fixed risk amount per trade for the next 2 weeks. No discretion, no exceptions.",
      evidence: `${money(risk.afterLosses)} avg risk after losses · ${money(risk.afterWins)} after wins`,
    });
  }

  // 5. Worst context — stop the bleeding first.
  const weak = analysis.edgeCards.weak;
  if (weak && weak.sample >= 10 && weak.expectancy < 0) {
    insights.push({
      level: "fix",
      title: `Your leak: ${weak.label}`,
      message: `This context costs you ${money(Math.abs(weak.expectancy))} per trade across ${weak.sample} trades. You don't need a new strategy — you need less of this one.`,
      action: `Skip ${weak.label} setups for the next 2 weeks, or halve size on them. Re-measure after 10 more trades.`,
      evidence: avg(weak),
    });
  }

  // 6. Best context — trade more of what works.
  const top = analysis.edgeCards.top;
  if (top && top.sample >= 10 && top !== weak && top.expectancy > 0) {
    insights.push({
      level: "strength",
      title: `Your edge lives here: ${top.label}`,
      message: `Across ${top.sample} trades this context earns ${money(top.expectancy)} per trade${top.evidenceTier === "VALIDATED EDGE" ? " and the sample is large enough to call it validated" : ""}. Most traders never find one clear edge — you have a candidate.`,
      action: `Write the exact entry rules for ${top.label} and make it your A+ setup: full size only here.`,
      evidence: `${avg(top)} · ${top.evidenceTier.toLowerCase()}`,
    });
  }

  // 7. Win-rate education for low-win-rate winners.
  if (overview.winRate < 45 && exp > 0) {
    insights.push({
      level: "strength",
      title: "Low win rate, positive expectancy",
      message: `You win only ${overview.winRate.toFixed(1)}% of trades and still make money — completely normal for a reward-driven style. Never "fix" this by chasing win rate; you'd trade a working system for a comforting one.`,
      action: "When doubt creeps in, re-read your expectancy line instead of your win rate.",
      evidence: `${overview.winRate.toFixed(1)}% win rate · ${overview.expectancyR != null ? `${overview.expectancyR.toFixed(2)}R avg` : money(exp)}`,
    });
  }

  // 8. Edge decay — is it getting worse?
  if (analysis.decay.direction === "DETERIORATING") {
    insights.push({
      level: "watch",
      title: "Recent trades are weaker",
      message: "Your last 20 trades underperform your full history. That can be variance, worse conditions, or discipline slipping — the journal will tell you which.",
      action: "Review your last 10 trades: mark each as 'followed plan' or not. If plan-following slipped, that's the fix.",
      evidence: `recent-20 vs full history · ${analysis.decay.direction.toLowerCase()}`,
    });
  } else if (analysis.decay.direction === "IMPROVING" && readiness === "MEANINGFUL") {
    insights.push({
      level: "strength",
      title: "You're getting better",
      message: "Your recent 20 trades beat your full history. Something changed for the better — find it in your notes and protect it.",
      action: "Write down what you did differently in the last month and make it a permanent rule.",
      evidence: `recent-20 vs full history · ${analysis.decay.direction.toLowerCase()}`,
    });
  }

  // 9. Drawdown framing — normalize the pain.
  const dd = analysis.drawdown;
  if (dd.count > 0 && dd.maximum > 0) {
    const painful = dd.maximum > Math.abs(exp * sample) * 0.5;
    insights.push({
      level: painful ? "watch" : "strength",
      title: "Drawdowns are the fee",
      message: painful
        ? `Your deepest drawdown was ${money(dd.maximum)} across ${dd.count} episode${dd.count === 1 ? "" : "s"} (about ${money(dd.average)} each). Drawdowns are normal, but this one is large relative to your edge — check whether behaviour, not the market, deepened it.`
        : `You've survived ${dd.count} drawdown episode${dd.count === 1 ? "" : "s"} averaging ${money(dd.average)} and kept trading your plan. That resilience is a genuine trading skill.`,
      action: painful
        ? "Open your deepest drawdown episode and tag every trade: plan-followed or not. Fix the behaviour half first."
        : "Keep your risk fixed through the next drawdown — that is when most traders abandon what works.",
      evidence: `${money(dd.maximum)} max · ${money(dd.average)} avg · ${dd.count} episodes`,
    });
  }

  // 10. Self-reported behaviour tags.
  const topTag = [...analysis.behavior.tags].sort((a, b) => b.sample - a.sample)[0];
  if (topTag && topTag.sample >= 3) {
    insights.push({
      level: "fix",
      title: `Recurring pattern: ${topTag.label}`,
      message: `You've tagged "${topTag.label}" on ${topTag.sample} trades${topTag.expectancy < 0 ? ` and those trades lose ${money(Math.abs(topTag.expectancy))} on average` : ""}. Naming it was the hard part — now it needs a rule.`,
      action: `Write one if-then rule against "${topTag.label}" (e.g. "If I feel the urge to chase, I close the platform for 15 minutes") and put it in today's plan.`,
      evidence: `${topTag.sample} tagged trades${topTag.expectancy ? ` · ${money(topTag.expectancy)} avg` : ""}`,
    });
  }

  // 11. Journal quality — the analysis is only as good as the data.
  const quality = analysis.journalQuality.completeness;
  if (quality < 70 && sample >= 10) {
    insights.push({
      level: "watch",
      title: "Your journal has gaps",
      message: `Only ${quality.toFixed(0)}% of your journal fields are filled. Every insight above is weaker than it looks — the mentor can only read what you wrote down.`,
      action: "For the next 10 trades, fill risk, screenshot, and notes before you close the app. Completeness first, cleverness later.",
      evidence: `${quality.toFixed(0)}% journal completeness`,
    });
  }

  // Order: fixes first, then watches, then strengths. Cap at 6 so it stays readable.
  const rank: Record<MentorInsightLevel, number> = { fix: 0, watch: 1, strength: 2 };
  const ordered = [...insights].sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 6);
  const nextAction = ordered.find(item => item.level === "fix")?.action ?? ordered[0]?.action ?? null;
  const headline =
    exp > 0
      ? `You're a profitable trader on ${sample} trades. The job now is protecting the edge from behaviour leaks.`
      : exp < 0
        ? `You're paying ${money(Math.abs(exp))} per trade to learn. The leaks below are fixable — start with the first one.`
        : `You're at breakeven across ${sample} trades — one fixed leak away from profitability.`;

  return { sample, readiness, headline, insights: ordered, nextAction };
}

/** Compact text form of the brief, injected into the AI mentor's prompt as grounding. */
export function mentorBriefPromptText(brief: MentorBrief): string {
  const lines = [
    `DETERMINISTIC MENTOR BRIEF (computed from the journal, not generated): sample=${brief.sample}, readiness=${brief.readiness}`,
    `Headline: ${brief.headline}`,
    ...brief.insights.map(item => `- [${item.level.toUpperCase()}] ${item.title}: ${item.message} Action: ${item.action} (Evidence: ${item.evidence})`),
  ];
  if (brief.nextAction) lines.push(`Single next action: ${brief.nextAction}`);
  return lines.join("\n");
}
