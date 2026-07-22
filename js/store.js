// Central data store: talks to Supabase, caches per-account data, exposes
// CRUD, computes balances, drives realtime + sync-status + offline events.
import { getSupabase, humanError } from "./supabaseClient.js";
import { SCREENSHOTS_BUCKET } from "./config.js";
import { DEFAULT_OPTIONS, DEFAULT_TRADING_RULES } from "./defaults.js";
import { DEFAULT_GOALS } from "./goalsEngine.js";
import {
  saveSnapshot, loadSnapshot, getQueue, enqueue, flushQueue,
  saveAccountsCache, loadAccountsCache, saveOptionsCache, loadOptionsCache,
} from "./offline.js";

const listeners = new Set(); // data-changed listeners
const syncListeners = new Set(); // sync-status listeners

export const state = {
  user: null,
  accounts: [],
  currentAccountId: null,
  trades: [],
  cash: [],
  skipped: [],
  reviews: [],
  dailyPlans: [],
  goals: [],
  options: structuredClone(DEFAULT_OPTIONS),
  tradingRulesMeta: {
    custom: [],
    disabled: [],
    edited: {},
    order: null,
  },
  online: navigator.onLine,
  sync: "idle", // idle | syncing | synced | offline | signed-out
};

let channel = null;

// ---------- pub/sub ----------
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function onSync(fn) {
  syncListeners.add(fn);
  return () => syncListeners.delete(fn);
}
function emit() {
  for (const fn of listeners) fn(state);
}
function setSync(status) {
  state.sync = status;
  for (const fn of syncListeners) fn(status);
}

// ---------- network ----------
window.addEventListener("online", async () => {
  state.online = true;
  if (!state.user) { setSync("synced"); return; }
  setSync("syncing");
  try {
    const res = await flushQueue(state.user.id, applyQueuedOp);
    await refreshAll();
    if (res.synced) {
      window.dispatchEvent(new CustomEvent("gj:synced", { detail: { count: res.synced } }));
    }
  } catch {
    setSync(navigator.onLine ? "synced" : "offline");
  }
});
window.addEventListener("offline", () => {
  state.online = false;
  setSync("offline");
});

// Map DB tables to the in-memory state arrays for optimistic offline updates.
const TABLE_STATE = {
  trades: "trades",
  cash_transactions: "cash",
  skipped_trades: "skipped",
  weekly_reviews: "reviews",
  daily_plans: "dailyPlans",
  goals: "goals",
};

function persistSnapshot() {
  saveSnapshot(state.user?.id, state.currentAccountId, {
    trades: state.trades,
    cash: state.cash,
    skipped: state.skipped,
    reviews: state.reviews,
    dailyPlans: state.dailyPlans,
    goals: state.goals,
  });
}

function applyOptimistic(table, op, payload, id) {
  const key = TABLE_STATE[table];
  if (!key) return;
  const arr = state[key];
  if (op === "delete") {
    state[key] = arr.filter((r) => r.id !== id);
    return;
  }
  if (op === "update") {
    const r = arr.find((x) => x.id === id);
    if (r) Object.assign(r, payload);
    return;
  }
  arr.push({
    id,
    user_id: state.user?.id,
    account_id: state.currentAccountId,
    created_at: new Date().toISOString(),
    ...payload,
    __pending: true,
  });
}

// Queue a write made while offline and reflect it locally right away.
function offlineMutate(table, op, payload, id) {
  if (op === "insert" && !id) id = "tmp-" + (crypto.randomUUID?.() || Date.now());
  enqueue(state.user.id, { table, op, payload: payload || null, rowId: id || null, accountId: state.currentAccountId });
  applyOptimistic(table, op, payload, id);
  persistSnapshot();
  setSync("offline");
  emit();
  return { offline: true, id };
}

// Replay one queued op against Supabase (used on reconnect).
async function applyQueuedOp(op) {
  const c = sb();
  if (op.op === "insert") {
    const { error } = await c.from(op.table).insert({ ...op.payload, user_id: state.user.id, account_id: op.accountId });
    if (error) throw error;
  } else if (op.op === "update") {
    const { error } = await c.from(op.table).update(op.payload).eq("id", op.rowId);
    if (error) throw error;
  } else if (op.op === "delete") {
    const { error } = await c.from(op.table).delete().eq("id", op.rowId);
    if (error) throw error;
  }
}

