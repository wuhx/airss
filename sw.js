const CACHE_NAME = 'airss-cache-77baf537';
const DATA_CACHE_NAME = 'airss-data-v1';

const CORE_ASSETS = [
  './',
  './index.html',
  './assets/style.css',
  './assets/app.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (key !== CACHE_NAME && key !== DATA_CACHE_NAME) {
          return caches.delete(key);
        }
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // XML feeds and feeds.json use Network-First (fallback to cache)
  // or Stale-While-Revalidate depending on how we handle it. 
  // Let's use Network-First to ensure we get the latest if online, 
  // but fallback to cache if offline.
  if (url.pathname.endsWith('.xml') || url.pathname.endsWith('feeds.json')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const resClone = response.clone();
          caches.open(DATA_CACHE_NAME).then(cache => cache.put(event.request, resClone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Core assets use Cache-First (with network fallback)
  if (CORE_ASSETS.some(asset => url.pathname.endsWith(asset.replace('./', '')))) {
    event.respondWith(
      caches.match(event.request).then(response => {
        return response || fetch(event.request).then(netRes => {
          const resClone = netRes.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
          return netRes;
        });
      })
    );
    return;
  }

  // Everything else (like images inside articles) uses Cache-First then Network
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request).catch(() => {
        // Ignore errors for images when offline
      });
    })
  );
});
