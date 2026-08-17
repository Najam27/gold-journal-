export type StrategyFilters = {
  session?: string;
  timeframe?: string;
  level?: string;
  setupQuality?: string;
};

export type GoalControlConfig = {
  note: string;
  strategy: StrategyFilters;
};

const CONTROL_CONFIG_MARKER = "gold-journal-control-v1";

export function encodeGoalControl(note: string, strategy: StrategyFilters = {}) {
  return JSON.stringify({ marker: CONTROL_CONFIG_MARKER, note: note.trim(), strategy });
}

export function decodeGoalControl(description?: string | null): GoalControlConfig {
  if (!description) return { note: "", strategy: {} };
  try {
    const parsed = JSON.parse(description);
    if (parsed?.marker === CONTROL_CONFIG_MARKER) {
      return {
        note: typeof parsed.note === "string" ? parsed.note : "",
        strategy: {
          session: typeof parsed.strategy?.session === "string" ? parsed.strategy.session : "",
          timeframe: typeof parsed.strategy?.timeframe === "string" ? parsed.strategy.timeframe : "",
          level: typeof parsed.strategy?.level === "string" ? parsed.strategy.level : "",
          setupQuality: typeof parsed.strategy?.setupQuality === "string" ? parsed.strategy.setupQuality : "",
        },
      };
    }
  } catch {
    // Existing free-text descriptions stay fully backward compatible.
  }
  return { note: description, strategy: {} };
}
