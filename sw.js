/* AutoCoach Lift — service worker (v5).
   - Pre-caches the app shell so the PWA installs and runs fully offline.
   - Network-first for same-origin GETs (updates arrive as soon as you're online), with a
     cache fallback when offline or when the network is slow (3.5 s).
   - Cross-origin requests (the Gemini API and your Supabase project — sign-in and cloud sync) and
     non-GET requests are never touched, so sync traffic always goes straight to the network.
   - The page can send {type:'SKIP_WAITING'} to activate a freshly installed worker.
   - Rest-timer alerts: the page posts {type:'REST_SCHEDULE', end, title, label, icon}; the worker waits
     (inside event.waitUntil, so the browser keeps it alive for a few minutes at most) and then shows a system
     notification — unless the app is already visible. {type:'REST_CANCEL'} withdraws it. This is best-effort:
     a browser may still suspend the worker. Guaranteed background delivery would need a push server. */
const CACHE = 'autocoach-lift-v5';
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

let rest = null; // { id, timer, finish }

function cancelRest() {
  if (!rest) return;
  clearTimeout(rest.timer);
  const r = rest; rest = null; r.finish();
}

function appVisible() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(list => list.some(c => c.visibilityState === 'visible' && (c.focused === undefined || c.focused)));
}

function scheduleRest(msg) {
  cancelRest();
  const wait = Math.max(0, Math.min(Number(msg.end) - Date.now(), 290000));
  if (!isFinite(wait)) return Promise.resolve();
  return new Promise(resolve => {
    const me = { finish: resolve };
    me.timer = setTimeout(() => {
      if (rest === me) rest = null;
      appVisible().then(visible => {
        if (visible) return null;
        const label = msg.label ? String(msg.label) + ' \u2014 r' : 'R';
        return self.registration.showNotification(msg.title || 'Coach Ducky: Time for your next set!', {
          body: label + 'est is over. Get back under that bar! \ud83d\udcaa',
          tag: 'rest-timer', renotify: false, requireInteraction: false,
          vibrate: [200, 100, 200, 100, 400],
          icon: msg.icon || undefined, badge: msg.icon || undefined,
          data: { url: self.registration.scope }
        });
      }).catch(() => {}).then(resolve);
    }, wait);
    rest = me;
  });
}

self.addEventListener('message', event => {
  const d = event.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  else if (d.type === 'REST_SCHEDULE') event.waitUntil(scheduleRest(d));
  else if (d.type === 'REST_CANCEL') cancelRest();
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = list.find(c => 'focus' in c);
      if (open) { open.postMessage({ type: 'REST_DONE' }); return open.focus(); }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    })
  );
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
