import { getSupabase } from "./supabaseClient.js";
import { isConfigured } from "./config.js";
import { renderAuth, signOut } from "./auth.js";
import {
  state, setUser, ensureAccount, loadOptions, refreshAll, subscribeRealtime,
  onChange, onSync, ledger, currentAccount, addAccount, renameAccount, switchAccount,
} from "./store.js";
import { toast, confirmDialog, fmtMoney, fmtPct, escapeHtml } from "./ui.js";
import { exportCSV, exportExcel, exportTradesPDF, tradesToRows } from "./export.js";
import { initPWA, promptInstall, applyUpdate, isIOS, isStandalone, canPromptInstall } from "./pwa.js";

import * as tradelog from "./pages/tradelog.js";
import * as missed from "./pages/missed.js";
import * as analysis from "./pages/analysis.js";
import * as pnl from "./pages/pnl.js";
import * as weekly from "./pages/weekly.js";
import * as ai from "./pages/ai.js";
import * as options from "./pages/options.js";

const PAGES = {
  tradelog: { title: "Trade Log", icon: "candlestick-chart", mod: tradelog },
  missed: { title: "Missed", icon: "eye-off", mod: missed },
  analysis: { title: "Analysis", icon: "bar-chart-3", mod: analysis },
  pnl: { title: "PnL", icon: "calendar-days", mod: pnl },
  weekly: { title: "Weekly Review", icon: "notebook-pen", mod: weekly },
  ai: { title: "AI Mentor", icon: "brain", mod: ai },
  options: { title: "Options", icon: "settings", mod: options },
};

let current = localStorage.getItem("gj-page") || "tradelog";
const root = () => document.getElementById("app-root");

// ---------------- boot ----------------
async function boot() {
  initPWA();
  wireSplash();
  const c = getSupabase();
  if (!c) {
    finishSplash(() => renderAuth(root()));
    return;
  }
  const { data } = await c.auth.getSession();
  await handleSession(data.session, true);

  c.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") {
      if (session?.user && session.user.id !== state.user?.id) await handleSession(session, false);
    } else if (event === "SIGNED_OUT") {
      setUser(null);
      renderAuth(root());
    } else if (event === "PASSWORD_RECOVERY") {
      promptNewPassword();
    }
  });
}

let loadedForUser = null;
async function handleSession(session, isInitial) {
  if (!session?.user) {
    if (isInitial) finishSplash(() => renderAuth(root()));
    else renderAuth(root());
    return;
  }
  if (loadedForUser === session.user.id) return;
  loadedForUser = session.user.id;
  setUser(session.user);
  try {
    await ensureAccount();
    await loadOptions();
    renderShell();
    setLoadingPages(true);
    await refreshAll();
    setLoadingPages(false);
    subscribeRealtime();
    navigate(current);
  } catch (e) {
    toast(e.message || "Failed to load your data.", "error");
    renderShell();
  } finally {
    if (isInitial) finishSplash();
  }
}

function setLoadingPages(v) {
  tradelog.setLoading(v);
  missed.setLoading(v);
}

// ---------------- splash ----------------
function wireSplash() {
  const bar = document.querySelector(".splash-bar span");
  if (bar) requestAnimationFrame(() => (bar.style.width = "90%"));
}
function finishSplash(then) {
  const splash = document.getElementById("splash");
  if (!splash) { then?.(); return; }
  const bar = splash.querySelector(".splash-bar span");
  if (bar) bar.style.width = "100%";
  setTimeout(() => {
    splash.classList.add("hide");
    setTimeout(() => { splash.style.display = "none"; then?.(); }, 500);
  }, 300);
}

