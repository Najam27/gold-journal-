import { state, saveOptions, resetOptions, clearAllTrades, saveTradingRulesMeta, getActiveTradingRules } from "../store.js";
import { getSupabase, humanError } from "../supabaseClient.js";
import { OPTION_LABELS, DEFAULT_TRADING_RULES } from "../defaults.js";
import { toast, confirmDialog, escapeHtml } from "../ui.js";

export function render(container) {
  const u = state.user;
  const providers = (u?.app_metadata?.providers || u?.identities?.map((i) => i.provider) || ["email"]).join(", ");

  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Options</h1><p class="page-sub">Profile, danger zone &amp; custom lists</p></div>
  </div>

  <div class="opt-grid">
    <div class="glass card-pad">
      <h6>Profile</h6>
      <div class="profile-row">
        <div class="avatar-lg">${initials(u)}</div>
        <div>
          <div class="pf-name">${escapeHtml(displayName(u))}</div>
          <div class="pf-email">${escapeHtml(u?.email || "")}</div>
          <div class="pf-prov"><i data-lucide="key-round"></i> ${escapeHtml(providers)}</div>
        </div>
      </div>
      <hr>
      <h6>Change Password</h6>
      <form id="pw-form" class="modal-form">
        <label class="field"><span>New password</span><input type="password" name="pw" placeholder="At least 8 characters"></label>
        <label class="field"><span>Confirm password</span><input type="password" name="pw2" placeholder="Re-enter"></label>
        <button type="submit" class="btn btn-gold btn-sm" id="pw-btn"><span class="btn-label">Update Password</span></button>
      </form>
    </div>

    <div class="glass card-pad danger-zone">
      <h6><i data-lucide="alert-triangle"></i> Danger Zone</h6>
      <p class="note">These actions can't be undone.</p>
      <button class="btn btn-danger btn-block" id="clear-trades"><i data-lucide="trash-2"></i> Clear All Trades</button>
      <button class="btn btn-ghost btn-block mt" id="reset-opts"><i data-lucide="rotate-ccw"></i> Reset Options to Defaults</button>
    </div>
  </div>

  <div class="glass card-pad mt" id="trading-rules-section">
    <h6>Trading Rules</h6>
    <p class="note">Manage default and custom rules. Changes apply to all future daily plan entries. Existing entries keep their saved rules.</p>
    <div class="tr-rules-list" id="tr-rules-list">${tradingRulesHtml()}</div>
    <div class="tr-add-row">
      <input type="text" id="tr-new-rule" placeholder="Add a custom rule…">
      <button type="button" class="btn btn-ghost btn-sm" id="tr-add-btn"><i data-lucide="plus"></i> Add Rule</button>
    </div>
  </div>

  <div class="glass card-pad mt">
    <h6>Customise Dropdown Options</h6>
    <p class="note">Add, edit or remove tags. Changes apply everywhere instantly and sync to the cloud.</p>
    <div class="opt-lists" id="opt-lists">${listsHtml()}</div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  wire(container);
  if (sessionStorage.getItem("gj-scroll-rules")) {
    sessionStorage.removeItem("gj-scroll-rules");
    container.querySelector("#trading-rules-section")?.scrollIntoView({ behavior: "smooth" });
  }
}

function getAllManagedRules() {
  const meta = state.tradingRulesMeta;
  const defaults = DEFAULT_TRADING_RULES.map((r) => ({
    id: r.id,
    text: meta.edited[r.id] || r.text,
    is_default: true,
    active: !meta.disabled.includes(r.id),
  }));
  const custom = (meta.custom || []).map((r) => ({
    id: r.id,
    text: r.text,
    is_default: false,
    active: r.active !== false,
  }));
  let all = [...defaults, ...custom];
  if (meta.order?.length) {
    const orderMap = new Map(meta.order.map((id, i) => [id, i]));
    all.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
  }
  return all;
}