// Populate state from the cached snapshot + replay pending ops (offline boot / reads).
function hydrateOffline() {
  const snap = loadSnapshot(state.user?.id, state.currentAccountId);
  state.trades = snap?.trades || [];
  state.cash = snap?.cash || [];
  state.skipped = snap?.skipped || [];
  state.reviews = snap?.reviews || [];
  state.dailyPlans = snap?.dailyPlans || [];
  state.goals = snap?.goals || [];
  for (const op of getQueue(state.user?.id)) {
    if (op.accountId === state.currentAccountId) applyOptimistic(op.table, op.op, op.payload, op.rowId);
  }
  emit();
}

export function setUser(user) {
  state.user = user;
  if (!user) {
    state.accounts = [];
    state.currentAccountId = null;
    state.trades = state.cash = state.skipped = state.reviews = state.dailyPlans = state.goals = [];
    state.options = structuredClone(DEFAULT_OPTIONS);
    state.tradingRulesMeta = { custom: [], disabled: [], edited: {}, order: null };
    unsubscribeRealtime();
    setSync("signed-out");
    emit();
  }
}

const sb = () => {
  const c = getSupabase();
  if (!c) throw new Error("Supabase is not configured.");
  return c;
};

// ---------- accounts ----------
export async function ensureAccount() {
  if (!navigator.onLine) {
    const cached = loadAccountsCache(state.user.id);
    state.accounts = cached?.accounts || [];
    const saved = localStorage.getItem("gj-account-" + state.user.id);
    state.currentAccountId =
      (saved && state.accounts.some((a) => a.id === saved) && saved) ||
      cached?.currentAccountId ||
      state.accounts[0]?.id ||
      null;
    return;
  }
  const { data, error } = await sb()
    .from("accounts")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  let accounts = data || [];
  if (accounts.length === 0) {
    const { data: created, error: e2 } = await sb()
      .from("accounts")
      .insert({ user_id: state.user.id, name: "Main Account", is_default: true })
      .select()
      .single();
    if (e2) throw e2;
    accounts = [created];
    await seedDefaultGoals(created.id);
  }
  state.accounts = accounts;
  const saved = localStorage.getItem("gj-account-" + state.user.id);
  state.currentAccountId =
    (saved && accounts.some((a) => a.id === saved) && saved) || accounts[0].id;
  saveAccountsCache(state.user.id, accounts, state.currentAccountId);
}

export function currentAccount() {
  return state.accounts.find((a) => a.id === state.currentAccountId) || null;
}

export async function switchAccount(id) {
  state.currentAccountId = id;
  localStorage.setItem("gj-account-" + state.user.id, id);
  await refreshAll();
}

export async function addAccount(name, startingBalance = 0) {
  const { data, error } = await sb()
    .from("accounts")
    .insert({
      user_id: state.user.id,
      name: name || "New Account",
      starting_balance: Number(startingBalance) || 0,
    })
    .select()
    .single();
  if (error) throw error;
  state.accounts.push(data);
  await seedDefaultGoals(data.id);
  await switchAccount(data.id);
  return data;
}

export async function renameAccount(id, name) {
  const { error } = await sb().from("accounts").update({ name }).eq("id", id);
  if (error) throw error;
  const a = state.accounts.find((x) => x.id === id);
  if (a) a.name = name;
  emit();
}

export async function updateAccountStartingBalance(id, val) {
  const { error } = await sb()
    .from("accounts")
    .update({ starting_balance: Number(val) || 0 })
    .eq("id", id);
  if (error) throw error;
  const a = state.accounts.find((x) => x.id === id);
  if (a) a.starting_balance = Number(val) || 0;
  await refreshAll();
}

