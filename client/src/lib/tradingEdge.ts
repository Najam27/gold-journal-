import { toNumber } from "./gold";

export const EDGE_MIN_SAMPLE = 5;

export type EdgeTrade = {
  session?: string | null;
  timeframe?: string | null;
  level?: string | null;
  result: string;
  pnl: number | string | null;
  tradeDate?: number | string | Date | null;
};

export type EdgeRow = {
  key: string;
  label: string;
  sample: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  netPnl: number;
  expectancy: number;
  qualified: boolean;
};

type Dimension = "session" | "timeframe" | "level";

function labelFor(trade: EdgeTrade, dimensions: Dimension[]) {
  const values = dimensions.map(dimension => String(trade[dimension] || "").trim()).filter(Boolean);
  return values.length === dimensions.length ? values.join(" · ") : null;
}

export function edgeRows(trades: EdgeTrade[], dimensions: Dimension[]) {
  const groups = new Map<string, EdgeTrade[]>();
  for (const trade of trades) {
    if (trade.result === "OPEN") continue;
    const label = labelFor(trade, dimensions);
    if (!label) continue;
    const current = groups.get(label) ?? [];
    current.push(trade);
    groups.set(label, current);
  }
  const entries = Array.from(groups.entries()) as [string, EdgeTrade[]][];
  return entries.map(([label, rows]): EdgeRow => {
    const wins = rows.filter(row => row.result === "WIN").length;
    const losses = rows.filter(row => row.result === "LOSS").length;
    const breakEven = rows.filter(row => row.result === "BREAK_EVEN").length;
    const netPnl = rows.reduce((sum, row) => sum + toNumber(row.pnl), 0);
    return { key: label, label, sample: rows.length, wins, losses, breakEven, winRate: rows.length ? wins / rows.length * 100 : 0, netPnl, expectancy: rows.length ? netPnl / rows.length : 0, qualified: rows.length >= EDGE_MIN_SAMPLE };
  }).sort((a, b) => b.expectancy - a.expectancy || b.winRate - a.winRate || b.sample - a.sample);
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
  const strongest = [...qualified].sort((a, b) => b.expectancy - a.expectancy || b.winRate - a.winRate || b.sample - a.sample)[0] ?? null;
  const weakest = [...qualified].sort((a, b) => a.expectancy - b.expectancy || a.winRate - b.winRate || b.sample - a.sample)[0] ?? null;
  return { sessions, timeframes, levels, sessionTimeframes, levelSessions, levelTimeframes, strongest, weakest };
}