function tradingRulesHtml() {
  const rules = getAllManagedRules();
  if (!rules.length) return `<div class="empty-state"><p>No rules configured.</p></div>`;
  return rules.map((r, i) => `
    <div class="tr-rule-row ${r.active ? "" : "inactive"}" draggable="true" data-id="${escapeHtml(r.id)}" data-idx="${i}">
      <span class="tr-drag" title="Drag to reorder"><i data-lucide="grip-vertical"></i></span>
      <label class="tr-toggle"><input type="checkbox" class="tr-active" ${r.active ? "checked" : ""}><span class="tr-toggle-ui"></span></label>
      <span class="tr-text ${r.is_default ? "" : "custom"}" contenteditable="true">${escapeHtml(r.text)}</span>
      ${r.is_default ? `<span class="tr-badge">Default</span>` : `<button type="button" class="tr-del" title="Delete"><i data-lucide="trash-2"></i></button>`}
    </div>`).join("");
}

function displayName(u) {
  return u?.user_metadata?.full_name || u?.user_metadata?.name || (u?.email ? u.email.split("@")[0] : "Trader");
}
function initials(u) {
  const n = displayName(u);
  return n.slice(0, 2).toUpperCase();
}

function listsHtml() {
  return Object.keys(OPTION_LABELS)
    .map((key) => {
      const items = state.options[key] || [];
      return `<div class="opt-list glass" data-key="${key}">
        <div class="ol-head"><span>${OPTION_LABELS[key]}</span><span class="count-badge">${items.length}</span></div>
        <div class="ol-items">
          ${items.map((it, i) => `<div class="ol-tag"><span class="ol-text" contenteditable="true" data-i="${i}">${escapeHtml(it)}</span><button class="ol-del" data-del="${i}">&times;</button></div>`).join("")}
        </div>
        <div class="ol-add"><input type="text" placeholder="Add option…" class="ol-input"><button class="btn btn-ghost btn-sm ol-add-btn"><i data-lucide="plus"></i></button></div>
      </div>`;
    })
    .join("");
}

function wire(container) {
  // password
  const pwForm = container.querySelector("#pw-form");
  pwForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = pwForm.querySelector("#pw-btn");
    const pw = pwForm.pw.value, pw2 = pwForm.pw2.value;
    if (pw.length < 8) return toast("Password must be at least 8 characters.", "error");
    if (pw !== pw2) return toast("Passwords don't match.", "error");
    btn.disabled = true; btn.classList.add("loading");
    try {
      const { error } = await getSupabase().auth.updateUser({ password: pw });
      if (error) throw error;
      toast("Password updated.", "success");
      pwForm.reset();
    } catch (err) { toast(humanError(err), "error"); }
    finally { btn.disabled = false; btn.classList.remove("loading"); }
  });

  // danger
  container.querySelector("#clear-trades").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Clear all trades?", body: "Permanently deletes every trade in this account.", confirmText: "Delete all" });
    if (!ok) return;
    try { await clearAllTrades(); toast("All trades cleared.", "success"); } catch (e) { toast(e.message, "error"); }
  });
  container.querySelector("#reset-opts").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Reset options?", body: "Restores all dropdown lists to defaults.", confirmText: "Reset", danger: false });
    if (!ok) return;
    try { await resetOptions(); toast("Options reset.", "success"); render(container); } catch (e) { toast(e.message, "error"); }
  });

  // option lists editing
  const persist = async () => {
    try { await saveOptions(structuredClone(state.options)); } catch (e) { toast(e.message, "error"); }
  };

  container.querySelector("#opt-lists").addEventListener("click", async (e) => {
    const list = e.target.closest(".opt-list");
    if (!list) return;
    const key = list.dataset.key;
    const del = e.target.closest("[data-del]");
    const addBtn = e.target.closest(".ol-add-btn");
    if (del) {
      state.options[key].splice(Number(del.dataset.del), 1);
      await persist(); render(container);
    }
    if (addBtn) {
      const input = list.querySelector(".ol-input");
      const val = input.value.trim();
      if (!val) return;
      if (state.options[key].includes(val)) return toast("Already exists.", "warning");
      state.options[key].push(val);
      await persist(); render(container);
    }
  });

  container.querySelector("#opt-lists").addEventListener("keydown", (e) => {
    if (e.target.classList.contains("ol-input") && e.key === "Enter") {
      e.preventDefault();
      e.target.closest(".ol-add").querySelector(".ol-add-btn").click();
    }
  });

  // inline edit on blur
  container.querySelectorAll(".ol-text").forEach((span) => {
    span.addEventListener("blur", async () => {
      const list = span.closest(".opt-list");
      const key = list.dataset.key;
      const i = Number(span.dataset.i);
      const val = span.textContent.trim();
      if (!val) { span.textContent = state.options[key][i]; return; }
      if (state.options[key][i] !== val) { state.options[key][i] = val; await persist(); }
    });
    span.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } });
  });

  wireTradingRules(container);
}

