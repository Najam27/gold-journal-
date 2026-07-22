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
  { id: "max_trades", text: "Maximum 3 trades today. Stop after 3.", is_default: true },
  { id: "max_loss", text: "Stop trading if daily loss exceeds my limit.", is_default: true },
  { id: "no_revenge", text: "After a loss, wait 30 minutes before next entry.", is_default: true },
  { id: "no_fomo", text: "No chasing moves. Missed entry = wait for next setup.", is_default: true },
  { id: "setup_quality", text: "Only take A or A+ setups today.", is_default: true },
  { id: "sl_no_move", text: "Never move SL against the trade once set.", is_default: true },
  { id: "no_news", text: "No trades 30 minutes before/after high-impact news.", is_default: true },
  { id: "screenshot", text: "Take screenshot for every trade. No exceptions.", is_default: true },
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
