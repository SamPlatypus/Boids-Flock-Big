/**
 * Offline-first service worker.
 *
 * Install: precache the app shell (every module the page imports), so the
 * simulation works offline after the first visit.
 * Fetch: network-first for same-origin GETs, refreshing the cache on every
 * successful response; falls back to the cache when offline. Online users
 * always get the latest files, so deploys never serve stale code.
 *
 * Keep PRECACHE in sync with src/ (test/pwa.test.js enforces this).
 */
const CACHE = 'boids-v1';

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './src/app.js',
  './src/config.js',
  './src/core/emitter.js',
  './src/core/math.js',
  './src/core/rng.js',
  './src/core/spatial-hash.js',
  './src/core/torus.js',
  './src/input/pointer-input.js',
  './src/loop.js',
  './src/main.js',
  './src/render/renderer.js',
  './src/render/shapes.js',
  './src/render/surface.js',
  './src/sim/flocking.js',
  './src/sim/interactions.js',
  './src/sim/predator.js',
  './src/sim/prey-pool.js',
  './src/sim/simulation.js',
  './src/sim/species.js',
  './src/stats.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: true });
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
