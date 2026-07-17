import {
  state, saveDailyPlan, switchAccount, getActiveTradingRules, currentAccount,
} from "../store.js";
import { BIAS_OPTIONS, EMOTION_OPTIONS } from "../defaults.js";
import { getPKTDate } from "../goalsEngine.js";
import { toast, escapeHtml, todayISO } from "../ui.js";

let cursor = new Date();
cursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
let selectedDate = todayISO();
let formDirty = false;
let savedSnapshot = null;
let showAutoFillNote = false;

const EXEC_SCORE_LABELS = {
  1: "Poor — broke multiple rules",
  2: "Below average — inconsistent",
  3: "Average — some good, some bad",
  4: "Good — mostly disciplined",
  5: "Excellent — full rule compliance",
};

function sessionShortName(full) {
  const map = {
    "Pre-Asian (3am-5am)": "Pre-Asian",
    "Asian (5am-8am)": "Asian",
    "Post-Asian (8am-10am)": "Post-Asian",
    "Pre-London (10am-12pm)": "Pre-London",
    "London (12pm-2pm)": "London",
    "Post-London (2pm-4pm)": "Post-London",
    "Pre-NY (4pm-5pm)": "Pre-NY",
    "New York (5pm-8pm)": "New York",
    "Post-NY (8pm-3am)": "Post-NY",
  };
  return map[full] || full.split(" (")[0];
}

function fmtDateLong(iso) {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function isBeforeNoonPKT() {
  const pkt = getPKTDate();
  return pkt.getUTCHours() < 12;
}

function saveButtonLabel() {
  return isBeforeNoonPKT() ? "Save Morning Plan" : "Save End of Day Review";
}

function planForDate(date) {
  return state.dailyPlans.find((p) => p.plan_date === date);
}

function dotColor(entry) {
  if (!entry) return null;
  if (entry.overall_rating == null) return "blue";
  if (entry.overall_rating >= 4) return "green";
  if (entry.overall_rating === 3) return "amber";
  return "red";
}

function entryStatus(entry) {
  if (!entry) return { label: "NO ENTRY", cls: "status-none" };
  const hasMorning = entry.pre_bias || entry.key_levels || entry.plan_notes ||
    (entry.rules_planned && entry.rules_planned.some((r) => r.planned));
  const hasReview = entry.overall_rating != null;
  if (hasReview) return { label: "COMPLETED", cls: "status-completed" };
  if (hasMorning) {
    const isToday = entry.plan_date === todayISO();
    return isToday ? { label: "IN PROGRESS", cls: "status-progress" } : { label: "PLANNED", cls: "status-planned" };
  }
  return { label: "NO ENTRY", cls: "status-none" };
}

function parseSessions(str) {
  if (!str) return [];
  return str.split("|").filter(Boolean);
}

function serializeSessions(arr) {
  return arr.join("|");
}

function cloneRules(rules) {
  return (rules || []).map((r) => ({ ...r }));
}

function buildFormState(entry) {
  const rules = entry?.rules_planned?.length
    ? cloneRules(entry.rules_planned)
    : cloneRules(getActiveTradingRules());
  const followed = entry?.rules_followed?.length
    ? cloneRules(entry.rules_followed)
    : rules.map((r) => ({ ...r, followed: r.planned ? null : null }));

  if (entry?.rules_followed?.length) {
    for (const f of followed) {
      const saved = entry.rules_followed.find((x) => x.id === f.id);
      if (saved) f.followed = saved.followed;
    }
  }

  return {
    id: entry?.id || null,
    pre_bias: entry?.pre_bias || "",
    key_levels: entry?.key_levels || "",
    sessions: parseSessions(entry?.session_focus),
    plan_notes: entry?.plan_notes || "",
    rules_planned: rules,
    emotion_start: entry?.emotion_start || "",
    emotion_end: entry?.emotion_end || "",
    execution_score: entry?.execution_score || 0,
    rules_followed: followed,
    what_went_well: entry?.what_went_well || "",
    what_went_wrong: entry?.what_went_wrong || "",
    lessons: entry?.lessons || "",
    overall_rating: entry?.overall_rating || 0,
  };
}

function complianceStats(rules) {
  const planned = (rules || []).filter((r) => r.planned);
  const followed = planned.filter((r) => r.followed === true);
  const total = planned.length;
  const pct = total ? Math.round((followed.length / total) * 100) : 0;
  return { followed: followed.length, total, pct };
}

function complianceClass(pct) {
  if (pct >= 80) return "compliance-good";
  if (pct >= 60) return "compliance-mid";
  return "compliance-bad";
}

function monthStats(year, month) {
  const plans = state.dailyPlans.filter((p) => {
    const d = new Date(p.plan_date + "T00:00:00");
    return d.getFullYear() === year && d.getMonth() === month;
  });
  const rated = plans.filter((p) => p.overall_rating != null);
  const avgRating = rated.length
    ? (rated.reduce((s, p) => s + p.overall_rating, 0) / rated.length).toFixed(1)
    : "—";
  let totalPlanned = 0, totalFollowed = 0;
  for (const p of plans) {
    const stats = complianceStats(p.rules_followed?.length ? p.rules_followed : p.rules_planned);
    totalPlanned += stats.total;
    totalFollowed += stats.followed;
  }
  const compliancePct = totalPlanned ? Math.round((totalFollowed / totalPlanned) * 100) : "—";
  return { logged: plans.length, avgRating, compliancePct };
}

function autoFillFromGoals(planDate, rulesFollowed) {
  let changed = false;
  const dayTrades = state.trades.filter((t) => t.trade_date === planDate);
  const maxGoal = state.goals.find((g) => g.type === "max_trades" && g.is_active);
  if (maxGoal && dayTrades.length > Number(maxGoal.target_value)) {
    const rule = rulesFollowed.find((r) => r.id === "max_trades");
    if (rule && rule.planned) { rule.followed = false; changed = true; }
  }
  const revengeGoal = state.goals.find((g) => g.type === "no_revenge_trade" && g.is_active);
  if (revengeGoal && dayTrades.length >= 2) {
    const sorted = dayTrades.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const minMin = Number(revengeGoal.target_value) || 30;
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].result !== "Loss") continue;
      const gap = (new Date(sorted[i + 1].created_at) - new Date(sorted[i].created_at)) / 60000;
      if (gap < minMin) {
        const rule = rulesFollowed.find((r) => r.id === "no_revenge");
        if (rule && rule.planned) { rule.followed = false; changed = true; }
        break;
      }
    }
  }
  return changed;
}

