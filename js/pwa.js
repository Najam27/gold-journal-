// PWA glue: service-worker registration, install prompt, and update detection.
// Emits window CustomEvents the UI layer (app.js) listens to:
//   gj:installable   → the browser can show a native install prompt
//   gj:installed     → the app was installed
//   gj:update-ready  → a new service worker is waiting to activate

let deferredPrompt = null;
let waitingWorker = null;
let reloadingForUpdate = false;

export function isIOS() {
  const ua = navigator.userAgent || "";
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as Mac but has touch.
  const iPadOS = /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

export function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

export function canPromptInstall() {
  return !!deferredPrompt;
}

// Trigger the native install prompt. Returns the user's choice ("accepted"/"dismissed")
// or null when no prompt is available.
export async function promptInstall() {
  if (!deferredPrompt) return null;
  deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  return outcome;
}

// Activate the waiting service worker; the page reloads on controllerchange.
export function applyUpdate() {
  if (waitingWorker) waitingWorker.postMessage("SKIP_WAITING");
}

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function initPWA() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    emit("gj:installable");
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    emit("gj:installed");
  });

  if (!("serviceWorker" in navigator)) return;

  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("service-worker.js");

      // A worker is already waiting (update found on a previous load).
      if (reg.waiting && navigator.serviceWorker.controller) {
        waitingWorker = reg.waiting;
        emit("gj:update-ready");
      }

      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          // Newly installed AND an old SW controls the page → it's an update.
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            waitingWorker = reg.waiting || nw;
            emit("gj:update-ready");
          }
        });
      });

      // Periodically check for a new deployment.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    } catch {
      /* SW registration failed — app still works online */
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    });
  });
}
