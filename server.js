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

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace('/api/', '').replace(/\/$/, '');
    const handlerPath = path.join(__dirname, 'api', name + '.js');

    if (!fs.existsSync(handlerPath)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    try {
      delete require.cache[require.resolve(handlerPath)];
      const handler = require(handlerPath);
      const fn = handler.default || handler;

      req.query = Object.fromEntries(new URLSearchParams(parsedUrl.query));

      res.status = (code) => { res.statusCode = code; return res; };
      res.json = (data) => {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(data));
        }
      };
      res.send = (data) => { if (!res.headersSent) res.end(data); };
      res.end = (original => function(...args) {
        if (!res.headersSent) return original.apply(res, args);
      })(res.end);

      await fn(req, res);
    } catch (e) {
      console.error('Handler error:', e.message);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // Static files
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
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

// Cron jobs
function scheduleJob(apiPath, intervalMs, startHour, endHour, days) {
  setInterval(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
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

      const mockReq = { method: 'GET', query: Object.fromEntries(new URLSearchParams(parsedUrl.query)), headers: {} };
      const mockRes = {
        headersSent: false,
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(d) { console.log(`Cron ${apiPath}:`, JSON.stringify(d).slice(0, 100)); },
        end(d) { if (d) console.log(`Cron ${apiPath} end:`, String(d).slice(0, 100)); },
        send(d) { console.log(`Cron ${apiPath} send:`, String(d).slice(0, 100)); },
      };

      fn(mockReq, mockRes).catch(e => console.error(`Cron error ${apiPath}:`, e.message));
    } catch(e) {
      console.error(`Cron load error ${apiPath}:`, e.message);
    }
  }, intervalMs);
}

setTimeout(() => {
  // ✅ UTC times — KSA = UTC+3
  // السوق الأمريكي: 9:30AM-4PM ET = 14:30-21:00 UTC = 17:30-00:00 KSA
  // الأيام: 1-5 UTC = الاثنين-الجمعة UTC = الثلاثاء-السبت KSA (لكن السوق الأمريكي يعمل الاثنين-الجمعة ET)

  const weekdays = [1,2,3,4,5]; // Mon-Fri UTC

  // ✅ المؤشرات: كل 5 دقائق من 9AM-22:30 UTC (12PM-01:30 KSA)
  scheduleJob('/api/alert-indices?action=check', 5*60*1000,  9, 23, weekdays);

  // ✅ الأسهم: كل 5 دقائق من 13:30-21:30 UTC (16:30-00:30 KSA)
  scheduleJob('/api/alert-stocks?action=check',  5*60*1000, 13, 22, weekdays);

  // Options Flow: كل 30 دقيقة من 13:30-21:30 UTC
  scheduleJob('/api/options-flow?action=flow',   30*60*1000, 13, 22, weekdays);
  scheduleJob('/api/options-flow?action=interpret', 60*60*1000, 14, 22, weekdays);

  console.log('✅ Cron jobs started — Indices: 9-23 UTC | Stocks: 13-22 UTC');
}, 3000);
