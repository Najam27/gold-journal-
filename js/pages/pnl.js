import { state } from "../store.js";
import { fmtMoney } from "../ui.js";

let cursor = new Date();
cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);

export function render(container) {
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthName = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const daily = dailyPnl(year, month);
  const monthTotal = Object.values(daily).reduce((s, v) => s + v, 0);
  const green = Object.values(daily).filter((v) => v > 0).length;
  const red = Object.values(daily).filter((v) => v < 0).length;

  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">P&amp;L Calendar</h1><p class="page-sub">Daily profit / loss heatmap</p></div>
    <div class="page-actions">
      <button class="btn btn-ghost" id="prev"><i data-lucide="chevron-left"></i></button>
      <button class="btn btn-ghost" id="today">This Month</button>
      <button class="btn btn-ghost" id="next"><i data-lucide="chevron-right"></i></button>
    </div>
  </div>

  <div class="stat-strip">
    ${stat("Month", monthName, "calendar")}
    ${stat("Net P&L", fmtMoney(monthTotal), "sigma", true)}
    ${stat("Green Days", green, "trending-up")}
    ${stat("Red Days", red, "trending-down")}
  </div>

  <div class="calendar glass" id="calendar">
    <div class="cal-grid cal-head">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}
    </div>
    <div class="cal-grid" id="cal-body">${cellsHtml(year, month, daily)}</div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  const anim = container.querySelector("#cal-body");
  anim.classList.add("cal-in");

  container.querySelector("#prev").addEventListener("click", () => { cursor = new Date(year, month - 1, 1); render(container); });
  container.querySelector("#next").addEventListener("click", () => { cursor = new Date(year, month + 1, 1); render(container); });
  container.querySelector("#today").addEventListener("click", () => { const n = new Date(); cursor = new Date(n.getFullYear(), n.getMonth(), 1); render(container); });
}

function stat(label, value, icon, money) {
  return `<div class="stat-card glass"><div class="stat-glow"></div><div class="stat-icon"><i data-lucide="${icon}"></i></div>
    <div class="stat-meta"><div class="stat-label">${label}</div><div class="stat-value ${money ? "money" : ""}">${value}</div></div></div>`;
}

function dailyPnl(year, month) {
  const map = {};
  for (const t of state.trades) {
    const d = new Date(t.trade_date + "T00:00:00");
    if (d.getFullYear() === year && d.getMonth() === month) {
      const key = t.trade_date;
      map[key] = (map[key] || 0) + Number(t.pnl || 0);
    }
  }
  return map;
}

function cellsHtml(year, month, daily) {
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const vals = Object.values(daily).map(Math.abs);
  const max = Math.max(1, ...vals);
  let html = "";
  for (let i = 0; i < startDow; i++) html += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= days; d++) {
    const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const pnl = daily[key];
    let cls = "cal-cell", style = "";
    if (pnl !== undefined) {
      const intensity = Math.min(1, Math.abs(pnl) / max);
      const alpha = 0.18 + intensity * 0.6;
      if (pnl > 0) { cls += " pos"; style = `background:rgba(62,207,142,${alpha})`; }
      else if (pnl < 0) { cls += " neg"; style = `background:rgba(255,92,108,${alpha})`; }
      else { cls += " be"; }
    }
    html += `<div class="${cls}" style="${style}">
      <span class="cal-day">${d}</span>
      ${pnl !== undefined ? `<span class="cal-pnl">${fmtMoney(pnl)}</span>` : ""}
    </div>`;
  }
  return html;
}