// ---------- options (custom lists) ----------
export async function loadOptions() {
  if (!navigator.onLine) {
    state.options = loadOptionsCache(state.user.id) || structuredClone(DEFAULT_OPTIONS);
    await loadTradingRulesMeta();
    return;
  }
  const { data, error } = await sb()
    .from("journal_meta")
    .select("value")
    .eq("key", "options")
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  const merged = structuredClone(DEFAULT_OPTIONS);
  if (data?.value) Object.assign(merged, data.value);
  state.options = merged;
  saveOptionsCache(state.user.id, merged);
  await loadTradingRulesMeta();
}

export async function saveOptions(options) {
  state.options = options;
  const { error } = await sb()
    .from("journal_meta")
    .upsert(
      { user_id: state.user.id, key: "options", value: options },
      { onConflict: "user_id,key" }
    );
  if (error) throw error;
  emit();
}

export async function resetOptions() {
  await saveOptions(structuredClone(DEFAULT_OPTIONS));
}

const DEFAULT_RULES_META = { custom: [], disabled: [], edited: {}, order: null };

export async function loadTradingRulesMeta() {
  if (!state.user) return;
  if (!navigator.onLine) {
    const cached = loadOptionsCache(state.user.id + "-rules");
    state.tradingRulesMeta = cached || structuredClone(DEFAULT_RULES_META);
    return;
  }
  const [customRes, prefsRes] = await Promise.all([
    sb().from("journal_meta").select("value").eq("key", "custom_trading_rules").maybeSingle(),
    sb().from("journal_meta").select("value").eq("key", "trading_rules_prefs").maybeSingle(),
  ]);
  const custom = Array.isArray(customRes.data?.value) ? customRes.data.value : [];
  const prefs = prefsRes.data?.value || {};
  state.tradingRulesMeta = {
    custom,
    disabled: prefs.disabled || [],
    edited: prefs.edited || {},
    order: prefs.order || null,
  };
  saveOptionsCache(state.user.id + "-rules", state.tradingRulesMeta);
}

export async function saveTradingRulesMeta(meta) {
  state.tradingRulesMeta = meta;
  const { error: e1 } = await sb()
    .from("journal_meta")
    .upsert(
      { user_id: state.user.id, key: "custom_trading_rules", value: meta.custom || [] },
      { onConflict: "user_id,key" }
    );
  if (e1) throw e1;
  const { error: e2 } = await sb()
    .from("journal_meta")
    .upsert(
      {
        user_id: state.user.id,
        key: "trading_rules_prefs",
        value: { disabled: meta.disabled || [], edited: meta.edited || {}, order: meta.order || null },
      },
      { onConflict: "user_id,key" }
    );
  if (e2) throw e2;
  saveOptionsCache(state.user.id + "-rules", meta);
  emit();
}

