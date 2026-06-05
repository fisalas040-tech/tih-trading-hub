const CACHE_NAME = 'tih-v4';
const STATIC = ['/', '/manifest.json'];

// ── Install ──
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC).catch(() => {}))
  );
});

// ── Activate ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch (network first) ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// ── Push Notification ──
self.addEventListener('push', e => {
  let data = { title: '📊 TIH', body: 'إشارة جديدة!', signal: null };
  try { data = e.data.json(); } catch {}

  const isCall = data.signal === 'CALL';
  const icon = isCall ? '🟢' : data.signal === 'PUT' ? '🔴' : '📊';

  e.waitUntil(
    self.registration.showNotification(data.title || '📊 TIH Trading Hub', {
      body: data.body || 'إشارة جديدة!',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'tih-signal-' + Date.now(),
      renotify: true,
      requireInteraction: data.signal ? true : false,
      vibrate: [200, 100, 200],
      data: { url: data.url || '/', signal: data.signal },
      actions: data.signal ? [
        { action: 'open', title: '📊 تحليل' },
        { action: 'dismiss', title: '✕ إغلاق' }
      ] : []
    })
  );
});

// ── Notification Click ──
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
