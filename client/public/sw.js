// Bump on any shell/stylesheet change: the fetch handler is network-first, but a
// stale cached bundle is what makes a shipped fix look like it never landed.
const CACHE_NAME = "gold-journal-static-v27";
const PRECACHE = ["/manifest.json", "/gold-journal-3d.svg"];

// No skipWaiting here: the new worker must park in `waiting` so the app's
// "Update now" banner has a worker to activate. Activating eagerly left the
// banner with nothing to promote and the user stuck on the old bundle.
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(PRECACHE.map(asset => cache.add(asset)))));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/storage/")) return;
  if (!["script", "style", "image", "font"].includes(request.destination)) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  }).catch(() => caches.match(request)));
});