// ---------------- shell ----------------
function renderShell() {
  root().innerHTML = `
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="sb-brand">
        <div class="brand-mark sm">AU</div>
        <div class="brand-name">Gold Journal</div>
        <button class="sb-close" id="sb-close"><i data-lucide="x"></i></button>
      </div>

      <div class="sb-user glass">
        <div class="avatar" id="sb-avatar"></div>
        <div class="sb-user-meta">
          <div class="sb-user-name" id="sb-user-name"></div>
          <div class="sb-sync" id="sb-sync"><span class="sync-dot"></span><span class="sync-label">…</span></div>
        </div>
        <button class="ic-btn" id="sb-signout" title="Sign out"><i data-lucide="log-out"></i></button>
      </div>

      <button class="sb-install" id="btn-install" hidden><i data-lucide="download"></i> Install App</button>
      <div class="ios-tip" id="ios-tip" hidden>Tap the <b>Share</b> button, then <b>"Add to Home Screen"</b>.</div>

      <div class="sb-account">
        <label>Account</label>
        <div class="acct-switch">
          <select id="acct-select"></select>
          <button class="ic-btn" id="acct-rename" title="Rename"><i data-lucide="pencil"></i></button>
          <button class="ic-btn" id="acct-add" title="Add account"><i data-lucide="plus"></i></button>
        </div>
      </div>

      <nav class="sb-nav" id="sb-nav">
        ${Object.entries(PAGES).map(([k, p]) => `<button class="nav-item" data-page="${k}"><i data-lucide="${p.icon}"></i><span>${p.title}</span></button>`).join("")}
      </nav>

      <div class="sb-stats glass" id="sb-stats"></div>

      <div class="sb-export">
        <label>Export</label>
        <div class="export-row">
          <button class="btn btn-ghost btn-sm" id="exp-xls"><i data-lucide="sheet"></i> Excel</button>
          <button class="btn btn-ghost btn-sm" id="exp-csv"><i data-lucide="file-down"></i> CSV</button>
          <button class="btn btn-ghost btn-sm" id="exp-pdf"><i data-lucide="file-text"></i> PDF</button>
        </div>
      </div>

      <div class="sb-diag">
        <button class="diag-toggle" id="diag-toggle"><i data-lucide="terminal"></i> Diagnostics <i data-lucide="chevron-down" class="chev"></i></button>
        <div class="diag-body" id="diag-body"></div>
      </div>
    </aside>

    <div class="sb-backdrop" id="sb-backdrop"></div>

    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" id="menu-btn"><i data-lucide="menu"></i></button>
        <div class="tb-title">Gold Journal</div>
        <button class="icon-btn" id="tb-add"><i data-lucide="plus"></i></button>
      </header>
      <main class="content" id="page"></main>
      <nav class="bottom-nav" id="bottom-nav">
        ${Object.entries(PAGES).slice(0, 5).map(([k, p]) => `<button class="bn-item" data-page="${k}"><i data-lucide="${p.icon}"></i><span>${p.title}</span></button>`).join("")}
      </nav>
    </div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  wireShell();
  renderSidebarUser();
  renderAccounts();
  renderSidebarStats();
  updateSync(state.sync);
  renderDiagnostics();
  refreshInstallUI();
}

function wireShell() {
  root().querySelectorAll("[data-page]").forEach((btn) => btn.addEventListener("click", () => { navigate(btn.dataset.page); closeDrawer(); }));
  root().querySelector("#sb-signout").addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "Sign out?", body: "You'll need to sign in again.", confirmText: "Sign out", danger: false });
    if (ok) { loadedForUser = null; await signOut(); }
  });
  root().querySelector("#menu-btn").addEventListener("click", openDrawer);
  root().querySelector("#sb-close").addEventListener("click", closeDrawer);
  root().querySelector("#sb-backdrop").addEventListener("click", closeDrawer);
  root().querySelector("#tb-add").addEventListener("click", () => { navigate("tradelog"); tradelog.openTradeModal(null, () => navigate("tradelog")); });

  root().querySelector("#acct-select").addEventListener("change", async (e) => {
    try { await switchAccount(e.target.value); toast("Switched account.", "info"); navigate(current); } catch (err) { toast(err.message, "error"); }
  });
  root().querySelector("#acct-add").addEventListener("click", async () => {
    const name = prompt("New account name:", "Prop Firm Account");
    if (!name) return;
    const bal = prompt("Starting balance ($):", "0");
    try { await addAccount(name, Number(bal) || 0); toast("Account created.", "success"); navigate(current); } catch (e) { toast(e.message, "error"); }
  });
  root().querySelector("#acct-rename").addEventListener("click", async () => {
    const acc = currentAccount();
    const name = prompt("Rename account:", acc?.name || "");
    if (!name) return;
    try { await renameAccount(acc.id, name); toast("Renamed.", "success"); } catch (e) { toast(e.message, "error"); }
  });

  root().querySelector("#exp-csv").addEventListener("click", () => exportCSV(tradesToRows(), "gold-journal-trades.csv"));
  root().querySelector("#exp-xls").addEventListener("click", () => exportExcel(tradesToRows(), "gold-journal-trades.xlsx", "Trades"));
  root().querySelector("#exp-pdf").addEventListener("click", () => exportTradesPDF({}));

  root().querySelector("#diag-toggle").addEventListener("click", () => {
    const body = root().querySelector("#diag-body");
    body.classList.toggle("open");
    root().querySelector("#diag-toggle .chev").classList.toggle("up");
    renderDiagnostics();
  });

  root().querySelector("#btn-install")?.addEventListener("click", onInstallClick);
}

// ---------------- PWA install + update ----------------
let installAvailable = false;

function refreshInstallUI() {
  const btn = root().querySelector("#btn-install");
  if (!btn) return;
  const show = !isStandalone() && (installAvailable || isIOS());
  btn.hidden = !show;
  if (!show) root().querySelector("#ios-tip")?.setAttribute("hidden", "");
}

async function onInstallClick() {
  if (canPromptInstall()) {
    const outcome = await promptInstall();
    if (outcome === "accepted") { installAvailable = false; refreshInstallUI(); }
  } else if (isIOS()) {
    const tip = root().querySelector("#ios-tip");
    if (tip) tip.toggleAttribute("hidden");
  }
}

function showUpdateBanner() {
  if (document.getElementById("update-banner")) return;
  const bar = document.createElement("div");
  bar.id = "update-banner";
  bar.className = "update-banner";
  bar.innerHTML = `<span class="ub-text"><i data-lucide="rocket"></i> A new version is available</span><button class="btn btn-gold btn-sm" id="update-now">Update Now</button>`;
  document.body.appendChild(bar);
  window.lucide?.createIcons({ nameAttr: "data-lucide" });
  requestAnimationFrame(() => bar.classList.add("show"));
  bar.querySelector("#update-now").addEventListener("click", (e) => {
    e.currentTarget.textContent = "Updating…";
    e.currentTarget.disabled = true;
    applyUpdate();
  });
}

window.addEventListener("gj:installable", () => { installAvailable = true; refreshInstallUI(); });
window.addEventListener("gj:installed", () => { installAvailable = false; refreshInstallUI(); toast("App installed successfully", "success"); });
window.addEventListener("gj:update-ready", showUpdateBanner);
window.addEventListener("gj:synced", (e) => {
  const n = e.detail?.count || 0;
  if (n) toast(`${n} change${n === 1 ? "" : "s"} synced`, "success");
});

function openDrawer() { root().querySelector("#sidebar").classList.add("open"); root().querySelector("#sb-backdrop").classList.add("show"); }
function closeDrawer() { root().querySelector("#sidebar").classList.remove("open"); root().querySelector("#sb-backdrop").classList.remove("show"); }

function renderSidebarUser() {
  const u = state.user;
  const name = u?.user_metadata?.full_name || u?.user_metadata?.name || (u?.email ? u.email.split("@")[0] : "Trader");
  const avatarUrl = u?.user_metadata?.avatar_url;
  root().querySelector("#sb-user-name").textContent = name;
  const av = root().querySelector("#sb-avatar");
  if (avatarUrl) av.innerHTML = `<img src="${avatarUrl}" alt="">`;
  else av.textContent = name.slice(0, 2).toUpperCase();
}

function renderAccounts() {
  const select = root().querySelector("#acct-select");
  if (!select) return;
  select.innerHTML = state.accounts.map((a) => `<option value="${a.id}" ${a.id === state.currentAccountId ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("");
}

function renderSidebarStats() {
  const el = root().querySelector("#sb-stats");
  if (!el) return;
  const l = ledger();
  const wins = state.trades.filter((t) => t.result === "Win").length;
  const losses = state.trades.filter((t) => t.result === "Loss").length;
  const decided = wins + losses;
  const winRate = decided ? (wins / decided) * 100 : 0;
  const totalPnl = state.trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  el.innerHTML = `
    <div class="mini-stat"><span>Balance</span><b class="money">${fmtMoney(l.balance)}</b></div>
    <div class="mini-stat"><span>Win rate</span><b>${fmtPct(winRate)}</b></div>
    <div class="mini-stat"><span>Total P&L</span><b class="money ${totalPnl >= 0 ? "pos" : "neg"}">${fmtMoney(totalPnl)}</b></div>
    <div class="mini-stat"><span>Trades</span><b>${state.trades.length}</b></div>`;
}

function updateSync(status) {
  const el = root().querySelector("#sb-sync");
  if (!el) return;
  const map = {
    idle: ["…", "sync-idle"], syncing: ["Syncing…", "sync-syncing"], synced: ["Synced", "sync-ok"],
    offline: ["Offline", "sync-off"], "signed-out": ["Sign in required", "sync-off"],
  };
  const [label, cls] = map[status] || map.idle;
  el.className = "sb-sync " + cls;
  el.querySelector(".sync-label").textContent = label;
}

function renderDiagnostics() {
  const body = root().querySelector("#diag-body");
  if (!body || !body.classList.contains("open")) return;
  body.innerHTML = `
    <div class="diag-row"><span>Auth</span><b>${state.user ? "signed in" : "signed out"}</b></div>
    <div class="diag-row"><span>User</span><b>${escapeHtml(state.user?.email || "-")}</b></div>
    <div class="diag-row"><span>Config</span><b>${isConfigured() ? "ok" : "missing"}</b></div>
    <div class="diag-row"><span>Sync</span><b>${state.sync}</b></div>
    <div class="diag-row"><span>Online</span><b>${state.online}</b></div>
    <div class="diag-row"><span>Accounts</span><b>${state.accounts.length}</b></div>
    <div class="diag-row"><span>Trades</span><b>${state.trades.length}</b></div>
    <div class="diag-row"><span>Storage</span><b>screenshots</b></div>`;
}

// ---------------- navigation ----------------
function navigate(page) {
  if (!PAGES[page]) page = "tradelog";
  current = page;
  localStorage.setItem("gj-page", page);
  root().querySelectorAll(".nav-item, .bn-item").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  const pageEl = root().querySelector("#page");
  pageEl.classList.remove("fade-in");
  void pageEl.offsetWidth;
  pageEl.classList.add("fade-in");
  PAGES[page].mod.render(pageEl);
}

// ---------------- reactivity ----------------
onSync((status) => { updateSync(status); renderDiagnostics(); });
onChange(() => {
  if (!root().querySelector(".layout")) return;
  renderAccounts();
  renderSidebarStats();
  renderDiagnostics();
  const pageEl = root().querySelector("#page");
  if (pageEl && PAGES[current]) PAGES[current].mod.render(pageEl);
});

// ---------------- password recovery ----------------
async function promptNewPassword() {
  const pw = prompt("Enter your new password (min 8 chars):");
  if (!pw || pw.length < 8) return toast("Password too short.", "error");
  const { error } = await getSupabase().auth.updateUser({ password: pw });
  if (error) toast(error.message, "error");
  else toast("Password updated — you're signed in.", "success");
}

document.addEventListener("DOMContentLoaded", boot);
