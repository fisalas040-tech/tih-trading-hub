// TIH Service Worker — Enhanced Cache & Error Management
const CACHE_NAME = 'tih-v4';
const STATIC_FILES = ['/', '/manifest.json', '/index.html', '/api/analyze.js'];

// ── Install ──
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => 
      cache.addAll(STATIC_FILES).catch((error) => 
        console.error('Failed to cache static files:', error)
      )
    )
  );
});

// ── Activate ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => 
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch (Fallback to Cache with Improved Error Handling) ──
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response || response.status !== 200) {
          console.warn('Fetching failed or returned non-200:', response);
          return caches.match(event.request);
        }
        const clonedResponse = response.clone();
        caches.open(CACHE_NAME).then((cache) => 
          cache.put(event.request, clonedResponse).catch((err) => 
            console.error('Failed to update cache on fetch:', err)
          )
        );
        return response;
      })
      .catch((error) => {
        console.error('Network fetch failed, attempting cache fallback:', error);
        return caches.match(event.request).then((cachedResponse) => 
          cachedResponse || 
          new Response('Error: Resource not available offline.', {
            status: 503,
            statusText: 'Service Unavailable',
          })
        );
      })
  );
});

// ── Push Notification ──
self.addEventListener('push', (event) => {
  let data = { title: 'TIH Notification', body: 'New update available!' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (e) {
    console.error('Push data parsing failed:', e);
  }

  const options = {
    body: data.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Notification Click ──
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (!event.notification.data || !event.notification.data.url) return;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (let client of clientList) {
        if (client.url === event.notification.data.url) {
          return client.focus();
        }
      }
      return clients.openWindow(event.notification.data.url);
    })
  );
});