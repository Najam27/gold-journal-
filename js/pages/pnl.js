import { state, currentAccount } from "../store.js";
import { fmtMoney } from "../ui.js";

let cursor = new Date();
cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);

export function render(container) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthName = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const daily = dailyStats(year, month);

  container.innerHTML = `
  <div class="page-head pnl-head">
    <div><h1 class="page-title">${monthName}</h1></div>
    <div class="page-actions">
      <button class="btn btn-ghost" id="prev"><i data-lucide="chevron-left"></i></button>
      <button class="btn btn-ghost" id="today">This Month</button>
      <button class="btn btn-ghost" id="next"><i data-lucide="chevron-right"></i></button>
    </div>
  </div>

  <div class="calendar weekly-calendar glass" id="calendar">
    <div class="weekly-dow">
      <div></div>
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
    </div>
    <div id="cal-body">${weeksHtml(year, month, daily)}</div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  const anim = container.querySelector("#cal-body");
  anim.classList.add("cal-in");

  container.querySelector("#prev").addEventListener("click", () => { cursor = new Date(year, month - 1, 1); render(container); });
  container.querySelector("#next").addEventListener("click", () => { cursor = new Date(year, month + 1, 1); render(container); });
  container.querySelector("#today").addEventListener("click", () => { const n = new Date(); cursor = new Date(n.getFullYear(), n.getMonth(), 1); render(container); });
}

function dailyStats(year, month) {
  const map = {};
  for (const t of state.trades) {
    const d = new Date(t.trade_date + "T00:00:00");
    if (d.getFullYear() === year && d.getMonth() === month) {
      const key = t.trade_date;
      if (!map[key]) map[key] = { pnl: 0, trades: 0, wins: 0, losses: 0 };
      map[key].pnl += Number(t.pnl || 0);
      map[key].trades++;
      if (t.result === "Win") map[key].wins++;
      if (t.result === "Loss") map[key].losses++;
    }
  }
  return map;
}

function weeksHtml(year, month, daily) {
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const weeks = [];
  let week = Array(7).fill(null);
  for (let i = 0; i < startDow; i++) week[i] = null;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month, d).getDay();
    week[dow] = d;
    if (dow === 6 || d === days) {
      weeks.push(week);
      week = Array(7).fill(null);
    }
  }
  const base = Number(currentAccount()?.starting_balance || 0);
  const max = Math.max(1, ...Object.values(daily).map((v) => Math.abs(v.pnl)));
  let html = "";
  weeks.forEach((daysInWeek, i) => {
    const weekStats = daysInWeek.reduce((acc, d) => {
      if (!d) return acc;
      const key = keyFor(year, month, d);
      const stats = daily[key];
      if (!stats) return acc;
      acc.pnl += Number(stats.pnl || 0);
      acc.trades += stats.trades;
      acc.wins += stats.wins;
      acc.losses += stats.losses;
      return acc;
    }, { pnl: 0, trades: 0, wins: 0, losses: 0 });
    const weekTotal = weekStats.pnl;
    const pct = base ? (weekTotal / base) * 100 : 0;
    const weekMood = weekStats.wins > weekStats.losses ? "week-win" : weekStats.losses > weekStats.wins ? "week-loss" : "";
    html += `<div class="week-row">
      <div class="week-summary ${weekMood}">
        <div class="week-label">Week ${i + 1} <span class="${pct >= 0 ? "pos" : "neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span></div>
        <div class="week-pnl">${fmtMoney(weekTotal)}</div>
        <div class="week-wl">${weekStats.trades ? `${weekStats.wins}W / ${weekStats.losses}L` : "0W / 0L"}</div>
      </div>
      <div class="week-days">${daysInWeek.map((d) => dayCell(year, month, d, daily, max)).join("")}</div>
    </div>`;
  });
  return html;
}

function keyFor(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dayCell(year, month, day, daily, max) {
  if (!day) return `<div class="cal-cell empty"></div>`;
  const stats = daily[keyFor(year, month, day)];
  let cls = "cal-cell", style = "";
  if (stats) {
    const intensity = Math.min(1, Math.abs(stats.pnl) / max);
    const alpha = 0.46 + intensity * 0.28;
    if (stats.pnl > 0) { cls += " pos"; style = `background:rgba(14,83,48,${alpha})`; }
    else if (stats.pnl < 0) { cls += " neg"; style = `background:rgba(103,25,30,${alpha})`; }
  }
  const decided = stats ? stats.wins + stats.losses : 0;
  const winRate = decided ? Math.round((stats.wins / decided) * 100) : 0;
  return `<div class="${cls}" style="${style}">
    <span class="cal-day">${day}</span>
    ${stats ? `<div class="cal-cell-data"><span class="cal-pnl">${fmtMoney(stats.pnl)}</span><span class="cal-detail">${stats.trades} trades | ${winRate}%</span></div>` : ""}
  </div>`;
}
