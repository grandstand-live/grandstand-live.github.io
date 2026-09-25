/* Grandstand service worker — network first, cache as a fallback.
   The page is a live scoreboard, so a stale copy must never win over the
   network; the cache only exists so the app still opens when offline, or
   when the network is too slow to be worth waiting on. */
var CACHE = 'grandstand-v19';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

/* How long the page waits on the network before opening from the cache.
   On a train or a stadium's crowded signal the page used to sit blank until
   the request gave up; now it opens on the last copy and the fresh one
   still lands in the cache for next time. The scores inside are fetched
   live either way — only the app itself comes from the cache. */
var PAGE_WAIT = 2500;

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

  var net = fetch(isPage ? new Request(req, { cache: 'no-store' }) : req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
    }
    return res;
  });
  function fromCache() {
    return caches.match(req).then(function (hit) {
      return hit || caches.match('./index.html');
    });
  }

  if (!isPage) {
    e.respondWith(net.catch(fromCache));
    return;
  }

  e.respondWith(new Promise(function (resolve) {
    var settled = false;
    function answer(res) { if (!settled && res) { settled = true; resolve(res); } }
    var timer = setTimeout(function () {
      caches.match(req).then(answer);    // nothing cached yet: keep waiting on the network
    }, PAGE_WAIT);
    net.then(function (res) { clearTimeout(timer); answer(res); })
      .catch(function () {
        clearTimeout(timer);
        // offline with nothing cached: fail now rather than hang
        fromCache().then(function (hit) { answer(hit || Response.error()); });
      });
  }));
  // let a slow response finish into the cache after the page has opened
  e.waitUntil(net.catch(function () {}));
});

/* Pushes from the Worker (worker/worker.js): the payload is the whole
   notification, and a tap opens the board it was about. */
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Grandstand', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: './icon-192.png', badge: './icon-192.png', data: { url: d.url || './' }
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) {
        if ('navigate' in list[i]) list[i].navigate(url);
        return list[i].focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