/** Build the active rule list for a new daily plan entry. */
export function getActiveTradingRules() {
  const meta = state.tradingRulesMeta || DEFAULT_RULES_META;
  const defaults = DEFAULT_TRADING_RULES.filter((r) => !meta.disabled.includes(r.id)).map((r) => ({
    ...r,
    text: meta.edited[r.id] || r.text,
    planned: true,
    followed: null,
  }));
  const custom = (meta.custom || [])
    .filter((r) => r.active !== false)
    .map((r) => ({
      id: r.id,
      text: r.text,
      is_default: false,
      is_custom: true,
      planned: true,
      followed: null,
    }));
  let all = [...defaults, ...custom];
  if (meta.order?.length) {
    const orderMap = new Map(meta.order.map((id, i) => [id, i]));
    all.sort((a, b) => (orderMap.get(a.id) ?? 999) - (orderMap.get(b.id) ?? 999));
  }
  const seen = new Set();
  return all.filter((r) => {
    const key = String(r.text || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- data load ----------
export async function refreshAll() {
  if (!state.user) return;
  if (!navigator.onLine) {
    hydrateOffline();
    setSync("offline");
    return;
  }
  setSync("syncing");
  try {
    const acc = state.currentAccountId;
    const [trades, cash, skipped, reviews, dailyPlans, goals] = await Promise.all([
      sb().from("trades").select("*").eq("account_id", acc).order("trade_date", { ascending: true }).order("created_at", { ascending: true }),
      sb().from("cash_transactions").select("*").eq("account_id", acc).order("tx_date", { ascending: true }).order("created_at", { ascending: true }),
      sb().from("skipped_trades").select("*").eq("account_id", acc).order("trade_date", { ascending: false }),
      sb().from("weekly_reviews").select("*").eq("account_id", acc).order("week_of", { ascending: false }),
      sb().from("daily_plans").select("*").eq("account_id", acc).order("plan_date", { ascending: false }),
      sb().from("goals").select("*").eq("account_id", acc).order("created_at", { ascending: true }),
    ]);
    for (const r of [trades, cash, skipped, reviews, dailyPlans, goals]) if (r.error) throw r.error;
    state.trades = trades.data || [];
    state.cash = cash.data || [];
    state.skipped = skipped.data || [];
    state.reviews = reviews.data || [];
    state.dailyPlans = dailyPlans.data || [];
    state.goals = goals.data || [];
    if (!state.goals.length) {
      await ensureGoalsForAccount(acc);
      const g2 = await sb().from("goals").select("*").eq("account_id", acc).order("created_at", { ascending: true });
      if (!g2.error) state.goals = g2.data || [];
    }
    persistSnapshot();
    setSync("synced");
    emit();
  } catch (err) {
    setSync(navigator.onLine ? "synced" : "offline");
    throw new Error(humanError(err));
  }
}

// ---------- balance timeline ----------
// Merge trades + cash into one time-ordered ledger and compute running balance.
export function ledger() {
  const acc = currentAccount();
  const start = Number(acc?.starting_balance || 0);
  const events = [];
  for (const t of state.trades)
    events.push({ kind: "trade", date: t.trade_date, ts: t.created_at, delta: Number(t.pnl || 0), ref: t });
  for (const c of state.cash)
    events.push({
      kind: c.type,
      date: c.tx_date,
      ts: c.created_at,
      delta: c.type === "withdraw" ? -Math.abs(Number(c.amount || 0)) : Math.abs(Number(c.amount || 0)),
      ref: c,
    });
  events.sort((a, b) => (a.date === b.date ? String(a.ts).localeCompare(String(b.ts)) : String(a.date).localeCompare(String(b.date))));
  let bal = start;
  for (const e of events) {
    bal += e.delta;
    e.balance = bal;
  }
  return { start, events, balance: bal };
}

export function tradeRunningBalance(tradeId) {
  const l = ledger();
  const e = l.events.find((x) => x.kind === "trade" && x.ref.id === tradeId);
  return e ? e.balance : l.balance;
}

// ---------- trades CRUD ----------
export async function saveTrade(payload, id = null) {
  if (!navigator.onLine) return offlineMutate("trades", id ? "update" : "insert", payload, id);
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("trades").update(row).eq("id", id).select().single();
  else res = await sb().from("trades").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteTrade(id) {
  if (!navigator.onLine) return offlineMutate("trades", "delete", null, id);
  const t = state.trades.find((x) => x.id === id);
  if (t?.screenshot_path) {
    await sb().storage.from(SCREENSHOTS_BUCKET).remove([t.screenshot_path]).catch(() => {});
  }
  const { error } = await sb().from("trades").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

export async function clearAllTrades() {
  const { error } = await sb().from("trades").delete().eq("account_id", state.currentAccountId);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- cash CRUD ----------
export async function saveCash(payload, id = null) {
  if (!navigator.onLine) return offlineMutate("cash_transactions", id ? "update" : "insert", payload, id);
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("cash_transactions").update(row).eq("id", id).select().single();
  else res = await sb().from("cash_transactions").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteCash(id) {
  if (!navigator.onLine) return offlineMutate("cash_transactions", "delete", null, id);
  const { error } = await sb().from("cash_transactions").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- skipped CRUD ----------
export async function saveSkipped(payload, id = null) {
  if (!navigator.onLine) return offlineMutate("skipped_trades", id ? "update" : "insert", payload, id);
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("skipped_trades").update(row).eq("id", id).select().single();
  else res = await sb().from("skipped_trades").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteSkipped(id) {
  if (!navigator.onLine) return offlineMutate("skipped_trades", "delete", null, id);
  const { error } = await sb().from("skipped_trades").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- weekly reviews CRUD ----------
export async function saveReview(payload, id = null) {
  if (!navigator.onLine) return offlineMutate("weekly_reviews", id ? "update" : "insert", payload, id);
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("weekly_reviews").update(row).eq("id", id).select().single();
  else res = await sb().from("weekly_reviews").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteReview(id) {
  if (!navigator.onLine) return offlineMutate("weekly_reviews", "delete", null, id);
  const { error } = await sb().from("weekly_reviews").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- daily plans CRUD ----------
export async function saveDailyPlan(payload, id = null) {
  if (!navigator.onLine) return offlineMutate("daily_plans", id ? "update" : "insert", payload, id);
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("daily_plans").update(row).eq("id", id).select().single();
  else res = await sb().from("daily_plans").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteDailyPlan(id) {
  if (!navigator.onLine) return offlineMutate("daily_plans", "delete", null, id);
  const { error } = await sb().from("daily_plans").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- goals CRUD ----------
async function seedDefaultGoals(accountId) {
  if (!state.user || !navigator.onLine) return;
  const rows = DEFAULT_GOALS.map((g) => ({
    user_id: state.user.id,
    account_id: accountId,
    title: g.title,
    type: g.type,
    period: g.period,
    target_value: g.target_value,
    comparison: g.comparison,
    is_active: true,
    is_default: true,
    notify_on_breach: true,
  }));
  const { error } = await sb().from("goals").insert(rows);
  if (error) throw error;
}

async function ensureGoalsForAccount(accountId) {
  if (!state.user || !navigator.onLine || !accountId) return;
  const { count, error } = await sb()
    .from("goals")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (error) throw error;
  if (!count) await seedDefaultGoals(accountId);
}

export async function saveGoal(payload, id = null) {
  if (!navigator.onLine) return offlineMutate("goals", id ? "update" : "insert", payload, id);
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("goals").update(row).eq("id", id).select().single();
  else res = await sb().from("goals").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteGoal(id) {
  if (!navigator.onLine) return offlineMutate("goals", "delete", null, id);
  const { error } = await sb().from("goals").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

export async function toggleGoalActive(id, isActive) {
  return saveGoal({ is_active: isActive }, id);
}

// ---------- storage: screenshots ----------
export async function uploadScreenshot(file, onProgress) {
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `${state.user.id}/${state.currentAccountId}/${Date.now()}.${ext}`;
  // supabase-js v2 doesn't expose upload progress, so we fake coarse steps.
  onProgress?.(10);
  const { error } = await sb()
    .storage.from(SCREENSHOTS_BUCKET)
    .upload(path, file, { cacheControl: "3600", upsert: false, contentType: file.type });
  if (error) throw new Error(humanError(error));
  onProgress?.(100);
  return path;
}

export async function signedUrl(path, expires = 3600) {
  if (!path) return null;
  const { data, error } = await sb()
    .storage.from(SCREENSHOTS_BUCKET)
    .createSignedUrl(path, expires);
  if (error) return null;
  return data.signedUrl;
}

// ---------- realtime ----------
export function subscribeRealtime() {
  unsubscribeRealtime();
  const c = getSupabase();
  if (!c || !state.user) return;
  channel = c.channel("gj-" + state.user.id);
  const tables = ["trades", "cash_transactions", "skipped_trades", "weekly_reviews", "daily_plans", "goals", "accounts", "journal_meta"];
  for (const table of tables) {
    channel.on("postgres_changes", { event: "*", schema: "public", table, filter: `user_id=eq.${state.user.id}` }, () => {
      refreshAll().catch(() => {});
      if (state.accounts.length) reloadAccountsQuietly().catch(() => {});
    });
  }
  channel.subscribe();
}

async function reloadAccountsQuietly() {
  const { data } = await sb().from("accounts").select("*").order("created_at", { ascending: true });
  if (data) {
    state.accounts = data;
    emit();
  }
}

export function unsubscribeRealtime() {
  if (channel) {
    getSupabase()?.removeChannel(channel);
    channel = null;
  }
}
