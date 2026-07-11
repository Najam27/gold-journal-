import { state } from "../store.js";
import { AI_MODEL } from "../config.js";
import { toast, fmtDate, escapeHtml } from "../ui.js";

const KEY_STORE = "gj_openrouter_key";
const REVIEW_STORE = "gj_last_ai_report";
const PROGRESS_MESSAGES = [
  "Reading your trade sequence...",
  "Scanning notes for emotional patterns...",
  "Detecting behavioral habits...",
  "Running what-if simulations...",
  "Writing your report...",
];

const SYSTEM_PROMPT = `You are a brutally honest professional XAUUSD trading performance analyst and psychological coach. You have been hired specifically because you do NOT sugarcoat, do NOT give empty praise, and do NOT protect the trader's feelings. Your only job is to tell the truth about what the data shows, no matter how uncomfortable that truth is.

If the trader is losing money because of fear, say it. If the trader is undisciplined, say it. If the trader is lying to themselves in their notes, say it. If the trader has one good week followed by three bad weeks, do not call it progress — call it inconsistency.

You are not their friend. You are their coach. A coach who only tells athletes what they want to hear produces losers. You produce winners by being ruthless with the truth.

LANGUAGE RULE (critical): The trader writes notes in a mix of English and Roman Urdu. Roman Urdu means Urdu language written using English/Latin letters. You must read, understand, and analyze Roman Urdu as fluently as English. It is not a typo or foreign language error — it is intentional.

Roman Urdu emotion vocabulary you will encounter:
dar gaya / dar k nikla = got scared and exited
jaldi ki / jaldi kiya = rushed, took entry too fast
level strong tha = the level looked strong/valid
news ane wali thi = news was coming soon
mast trade / zabardast = great trade, felt confident
pata nahi tha = was not sure, uncertain
nahi chahiye tha = should not have taken this trade
लालच aya / lalach aya = greed came in, got greedy
gussa aya = got angry (often after a loss)
dobara entry = re-entered the same trade
band nahi kiya = did not close the trade, held it
SL move kiya = moved the stop loss
TP chhota kar liya = reduced the take profit early
bas yahi tha = that was all the setup showed
koi confirmation nahi tha = no confirmation was there
thaka hua tha = was tired
achanak = suddenly (often indicates surprise/FOMO)

Read between the lines of notes. A trader who writes 'jaldi ki' on 4 losing trades is confessing to a pattern even if they do not realize it. A trader who writes 'dar gaya' on winning trades that were exited early is telling you their fear is costing them money. Extract these confessions and confront the trader with them directly.

DATA INSUFFICIENCY WARNING:
If total trades analyzed is below 20, begin the entire report with this block in red bold:
WARNING: Only [X] trades in this dataset. Statistical patterns below are preliminary observations only — not reliable conclusions. Every finding needs more data to confirm. Add more trades before treating any insight here as proven.

If below 10 trades, refuse to give behavioral analysis and state: Not enough data for behavioral pattern analysis. Log at least 20 trades first.

REPORT FORMAT — follow this exactly, every time:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GOLD JOURNAL — TRADING REPORT CARD
Period: [date range]
Account: [account name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OVERALL GRADE: [A / B / C / D / F]
VERDICT: [One sentence. No softening. What is the single truth about this trader's performance right now.]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SECTION 1 — CORE NUMBERS
State each metric. After each one, give a one-line honest interpretation. Do not just list numbers.

Win Rate: X%
→ [Is this acceptable? Compare to 50% minimum. If below, say how far below and what it means for the account long term]

Profit Factor: X
→ [Below 1.0 = losing money. 1.0–1.5 = barely surviving. 1.5–2.0 = acceptable. Above 2.0 = good. State which category and what it means in plain terms]

Average Win: $X vs Average Loss: $X
→ [Is the trader winning more than they lose per trade? If average loss is bigger than average win, explain why this is dangerous even with a decent win rate]

Planned R:R vs Actual R:R captured: X vs X
→ [If actual is lower than planned, calculate the $ gap and state: This gap cost you $X this period. That is not a small number — it is a habit with a price tag.]

Net P&L: $X
→ [Positive or negative. If negative, state how many weeks at this rate until the account is in serious trouble]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SECTION 2 — EMOTIONAL & PSYCHOLOGICAL ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is the most important section. Read every note. Find the emotional pattern the trader cannot see themselves.

2A. FEAR ANALYSIS
Scan all notes for fear indicators: dar gaya, dar k nikla, scared, nervous, not sure, pata nahi tha, koi confirmation nahi tha, hesitated

For each fear-tagged trade: what was the result? Calculate: win rate on fear trades vs non-fear trades.

State finding directly:
'On X trades where your notes show fear or hesitation, your win rate was Y%. On trades where you showed confidence, it was Z%. [If fear trades perform worse]: Your fear is making you exit good setups early and skip valid entries. Fear is not protecting you — it is costing you money. [If fear trades perform better]: Interesting — your fear may actually be your signal to be cautious. But this needs more data to confirm.'

2B. IMPATIENCE & RUSHING ANALYSIS
Scan notes for: jaldi ki, jaldi kiya, rushed, early entry, achanak, did not wait, entered early

For each impatience-tagged trade: what was the result? How many had mistake tag = Early entry? Calculate $ cost of impatient entries vs patient ones (cross-reference patience score).

State finding:
'You rushed X out of Y trades this period. Patience score on losing trades averaged [X]. On winning trades it averaged [Y]. [If correlation exists]: The data proves your impatience is directly causing losses. Every trade where you scored patience 1 or 2 had a [X]% win rate. Trades with patience 4 or 5 had [Y]% win rate. This is not a theory — it is in your own numbers.'

2C. GREED & FOMO ANALYSIS
Scan notes for: lalach aya, FOMO, chased, missed it, entered late, achanak move dekha, bina setup k

Flag instances where:
- Setup quality was B but market was moving fast
- Entry was in New York or high-volatility session without A/A+ confirmation
- Trader entered after a big candle already moved

State finding:
'FOMO cost you X trades this period. These were trades you took because price was moving, not because your setup was valid. Net P&L on FOMO-tagged trades: -$X. You are paying a FOMO tax of approximately $X per month. Stop chasing. Your setups find you — you do not chase them.'

2D. REVENGE TRADING ANALYSIS
Use pre-defined rules to detect revenge trades: a trade taken within 30 minutes of a loss AND at higher risk than average. Report how many and how much it cost.

2E. DISCIPLINE SCORE
Give a discipline score out of 10. Base it on setup quality distribution, risk consistency, and respect for rules.`;