function calendarHtml(year, month) {
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = todayISO();
  const monthName = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += `<div class="plan-cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const entry = planForDate(iso);
    const dot = dotColor(entry);
    const isToday = iso === today;
    const isSelected = iso === selectedDate;
    const isPast = iso < today;
    let cls = "plan-cal-cell";
    if (isToday) cls += " today";
    if (isSelected) cls += " selected";
    if (isPast && !isSelected) cls += " past";
    cells += `<button type="button" class="${cls}" data-date="${iso}">
      <span class="plan-cal-day">${d}</span>
      ${dot ? `<span class="plan-cal-dot dot-${dot}"></span>` : ""}
    </button>`;
  }
  return `
    <div class="plan-cal-nav">
      <button type="button" class="btn btn-ghost btn-sm" id="plan-prev"><i data-lucide="chevron-left"></i></button>
      <span class="plan-cal-month">${monthName}</span>
      <button type="button" class="btn btn-ghost btn-sm" id="plan-next"><i data-lucide="chevron-right"></i></button>
    </div>
    <div class="plan-cal-dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<span>${d}</span>`).join("")}</div>
    <div class="plan-cal-grid">${cells}</div>`;
}

function starsHtml(name, value, max = 5) {
  let html = `<div class="star-rating" data-stars="${name}">`;
  for (let i = 1; i <= max; i++) {
    html += `<button type="button" class="star-btn ${i <= value ? "active" : ""}" data-val="${i}" aria-label="${i} stars">
      <i data-lucide="star"></i>
    </button>`;
  }
  html += "</div>";
  return html;
}

function rulesChecklistHtml(rules, mode) {
  const defaults = rules.filter((r) => !r.is_custom);
  const customs = rules.filter((r) => r.is_custom);
  const renderRule = (r, i) => {
    if (mode === "plan") {
      return `<label class="plan-rule-row ${r.planned ? "" : "unchecked"}">
        <input type="checkbox" class="plan-rule-check" data-idx="${i}" ${r.planned ? "checked" : ""}>
        <span class="plan-rule-text">${escapeHtml(r.text)}</span>
      </label>`;
    }
    if (!r.planned) return "";
    const yes = r.followed === true;
    const no = r.followed === false;
    return `<div class="plan-rule-review ${r.followed === false ? "broken" : ""}">
      <span class="plan-rule-text">${escapeHtml(r.text)}</span>
      <div class="plan-rule-toggle">
        <button type="button" class="rule-yes ${yes ? "active" : ""}" data-idx="${i}" data-val="true">Yes</button>
        <button type="button" class="rule-no ${no ? "active" : ""}" data-idx="${i}" data-val="false">No</button>
      </div>
    </div>`;
  };

  let html = defaults.map((r) => renderRule(r, rules.indexOf(r))).join("");
  if (customs.length) {
    html += `<div class="plan-rules-divider"></div>`;
    html += customs.map((r) => renderRule(r, rules.indexOf(r))).join("");
  }
  return html;
}

function renderForm(container, form) {
  const entry = planForDate(selectedDate);
  const status = entryStatus(entry);
  const comp = complianceStats(form.rules_followed);
  const compCls = complianceClass(comp.pct);
  const sessions = state.options.sessions || [];

  container.querySelector("#plan-form-area").innerHTML = `
    <div class="plan-day-header">
      <div class="plan-day-title-row">
        <h2 class="plan-day-date">${fmtDateLong(selectedDate)}</h2>
        <span class="plan-status-pill ${status.cls}">${status.label}</span>
        ${formDirty ? '<span class="plan-unsaved">Unsaved changes</span>' : ""}
      </div>
      <div class="plan-save-row">
        <button type="button" class="btn btn-gold" id="plan-save">${saveButtonLabel()}</button>
      </div>
    </div>

    ${showAutoFillNote ? `<div class="plan-autofill-note"><i data-lucide="info"></i> Some rules were auto-filled from your Goals data. Review and adjust if needed.</div>` : ""}

    <div class="plan-section-label">MORNING PLAN</div>

    <div class="plan-field">
      <label>Today's Bias</label>
      <div class="bias-pills" id="bias-pills">
        ${BIAS_OPTIONS.map((b) => {
          const cls = b === "Bullish" ? "bias-bull" : b === "Bearish" ? "bias-bear" : b === "Neutral" ? "bias-neutral" : "bias-none";
          return `<button type="button" class="bias-pill ${form.pre_bias === b ? "active " + cls : ""}" data-bias="${escapeHtml(b)}">${escapeHtml(b)}</button>`;
        }).join("")}
      </div>
    </div>

    <div class="plan-field">
      <label>Key Levels</label>
      <textarea id="key-levels" rows="3" placeholder="TJL2 at 3285, QML at 3310, SBR at 3340...">${escapeHtml(form.key_levels)}</textarea>
    </div>

    <div class="plan-field">
      <label>Sessions to Trade</label>
      <div class="session-pills" id="session-pills">
        ${sessions.map((s) => {
          const short = sessionShortName(s);
          const active = form.sessions.includes(s) ? "active" : "";
          return `<button type="button" class="session-pill ${active}" data-session="${escapeHtml(s)}">${escapeHtml(short)}</button>`;
        }).join("")}
      </div>
    </div>

    <div class="plan-field">
      <label>Trading Rules for Today</label>
      <div class="plan-rules-list" id="rules-planned">${rulesChecklistHtml(form.rules_planned, "plan")}</div>
      <div class="plan-add-rule" id="add-rule-wrap" hidden>
        <input type="text" id="custom-rule-input" placeholder="Enter custom rule for today…">
        <button type="button" class="btn btn-ghost btn-sm" id="custom-rule-add">Add</button>
        <button type="button" class="btn btn-ghost btn-sm" id="custom-rule-cancel">Cancel</button>
      </div>
      <button type="button" class="btn btn-ghost btn-sm plan-add-rule-btn" id="show-add-rule">+ Add custom rule for today</button>
      <a href="#" class="plan-manage-rules" id="manage-rules">Manage default rules</a>
    </div>

    <div class="plan-field">
      <label>Overall Plan for Today</label>
      <textarea id="plan-notes" rows="4" placeholder="Write your overall game plan for today's session…">${escapeHtml(form.plan_notes)}</textarea>
    </div>

    <div class="plan-section-label">END OF DAY REVIEW</div>

    <div class="plan-field">
      <label>Emotions</label>
      <div class="emotion-group">
        <span class="emotion-row-label">Before trading</span>
        <div class="emotion-pills" data-emotion="start">
          ${EMOTION_OPTIONS.map((e) => {
            const val = `${e.emoji} ${e.label}`;
            return `<button type="button" class="emotion-pill ${form.emotion_start === val ? "active" : ""}" data-val="${escapeHtml(val)}">${e.emoji} ${escapeHtml(e.label)}</button>`;
          }).join("")}
        </div>
      </div>
      <div class="emotion-group">
        <span class="emotion-row-label">After trading</span>
        <div class="emotion-pills" data-emotion="end">
          ${EMOTION_OPTIONS.map((e) => {
            const val = `${e.emoji} ${e.label}`;
            return `<button type="button" class="emotion-pill ${form.emotion_end === val ? "active" : ""}" data-val="${escapeHtml(val)}">${e.emoji} ${escapeHtml(e.label)}</button>`;
          }).join("")}
        </div>
      </div>
    </div>

    <div class="plan-field">
      <label>Rules Review</label>
      <div class="compliance-bar-wrap ${compCls}">
        <div class="compliance-bar"><div class="compliance-fill" style="width:${comp.pct}%"></div></div>
        <span class="compliance-label">${comp.followed} of ${comp.total} rules followed (${comp.pct}%)</span>
      </div>
      <div class="plan-rules-list" id="rules-followed">${rulesChecklistHtml(form.rules_followed, "review")}</div>
    </div>

    <div class="plan-field">
      <label>Execution Score</label>
      ${starsHtml("execution", form.execution_score)}
      <p class="star-desc">${EXEC_SCORE_LABELS[form.execution_score] || ""}</p>
    </div>

    <div class="plan-field">
      <label>What went well today?</label>
      <textarea id="what-well" rows="3" placeholder="e.g. Waited for confirmation, held my winners to TP, respected SL…">${escapeHtml(form.what_went_well)}</textarea>
    </div>

    <div class="plan-field">
      <label>What went wrong today?</label>
      <textarea id="what-wrong" rows="3" placeholder="e.g. Took a FOMO trade in NY session, moved SL once…">${escapeHtml(form.what_went_wrong)}</textarea>
    </div>

    <div class="plan-field">
      <label>Lesson for tomorrow</label>
      <textarea id="lessons" rows="2" placeholder="The one thing I will do differently tomorrow…">${escapeHtml(form.lessons)}</textarea>
    </div>

    <div class="plan-field">
      <label>How was today overall?</label>
      ${starsHtml("overall", form.overall_rating)}
    </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
}

