// Lightweight animated modal (fade + scale). Not dependent on Bootstrap JS
// so we fully control the open/close animation.

export function openModal({ title = "", bodyHtml = "", size = "", onMount } = {}) {
  const backdrop = document.createElement("div");
  backdrop.className = "gj-modal-backdrop";
  backdrop.innerHTML = `
    <div class="gj-modal ${size}" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="gj-modal-header">
        <h5 class="gj-modal-title">${title}</h5>
        <button class="gj-modal-x" aria-label="Close">&times;</button>
      </div>
      <div class="gj-modal-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(backdrop);
  document.body.classList.add("gj-modal-open");
  window.lucide?.createIcons({ nameAttr: "data-lucide" });

  const close = () => {
    backdrop.classList.remove("show");
    document.body.classList.remove("gj-modal-open");
    setTimeout(() => backdrop.remove(), 220);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  backdrop.querySelector(".gj-modal-x").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);

  requestAnimationFrame(() => backdrop.classList.add("show"));

  const api = { el: backdrop, body: backdrop.querySelector(".gj-modal-body"), close };
  onMount?.(api);
  return api;
}
