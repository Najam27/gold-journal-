import { metricRow, type AnalysisTrade } from "@shared/analysisEngine";

export const EDGE_MIN_SAMPLE = 5;
export type EdgeTrade = AnalysisTrade;
export type Dimension = "session" | "timeframe" | "level";
export type EdgeRow = ReturnType<typeof metricRow> & { qualified: boolean };

function labelFor(trade: EdgeTrade, dimensions: Dimension[]) {
  const values = dimensions.map(dimension => String(trade[dimension] ?? "").trim());
  return values.every(Boolean) ? values.join(" · ") : null;
}

export function edgeRows(trades: EdgeTrade[], dimensions: Dimension[]): EdgeRow[] {
  const groups = new Map<string, EdgeTrade[]>();
  for (const trade of trades) {
    const label = labelFor(trade, dimensions);
    if (!label || trade.result === "OPEN") continue;
    const current = groups.get(label) ?? [];
    current.push(trade);
    groups.set(label, current);
  }
  return Array.from(groups.entries()).map(([label, rows]) => ({ ...metricRow(label, rows), qualified: rows.length >= EDGE_MIN_SAMPLE })).sort((a, b) => b.edgeScore - a.edgeScore || b.expectancy - a.expectancy || b.sample - a.sample);
}

export function buildTradingEdge(trades: EdgeTrade[]) {
  const sessions = edgeRows(trades, ["session"]);
  const timeframes = edgeRows(trades, ["timeframe"]);
  const levels = edgeRows(trades, ["level"]);
  const sessionTimeframes = edgeRows(trades, ["session", "timeframe"]);
  const levelSessions = edgeRows(trades, ["level", "session"]);
  const levelTimeframes = edgeRows(trades, ["level", "timeframe"]);
  const all = [...sessions, ...timeframes, ...levels, ...sessionTimeframes, ...levelSessions, ...levelTimeframes];
  const qualified = all.filter(row => row.qualified);
  const strongest = [...qualified].sort((a, b) => b.edgeScore - a.edgeScore || b.expectancy - a.expectancy || b.sample - a.sample)[0] ?? null;
  const weakest = [...qualified].sort((a, b) => a.edgeScore - b.edgeScore || a.expectancy - b.expectancy || b.sample - a.sample)[0] ?? null;
  return { sessions, timeframes, levels, sessionTimeframes, levelSessions, levelTimeframes, strongest, weakest };
}