function collectForm(container, form) {
  form.key_levels = container.querySelector("#key-levels")?.value || "";
  form.plan_notes = container.querySelector("#plan-notes")?.value || "";
  form.what_went_well = container.querySelector("#what-well")?.value || "";
  form.what_went_wrong = container.querySelector("#what-wrong")?.value || "";
  form.lessons = container.querySelector("#lessons")?.value || "";
  return form;
}

function markDirty(container, form) {
  formDirty = true;
  const el = container.querySelector(".plan-unsaved");
  if (!el) {
    const row = container.querySelector(".plan-day-title-row");
    if (row) row.insertAdjacentHTML("beforeend", '<span class="plan-unsaved">Unsaved changes</span>');
  }
}

function wireForm(container, form) {
  const area = container.querySelector("#plan-form-area");

  area.querySelector("#bias-pills")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-bias]");
    if (!btn) return;
    form.pre_bias = btn.dataset.bias;
    area.querySelectorAll(".bias-pill").forEach((b) => {
      b.classList.remove("active", "bias-bull", "bias-bear", "bias-neutral", "bias-none");
    });
    const cls = form.pre_bias === "Bullish" ? "bias-bull" : form.pre_bias === "Bearish" ? "bias-bear" : form.pre_bias === "Neutral" ? "bias-neutral" : "bias-none";
    btn.classList.add("active", cls);
    markDirty(container, form);
  });

  area.querySelector("#session-pills")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-session]");
    if (!btn) return;
    const s = btn.dataset.session;
    if (form.sessions.includes(s)) form.sessions = form.sessions.filter((x) => x !== s);
    else form.sessions.push(s);
    btn.classList.toggle("active");
    markDirty(container, form);
  });

  area.querySelector("#rules-planned")?.addEventListener("change", (e) => {
    const cb = e.target.closest(".plan-rule-check");
    if (!cb) return;
    const idx = Number(cb.dataset.idx);
    form.rules_planned[idx].planned = cb.checked;
    form.rules_followed[idx].planned = cb.checked;
    cb.closest(".plan-rule-row").classList.toggle("unchecked", !cb.checked);
    markDirty(container, form);
    syncComplianceBar(container, form);
  });

  area.querySelector("#show-add-rule")?.addEventListener("click", () => {
    area.querySelector("#add-rule-wrap").hidden = false;
    area.querySelector("#show-add-rule").hidden = true;
    area.querySelector("#custom-rule-input").focus();
  });

  area.querySelector("#custom-rule-cancel")?.addEventListener("click", () => {
    area.querySelector("#add-rule-wrap").hidden = true;
    area.querySelector("#show-add-rule").hidden = false;
    area.querySelector("#custom-rule-input").value = "";
  });

  area.querySelector("#custom-rule-add")?.addEventListener("click", () => {
    const input = area.querySelector("#custom-rule-input");
    const text = input.value.trim();
    if (!text) return;
    const id = "custom_" + Date.now();
    const rule = { id, text, is_default: false, is_custom: true, planned: true, followed: null };
    form.rules_planned.push(rule);
    form.rules_followed.push({ ...rule });
    input.value = "";
    area.querySelector("#add-rule-wrap").hidden = true;
    area.querySelector("#show-add-rule").hidden = false;
    area.querySelector("#rules-planned").innerHTML = rulesChecklistHtml(form.rules_planned, "plan");
    area.querySelector("#rules-followed").innerHTML = rulesChecklistHtml(form.rules_followed, "review");
    markDirty(container, form);
  });

  area.querySelector("#manage-rules")?.addEventListener("click", (e) => {
    e.preventDefault();
    sessionStorage.setItem("gj-scroll-rules", "1");
    window.dispatchEvent(new CustomEvent("gj:navigate", { detail: { page: "options" } }));
  });

  for (const sel of ["#key-levels", "#plan-notes", "#what-well", "#what-wrong", "#lessons"]) {
    area.querySelector(sel)?.addEventListener("input", () => markDirty(container, form));
  }

  area.querySelectorAll("[data-emotion]").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".emotion-pill");
      if (!btn) return;
      const key = group.dataset.emotion === "start" ? "emotion_start" : "emotion_end";
      form[key] = btn.dataset.val;
      group.querySelectorAll(".emotion-pill").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      markDirty(container, form);
    });
  });

  area.querySelector("#rules-followed")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-val]");
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    form.rules_followed[idx].followed = btn.dataset.val === "true";
    area.querySelector("#rules-followed").innerHTML = rulesChecklistHtml(form.rules_followed, "review");
    syncComplianceBar(container, form);
    markDirty(container, form);
  });

  area.querySelectorAll(".star-rating").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".star-btn");
      if (!btn) return;
      const val = Number(btn.dataset.val);
      const name = group.dataset.stars;
      if (name === "execution") {
        form.execution_score = val;
        area.querySelector(".star-desc").textContent = EXEC_SCORE_LABELS[val] || "";
      } else {
        form.overall_rating = val;
      }
      group.querySelectorAll(".star-btn").forEach((b, i) => b.classList.toggle("active", i < val));
      markDirty(container, form);
    });
    group.addEventListener("mouseover", (e) => {
      const btn = e.target.closest(".star-btn");
      if (!btn) return;
      const val = Number(btn.dataset.val);
      group.querySelectorAll(".star-btn").forEach((b, i) => b.classList.toggle("hover", i < val));
    });
    group.addEventListener("mouseleave", () => {
      group.querySelectorAll(".star-btn").forEach((b) => b.classList.remove("hover"));
    });
  });

  area.querySelector("#plan-save")?.addEventListener("click", async () => {
    collectForm(container, form);
    const btn = area.querySelector("#plan-save");
    btn.disabled = true;
    btn.classList.add("loading");

    if (isBeforeNoonPKT() === false || form.overall_rating) {
      showAutoFillNote = autoFillFromGoals(selectedDate, form.rules_followed);
      if (showAutoFillNote) {
        area.querySelector("#rules-followed").innerHTML = rulesChecklistHtml(form.rules_followed, "review");
        syncComplianceBar(container, form);
        if (!area.querySelector(".plan-autofill-note")) {
          area.querySelector(".plan-section-label")?.insertAdjacentHTML("beforebegin",
            `<div class="plan-autofill-note"><i data-lucide="info"></i> Some rules were auto-filled from your Goals data. Review and adjust if needed.</div>`);
          window.lucide?.createIcons({ nameAttr: "data-lucide" });
        }
      }
    }

    const payload = {
      plan_date: selectedDate,
      pre_bias: form.pre_bias || null,
      key_levels: form.key_levels || null,
      session_focus: serializeSessions(form.sessions) || null,
      plan_notes: form.plan_notes || null,
      rules_planned: form.rules_planned,
      emotion_start: form.emotion_start || null,
      emotion_end: form.emotion_end || null,
      execution_score: form.execution_score || null,
      rules_followed: form.rules_followed,
      what_went_well: form.what_went_well || null,
      what_went_wrong: form.what_went_wrong || null,
      lessons: form.lessons || null,
      overall_rating: form.overall_rating || null,
    };

    try {
      await saveDailyPlan(payload, form.id);
      formDirty = false;
      savedSnapshot = JSON.stringify(form);
      const msg = isBeforeNoonPKT() && !form.overall_rating ? "Plan saved." : "Review saved.";
      toast(msg, "success");
      render(container);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.classList.remove("loading");
    }
  });
}

