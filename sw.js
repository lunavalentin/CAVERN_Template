// One cache name per tour: it contains this worker's scope, so tours that share an origin (for
// example several project pages under one github.io domain) do not share a cache, and a tour
// deletes only its own older caches. A tour on the same origin that still runs the stock worker
// deletes every other cache, this one included, when its worker activates; this tour's next
// online visit in a new tab stores its own files again (a reload of a tab that stayed open can
// take the scripts from the browser's memory cache, past this worker, so they are not stored
// again). The spaces around the scope cannot occur unencoded in a URL, so no other tour's cache
// name starts with this tour's prefix. Raise the version when the precached files change.
const CACHE_PREFIX = 'cavern ' + self.registration.scope + ' ';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const URLS_TO_CACHE = [
    './',
    './index.html',
    './config.json',
    './scripts/main.js',
    './scripts/audio.js',
    './scripts/map.js',
    'https://aframe.io/releases/1.4.2/aframe.min.js',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css',
    // Add other critical assets here if needed, but not all large images
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(URLS_TO_CACHE);
            })
    );
});

self.addEventListener('fetch', event => {
    // Same-origin GET: network first (a returning visitor gets the current page, settings, scripts
    // and data, as far as the HTTP cache lets the request through), small files refresh the cache,
    // and this tour's own cached copy is used only when the network fails (caches.match would
    // search every cache of the origin, the stock worker's shared 'cavern-v1' first).
    // Other hosts (the pinned CDN libraries): cache first, as before.
    const req = event.request;
    const sameOrigin = new URL(req.url).origin === self.location.origin;
    if (sameOrigin && req.method === 'GET') {
        event.respondWith(
            fetch(req)
                .then(response => {
                    const small = /(\/|\.html|\.json|\.csv|\.js|\.svg)$/.test(new URL(req.url).pathname);
                    if (small && response && response.status === 200 && response.type === 'basic') {
                        const copy = response.clone();
                        // waitUntil keeps the worker alive until the copy is stored
                        event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => { }));
                    }
                    return response;
                })
                .catch(() => caches.open(CACHE_NAME).then(cache => cache.match(req)).then(r => r || Response.error()))
        );
        return;
    }
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});

self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // the stock worker's 'cavern-v1' is shared by every tour of the origin: only this
                    // tour's own precached files are removed from it (the CDN files and other tours'
                    // files stay)
                    if (cacheName === 'cavern-v1') {
                        const own = URLS_TO_CACHE.map(u => new URL(u, self.location))
                            .filter(u => u.origin === self.location.origin).map(u => u.href);
                        return caches.open(cacheName).then(cache => Promise.all(own.map(u => cache.delete(u))));
                    }
                    // only this tour's own retired caches: never another tour's or application's
                    if (cacheName.startsWith(CACHE_PREFIX) && cacheWhitelist.indexOf(cacheName) === -1) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
});
