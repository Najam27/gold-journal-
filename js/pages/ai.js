import { state } from "../store.js";
import { AI_MODEL } from "../config.js";
import { toast, escapeHtml, fmtMoney } from "../ui.js";

const KEY_STORE = "gj-openrouter-key"; // sessionStorage only — never persisted to DB

export function render(container) {
  const hasKey = !!sessionStorage.getItem(KEY_STORE);
  const savedReview = sessionStorage.getItem("gj-ai-review");

  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">AI Mentor</h1><p class="page-sub">Get an AI review of your trading</p></div>
  </div>

  <div class="two-col">
    <div class="glass card-pad">
      <h6>Settings</h6>
      <label class="field"><span>OpenRouter API key</span>
        <div class="pw-wrap">
          <input type="password" id="ai-key" placeholder="sk-or-..." value="${hasKey ? "••••••••••••" : ""}">
          <button type="button" class="pw-toggle" id="ai-key-toggle"><i data-lucide="eye"></i></button>
        </div>
      </label>
      <label class="field"><span>Model</span><input type="text" value="${AI_MODEL}" readonly></label>
      <div class="btn-row">
        <button class="btn btn-gold btn-sm" id="save-key">Save Key</button>
        <button class="btn btn-ghost btn-sm" id="clear-key">Clear Key</button>
      </div>
      <p class="note"><i data-lucide="shield"></i> Your key is stored only in this browser session (never sent to our servers or database). It's used to call OpenRouter directly from your browser.</p>
      <button class="btn btn-gold btn-block mt" id="analyze"><i data-lucide="brain"></i> Analyze Trades</button>
    </div>

    <div class="glass card-pad ai-output" id="ai-output">
      ${savedReview ? renderReview(savedReview) : emptyState()}
    </div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });

  const keyInput = container.querySelector("#ai-key");
  container.querySelector("#ai-key-toggle").addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });
  container.querySelector("#save-key").addEventListener("click", () => {
    const v = keyInput.value.trim();
    if (!v || v.startsWith("••")) return toast("Enter a valid key.", "warning");
    sessionStorage.setItem(KEY_STORE, v);
    keyInput.value = "••••••••••••";
    toast("API key saved for this session.", "success");
  });
  container.querySelector("#clear-key").addEventListener("click", () => {
    sessionStorage.removeItem(KEY_STORE);
    keyInput.value = "";
    toast("API key cleared.", "info");
  });
  container.querySelector("#analyze").addEventListener("click", () => analyze(container));
}

function emptyState() {
  return `<div class="empty-state"><i data-lucide="message-square-text"></i><p>No review yet. Add your OpenRouter key and click <strong>Analyze Trades</strong>.</p></div>`;
}

function renderReview(text) {
  return `<div class="ai-review">${mdToHtml(text)}</div>`;
}

function summarise() {
  const t = state.trades;
  const wins = t.filter((x) => x.result === "Win").length;
  const losses = t.filter((x) => x.result === "Loss").length;
  const decided = wins + losses;
  const pnl = t.reduce((s, x) => s + Number(x.pnl || 0), 0);
  const bySetup = {}, byMistake = {}, bySession = {};
  for (const x of t) {
    bySetup[x.setup_quality || "?"] = (bySetup[x.setup_quality || "?"] || 0) + 1;
    if (x.mistake && x.mistake !== "No mistake") byMistake[x.mistake] = (byMistake[x.mistake] || 0) + 1;
    bySession[x.session || "?"] = (bySession[x.session || "?"] || 0) + Number(x.pnl || 0);
  }
  return {
    count: t.length, wins, losses, winRate: decided ? ((wins / decided) * 100).toFixed(1) : 0,
    totalPnl: pnl.toFixed(2), bySetup, byMistake, bySession,
    recent: t.slice(-15).map((x) => ({ date: x.trade_date, side: x.side, setup: x.setup_quality, result: x.result, pnl: x.pnl, mistake: x.mistake, notes: x.notes })),
  };
}

async function analyze(container) {
  const key = sessionStorage.getItem(KEY_STORE);
  const out = container.querySelector("#ai-output");
  const btn = container.querySelector("#analyze");
  if (!key) return toast("Add your OpenRouter API key first.", "warning");
  if (!state.trades.length) return toast("No trades to analyse.", "warning");

  btn.disabled = true; btn.classList.add("loading");
  out.innerHTML = `<div class="ai-loading"><div class="ai-orb"></div><p>Analysing your trades…</p></div>`;

  const data = summarise();
  const prompt = `You are an elite XAUUSD (gold) trading mentor. Analyse this trader's journal data and give a concise, direct performance review with: 1) overall assessment, 2) biggest strengths, 3) biggest leaks/mistakes to fix, 4) 3 concrete action items for next week. Use markdown headers and bullet points. Be specific and reference their numbers.\n\nDATA:\n${JSON.stringify(data, null, 2)}`;

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "user", content: prompt }] }),
    });
    if (res.status === 401) throw new Error("Invalid API key.");
    if (!res.ok) throw new Error(`Request failed (${res.status}).`);
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from model.");
    sessionStorage.setItem("gj-ai-review", text);
    out.innerHTML = renderReview(text);
    window.lucide?.createIcons({ nameAttr: "data-lucide" });
    toast("Review generated.", "success");
  } catch (err) {
    out.innerHTML = emptyState();
    window.lucide?.createIcons({ nameAttr: "data-lucide" });
    toast(err.message || "AI request failed.", "error");
  } finally {
    btn.disabled = false; btn.classList.remove("loading");
  }
}

// minimal markdown -> html (headers, bold, lists)
function mdToHtml(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "", inList = false;
  for (let line of lines) {
    line = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    if (/^#{1,6}\s/.test(line)) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = line.match(/^#+/)[0].length;
      html += `<h${Math.min(level + 2, 6)}>${line.replace(/^#+\s/, "")}</h${Math.min(level + 2, 6)}>`;
    } else if (/^\s*[-*]\s/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${line.replace(/^\s*[-*]\s/, "")}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${line}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}
