/* ============================================================
   service-worker.js —— 离线能力
   首次访问时把页面与识别资源全部预缓存；之后断网也能打开。
   注意：Service Worker 只在 http(s) 下生效，本地请用 http.server 测试。
   ============================================================ */
/* 升级部署时务必修改版本号（v1 -> v2），否则浏览器会继续用旧缓存 */
var CACHE_NAME = 'handwriting-offline-v1';

var PRECACHE = [
  './',
  './index.html',
  './css/style.css',
  './js/engine.js',
  './js/app.js',
  './lib/hanzilookup.min.js',
  './data/mmah.json',
  './data/words.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function (cache) { return cache.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE_NAME) return caches.delete(k);
          return null;
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航：优先回缓存里的 index.html，保证离线可打开
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then(function (cached) {
        return cached || fetch(req);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    })
  );
});