export function render(container) {
  const savedKey = localStorage.getItem(KEY_STORE) || "";
  const savedReview = loadSavedReview();
  const rangeValue = localStorage.getItem("gj_ai_range") || "last_30";
  const customFrom = localStorage.getItem("gj_ai_from") || "";
  const customTo = localStorage.getItem("gj_ai_to") || "";

  container.innerHTML = `
    <div class="page-head">
      <div><h1 class="page-title">AI Mentor</h1><p class="page-sub">Get an AI review of your trading</p></div>
    </div>
    <div class="ai-shell">
      <div class="glass card-pad ai-settings">
        <h6>Settings</h6>
        <label class="field"><span>OpenRouter API key</span>
          <div class="pw-wrap">
            <input type="password" id="ai-key" placeholder="sk-or-..." value="${escapeHtml(savedKey)}">
            <button type="button" class="pw-toggle" id="ai-key-toggle"><i data-lucide="eye"></i></button>
          </div>
        </label>
        <div class="ai-key-status" id="ai-key-status">${savedKey ? "Key saved locally" : "No key saved"}</div>
        <label class="field"><span>Model</span><input type="text" value="${escapeHtml(AI_MODEL)}" readonly></label>
        <label class="field"><span>Date range</span>
          <select id="ai-range" class="mini-select">
            <option value="last_7" ${rangeValue === "last_7" ? "selected" : ""}>Last 7 days</option>
            <option value="last_30" ${rangeValue === "last_30" ? "selected" : ""}>Last 30 days</option>
            <option value="this_month" ${rangeValue === "this_month" ? "selected" : ""}>This month</option>
            <option value="all_time" ${rangeValue === "all_time" ? "selected" : ""}>All time</option>
            <option value="custom" ${rangeValue === "custom" ? "selected" : ""}>Custom range</option>
          </select>
        </label>
        <div class="ai-custom-range ${rangeValue === "custom" ? "show" : ""}" id="ai-custom-range">
          <label class="field"><span>From</span><input type="date" id="ai-from" value="${escapeHtml(customFrom)}"></label>
          <label class="field"><span>To</span><input type="date" id="ai-to" value="${escapeHtml(customTo)}"></label>
        </div>
        <div class="btn-row">
          <button class="btn btn-gold btn-sm" id="save-key">Save Key</button>
          <button class="btn btn-ghost btn-sm" id="clear-key">Clear Key</button>
        </div>
        <p class="note"><i data-lucide="shield"></i> Your key is stored only in this browser's local storage and never sent to our servers or database.</p>
        <button class="btn btn-gold btn-block mt" id="analyze"><i data-lucide="brain"></i> Analyze Trades</button>
      </div>
      <div class="glass card-pad ai-output" id="ai-output">
        ${savedReview ? renderReview(savedReview) : emptyState()}
      </div>
    </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });

  const keyInput = container.querySelector("#ai-key");
  const keyStatus = container.querySelector("#ai-key-status");
  const rangeSelect = container.querySelector("#ai-range");
  const customRange = container.querySelector("#ai-custom-range");
  const fromInput = container.querySelector("#ai-from");
  const toInput = container.querySelector("#ai-to");

  container.querySelector("#ai-key-toggle").addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });

  container.querySelector("#save-key").addEventListener("click", () => {
    const v = keyInput.value.trim();
    if (!v) return toast("Enter a valid key.", "warning");
    localStorage.setItem(KEY_STORE, v);
    keyStatus.textContent = "Key saved locally";
    toast("API key saved locally.", "success");
  });

  container.querySelector("#clear-key").addEventListener("click", () => {
    localStorage.removeItem(KEY_STORE);
    keyInput.value = "";
    keyStatus.textContent = "No key saved";
    toast("API key cleared.", "info");
  });

  rangeSelect.addEventListener("change", () => {
    const showCustom = rangeSelect.value === "custom";
    customRange.classList.toggle("show", showCustom);
    localStorage.setItem("gj_ai_range", rangeSelect.value);
  });

  [fromInput, toInput].forEach((input) => {
    input?.addEventListener("change", () => {
      localStorage.setItem("gj_ai_from", fromInput.value);
      localStorage.setItem("gj_ai_to", toInput.value);
    });
  });

  container.querySelector("#analyze").addEventListener("click", () => analyze(container));

  if (savedReview) {
    attachReportActions(container.querySelector("#ai-output"), savedReview.text || savedReview);
  }
}

function emptyState() {
  return `<div class="empty-state"><i data-lucide="message-square-text"></i><p>No review yet. Add your OpenRouter key and click <strong>Analyze Trades</strong>.</p></div>`;
}

function loadSavedReview() {
  const raw = localStorage.getItem(REVIEW_STORE) || localStorage.getItem("gj_ai_report");
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && typeof data.text === "string") return data;
  } catch {
    return { text: raw };
  }
  return { text: raw };
}

function saveReview(text, meta = {}) {
  localStorage.setItem(REVIEW_STORE, JSON.stringify({ text, meta }));
}

function renderReview(saved) {
  const review = typeof saved === "string" ? { text: saved } : saved;
  const parsed = parseReview(review.text || "");
  const gradeClass = (parsed.grade || "F").toUpperCase();
  const warningBanner = review.meta?.tradeCount && review.meta.tradeCount < 20 ? `<div class="ai-warning-banner"><strong>WARNING:</strong> Only ${review.meta.tradeCount} trades in this dataset. Insights are preliminary.</div>` : "";

  return `
    <div class="ai-report-shell">
      ${warningBanner}
      <div class="ai-report-toolbar">
        <button class="btn btn-ghost btn-sm" id="copy-report"><i data-lucide="copy"></i> Copy Report</button>
        <button class="btn btn-gold btn-sm" id="download-pdf"><i data-lucide="file-down"></i> Download as PDF</button>
      </div>
      <div class="ai-report-card">
        <div class="ai-grade-row">
          <div class="ai-grade-badge grade-${String(gradeClass).toLowerCase()}">${escapeHtml(parsed.grade || "F")}</div>
          <div>
            <div class="ai-report-title">GOLD JOURNAL — TRADING REPORT CARD</div>
            <div class="ai-report-subtitle">${escapeHtml(parsed.verdict || "")}</div>
          </div>
        </div>
        <div class="ai-report-body">
          ${parsed.sections
            .map(
              (section) => `
            <details class="ai-accordion" ${section.open ? "open" : ""}>
              <summary>${escapeHtml(section.title)}</summary>
              <div class="ai-accordion-body">${mdToHtml(section.body)}</div>
            </details>
          `,
            )
            .join("")}
        </div>
        ${parsed.rules.length ? `
          <div class="ai-rules">
            <h4>Homework Rules</h4>
            <div class="ai-rules-grid">
              ${parsed.rules.map((rule) => `<div class="ai-rule-card">${escapeHtml(rule)}</div>`).join("")}
            </div>
          </div>
        ` : ""}
      </div>
    </div>`;
}

function parseReview(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let currentTitle = "Report";
  let currentBody = [];
  const rules = [];
  let grade = "F";
  let verdict = "";

  const commitSection = () => {
    if (currentBody.length || currentTitle !== "Report") {
      sections.push({ title: currentTitle, body: currentBody.join("\n").trim(), open: currentTitle !== "Report" });
    }
    currentBody = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentBody.push("");
      continue;
    }
    const gradeMatch = line.match(/OVERALL GRADE:\s*([A-F])/i);
    if (gradeMatch) grade = gradeMatch[1].toUpperCase();
    const verdictMatch = line.match(/VERDICT:\s*(.+)$/i);
    if (verdictMatch) verdict = verdictMatch[1].trim();
    const sectionMatch = line.match(/^SECTION\s*\d+\s*[—-]\s*(.+)$/i) || line.match(/^\d+\.\s*(.+)$/);
    if (sectionMatch) {
      commitSection();
      currentTitle = sectionMatch[1].trim();
      continue;
    }
    if (/^Rule\s+\d+:/i.test(line)) {
      rules.push(line);
      continue;
    }
    currentBody.push(line);
  }
  commitSection();

  return { grade, verdict, sections, rules };
}

function mdToHtml(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let inList = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (/^#{1,6}\s/.test(line)) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = Math.min(line.match(/^#+/)[0].length + 2, 6);
      html += `<h${level}>${line.replace(/^#+\s/, "")}</h${level}>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${line.replace(/^\s*[-*]\s+/, "")}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${line}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function parseRange(range) {
  const now = new Date();
  if (!range?.type) return null;
  if (range.type === "last_7") {
    const to = new Date(now);
    const from = new Date(now);
    from.setDate(now.getDate() - 7);
    return { from, to, label: "Last 7 days", type: "last_7" };
  }
  if (range.type === "last_30") {
    const to = new Date(now);
    const from = new Date(now);
    from.setDate(now.getDate() - 30);
    return { from, to, label: "Last 30 days", type: "last_30" };
  }
  if (range.type === "this_month") {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { from, to, label: "This month", type: "this_month" };
  }
  if (range.type === "all_time") {
    return { from: null, to: null, label: "All time", type: "all_time" };
  }
  if (range.type === "custom") {
    const from = range.from ? new Date(`${range.from}T00:00:00`) : null;
    const to = range.to ? new Date(`${range.to}T23:59:59`) : null;
    if (!from || !to || from > to) return null;
    return { from, to, label: `${fmtDate(from)} - ${fmtDate(to)}`, type: "custom" };
  }
  return null;
}

function filterTrades(items, range) {
  const list = Array.isArray(items) ? items : [];
  const selected = parseRange(range);
  if (!selected) return [];
  return list.filter((item) => {
    const dateValue = item.trade_date || item.date || item.created_at || "";
    if (!dateValue) return true;
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return true;
    if (selected.from && d < selected.from) return false;
    if (selected.to && d > selected.to) return false;
    return true;
  });
}

function filterReviews(items, range) {
  const list = Array.isArray(items) ? items : [];
  const selected = parseRange(range);
  if (!selected) return [];
  return list.filter((item) => {
    const dateValue = item.week_of || item.date || item.created_at || "";
    if (!dateValue) return true;
    const d = new Date(dateValue);
    if (Number.isNaN(d.getTime())) return true;
    if (selected.from && d < selected.from) return false;
    if (selected.to && d > selected.to) return false;
    return true;
  });
}

function summarize(range) {
  const trades = filterTrades(state.trades || [], range);
  const skippedTrades = filterTrades(state.skipped || [], range);
  const reviews = filterReviews(state.reviews || [], range);
  const totalTrades = trades.length;
  const wins = trades.filter((x) => String(x.result || "").toLowerCase() === "win").length;
  const losses = trades.filter((x) => String(x.result || "").toLowerCase() === "loss").length;
  const breakEvens = trades.filter((x) => ["breakeven", "break-even", "be"].includes(String(x.result || "").toLowerCase())).length;
  const decided = wins + losses;
  const winRate = decided ? Number(((wins / decided) * 100).toFixed(1)) : 0;
  const pnlValues = trades.map((x) => Number(x.pnl || 0));
  const netPnl = pnlValues.reduce((sum, n) => sum + n, 0);
  const grossProfit = pnlValues.filter((n) => n > 0).reduce((sum, n) => sum + n, 0);
  const grossLoss = pnlValues.filter((n) => n < 0).reduce((sum, n) => sum + Math.abs(n), 0);
  const profitFactor = grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : null;
  const riskValues = trades
    .map((x) => Number(x.risk_amount || x.risk || x.risk_usd || x.risk_dollar || x.risk_dollars || 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const rewardValues = trades
    .map((x) => Number(x.reward_amount || x.reward || x.reward_usd || x.reward_dollar || x.reward_dollars || 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const plannedRRs = trades
    .map((x) => Number(x.r_ratio || x.rr_ratio || x.rr || x.risk_reward || 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  const avgRisk = riskValues.length ? Number((riskValues.reduce((a, b) => a + b, 0) / riskValues.length).toFixed(2)) : 0;
  const avgReward = rewardValues.length ? Number((rewardValues.reduce((a, b) => a + b, 0) / rewardValues.length).toFixed(2)) : 0;
  const avgPlannedRR = plannedRRs.length ? Number((plannedRRs.reduce((a, b) => a + b, 0) / plannedRRs.length).toFixed(2)) : 0;
  const actualRRs = trades
    .map((x) => {
      const risk = Number(x.risk_amount || x.risk || x.risk_usd || x.risk_dollar || x.risk_dollars || 0);
      const pnl = Number(x.pnl || 0);
      return risk > 0 ? pnl / risk : null;
    })
    .filter((n) => Number.isFinite(n));
  const avgActualRR = actualRRs.length ? Number((actualRRs.reduce((a, b) => a + b, 0) / actualRRs.length).toFixed(2)) : 0;

  const noteSignals = trades.map((trade) => {
    const note = String(trade.notes || trade.note || trade.comment || "").toLowerCase();
    return {
      fear: /dar gaya|dar k nikla|scared|nervous|not sure|pata nahi tha|hesitated|koi confirmation nahi tha/.test(note),
      rush: /jaldi ki|jaldi kiya|rushed|early entry|achanak|did not wait|entered early/.test(note),
      greed: /lalach aya|fomo|chased|missed it|entered late|achanak move|bina setup k/.test(note),
    };
  });

  const fearSignals = noteSignals.filter((x) => x.fear).length;
  const rushSignals = noteSignals.filter((x) => x.rush).length;
  const greedSignals = noteSignals.filter((x) => x.greed).length;

  return {
    range: parseRange(range),
    account: state.accounts?.find((a) => a.id === state.currentAccountId)?.name || "Unknown account",
    totalTrades,
    wins,
    losses,
    breakEvens,
    winRate,
    netPnl: Number(netPnl.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    profitFactor,
    averageRisk: avgRisk,
    averageReward: avgReward,
    averagePlannedRR: avgPlannedRR,
    averageActualRR: avgActualRR,
    tradeCount: totalTrades,
    fearSignals,
    rushSignals,
    greedSignals,
    trades: trades.map((x) => ({
      date: x.trade_date,
      session: x.session,
      level: x.level,
      timeframe: x.timeframe,
      setup_quality: x.setup_quality,
      confirmation_type: x.confirmation_type,
      market_condition: x.market_condition,
      bias_alignment: x.bias_alignment,
      patience_score: x.patience_score,
      mistake_tag: x.mistake_tag || x.mistake,
      hold_quality: x.hold_quality,
      risk_amount: x.risk_amount || x.risk || x.risk_usd || x.risk_dollar || x.risk_dollars || null,
      reward_amount: x.reward_amount || x.reward || x.reward_usd || x.reward_dollar || x.reward_dollars || null,
      rr_ratio: x.r_ratio || x.rr_ratio || x.rr || x.risk_reward || null,
      result: x.result,
      pnl: Number(x.pnl || 0),
      notes: x.notes || x.note || x.comment || "",
    })),
    skippedTrades: skippedTrades.map((x) => ({
      date: x.trade_date,
      session: x.session,
      level: x.level,
      setup_quality: x.setup_quality,
      result: x.result,
      notes: x.notes || x.note || x.comment || "",
    })),
    weeklyReviews: reviews.map((x) => ({ week_of: x.week_of || x.date, learned: x.learned, pattern: x.pattern, improve: x.improve })),
  };
}

async function analyze(container) {
  const savedKey = localStorage.getItem(KEY_STORE) || "";
  const out = container.querySelector("#ai-output");
  const btn = container.querySelector("#analyze");
  if (!savedKey) {
    out.innerHTML = `<div class="ai-error-state"><p>No API key saved. Enter your OpenRouter key above.</p></div>`;
    return toast("No API key saved. Enter your OpenRouter key above.", "warning");
  }

  if (!Array.isArray(state.trades) || !state.trades.length) {
    out.innerHTML = `<div class="ai-error-state"><p>No trades to analyze.</p></div>`;
    return toast("No trades to analyze.", "warning");
  }

  const rangeSelect = container.querySelector("#ai-range");
  const fromInput = container.querySelector("#ai-from");
  const toInput = container.querySelector("#ai-to");
  const range = {
    type: rangeSelect.value,
    from: fromInput?.value || "",
    to: toInput?.value || "",
  };

  if (range.type === "custom" && (!range.from || !range.to)) {
    out.innerHTML = `<div class="ai-error-state"><p>Please choose both a start and end date for the custom range.</p></div>`;
    return toast("Choose both dates for the custom range.", "warning");
  }

  const summary = summarize(range);
  const rangeLabel = summary.range?.label || range.type;
  const requestData = {
    account: summary.account,
    dateRange: rangeLabel,
    totalTrades: summary.totalTrades,
    summaryStats: {
      winRate: summary.winRate,
      profitFactor: summary.profitFactor,
      netPnl: summary.netPnl,
      averageRisk: summary.averageRisk,
      averageReward: summary.averageReward,
      averagePlannedRR: summary.averagePlannedRR,
      averageActualRR: summary.averageActualRR,
      grossProfit: summary.grossProfit,
      grossLoss: summary.grossLoss,
    },
    tradeCount: summary.tradeCount,
    tradeSequence: summary.trades.slice(-50),
    skippedTrades: summary.skippedTrades,
    weeklyReviews: summary.weeklyReviews,
    emotionSignals: {
      fearCount: summary.fearSignals,
      rushCount: summary.rushSignals,
      greedCount: summary.greedSignals,
    },
  };

  btn.disabled = true;
  btn.classList.add("loading");
  out.innerHTML = `<div class="ai-loading"><div class="ai-orb"></div><p>${PROGRESS_MESSAGES[0]}</p></div>`;
  let tick = 1;
  const progressTimer = setInterval(() => {
    const paragraph = out.querySelector(".ai-loading p");
    if (paragraph) paragraph.textContent = PROGRESS_MESSAGES[tick % PROGRESS_MESSAGES.length];
    tick += 1;
  }, 3000);

  try {
    const userContent = `Analyze this trader's journal data and return the report exactly in the requested structure.\n\nDATA:\n${JSON.stringify(requestData, null, 2)}`;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${savedKey}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (response.status === 401) throw new Error("Invalid OpenRouter API key.");
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenRouter error ${response.status}${text ? `: ${text}` : ""}`);
    }

    const json = await response.json();
    const report = json?.choices?.[0]?.message?.content;
    if (!report) throw new Error("Empty response from model.");

    saveReview(report, { tradeCount: summary.totalTrades });
    out.innerHTML = renderReview({ text: report, meta: { tradeCount: summary.totalTrades } });
    attachReportActions(out, report);
    window.lucide?.createIcons({ nameAttr: "data-lucide" });
    toast("Review generated.", "success");
  } catch (error) {
    out.innerHTML = `<div class="ai-error-state"><p>${escapeHtml(error.message || "AI request failed.")}</p></div>`;
    window.lucide?.createIcons({ nameAttr: "data-lucide" });
    toast(error.message || "AI request failed.", "error");
  } finally {
    clearInterval(progressTimer);
    btn.disabled = false;
    btn.classList.remove("loading");
  }
}

function attachReportActions(container, text) {
  container.querySelector("#copy-report")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Report copied to clipboard.", "success");
    } catch {
      toast("Clipboard access is unavailable.", "warning");
    }
  });

  container.querySelector("#download-pdf")?.addEventListener("click", () => {
    const printWindow = window.open("", "_blank", "width=900,height=900");
    if (!printWindow) {
      toast("Please allow popups to print the report.", "warning");
      return;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>AI Mentor Report</title><style>body{font-family:Inter,system-ui,sans-serif;padding:24px;color:#111;background:#fff}pre{white-space:pre-wrap;font-size:13px;line-height:1.5}h1{font-size:24px;margin-bottom:16px}</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  });
}
