// TIH Service Worker — Push Notifications
self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(clients.claim());
});

// استقبال Push من السيرفر
self.addEventListener('push', function(e) {
  var data = {};
  try {
    data = e.data.json();
  } catch (err) {
    data = { 
      title: 'TIH Alert', 
      body: e.data ? e.data.text() : 'إشارة تداول جديدة!', 
      icon: '/icon-192.png',
      url: '/default-url',
      tag: 'default-tag'
    };
  }

  var options = {
    body:    data.body    || 'إشارة تداول جديدة!',
    icon:    data.icon    || '/icon-192.png',
    badge:   '/icon-192.png',
    vibrate: [200, 100, 200],
    tag:     data.tag     || 'tih-alert',
    renotify: true,
    data:    { url: data.url || '/' },
    actions: [
      { action: 'open',    title: '📈 فتح الموقع' },
      { action: 'dismiss', title: '✕ إغلاق' }
    ]
  };

  e.waitUntil(
    self.registration.showNotification(data.title || '🔔 TIH Trading Hub', options)
  );
});

// عند الضغط على الإشعار
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(function(clientList) {
      const url = e.notification.data?.url || '/';
      for (var client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
