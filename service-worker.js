/* Gold Journal service worker — offline app shell + runtime caching.
 * Bump CACHE_VERSION on every deploy so clients detect a new version. */
const CACHE_VERSION = "gj-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// App shell precached on install so the app opens offline.
const APP_SHELL = [
  "./",
  "index.html",
  "manifest.json",
  "css/styles.css",
  "js/app.js",
  "js/auth.js",
  "js/config.js",
  "js/defaults.js",
  "js/export.js",
  "js/fullReport.js",
  "js/modal.js",
  "js/pwa.js",
  "js/offline.js",
  "js/store.js",
  "js/supabaseClient.js",
  "js/ui.js",
  "js/pages/ai.js",
  "js/pages/analysis.js",
  "js/pages/missed.js",
  "js/pages/options.js",
  "js/pages/pnl.js",
  "js/pages/tradelog.js",
  "js/pages/weekly.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png",
];

// Third-party CDNs we cache at runtime (Bootstrap, fonts, Lucide, jsPDF, Supabase JS lib).
const RUNTIME_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

// Never touched by the SW cache: Supabase API/auth/realtime and Storage (screenshots).
function isSupabase(url) {
  return (
    url.pathname.startsWith("/rest/v1/") ||
    url.pathname.startsWith("/auth/v1/") ||
    url.pathname.startsWith("/storage/v1/") ||
    url.pathname.startsWith("/realtime/v1/") ||
    /supabase\.(co|in)$/.test(url.hostname)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(APP_SHELL))
    // Note: no skipWaiting() here — the new SW waits so the app can show
    // an "update available" banner and activate on user confirmation.
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache mutations

  const url = new URL(req.url);
  if (isSupabase(url)) return; // let the network handle Supabase + screenshots

  // App-shell navigations: network-first, fall back to cached index.html offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("index.html").then((r) => r || caches.match("./")))
    );
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isRuntimeHost = RUNTIME_HOSTS.includes(url.hostname);
  if (!sameOrigin && !isRuntimeHost) return; // ignore other cross-origin

  // Cache-first with background refresh (stale-while-revalidate).
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && (res.type === "basic" || res.type === "cors")) {
            const copy = res.clone();
            const cacheName = sameOrigin ? STATIC_CACHE : RUNTIME_CACHE;
            caches.open(cacheName).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
