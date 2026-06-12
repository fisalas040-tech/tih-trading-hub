const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Load API handlers
const handlers = {
  'alert-indices': require('./api/alert-indices'),
  'alert-stocks': require('./api/alert-stocks'),
  'alert': require('./api/alert'),
  'analyze': require('./api/analyze'),
  'backtest': require('./api/backtest'),
  'bot': require('./api/bot'),
  'calendar': require('./api/calendar'),
  'markets': require('./api/markets'),
  'options-flow': require('./api/options-flow'),
  'performance': require('./api/performance'),
  'report': require('./api/report'),
};

// MIME types
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function createVercelCompatReq(req, parsedUrl) {
  req.query = Object.fromEntries(new URLSearchParams(parsedUrl.query));
  return req;
}

function createVercelCompatRes(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  };
  res.send = (data) => res.end(data);
  return res;
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.end(); return; }

  // API routes
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace('/api/', '').split('?')[0];
    const handler = handlers[name];
    if (handler) {
      createVercelCompatReq(req, parsedUrl);
      createVercelCompatRes(res);
      try {
        const fn = handler.default || handler;
        fn(req, res);
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.statusCode = 404;
      res.end('Not found');
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
const https = require('https');
function cronFetch(path) {
  const host = process.env.RAILWAY_STATIC_URL || `localhost:${PORT}`;
  const protocol = host.includes('railway.app') ? https : http;
  const options = { hostname: host.split(':')[0], port: host.split(':')[1] || (host.includes('railway.app') ? 443 : PORT), path, method: 'GET' };
  const r = protocol.request(options, res => {
    console.log(`Cron ${path}: ${res.statusCode}`);
  });
  r.on('error', e => console.error(`Cron error ${path}:`, e.message));
  r.end();
}

function scheduleJob(cronPath, intervalMs, startHour, endHour, days) {
  setInterval(() => {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    if (days.includes(day) && hour >= startHour && hour < endHour) {
      cronFetch(cronPath);
    }
  }, intervalMs);
}

// Start crons after 5 seconds
setTimeout(() => {
  const weekdays = [1,2,3,4,5];
  scheduleJob('/api/alert-indices?action=check', 5*60*1000, 7, 20, weekdays);
  scheduleJob('/api/alert-stocks?action=check', 15*60*1000, 13, 20, weekdays);
  scheduleJob('/api/options-flow?action=flow', 30*60*1000, 13, 20, weekdays);
  scheduleJob('/api/options-flow?action=interpret', 60*60*1000, 14, 20, weekdays);
  console.log('Cron jobs started');
}, 5000);