function wireTradingRules(container) {
  const list = container.querySelector("#tr-rules-list");
  if (!list) return;

  const persistRules = async () => {
    try {
      await saveTradingRulesMeta(structuredClone(state.tradingRulesMeta));
    } catch (e) {
      toast(e.message, "error");
    }
  };

  const rebuildFromDom = () => {
    const rows = [...list.querySelectorAll(".tr-rule-row")];
    const order = rows.map((r) => r.dataset.id);
    const meta = state.tradingRulesMeta;
    meta.order = order;
    meta.disabled = [];
    meta.edited = {};
    meta.custom = meta.custom || [];
    for (const row of rows) {
      const id = row.dataset.id;
      const text = row.querySelector(".tr-text").textContent.trim();
      const active = row.querySelector(".tr-active").checked;
      const isDefault = DEFAULT_TRADING_RULES.some((r) => r.id === id);
      if (isDefault) {
        if (!active) meta.disabled.push(id);
        const orig = DEFAULT_TRADING_RULES.find((r) => r.id === id);
        if (orig && text !== orig.text) meta.edited[id] = text;
      } else {
        const custom = meta.custom.find((r) => r.id === id);
        if (custom) {
          custom.text = text;
          custom.active = active;
        }
      }
    }
  };

  list.addEventListener("change", async (e) => {
    if (!e.target.classList.contains("tr-active")) return;
    rebuildFromDom();
    await persistRules();
    list.innerHTML = tradingRulesHtml();
    window.lucide?.createIcons({ nameAttr: "data-lucide" });
    wireTradingRules(container);
  });

  list.addEventListener("click", async (e) => {
    const del = e.target.closest(".tr-del");
    if (!del) return;
    const row = del.closest(".tr-rule-row");
    const id = row.dataset.id;
    state.tradingRulesMeta.custom = (state.tradingRulesMeta.custom || []).filter((r) => r.id !== id);
    rebuildFromDom();
    await persistRules();
    render(container);
  });

  list.querySelectorAll(".tr-text").forEach((span) => {
    span.addEventListener("blur", async () => {
      rebuildFromDom();
      await persistRules();
    });
    span.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } });
  });

  let dragId = null;
  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".tr-rule-row");
    if (!row) return;
    dragId = row.dataset.id;
    row.classList.add("dragging");
  });
  list.addEventListener("dragend", (e) => {
    e.target.closest(".tr-rule-row")?.classList.remove("dragging");
    dragId = null;
  });
  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    const row = e.target.closest(".tr-rule-row");
    if (!row || row.dataset.id === dragId) return;
    const dragging = list.querySelector(".dragging");
    if (dragging) {
      const rect = row.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      if (e.clientY < mid) list.insertBefore(dragging, row);
      else list.insertBefore(dragging, row.nextSibling);
    }
  });
  list.addEventListener("drop", async (e) => {
    e.preventDefault();
    rebuildFromDom();
    await persistRules();
  });

  container.querySelector("#tr-add-btn")?.addEventListener("click", async () => {
    const input = container.querySelector("#tr-new-rule");
    const text = input.value.trim();
    if (!text) return toast("Enter rule text.", "warning");
    const id = "custom_" + Date.now();
    state.tradingRulesMeta.custom = state.tradingRulesMeta.custom || [];
    state.tradingRulesMeta.custom.push({ id, text, is_default: false, active: true });
    input.value = "";
    await persistRules();
    render(container);
  });

  container.querySelector("#tr-new-rule")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); container.querySelector("#tr-add-btn").click(); }
  });
}
