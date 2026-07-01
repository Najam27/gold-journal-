import { state, saveTrade, currentAccount } from "../store.js";
import { toast, fmtPct, fmtMoney, escapeHtml, todayISO } from "../ui.js";

let chartLibLoaded = false;
const charts = [];

async function loadChartJs() {
  if (chartLibLoaded && window.Chart) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
    s.onload = resolve; s.onerror = () => reject(new Error("Chart.js failed to load"));
    document.head.appendChild(s);
  });
  chartLibLoaded = true;
}

function groupStats(keyFn) {
  const map = new Map();
  for (const t of state.trades) {
    const k = keyFn(t) || "—";
    if (!map.has(k)) map.set(k, { wins: 0, losses: 0, pnl: 0, n: 0 });
    const g = map.get(k);
    g.n++; g.pnl += Number(t.pnl || 0);
    if (t.result === "Win") g.wins++;
    if (t.result === "Loss") g.losses++;
  }
  return map;
}

export function render(container) {
  const trades = state.trades;
  const wins = trades.filter((t) => t.result === "Win").length;
  const losses = trades.filter((t) => t.result === "Loss").length;
  const decided = wins + losses;
  const winRate = decided ? (wins / decided) * 100 : 0;
  const avgWin = wins ? trades.filter((t) => t.result === "Win").reduce((s, t) => s + Number(t.pnl || 0), 0) / wins : 0;
  const avgLoss = losses ? trades.filter((t) => t.result === "Loss").reduce((s, t) => s + Number(t.pnl || 0), 0) / losses : 0;

  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Analysis</h1><p class="page-sub">Auto-generated performance analytics</p></div>
    <div class="page-actions"><button class="btn btn-ghost" id="btn-demo"><i data-lucide="sparkles"></i> Load Demo Data</button></div>
  </div>

  <div class="stat-strip">
    ${stat("Win Rate", fmtPct(winRate), "target")}
    ${stat("Avg Win", fmtMoney(avgWin), "trending-up", true)}
    ${stat("Avg Loss", fmtMoney(avgLoss), "trending-down", true)}
    ${stat("Sample", `${decided}`, "database")}
  </div>

  ${trades.length === 0 ? `<div class="empty-state big glass"><i data-lucide="bar-chart-3"></i><p>No trades to analyse yet.<br>Log trades or click <strong>Load Demo Data</strong>.</p></div>` : `
  <div class="chart-grid">
    <div class="chart-card glass"><h6>Equity Curve</h6><canvas id="c-equity"></canvas></div>
    <div class="chart-card glass"><h6>Win / Loss / BE</h6><canvas id="c-results"></canvas></div>
    <div class="chart-card glass"><h6>P&L by Session</h6><canvas id="c-session"></canvas></div>
    <div class="chart-card glass"><h6>Win rate by Setup Quality</h6><canvas id="c-setup"></canvas></div>
    <div class="chart-card glass"><h6>P&L by Level</h6><canvas id="c-level"></canvas></div>
    <div class="chart-card glass"><h6>P&L by Confirmation</h6><canvas id="c-confirm"></canvas></div>
    <div class="chart-card glass wide"><h6>Common Mistakes</h6><canvas id="c-mistakes"></canvas></div>
  </div>`}`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  container.querySelector("#btn-demo").addEventListener("click", () => loadDemo(() => render(container)));
  if (trades.length) drawCharts();
}

function stat(label, value, icon, money) {
  return `<div class="stat-card glass"><div class="stat-glow"></div><div class="stat-icon"><i data-lucide="${icon}"></i></div>
    <div class="stat-meta"><div class="stat-label">${label}</div><div class="stat-value ${money ? "money" : ""}">${value}</div></div></div>`;
}

const GOLD = "#d4af37";
const GREEN = "#3ecf8e";
const RED = "#ff5c6c";
const GRID = "rgba(255,255,255,0.06)";
const TICK = "#8b93a7";

async function drawCharts() {
  try {
    await loadChartJs();
  } catch (e) {
    toast("Couldn't load charts (network).", "error");
    return;
  }
  const Chart = window.Chart;
  Chart.defaults.color = TICK;
  Chart.defaults.font.family = "Inter, sans-serif";
  charts.forEach((c) => c.destroy());
  charts.length = 0;

  const mk = (id, cfg) => {
    const el = document.getElementById(id);
    if (el) charts.push(new Chart(el, cfg));
  };
  const baseScales = { y: { grid: { color: GRID }, ticks: { color: TICK } }, x: { grid: { color: GRID }, ticks: { color: TICK } } };
  const noLegend = { plugins: { legend: { display: false } }, responsive: true, maintainAspectRatio: false, animation: { duration: 600 } };

  // equity curve
  let bal = Number(currentAccount()?.starting_balance || 0);
  const eqLabels = [], eqData = [];
  [...state.trades].forEach((t, i) => { bal += Number(t.pnl || 0); eqLabels.push(i + 1); eqData.push(bal); });
  mk("c-equity", {
    type: "line",
    data: { labels: eqLabels, datasets: [{ data: eqData, borderColor: GOLD, backgroundColor: "rgba(212,175,55,0.12)", fill: true, tension: 0.3, pointRadius: 0 }] },
    options: { ...noLegend, scales: baseScales },
  });

  // results doughnut
  const wins = state.trades.filter((t) => t.result === "Win").length;
  const losses = state.trades.filter((t) => t.result === "Loss").length;
  const be = state.trades.filter((t) => t.result === "Break-even").length;
  mk("c-results", {
    type: "doughnut",
    data: { labels: ["Win", "Loss", "Break-even"], datasets: [{ data: [wins, losses, be], backgroundColor: [GREEN, RED, "#8b93a7"], borderWidth: 0 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "bottom" } }, animation: { duration: 600 } },
  });

  const pnlByGroup = (map, id) => {
    const labels = [...map.keys()];
    const data = labels.map((k) => map.get(k).pnl);
    mk(id, {
      type: "bar",
      data: { labels, datasets: [{ data, backgroundColor: data.map((v) => (v >= 0 ? GREEN : RED)) }] },
      options: { ...noLegend, scales: baseScales },
    });
  };
  pnlByGroup(groupStats((t) => t.session), "c-session");
  pnlByGroup(groupStats((t) => t.level), "c-level");
  pnlByGroup(groupStats((t) => t.confirmation_type), "c-confirm");

  // win rate by setup
  const setupMap = groupStats((t) => t.setup_quality);
  const sLabels = [...setupMap.keys()];
  const sData = sLabels.map((k) => { const g = setupMap.get(k); const d = g.wins + g.losses; return d ? (g.wins / d) * 100 : 0; });
  mk("c-setup", {
    type: "bar",
    data: { labels: sLabels, datasets: [{ data: sData, backgroundColor: GOLD }] },
    options: { ...noLegend, scales: { ...baseScales, y: { ...baseScales.y, max: 100, ticks: { color: TICK, callback: (v) => v + "%" } } } },
  });

  // mistakes
  const mMap = groupStats((t) => t.mistake);
  const mLabels = [...mMap.keys()];
  const mData = mLabels.map((k) => mMap.get(k).n);
  mk("c-mistakes", {
    type: "bar",
    data: { labels: mLabels, datasets: [{ data: mData, backgroundColor: "#c77dff" }] },
    options: { ...noLegend, indexAxis: "y", scales: baseScales },
  });
}

async function loadDemo(onDone) {
  const o = state.options;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  toast("Generating demo trades…", "info");
  try {
    for (let i = 0; i < 18; i++) {
      const result = pick(["Win", "Win", "Loss", "Break-even"]);
      const risk = 100 + Math.floor(Math.random() * 150);
      const pnl = result === "Win" ? risk * (1 + Math.random() * 2) : result === "Loss" ? -risk : 0;
      const d = new Date();
      d.setDate(d.getDate() - (18 - i) * 2);
      await saveTrade({
        trade_date: d.toISOString().slice(0, 10),
        session: pick(o.sessions), side: pick(o.sides), level: pick(o.levels), timeframe: pick(o.timeframes),
        setup_quality: pick(o.setupQuality), confirmation_type: pick(o.confirmationType),
        market_condition: pick(o.marketCondition), bias_alignment: pick(o.biasAlignment),
        sl_placement: pick(o.slPlacement), tp_placement: pick(o.tpPlacement),
        patience_score: 1 + Math.floor(Math.random() * 5), mistake: pick(o.mistakeTypes), hold_quality: pick(o.holdQuality),
        risk_amount: risk, reward_amount: Math.max(0, pnl), pnl: Math.round(pnl * 100) / 100, result,
        notes: "Demo trade",
      });
    }
    toast("Demo data loaded.", "success");
    onDone?.();
  } catch (e) { toast(e.message || "Failed to load demo data.", "error"); }
}
