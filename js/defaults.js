// Default option lists. Users can customise these from the Options page;
// customisations are persisted per-user in the journal_meta table.

export const DEFAULT_OPTIONS = {
  sessions: [
    "Pre-Asian (3am-5am)",
    "Asian (5am-8am)",
    "Post-Asian (8am-10am)",
    "Pre-London (10am-12pm)",
    "London (12pm-2pm)",
    "Post-London (2pm-4pm)",
    "Pre-NY (4pm-5pm)",
    "New York (5pm-8pm)",
    "Post-NY (8pm-3am)",
  ],
  levels: ["SBR/TJL1", "RBS/TJL1", "TJL2", "QML", "FIB", "LVL4", "LVL2"],
  timeframes: ["1m", "5m", "15m", "H1", "4H"],
  setupQuality: ["A+", "A", "B"],
  mistakeTypes: [
    "No mistake",
    "Early entry",
    "Late entry",
    "SL too tight",
    "Fear exit",
    "FOMO trade",
    "Not Booking Profit",
    "Overtrading",
    "Not following plan",
  ],
  holdQuality: [
    "Held full TP",
    "Partial + runner",
    "Early exit",
    "SL hit",
    "RiskFree",
  ],
  marketCondition: ["Bullish", "Bearish", "Ranging", "Choppy"],
  biasAlignment: ["With Trend", "Counter Trend"],
  confirmationType: [
    "BOS",
    "CHoCH",
    "Engulfing",
    "Pin Bar",
    "Rejection Wick",
    "Impulse Entry",
    "None",
  ],
  slPlacement: ["Above CC", "Below CC", "Fixed $", "Below Zone", "Above Zone"],
  tpPlacement: [
    "Fixed 70 to 100pips",
    "Below Zone",
    "Above Zone",
    "Open TP",
    "Manually Exit",
  ],
  executionType: [
    "Manual Direct",
    "Limit Order",
    "Stop Order",
    "Manual After Confirmation",
  ],
  skipReasons: [
    "Fear - H1/15m too slow",
    "Fear - SL looked too big",
    "No confirmation candle",
    "Wrong session timing",
    "Already missed entry",
    "Distracted / not focused",
    "Low confidence in level",
    "lack of confidence",
    "Market is too fast",
    "Other",
  ],
  skipOutcomes: [
    "TP Hit - Full",
    "TP Hit - Partial",
    "SL Would Have Hit",
    "No Reaction",
    "Still Playing",
  ],
  results: ["Win", "Loss", "Break-even", "Open"],
  sides: ["Buy", "Sell"],
};

// Default trading rules pre-loaded for every new daily plan entry.
export const DEFAULT_TRADING_RULES = [
  { id: "setup_quality", text: "Only trade a planned A/A+ setup at marked level, in selected session.", is_default: true },
  { id: "risk_exit_plan", text: "Before entry, define entry, SL, TP, risk amount, and minimum 1:1.5 R:R.", is_default: true },
  { id: "max_trades", text: "Max 3 trades today. Stop immediately after daily loss limit or 2 losses.", is_default: true },
  { id: "no_revenge", text: "No revenge or FOMO trade. After a loss or missed move, wait 30 minutes.", is_default: true },
  { id: "emotion_lockout", text: "No trade while angry, greedy, anxious, tired, bored, or distracted. Take a reset first.", is_default: true },
  { id: "exit_discipline", text: "Exit only by plan. Do not move SL, panic-close, or hold hoping after invalidation.", is_default: true },
  { id: "no_news", text: "No trade during high-impact news, choppy price, or no-clear-bias conditions.", is_default: true },
];

export const EMOTION_OPTIONS = [
  { emoji: "😌", label: "Calm" },
  { emoji: "😤", label: "Frustrated" },
  { emoji: "😨", label: "Anxious" },
  { emoji: "😴", label: "Tired" },
  { emoji: "😎", label: "Confident" },
  { emoji: "🤑", label: "Greedy" },
  { emoji: "😑", label: "Distracted" },
  { emoji: "💪", label: "Focused" },
];

export const BIAS_OPTIONS = ["Bullish", "Bearish", "Neutral", "No clear bias"];

// Human-friendly labels for each editable option list (Options page).
export const OPTION_LABELS = {
  sessions: "Sessions",
  levels: "Levels",
  timeframes: "Timeframes",
  setupQuality: "Setup Quality",
  mistakeTypes: "Mistake Types",
  holdQuality: "Hold Quality",
  marketCondition: "Market Condition",
  biasAlignment: "Trade Direction vs Bias",
  confirmationType: "Confirmation Type",
  slPlacement: "SL Placement",
  tpPlacement: "TP Placement",
  executionType: "Execution Type",
  skipReasons: "Skipped Trade Reasons",
  skipOutcomes: "Skipped Trade Outcomes",
  results: "Results",
  sides: "Sides",
};
