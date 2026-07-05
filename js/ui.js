// Small UI helpers: toasts, confirm dialogs, formatting, DOM utilities.

let toastSeq = 0;

export function toast(message, type = "info", timeout = 4200) {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const id = `toast-${++toastSeq}`;
  const icons = {
    success: "check-circle",
    error: "alert-triangle",
    info: "info",
    warning: "alert-circle",
  };
  const el = document.createElement("div");
  el.className = `gj-toast gj-toast-${type}`;
  el.id = id;
  el.setAttribute("role", "alert");
  el.innerHTML = `
    <i data-lucide="${icons[type] || "info"}"></i>
    <span class="gj-toast-msg"></span>
    <button class="gj-toast-close" aria-label="Dismiss">&times;</button>`;
  el.querySelector(".gj-toast-msg").textContent = message;
  container.appendChild(el);
  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  requestAnimationFrame(() => el.classList.add("show"));
  const remove = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  };
  el.querySelector(".gj-toast-close").addEventListener("click", remove);
  if (timeout) setTimeout(remove, timeout);
  return id;
}

// Promise-based confirmation dialog (used before destructive actions).
export function confirmDialog({
  title = "Are you sure?",
  body = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = true,
} = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.className = "gj-modal-backdrop show";
    wrap.innerHTML = `
      <div class="gj-modal gj-modal-sm" role="dialog" aria-modal="true">
        <div class="gj-modal-header">
          <h5 class="gj-modal-title"></h5>
        </div>
        <div class="gj-modal-body"><p class="gj-confirm-body"></p></div>
        <div class="gj-modal-footer">
          <button class="btn btn-ghost" data-act="cancel"></button>
          <button class="btn ${danger ? "btn-danger" : "btn-gold"}" data-act="ok"></button>
        </div>
      </div>`;
    wrap.querySelector(".gj-modal-title").textContent = title;
    wrap.querySelector(".gj-confirm-body").textContent = body;
    wrap.querySelector('[data-act="cancel"]').textContent = cancelText;
    wrap.querySelector('[data-act="ok"]').textContent = confirmText;
    document.body.appendChild(wrap);
    window.lucide?.createIcons({ nameAttr: "data-lucide" });
    const close = (val) => {
      wrap.classList.remove("show");
      setTimeout(() => wrap.remove(), 200);
      resolve(val);
    };
    wrap.querySelector('[data-act="ok"]').addEventListener("click", () => close(true));
    wrap.querySelector('[data-act="cancel"]').addEventListener("click", () => close(false));
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) close(false);
    });
  });
}

// ---------- formatting ----------
export const fmtMoney = (n, currency = "$") => {
  const v = Number(n || 0);
  const sign = v < 0 ? "-" : "";
  return `${sign}${currency}${Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export const fmtNum = (n, d = 2) =>
  Number(n || 0).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

export const fmtPct = (n, d = 1) => `${Number(n || 0).toFixed(d)}%`;

export const fmtDate = (d) => {
  if (!d) return "";
  if (typeof d === "string") {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
};

export const fmtRR = (risk, reward) => {
  const r = Number(risk);
  if (!Number.isFinite(r) || r === 0) return "—";
  const w = Number(reward || 0);
  return `1 : ${(w / r).toFixed(2)}`;
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

export function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// Animated count-up for stat values.
export function countUp(el, to, { money = false, pct = false, dur = 700 } = {}) {
  if (!el) return;
  const from = Number(el.dataset.value || 0);
  const target = Number(to || 0);
  el.dataset.value = target;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - t, 3);
    const val = from + (target - from) * eased;
    el.textContent = money ? fmtMoney(val) : pct ? fmtPct(val) : fmtNum(val, 0);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Build a <select> option list, keeping a current value selected.
export function optionsHtml(list, current, { placeholder = "" } = {}) {
  const opts = [];
  if (placeholder) opts.push(`<option value="">${escapeHtml(placeholder)}</option>`);
  for (const item of list || []) {
    const sel = String(item) === String(current) ? "selected" : "";
    opts.push(`<option value="${escapeHtml(item)}" ${sel}>${escapeHtml(item)}</option>`);
  }
  return opts.join("");
}

export function skeletonRows(cols, rows = 6) {
  let html = "";
  for (let r = 0; r < rows; r++) {
    html += "<tr>";
    for (let c = 0; c < cols; c++) html += '<td><span class="gj-skel"></span></td>';
    html += "</tr>";
  }
  return html;
}
