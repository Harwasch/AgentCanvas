/* Agent Hub service worker: app-shell cache + web push. Never caches /api/ or /hooks/.
   Built assets have hashed names; whenever a new index.html arrives (install, activate, navigation) the cache keeps
   only the /assets/ files it references (directly, or as chunks named inside those scripts) and drops the rest. */
const CACHE = 'hub-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg', '/fonts/Geist-latin.woff2', '/fonts/GeistMono-latin.woff2'];

const bypass = (url) => url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/hooks/') || url.pathname.startsWith('/login');

async function precache() {
  const cache = await caches.open(CACHE);
  const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (res.ok) {
    const html = await res.clone().text();
    await cache.put('/', res);
    // built assets referenced by index.html (hashed names)
    const assets = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)).map((m) => m[1]);
    await Promise.all([...SHELL.slice(1), ...assets].map((u) => cache.add(u).catch(() => undefined)));
    await prune(html).catch(() => undefined);
  }
}

/** /assets/ paths the given index.html needs: its tags, plus chunks the entry scripts import (followed a few levels) */
async function referenced(cache, html) {
  const keep = new Set(Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)).map((m) => m[1]));
  const queue = [...keep].filter((u) => u.endsWith('.js'));
  for (let i = 0; i < queue.length && i < 60; i++) {
    const res = (await cache.match(queue[i])) || (await fetch(queue[i]).catch(() => null));
    if (!res || !res.ok) continue;
    const js = await res.clone().text();
    for (const m of js.matchAll(/["'`](?:\.\/|\/?assets\/)([\w.-]+\.(?:js|css))["'`]/g)) {
      const u = `/assets/${m[1]}`;
      if (!keep.has(u)) {
        keep.add(u);
        if (u.endsWith('.js')) queue.push(u);
      }
    }
  }
  return keep;
}

/** drop cached /assets/ files the current index.html no longer references (old hashed builds) */
async function prune(html) {
  const cache = await caches.open(CACHE);
  const keep = await referenced(cache, html);
  if (!keep.size) return; // not a built index.html: keep everything
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p.startsWith('/assets/') && !keep.has(p)) await cache.delete(req);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await precache().catch(() => undefined);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (bypass(url)) return;

  if (req.mode === 'navigate') {
    // network-first; fall back to the cached shell
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && url.pathname === '/') {
          const cache = await caches.open(CACHE);
          await cache.put('/', res.clone());
          // a new build: forget the old hashed assets (sw.js itself does not change between builds)
          event.waitUntil(res.clone().text().then(prune).catch(() => undefined));
        }
        return res;
      } catch {
        const cached = (await caches.match(req)) || (await caches.match('/'));
        return cached || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    // hashed / static: cache-first
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    })());
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Agent Hub', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Agent Hub';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || (data.data && data.data.url) || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if (c.url !== target && 'navigate' in c) { try { await c.navigate(target); } catch { /* cross-origin or not controlled */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
