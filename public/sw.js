// App shell cache so vendor pages open with no signal, plus push notifications.
const CACHE = 'ros-v2';
const SHELL = [
  '/', '/index.html', '/planner.html', '/vendor.html', '/css/app.css',
  '/invite.html', '/gate.html', '/js/time.js', '/js/common.js', '/js/planner.js', '/js/vendor.js', '/vendor/jsqr.js',
  '/socket.io/socket.io.js', '/manifest.webmanifest', '/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js')) return;

  if (e.request.mode === 'navigate') {
    const pages = { v: '/vendor.html', p: '/planner.html', i: '/invite.html', gate: '/gate.html' };
    const page = pages[url.pathname.split('/')[1]] || '/index.html';
    e.respondWith(fetch(e.request).catch(() => caches.match(page)));
    return;
  }

  // Serve from cache, refresh in the background.
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request);
    const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : { title: 'Run-of-show update', body: 'Your timeline changed.' };
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/icon.svg', badge: '/icon.svg', tag: 'ros-change', renotify: true, vibrate: [120, 60, 120], data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => new URL(w.url).pathname === url);
    return win ? win.focus() : self.clients.openWindow(url);
  }));
});
