/* AutoCoach Lift — service worker (v2).
   - Pre-caches the app shell so the PWA installs and runs fully offline.
   - Network-first for same-origin GETs (updates arrive as soon as you're online), with a
     cache fallback when offline or when the network is slow (3.5 s).
   - Cross-origin requests (the Gemini API) and non-GET requests are never touched.
   - The page can send {type:'SKIP_WAITING'} to activate a freshly installed worker. */
const CACHE = 'autocoach-lift-v2';
const SHELL = ['./', './index.html'];
const SLOW_MS = 3500;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true })
    .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
}

function networkFirst(req) {
  return new Promise(resolve => {
    let settled = false;
    const done = res => { if (!settled && res) { settled = true; resolve(res); } return settled; };
    const slow = setTimeout(() => { fromCache(req).then(done); }, SLOW_MS);

    fetch(req)
      .then(res => {
        clearTimeout(slow);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { /* quota: ignore */ });
        }
        done(res);
      })
      .catch(() => {
        clearTimeout(slow);
        fromCache(req).then(hit => { if (!done(hit)) { settled = true; resolve(Response.error()); } });
      });
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(req));
});
