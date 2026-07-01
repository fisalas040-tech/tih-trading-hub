const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // إعدادات CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  
  if (req.method === 'OPTIONS') { 
    res.statusCode = 204;
    res.end(); 
    return; 
  }

  // ✅ حماية Read-Only — منع التعديل من الزوار غير المصرح لهم
  const ADMIN_KEY = process.env.ADMIN_KEY || 'tih-secret-2026';

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const key = req.headers['x-admin-key'] || parsedUrl.query?.key;
    if (key !== ADMIN_KEY) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Read Only — غير مصرح بالتعديل' }));
      return; // 🛠️ تم الإصلاح: إيقاف التنفيذ فوراً لمنع الاختراق
    }
  }

  // مسارات الـ API
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace('/api/', '').replace(/\/$/, '');
    const handlerPath = path.join(__dirname, 'api', name + '.js');

    if (!fs.existsSync(handlerPath)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      // مسح الكاش للحصول على تحديثات الكود فوراً بدون إعادة تشغيل السيرفر
      delete require.cache[require.resolve(handlerPath)];
      const handler = require(handlerPath);
      const fn = handler.default || handler;

      // تجهيز الكائنات المساعدة للطلب والاستجابة بشكل شبيه بـ Express.js
      req.query = Object.fromEntries(new URLSearchParams(parsedUrl.query));

      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (data) => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        }
      };
      res.send = (data) => { 
        if (!res.headersSent) res.end(data); 
      };

      await fn(req, res);
    } catch (e) {
      console.error('Handler error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // قراءة الملفات الثابتة (واجهة المستخدم المترابطة SPA)
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // توجيه كل المسارات غير الموجودة إلى index.html لدعم برمجيات الفرونت إند (React/Vue/Vanilla Router)
      fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
        if (e) { res.statusCode = 404; res.end('Not found'); return; }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(d);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.setHeader('Content-Type', mime[ext] || 'text/plain');
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`TIH Trading Hub running on port ${PORT}`);
});

// دالة جدولة المهام التلقائية (Cron Jobs) للأسواق والأسهم
function scheduleJob(apiPath, intervalMs, startHour, endHour, days) {
  setInterval(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    
    // التحقق من أيام عمل السوق وساعات التشغيل المطلوبة بحسب توقيت UTC
    if (!days.includes(day) || hour < startHour || hour >= endHour) return;

    const parsedUrl = url.parse(apiPath, true);
    const pathname = parsedUrl.pathname;
    const name = pathname.replace('/api/', '').replace(/\/$/, '');
    const handlerPath = path.join(__dirname, 'api', name + '.js');
    if (!fs.existsSync(handlerPath)) return;

    try {
      delete require.cache[require.resolve(handlerPath)];
      const handler = require(handlerPath);
      const fn = handler.default || handler;

      // 🛠️ تم التطوير: كائن وهمي متكامل لا يسبب انهيار ملفات الـ API
      const mockReq = { 
        method: 'GET', 
        url: apiPath,
        query: Object.fromEntries(new URLSearchParams(parsedUrl.query)), 
        headers: { 'x-cron-job': 'true' } 
      };
      
      const mockRes = {
        headersSent: false,
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(d) { console.log(`[Cron] ${apiPath} JSON:`, JSON.stringify(d).slice(0, 120)); },
        end(d) { if (d) console.log(`[Cron] ${apiPath} End:`, String(d).slice(0, 120)); },
        send(d) { console.log(`[Cron] ${apiPath} Send:`, String(d).slice(0, 120)); },
      };

      fn(mockReq, mockRes).catch(e => console.error(`❌ Cron runtime error ${apiPath}:`, e.message));
    } catch(e) {
      console.error(`❌ Cron load error ${apiPath}:`, e.message);
    }
  }, intervalMs);
}

// بدء تشغيل الجدولة بعد 3 ثوانٍ من إقلاع الخادم لضمان استقراره
setTimeout(() => {
  const weekdays =; // من الإثنين إلى الجمعة (أيام عمل البورصة الأمريكية بالـ UTC)

  // فحص تنبيهات المؤشرات كل 5 دقائق
  scheduleJob('/api/alert-indices?action=check', 5 * 60 * 1000, 9, 23, weekdays);
  // فحص تنبيهات الأسهم كل 5 دقائق
  scheduleJob('/api/alert-stocks?action=check', 5 * 60 * 1000, 13, 22, weekdays);
  // سحب تدفقات عقود الأوبشن (Options Flow) كل 30 دقيقة
  scheduleJob('/api/options-flow?action=flow', 30 * 60 * 1000, 13, 22, weekdays);
  // تحليل وقراءة تدفق الأوبشن بواسطة الذكاء الاصطناعي/المعادلات كل ساعة
  scheduleJob('/api/options-flow?action=interpret', 60 * 60 * 1000, 14, 22, weekdays);
  // فحص أحجام العقود المفتوحة (OI Flow) كل 15 دقيقة
  scheduleJob('/api/oi-flow?action=check', 15 * 60 * 1000, 13, 22, weekdays);

  console.log('✅ All TIH Trading Cron jobs active [Mon-Fri UTC]');
}, 3000);
