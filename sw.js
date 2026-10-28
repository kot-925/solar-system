// Service worker: повторные запуски — мгновенно и без сети.
// Текстуры не меняются → «сначала кэш». Код и страница → отдаём из кэша сразу,
// а свежую версию тихо подтягиваем в фоне (увидите её при следующем открытии).
// При изменении текстур без смены имён файлов увеличьте VERSION.
const VERSION = 'v1';
const CACHE = `solar-${VERSION}`;
const CORE = ['./', 'index.html', 'main.js', 'data.js', 'shaders.js', 'previews.js', 'vendor/three.js', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/textures/') || url.pathname.includes('/icons/')) {
    e.respondWith(cacheFirst(e.request));
  } else {
    e.respondWith(staleWhileRevalidate(e.request, e));
  }
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const update = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  if (hit) {
    event.waitUntil(update.catch(() => {}));
    return hit;
  }
  return update;
}