function syncComplianceBar(container, form) {
  const comp = complianceStats(form.rules_followed);
  const wrap = container.querySelector(".compliance-bar-wrap");
  if (!wrap) return;
  wrap.className = `compliance-bar-wrap ${complianceClass(comp.pct)}`;
  wrap.querySelector(".compliance-fill").style.width = comp.pct + "%";
  wrap.querySelector(".compliance-label").textContent = `${comp.followed} of ${comp.total} rules followed (${comp.pct}%)`;
}

export function render(container) {
  if (!selectedDate || (selectedDate === todayISO() && !planForDate(selectedDate) && !formDirty)) {
    selectedDate = todayISO();
  }

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const stats = monthStats(year, month);
  const acc = currentAccount();
  const entry = planForDate(selectedDate);
  const form = buildFormState(entry);
  savedSnapshot = JSON.stringify(form);
  formDirty = false;
  showAutoFillNote = false;

  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Plan & Execution</h1><p class="page-sub">${escapeHtml(acc?.name || "Account")}</p></div>
  </div>

  <div class="plan-layout">
    <aside class="plan-sidebar glass card-pad">
      ${calendarHtml(year, month)}
      <div class="plan-sidebar-tools">
        <label class="field"><span>Account</span>
          <select id="plan-acct-select" class="mini-select">
            ${state.accounts.map((a) => `<option value="${a.id}" ${a.id === state.currentAccountId ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="btn btn-ghost btn-sm btn-block" id="plan-today">Today</button>
      </div>
      <div class="plan-month-stats glass">
        <div class="plan-stat"><span>Trading days logged</span><b>${stats.logged}</b></div>
        <div class="plan-stat"><span>Average day rating</span><b>${stats.avgRating}${stats.avgRating !== "—" ? "/5" : ""}</b></div>
        <div class="plan-stat"><span>Rules compliance</span><b>${stats.compliancePct}${stats.compliancePct !== "—" ? "%" : ""}</b></div>
      </div>
    </aside>

    <div class="plan-main glass card-pad" id="plan-form-area"></div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  renderForm(container, form);
  wireForm(container, form);

  container.querySelector("#plan-prev")?.addEventListener("click", () => {
    cursor = new Date(year, month - 1, 1);
    render(container);
  });
  container.querySelector("#plan-next")?.addEventListener("click", () => {
    cursor = new Date(year, month + 1, 1);
    render(container);
  });

  container.querySelectorAll(".plan-cal-cell[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedDate = btn.dataset.date;
      render(container);
    });
  });

  container.querySelector("#plan-today")?.addEventListener("click", () => {
    selectedDate = todayISO();
    const n = new Date();
    cursor = new Date(n.getFullYear(), n.getMonth(), 1);
    render(container);
  });

  container.querySelector("#plan-acct-select")?.addEventListener("change", async (e) => {
    try {
      await switchAccount(e.target.value);
      render(container);
    } catch (err) {
      toast(err.message, "error");
    }
  });
}
