import { state, saveReview, deleteReview } from "../store.js";
import { toast, confirmDialog, fmtDate, todayISO, escapeHtml } from "../ui.js";

export function render(container) {
  container.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Weekly Review</h1><p class="page-sub">Reflect and improve every week</p></div>
  </div>

  <div class="two-col">
    <form id="review-form" class="glass card-pad modal-form">
      <label class="field"><span>Week of</span><input type="date" name="week_of" value="${todayISO()}" required></label>
      <label class="field"><span>What did I learn this week?</span><textarea name="learned" rows="3" placeholder="Key lessons…"></textarea></label>
      <label class="field"><span>What pattern repeated (good or bad)?</span><textarea name="pattern" rows="3" placeholder="Recurring behaviour…"></textarea></label>
      <label class="field"><span>What will I improve next week?</span><textarea name="improve" rows="3" placeholder="Concrete actions…"></textarea></label>
      <button type="submit" class="btn btn-gold" id="save-review"><span class="btn-label">Save Review</span></button>
    </form>

    <div class="review-history">
      <div class="rh-head"><h6>History</h6><span class="count-badge">${state.reviews.length}</span></div>
      <div id="review-list">${listHtml()}</div>
    </div>
  </div>`;

  window.lucide?.createIcons({ nameAttr: "data-lucide" });

  const form = container.querySelector("#review-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("#save-review");
    if (btn.disabled) return;
    const fd = new FormData(form);
    if (!fd.get("learned") && !fd.get("pattern") && !fd.get("improve")) return toast("Fill in at least one field.", "warning");
    btn.disabled = true; btn.classList.add("loading");
    try {
      await saveReview({ week_of: fd.get("week_of"), learned: fd.get("learned") || null, pattern: fd.get("pattern") || null, improve: fd.get("improve") || null });
      toast("Review saved.", "success");
      render(container);
    } catch (err) { toast(err.message, "error"); }
    finally { btn.disabled = false; btn.classList.remove("loading"); }
  });

  container.querySelector("#review-list").addEventListener("click", async (e) => {
    const del = e.target.closest("[data-del]");
    if (!del) return;
    const ok = await confirmDialog({ title: "Delete review?", body: "This can't be undone.", confirmText: "Delete" });
    if (!ok) return;
    try { await deleteReview(del.dataset.del); toast("Deleted.", "success"); render(container); } catch (err) { toast(err.message, "error"); }
  });
}

function listHtml() {
  if (!state.reviews.length) return `<div class="empty-state"><i data-lucide="notebook-pen"></i><p>No reviews yet.</p></div>`;
  return state.reviews.map((r) => `
    <div class="review-item glass">
      <div class="ri-head">
        <span class="ri-week"><i data-lucide="calendar"></i> Week of ${fmtDate(r.week_of)}</span>
        <button class="ic-btn danger" data-del="${r.id}"><i data-lucide="trash-2"></i></button>
      </div>
      ${r.learned ? `<div class="ri-block"><span>Learned</span><p>${escapeHtml(r.learned)}</p></div>` : ""}
      ${r.pattern ? `<div class="ri-block"><span>Pattern</span><p>${escapeHtml(r.pattern)}</p></div>` : ""}
      ${r.improve ? `<div class="ri-block"><span>Improve</span><p>${escapeHtml(r.improve)}</p></div>` : ""}
    </div>`).join("");
}
