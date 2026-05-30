/**
 * DriveTracker Service Worker
 *
 * Strategy:
 *  - Static shell assets (HTML, JS, CSS, icons): Cache-first with background update.
 *  - Leaflet CDN assets: Stale-while-revalidate â€” serve from cache instantly, refresh in background.
 *  - OSM map tiles: Stale-while-revalidate with a dedicated tile cache capped at 2000 entries
 *    so we don't balloon storage on a mobile device.
 *  - Everything else (unknown): Network-first with cache fallback.
 *
 * sw.js itself must be served with Cache-Control: no-cache so the browser picks up
 * new versions immediately (configured in GCS / Firebase Hosting â€” see DEPLOY.md).
 */

// v3: evicts the old shell that still contained app.js with seedDefaultVehicles().
// Any device running the v2 shell was serving stale app.js which re-seeded
// the default vehicles on every fresh IndexedDB, regardless of the DB v3 migration.
const SHELL_CACHE   = 'DriveTracker-shell-v19';
const CDN_CACHE     = 'DriveTracker-cdn-v19';
const TILE_CACHE    = 'DriveTracker-tiles-v19';
const MAX_TILES     = 2000;   // tile entries cap (~50 MB at avg 25 KB/tile)
const MAX_TILE_AGE  = 7 * 24 * 60 * 60 * 1000;  // 7 days in ms

// App shell â€” versioned; bump SHELL_CACHE name on any change.
// Asset URLs include ?v=N to bust browser disk cache on every release.
// Bump both the version query string here AND in index.html together.
// NOTE: only include assets that are confirmed to exist in the bucket.
// cache.addAll() fails the entire SW install if ANY asset returns non-200.
const SHELL_ASSETS = [
  '/index.html',
  '/app.js?v=18',
  '/styles.css?v=18',
  '/manifest.json',
  '/ui-theme/theme.css?v=18',
];

// Third-party CDN assets we want cached for full offline use.
const CDN_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
];

// â”€â”€â”€ Install â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
self.addEventListener('install', event => {
  event.waitUntil(
    Promise.all([
      caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)),
      caches.open(CDN_CACHE).then(cache =>
        // Use individual try/catch so a single CDN failure doesn't abort install.
        Promise.allSettled(CDN_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] CDN prefetch failed:', url, err))
        ))
      ),
    ]).then(() => self.skipWaiting())
  );
});

// â”€â”€â”€ Activate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
self.addEventListener('activate', event => {
  const keep = new Set([SHELL_CACHE, CDN_CACHE, TILE_CACHE]);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => !keep.has(k)).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// â”€â”€â”€ Fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests.
  if (request.method !== 'GET') return;

  // OSM tile requests — stale-while-revalidate with capped tile store.
  if (isOsmTile(url)) {
    event.respondWith(tileStrategy(request));
    return;
  }

  // Leaflet CDN — stale-while-revalidate.
  if (isCdnAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
    return;
  }

  // index.html and auth.js — network-first so deployments are visible immediately.
  // These files are served with no-cache headers; the SW must not override that
  // with a stale cached copy or users would be stuck on old HTML/auth code.
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/auth.js') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  // All other shell assets — cache-first (versioned via ?v=N query string).
  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // Fallback: network-first.
  event.respondWith(networkFirst(request, SHELL_CACHE));
});

// â”€â”€â”€ Strategies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache  = await caches.open(cacheName);
  const cached = await cache.match(request);

  // Always kick off a background revalidation.
  const fetchPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(err => {
    console.warn('[SW] Revalidation fetch failed:', request.url, err);
    return null;  // null handled below — never returned to the browser
  });

  // If we have a cached copy, serve it instantly and revalidate in background.
  if (cached) return cached;

  // No cache — must wait for the network. If that also fails, return a
  // proper 503 so the browser gets a real error rather than a null response
  // (which some browsers treat as a TypeError and silently block the script).
  const networkResponse = await fetchPromise;
  return networkResponse || new Response('Resource unavailable offline.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' },
  });
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline â€” resource unavailable.', { status: 503 });
  }
}

async function tileStrategy(request) {
  const cache  = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  // Serve stale tile immediately; refresh in background.
  if (cached) {
    const cachedDate = new Date(cached.headers.get('sw-cached-at') || 0);
    const expired    = Date.now() - cachedDate.getTime() > MAX_TILE_AGE;
    if (!expired) return cached;
  }

  try {
    // Browser <img> requests use no-cors mode → opaque response (status 0).
    // response.ok is false for opaque responses, so we'd wrongly fall through to 503.
    // Fix: re-fetch with explicit cors mode — CartoCDN serves ACAO:* so this works.
    const corsReq  = new Request(request.url, { mode: 'cors' });
    const response = await fetch(corsReq);
    if (response.ok) {
      const stamped = stampResponse(response.clone());
      await evictOldTiles(cache);
      cache.put(request, stamped);
      return response;
    }
  } catch {
    if (cached) return cached;
  }

  return cached || new Response('Tile unavailable offline.', { status: 503 });
}

/**
 * Clone a response and inject a custom header recording the cache timestamp.
 * (We can't mutate the original Response object from the network.)
 */
function stampResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('sw-cached-at', new Date().toISOString());
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Evict the oldest tile entry once the cache exceeds MAX_TILES.
 * Simple LRU-lite: delete in insertion order (Cache API preserves it).
 */
async function evictOldTiles(cache) {
  const keys = await cache.keys();
  if (keys.length >= MAX_TILES) {
    await cache.delete(keys[0]);
  }
}

// â”€â”€â”€ URL classifiers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isOsmTile(url) {
  return (
    url.hostname.endsWith('.tile.openstreetmap.org') ||
    url.hostname.endsWith('.basemaps.cartocdn.com')
  );
}

function isCdnAsset(url) {
  return url.hostname === 'unpkg.com';
}

function isShellAsset(url) {
  // Same origin only.
  return url.origin === self.location.origin;
}

// â”€â”€â”€ Message handling (e.g. "skipWaiting" from the update prompt) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
