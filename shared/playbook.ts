/**
 * The trader's playbook: "trade more of this, avoid that."
 *
 * A professional doesn't trade vibes — they trade a short list of contexts
 * where their own journal proves an edge, and they starve the contexts where
 * it proves a leak. This module turns the analysis engine's ranked dimension
 * rows into those two lists, with a sample floor high enough that a lucky
 * week can't mint a playbook entry.
 *
 * Pure and deterministic: no AI, no invented numbers.
 */
import { EDGE_MIN_SAMPLE, type AnalysisResult, type MetricRow } from "./analysisEngine";

/** Playbook entries need a stricter floor than edge candidates: this list is
 * what the trader sizes up on, so 5-trade flukes must not qualify. */
export const PLAYBOOK_MIN_SAMPLE = 10;
export const PLAYBOOK_MAX_CARDS = 3;

export interface PlaybookCard {
  /** e.g. "Session", "Market condition", "Session × Timeframe" */
  dimension: string;
  /** e.g. "London", "Trending" */
  label: string;
  sample: number;
  expectancy: number;
  winRate: number;
  profitFactor: number | null;
  averageR: number | null;
  evidenceTier: string;
  /** One pro-coaching line with the numbers baked in. */
  headline: string;
  /** The concrete action. */
  action: string;
}

export interface Playbook {
  trade: PlaybookCard[];
  avoid: PlaybookCard[];
  /** Null when the journal is too thin for any card. */
  note: string | null;
}

const DIMENSION_LABELS: Record<string, string> = {
  sessions: "Session",
  timeframes: "Timeframe",
  levels: "Level",
  setups: "Setup quality",
  directions: "Direction",
  marketConditions: "Market condition",
  executionTypes: "Execution type",
  biasAlignments: "Bias alignment",
  confirmations: "Confirmation",
  days: "Weekday",
  hours: "Hour",
  sessionTimeframes: "Session × Timeframe",
  levelSessions: "Level × Session",
  levelTimeframes: "Level × Timeframe",
  sessionTimeframeLevels: "Session × Timeframe × Level",
  setupSessions: "Setup × Session",
  setupTimeframes: "Setup × Timeframe",
  setupLevels: "Setup × Level",
};

const money = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

function toCard(dimension: string, row: MetricRow, side: "trade" | "avoid"): PlaybookCard {
  const tail = `${row.winRate.toFixed(0)}% win rate` + (row.averageR != null ? ` · ${row.averageR.toFixed(2)}R avg` : "");
  const headline =
    side === "trade"
      ? `"${row.label}" earns ${money(row.expectancy)} per trade over ${row.sample} trades (${tail})${row.evidenceTier === "VALIDATED EDGE" ? " — validated edge" : ""}. This is your A-plan territory.`
      : `"${row.label}" costs ${money(Math.abs(row.expectancy))} per trade over ${row.sample} trades (${tail}). The market is telling you something — listen before the next entry.`;
  return {
    dimension,
    label: row.label,
    sample: row.sample,
    expectancy: row.expectancy,
    winRate: row.winRate,
    profitFactor: row.profitFactor,
    averageR: row.averageR,
    evidenceTier: row.evidenceTier,
    headline,
    action:
      side === "trade"
        ? `Trade "${row.label}" at full planned size. Write its exact entry rules down and refuse anything outside them when this context is absent.`
        : `Skip "${row.label}" for the next 2 weeks, or trade it at half size maximum. Re-measure after 10 more closed trades.`,
  };
}

function collectCandidates(analysis: AnalysisResult): Array<{ dimension: string; row: MetricRow }> {
  const out: Array<{ dimension: string; row: MetricRow }> = [];
  for (const [group, dimension] of Object.entries(DIMENSION_LABELS)) {
    const rows = (analysis as unknown as Record<string, MetricRow[] | undefined>)[group];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row.sample >= PLAYBOOK_MIN_SAMPLE) out.push({ dimension, row });
    }
  }
  return out;
}

/**
 * Builds the two lists. Trade cards: positive expectancy, ranked by edge
 * score. Avoid cards: negative expectancy, ranked by worst expectancy.
 * Labels are deduplicated so one context can't occupy the whole list.
 */
export function buildPlaybook(analysis: AnalysisResult): Playbook {
  const candidates = collectCandidates(analysis);

  const trade: PlaybookCard[] = [];
  const seenTrade = new Set<string>();
  for (const { dimension, row } of [...candidates].sort((a, b) => b.row.edgeScore - a.row.edgeScore || b.row.expectancy - a.row.expectancy)) {
    if (row.expectancy <= 0 || trade.length >= PLAYBOOK_MAX_CARDS || seenTrade.has(row.label)) continue;
    seenTrade.add(row.label);
    trade.push(toCard(dimension, row, "trade"));
  }

  const avoid: PlaybookCard[] = [];
  const seenAvoid = new Set<string>();
  for (const { dimension, row } of [...candidates].sort((a, b) => a.row.expectancy - b.row.expectancy)) {
    if (row.expectancy >= 0 || avoid.length >= PLAYBOOK_MAX_CARDS || seenAvoid.has(row.label)) continue;
    seenAvoid.add(row.label);
    avoid.push(toCard(dimension, row, "avoid"));
  }

  const note =
    trade.length === 0 && avoid.length === 0
      ? `No context has ${PLAYBOOK_MIN_SAMPLE}+ closed trades yet — the playbook unlocks as your journal grows. (Edge candidates start at ${EDGE_MIN_SAMPLE}.)`
      : null;

  return { trade, avoid, note };
}
