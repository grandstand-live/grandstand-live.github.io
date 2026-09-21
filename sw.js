/* Grandstand service worker — network first, cache as a fallback.
   The page is a live scoreboard, so a stale copy must never win over the
   network; the cache only exists so the app still opens when offline. */
var CACHE = 'grandstand-v2';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL).catch(function () {});
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('message', function (e) {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Never touch the sports APIs — those must always be live.
  if (url.origin !== self.location.origin) return;

  /* The page itself is fetched past the HTTP cache. GitHub Pages serves it
     with max-age=600, which is how an installed app can keep showing a
     ten-minute-old build after an update has already shipped. */
  var isPage = req.mode === 'navigate' ||
    url.pathname === '/' || /\.html$/.test(url.pathname);

  e.respondWith(
    fetch(isPage ? new Request(req, { cache: 'no-store' }) : req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match('./index.html');
      });
    })
  );
});
