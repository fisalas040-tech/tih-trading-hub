## 🔧 دليل حل المشاكل

استخدم هذا الدليل لحل المشاكل الشائعة في **TIH Trading Hub**.

---

## 🌐 مشاكل الويب

### الصفحة لا تحمل

**الحل:**
```bash
# 1. امسح الـ cache
Ctrl + Shift + Delete

# 2. أعد التحميل
F5

# 3. جرب متصفح آخر
```

---

## 🔔 مشاكل الإشعارات

### لا أستقبل الإشعارات

**الحل:**
```javascript
// تحقق من Service Worker
navigator.serviceWorker.getRegistrations()
  .then(regs => console.log('عدد SWs:', regs.length));

// تحقق من الإذن
console.log(Notification.permission);

// اطلب إذن جديد
Notification.requestPermission();
```

---

## 🔌 مشاكل الـ API

### "Error: Resource not available"

**الحل:**
```javascript
// تحقق من الاتصال
if (!navigator.onLine) {
  console.log('❌ لا توجد اتصال');
}

// جرب رموز مختلفة:
// AAPL, ^GSPC, DX-Y.NYB
```

---

## 📴 مشاكل Offline

### الموقع لا يعمل بدون إنترنت

**الحل:**
```javascript
// امسح الـ cache القديم
caches.keys().then(names => {
  names.forEach(name => caches.delete(name));
});
```

---

## ⚡ مشاكل الأداء

### الموقع بطيء جداً

**الحل:**
- قلل تحديث الرسوم البيانية
- استخدم Data Saver
- امسح الـ cache

---

## 🆘 لم تجد الحل؟

اذهب إلى [Issues](https://github.com/fisalas040-tech/tih-trading-hub/issues) وأنشئ بلاغ جديد.

---

**أتمنى لك تجربة سلسة! 🚀**
