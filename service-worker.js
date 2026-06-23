// Service Worker for TIH Trading Hub — v3 (no-cache, force-fresh)
// Takes over immediately, purges ALL old caches, reloads open clients.
self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    await self.clients.claim();
    var wins = await self.clients.matchAll({ type: 'window' });
    wins.forEach(function (c) { try { c.navigate(c.url); } catch (_) {} });
  })());
});

// Network-only: never serve a stale cached document or API response.
self.addEventListener('fetch', function (e) {
  e.respondWith(fetch(e.request));
});
