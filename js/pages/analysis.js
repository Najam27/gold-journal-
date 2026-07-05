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
  </div>
  <div class="heatmap-card glass">
    <div class="heatmap-head">
      <h6>Performance Heatmap</h6>
      <div class="heatmap-tabs">
        ${["edge", "hour", "session", "level", "tf", "setup"].map((tab) => `<button class="heatmap-tab ${tab === "edge" ? "active" : ""}" data-heatmap="${tab}">${heatmapTabLabel(tab)}</button>`).join("")}
      </div>
    </div>
    <div id="heatmap-body">${heatmapHtml("edge")}</div>
  </div>`}`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  container.querySelector("#btn-demo").addEventListener("click", () => loadDemo(() => render(container)));
  if (trades.length) {
    wireHeatmap(container);
    drawCharts();
  }
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

function heatmapTabLabel(tab) {
  return { edge: "Level Edge", hour: "By Hour", session: "By Session", level: "By Level", tf: "By TF", setup: "By Setup" }[tab];
}

function wireHeatmap(container) {
  const body = container.querySelector("#heatmap-body");
  container.querySelectorAll("[data-heatmap]").forEach((btn) => {
    btn.addEventListener("click", () => {
      container.querySelectorAll("[data-heatmap]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      body.innerHTML = heatmapHtml(btn.dataset.heatmap);
    });
  });
}

function heatmapHtml(tab) {
  if (tab === "edge") return levelEdgeHtml();
  if (tab === "hour") return hourHeatmapHtml();
  const configs = {
    session: ["Session", (t) => t.session, state.options.sessions],
    level: ["Level", (t) => t.level, state.options.levels],
    tf: ["TF", (t) => t.timeframe, state.options.timeframes],
    setup: ["Setup", (t) => t.setup_quality, state.options.setupQuality],
  };
  const [label, keyFn, defaults] = configs[tab];
  return dimensionHeatmapHtml(label, keyFn, defaults);
}

function resultCounts(trades) {
  const wins = trades.filter((t) => t.result === "Win").length;
  const losses = trades.filter((t) => t.result === "Loss").length;
  const decided = wins + losses;
  const pnl = trades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  return { total: trades.length, wins, losses, pnl, avgPnl: trades.length ? pnl / trades.length : 0, winRate: decided ? (wins / decided) * 100 : 0 };
}

function heatClass(stats) {
  if (!stats.total) return "";
  if (stats.winRate > 60) return "hm-pos";
  if (stats.winRate < 40) return "hm-neg";
  return "hm-mid";
}

function hourHeatmapHtml() {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const blocks = [
    ["00-04", 0, 3],
    ["04-08", 4, 7],
    ["08-12", 8, 11],
    ["12-16", 12, 15],
    ["16-20", 16, 19],
    ["20-24", 20, 23],
  ];
  const buckets = Array.from({ length: 7 }, () => blocks.map(() => []));
  for (const t of state.trades) {
    const base = t.created_at ? new Date(t.created_at) : new Date(`${t.trade_date}T00:00:00Z`);
    if (Number.isNaN(base.getTime())) continue;
    const pkt = new Date(base.getTime() + 5 * 60 * 60 * 1000);
    const day = pkt.getUTCDay();
    const hour = pkt.getUTCHours();
    const block = blocks.findIndex(([, start, end]) => hour >= start && hour <= end);
    if (block >= 0) buckets[day][block].push(t);
  }
  return `<div class="hm-hour-grid">
    <div></div>
    ${blocks.map(([label]) => `<div class="hm-col-head">${label}</div>`).join("")}
    ${days.map((day, dayIndex) => `
      <div class="hm-row-head">${day}</div>
      ${blocks.map((_, blockIndex) => {
        const stats = resultCounts(buckets[dayIndex][blockIndex]);
        return `<div class="hm-cell ${heatClass(stats)}">${stats.total ? `<strong>${stats.total} trades</strong><span>${stats.wins}W / ${stats.losses}L</span>` : ""}</div>`;
      }).join("")}
    `).join("")}
  </div>`;
}

function dimensionHeatmapHtml(label, keyFn, defaults = []) {
  const values = [...new Set([...(defaults || []), ...state.trades.map(keyFn).filter(Boolean)])];
  if (!values.length) return `<div class="empty-state">No ${label.toLowerCase()} data yet.</div>`;
  return `<div class="hm-dim-grid">
    <div class="hm-col-head">${label}</div>
    <div class="hm-col-head">Total Trades</div>
    <div class="hm-col-head">Wins</div>
    <div class="hm-col-head">Losses</div>
    <div class="hm-col-head">Win Rate %</div>
    ${values.map((value) => {
      const stats = resultCounts(state.trades.filter((t) => keyFn(t) === value));
      return `<div class="hm-row-label ${heatClass(stats)}">${escapeHtml(value)}</div>
        <div class="hm-metric ${heatClass(stats)}">${stats.total}</div>
        <div class="hm-metric ${heatClass(stats)}">${stats.wins}</div>
        <div class="hm-metric ${heatClass(stats)}">${stats.losses}</div>
        <div class="hm-metric ${heatClass(stats)}">${stats.total ? stats.winRate.toFixed(1) : "0.0"}%</div>`;
    }).join("")}
  </div>`;
}

function levelEdgeHtml() {
  const combos = new Map();
  for (const t of state.trades) {
    const level = t.level || "-";
    const tf = t.timeframe || "-";
    const session = t.session || "-";
    const key = `${level}|||${tf}|||${session}`;
    if (!combos.has(key)) combos.set(key, { level, tf, session, trades: [] });
    combos.get(key).trades.push(t);
  }
  const rows = [...combos.values()]
    .map((row) => ({ ...row, stats: resultCounts(row.trades) }))
    .sort((a, b) => b.stats.winRate - a.stats.winRate || b.stats.pnl - a.stats.pnl || b.stats.total - a.stats.total);
  if (!rows.length) return `<div class="empty-state">No level data yet.</div>`;

  const topRows = rows.filter((row) => row.stats.total > 0 && row.stats.pnl > 0).slice(0, 4);
  return `
    <div class="edge-summary">
      ${topRows.length ? topRows.map((row) => edgeCard(row)).join("") : `<div class="edge-empty">No profitable level combinations yet.</div>`}
    </div>
    <div class="edge-grid">
      <div class="hm-col-head">Level</div>
      <div class="hm-col-head">TF</div>
      <div class="hm-col-head">Session</div>
      <div class="hm-col-head">Trades</div>
      <div class="hm-col-head">W / L</div>
      <div class="hm-col-head">Win Rate</div>
      <div class="hm-col-head">Net P&L</div>
      <div class="hm-col-head">Avg P&L</div>
      ${rows.map((row) => {
        const cls = edgeClass(row.stats);
        return `<div class="edge-cell edge-main ${cls}">${escapeHtml(row.level)}</div>
          <div class="edge-cell ${cls}">${escapeHtml(row.tf)}</div>
          <div class="edge-cell ${cls}">${escapeHtml(row.session)}</div>
          <div class="edge-cell ${cls}">${row.stats.total}</div>
          <div class="edge-cell ${cls}">${row.stats.wins}W / ${row.stats.losses}L</div>
          <div class="edge-cell ${cls}">${row.stats.winRate.toFixed(1)}%</div>
          <div class="edge-cell ${cls}">${fmtMoney(row.stats.pnl)}</div>
          <div class="edge-cell ${cls}">${fmtMoney(row.stats.avgPnl)}</div>`;
      }).join("")}
    </div>`;
}

function edgeCard(row) {
  return `<div class="edge-card ${edgeClass(row.stats)}">
    <div class="edge-card-title">${escapeHtml(row.level)}</div>
    <div class="edge-card-sub">${escapeHtml(row.tf)} &middot; ${escapeHtml(row.session)}</div>
    <div class="edge-card-metrics">
      <span>${row.stats.total} trades</span>
      <span>${row.stats.wins}W / ${row.stats.losses}L</span>
      <span>${row.stats.winRate.toFixed(1)}%</span>
      <span>${fmtMoney(row.stats.pnl)}</span>
    </div>
  </div>`;
}

function edgeClass(stats) {
  if (!stats.total) return "";
  if (stats.pnl > 0 && stats.winRate >= 60) return "hm-pos";
  if (stats.pnl < 0 || stats.winRate < 40) return "hm-neg";
  return "hm-mid";
}

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
