// Rewritten on every deploy by the "Stamp service worker cache key" step in
// .github/workflows/deploy.yml, from the hash of the core assets. The value
// committed here is only a placeholder — don't bother keeping it current.
const CACHE_NAME = 'airss-cache-77baf537';
const DATA_CACHE_NAME = 'airss-data-v1';
const IMG_CACHE_NAME = 'airss-img-v1';
const IMG_CACHE_LIMIT = 400;

const CORE_ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js'
];

// Absolute paths of the core assets, so the fetch handler can match on equality
// instead of endsWith(). './' resolves to the scope root, which is what a
// navigation request asks for.
const CORE_PATHS = new Set(
  CORE_ASSETS.map(a => new URL(a, self.registration.scope).pathname)
);

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Not cache.addAll: that goes through the HTTP cache, and Pages serves
    // everything with max-age=600. A cache key bumped within ten minutes of the
    // previous fetch would be seeded with the *old* build and, being served
    // cache-first, keep serving it forever.
    await Promise.all(CORE_ASSETS.map(async asset => {
      const res = await fetch(new Request(asset, { cache: 'reload' }));
      if (res.ok) await cache.put(asset, res);
    }));
  })());
});

self.addEventListener('activate', event => {
  const keep = new Set([CACHE_NAME, DATA_CACHE_NAME, IMG_CACHE_NAME]);
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => keep.has(key) ? undefined : caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

// The revalidation can finish before the page has attached its message
// listener — on a fast connection it usually does. So remember that we found an
// update and hand it to the next client that says hello, which the page does as
// soon as it registers. One-shot: once a client has been told, a reload starts
// clean and the next revalidation finds nothing changed.
let pendingUpdate = false;

async function broadcastUpdate() {
  pendingUpdate = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: 'airss-update' });
}

self.addEventListener('message', event => {
  if (event.data?.type !== 'airss-hello') return;
  if (pendingUpdate) {
    pendingUpdate = false;
    event.source?.postMessage({ type: 'airss-update' });
  }
});

// Pages sends an ETag, but don't rely on it: fall back to Last-Modified, then
// to comparing the bodies, so the update pill still fires on a server that
// sends neither. Both responses are clones the caller no longer needs.
async function hasChanged(cached, fresh) {
  for (const header of ['ETag', 'Last-Modified']) {
    const a = cached.headers.get(header);
    const b = fresh.headers.get(header);
    if (a && b) return a !== b;
  }
  const [oldBody, newBody] = await Promise.all([cached.text(), fresh.text()]);
  return oldBody !== newBody;
}

// Serve the cached copy, then revalidate in the background. The revalidation
// uses cache: 'no-cache' so it always reaches the origin for an ETag check
// (cheap 304s) rather than sitting behind Pages' max-age=600; when the ETag
// moves we refresh the cache and tell the page a new build is available.
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  // Clone now, not inside the revalidation: by the time that resumes from its
  // first await, `cached` has been handed to the page and its body is disturbed,
  // and clone() on a disturbed Response throws.
  const previous = cached && cached.clone();

  const revalidate = (async () => {
    let fresh;
    try {
      fresh = await fetch(new Request(event.request, { cache: 'no-cache' }));
    } catch {
      return cached;
    }
    if (!fresh.ok) return cached;
    const changed = previous && await hasChanged(previous, fresh.clone());
    await cache.put(event.request, fresh.clone());
    if (changed) await broadcastUpdate();
    return fresh;
  })();

  if (cached) {
    event.waitUntil(revalidate);
    return cached;
  }
  return revalidate;
}

// Network-first, and genuinely so: cache: 'no-store' keeps the ten-minute HTTP
// cache out of the way, which is the whole point of a feed reader reloading.
async function networkFirst(event) {
  try {
    const res = await fetch(new Request(event.request, { cache: 'no-store' }));
    if (res.ok) {
      const cache = await caches.open(DATA_CACHE_NAME);
      await cache.put(event.request, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstImages(event) {
  const cached = await caches.match(event.request, { cacheName: IMG_CACHE_NAME });
  if (cached) return cached;
  const res = await fetch(event.request);
  if (res.ok || res.type === 'opaque') {
    const cache = await caches.open(IMG_CACHE_NAME);
    await cache.put(event.request, res.clone());
    // These used to live in CACHE_NAME and so were wiped on every deploy. In
    // their own cache nothing evicts them, so keep it to a rolling window —
    // keys() comes back in insertion order, so the oldest are at the front.
    const keys = await cache.keys();
    if (keys.length > IMG_CACHE_LIMIT) {
      await Promise.all(keys.slice(0, keys.length - IMG_CACHE_LIMIT)
        .map(k => cache.delete(k)));
    }
  }
  return res;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Match on our own paths only: an article can perfectly well link to
  // someone else's /index.html or /feed.xml.
  const ours = url.origin === self.location.origin;

  if (ours && (url.pathname.endsWith('.xml') || url.pathname.endsWith('feeds.json'))) {
    event.respondWith(networkFirst(event));
    return;
  }

  if (event.request.mode === 'navigate' || (ours && CORE_PATHS.has(url.pathname))) {
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  // Everything else (like images inside articles) is cache-first, in its own
  // cache so a core-asset bump doesn't evict it and it doesn't bloat the core.
  event.respondWith(cacheFirstImages(event).catch(() => Response.error()));
});
