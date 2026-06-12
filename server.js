// Service Worker for TIH Trading Hub
const CACHE_NAME = 'tih-v1';
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE_NAME)));
self.addEventListener('fetch', e => e.respondWith(fetch(e.request).catch(() => caches.match(e.request))));
