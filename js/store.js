// Central data store: talks to Supabase, caches per-account data, exposes
// CRUD, computes balances, drives realtime + sync-status + offline events.
import { getSupabase, humanError } from "./supabaseClient.js";
import { SCREENSHOTS_BUCKET } from "./config.js";
import { DEFAULT_OPTIONS } from "./defaults.js";

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
  options: structuredClone(DEFAULT_OPTIONS),
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
window.addEventListener("online", () => {
  state.online = true;
  setSync("synced");
  refreshAll().catch(() => {});
});
window.addEventListener("offline", () => {
  state.online = false;
  setSync("offline");
});

export function setUser(user) {
  state.user = user;
  if (!user) {
    state.accounts = [];
    state.currentAccountId = null;
    state.trades = state.cash = state.skipped = state.reviews = [];
    state.options = structuredClone(DEFAULT_OPTIONS);
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
  }
  state.accounts = accounts;
  const saved = localStorage.getItem("gj-account-" + state.user.id);
  state.currentAccountId =
    (saved && accounts.some((a) => a.id === saved) && saved) || accounts[0].id;
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
  const { data, error } = await sb()
    .from("journal_meta")
    .select("value")
    .eq("key", "options")
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  const merged = structuredClone(DEFAULT_OPTIONS);
  if (data?.value) Object.assign(merged, data.value);
  state.options = merged;
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

// ---------- data load ----------
export async function refreshAll() {
  if (!state.user) return;
  if (!navigator.onLine) {
    setSync("offline");
    return;
  }
  setSync("syncing");
  try {
    const acc = state.currentAccountId;
    const [trades, cash, skipped, reviews] = await Promise.all([
      sb().from("trades").select("*").eq("account_id", acc).order("trade_date", { ascending: true }).order("created_at", { ascending: true }),
      sb().from("cash_transactions").select("*").eq("account_id", acc).order("tx_date", { ascending: true }).order("created_at", { ascending: true }),
      sb().from("skipped_trades").select("*").eq("account_id", acc).order("trade_date", { ascending: false }),
      sb().from("weekly_reviews").select("*").eq("account_id", acc).order("week_of", { ascending: false }),
    ]);
    for (const r of [trades, cash, skipped, reviews]) if (r.error) throw r.error;
    state.trades = trades.data || [];
    state.cash = cash.data || [];
    state.skipped = skipped.data || [];
    state.reviews = reviews.data || [];
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
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("trades").update(row).eq("id", id).select().single();
  else res = await sb().from("trades").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteTrade(id) {
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
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("cash_transactions").update(row).eq("id", id).select().single();
  else res = await sb().from("cash_transactions").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteCash(id) {
  const { error } = await sb().from("cash_transactions").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- skipped CRUD ----------
export async function saveSkipped(payload, id = null) {
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("skipped_trades").update(row).eq("id", id).select().single();
  else res = await sb().from("skipped_trades").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteSkipped(id) {
  const { error } = await sb().from("skipped_trades").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
}

// ---------- weekly reviews CRUD ----------
export async function saveReview(payload, id = null) {
  const row = { ...payload, user_id: state.user.id, account_id: state.currentAccountId };
  let res;
  if (id) res = await sb().from("weekly_reviews").update(row).eq("id", id).select().single();
  else res = await sb().from("weekly_reviews").insert(row).select().single();
  if (res.error) throw new Error(humanError(res.error));
  await refreshAll();
  return res.data;
}

export async function deleteReview(id) {
  const { error } = await sb().from("weekly_reviews").delete().eq("id", id);
  if (error) throw new Error(humanError(error));
  await refreshAll();
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
  const tables = ["trades", "cash_transactions", "skipped_trades", "weekly_reviews", "accounts", "journal_meta"];
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
