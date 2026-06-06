// TIH Service Worker v2.0 - محسّن بمعالجة أخطاء أفضل وعربية كاملة
const CACHE_NAME = 'tih-v5';
const API_CACHE = 'tih-api-v5';
const STATIC_FILES = ['/', '/manifest.json', '/index.html'];

// ========== التثبيت ==========
self.addEventListener('install', (event) => {
  console.log('🔧 تثبيت Service Worker v2.0...');
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_FILES).catch((error) => {
        console.error('❌ فشل تخزين الملفات الثابتة:', error);
        // تابع حتى لو فشل بعض الملفات
        return Promise.resolve();
      });
    }).then(() => console.log('✅ تم تثبيت الملفات بنجاح'))
  );
});

// ========== التفعيل ==========
self.addEventListener('activate', (event) => {
  console.log('🚀 تفعيل Service Worker v2.0...');
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== API_CACHE)
          .map((key) => {
            console.log('🗑️ حذف الـ cache القديم:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      return self.clients.claim();
    }).then(() => console.log('✅ تم تفعيل Service Worker بنجاح'))
  );
});

// ========== الجلب مع الـ Cache Strategy ==========
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // تخطي الطلبات غير GET
  if (request.method !== 'GET') {
    return;
  }

  // Strategy: Network First مع Fallback للـ Cache (للـ API)
  if (url.pathname.startsWith('/api/')) {
    return event.respondWith(
      fetch(request)
        .then((response) => {
          // التحقق من الاستجابة
          if (!response || response.status !== 200) {
            console.warn(`⚠️ API طلب غير ناجح (${response.status}):`, url.pathname);
            return caches.match(request);
          }

          // استنساخ وتخزين الاستجابة
          const clonedResponse = response.clone();
          caches.open(API_CACHE).then((cache) => {
            cache.put(request, clonedResponse).catch((err) => {
              console.error('❌ فشل تخزين استجابة API:', err);
            });
          });
          return response;
        })
        .catch((error) => {
          console.error('🌐 فشل الاتصال بـ API، استخدام الـ cache:', error);
          return caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
              return cachedResponse;
            }
            return new Response(
              JSON.stringify({
                error: '❌ خطأ: لا يمكن الوصول إلى الخدمة حالياً',
                message: 'حاول الاتصال بالإنترنت وجرب مجدداً',
                timestamp: new Date().toISOString(),
                offline: true
              }),
              {
                status: 503,
                statusText: 'خدمة غير متاحة',
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
              }
            );
          });
        })
    );
  }

  // Strategy: Cache First مع Fallback للـ Network (للملفات الثابتة)
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          console.log('📦 تم تحميل من الـ cache:', url.pathname);
          return cachedResponse;
        }

        return fetch(request)
          .then((response) => {
            // التحقق من الاستجابة
            if (!response || response.status !== 200) {
              console.warn(`⚠️ استجابة غير صحيحة (${response.status}):`, url.pathname);
              return new Response('❌ خطأ: الملف غير متاح', { status: 404 });
            }

            // استنساخ وتخزين الاستجابة الجديدة
            const clonedResponse = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, clonedResponse).catch((err) => {
                console.error('❌ فشل تحديث الـ cache:', err);
              });
            });
            console.log('🌐 تم تحميل من الشبكة:', url.pathname);
            return response;
          })
          .catch((error) => {
            console.error('🌐 فشل تحميل الملف من الشبكة:', url.pathname, error);
            return new Response(
              '❌ خطأ: لا يمكن تحميل هذا الملف (بدون اتصال)',
              { status: 503 }
            );
          });
      })
  );
});

// ========== إشعارات Push ==========
self.addEventListener('push', (event) => {
  console.log('📬 استقبال إشعار push...');

  let notificationData = {
    title: '🔔 إشعار TIH Trading Hub',
    body: '📈 تحديث تداولي جديد!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    url: '/',
    tag: 'tih-alert'
  };

  try {
    if (event.data) {
      const parsedData = event.data.json();
      notificationData = { ...notificationData, ...parsedData };
      console.log('✅ تم تحليل بيانات الإشعار:', parsedData);
    }
  } catch (error) {
    console.error('❌ فشل تحليل JSON للإشعار:', error);
    // استخدم البيانات الافتراضية
    if (event.data) {
      try {
        const text = event.data.text();
        notificationData.body = text;
      } catch (e) {
        console.error('❌ فشل قراءة نص الإشعار:', e);
      }
    }
  }

  const options = {
    body: notificationData.body,
    icon: notificationData.icon,
    badge: notificationData.badge,
    vibrate: [200, 100, 200],
    tag: notificationData.tag,
    renotify: true,
    requireInteraction: false,
    data: { url: notificationData.url },
    actions: [
      { action: 'open', title: '📈 فتح الموقع' },
      { action: 'dismiss', title: '✕ إغلاق' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(notificationData.title, options)
      .then(() => console.log('✅ تم عرض الإشعار بنجاح'))
      .catch((error) => console.error('❌ فشل عرض الإشعار:', error))
  );
});

// ========== النقر على الإشعار ==========
self.addEventListener('notificationclick', (event) => {
  console.log('👆 تم النقر على الإشعار:', event.action);
  event.notification.close();

  // إذا كان الإجراء "dismiss"، أغلق فقط
  if (event.action === 'dismiss') {
    console.log('✅ تم إغلاق الإشعار بواسطة المستخدم');
    return;
  }

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // البحث عن نافذة موجودة بنفس الـ URL
        for (let client of clientList) {
          if (client.url === url && 'focus' in client) {
            console.log('🔄 تم تركيز النافذة الموجودة:', url);
            return client.focus();
          }
        }
        // فتح نافذة جديدة إذا لم توجد
        console.log('🆕 فتح نافذة جديدة:', url);
        return clients.openWindow(url);
      })
      .catch((error) => {
        console.error('❌ فشل معالجة النقر على الإشعار:', error);
      })
  );
});

// ========== إغلاق الإشعار ==========
self.addEventListener('notificationclose', (event) => {
  console.log('✅ تم إغلاق الإشعار:', event.notification.tag);
});

// ========== معالج الرسائل من الصفحة ==========
self.addEventListener('message', (event) => {
  console.log('📨 استقبال رسالة:', event.data);

  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    console.log('⚡ تم تفعيل Service Worker الجديد فوراً');
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('🗑️ تم حذف الـ cache بالكامل');
      event.ports[0].postMessage({ success: true });
    });
  }
});
