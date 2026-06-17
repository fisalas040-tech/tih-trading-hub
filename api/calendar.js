const https = require('https');

// ─── In-memory cache (fallback if all sources fail) ───────────────────────────
let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ─── Fetch helper ─────────────────────────────────────────────────────────────
function fetchUrl(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname,
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, */*',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.forexfactory.com/',
      },
      timeout: 8000,
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        const trimmed = d.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          reject(new Error(`Not JSON (${r.statusCode}): ${trimmed.substring(0, 80)}`));
          return;
        }
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ─── Translation map ──────────────────────────────────────────────────────────
const NAMES_AR_MAP = [
  { k: 'Non-Farm Payroll',    ar: 'الوظائف خارج الزراعة (NFP)' },
  { k: 'Nonfarm Payroll',     ar: 'الوظائف خارج الزراعة (NFP)' },
  { k: 'Non-Farm Employment', ar: 'الوظائف خارج الزراعة' },
  { k: 'Nonfarm Employment',  ar: 'الوظائف خارج الزراعة' },
  { k: 'Non-Farm',            ar: 'الوظائف خارج الزراعة' },
  { k: 'Nonfarm',             ar: 'الوظائف خارج الزراعة' },
  { k: 'Employment Change',   ar: 'تغير التوظيف' },
  { k: 'Employment',          ar: 'بيانات التوظيف' },
  { k: 'Unemployment Rate',   ar: 'معدل البطالة' },
  { k: 'Unemployment',        ar: 'معدل البطالة' },
  { k: 'Jobless Claims',      ar: 'طلبات البطالة' },
  { k: 'Average Hourly',      ar: 'متوسط الأجور بالساعة' },
  { k: 'Participation Rate',  ar: 'معدل المشاركة' },
  { k: 'CPI',                 ar: 'مؤشر أسعار المستهلك' },
  { k: 'Core CPI',            ar: 'التضخم الأساسي' },
  { k: 'PPI',                 ar: 'أسعار المنتجين' },
  { k: 'PCE',                 ar: 'نفقات الاستهلاك' },
  { k: 'FOMC',                ar: 'قرار الفيدرالي' },
  { k: 'Federal Reserve',     ar: 'قرار الفيدرالي' },
  { k: 'Interest Rate',       ar: 'قرار الفائدة' },
  { k: 'GDP',                 ar: 'الناتج المحلي الإجمالي' },
  { k: 'Retail Sales',        ar: 'مبيعات التجزئة' },
  { k: 'ISM',                 ar: 'مؤشر ISM' },
  { k: 'PMI',                 ar: 'مؤشر PMI' },
  { k: 'Trade Balance',       ar: 'الميزان التجاري' },
  { k: 'Consumer Confidence', ar: 'ثقة المستهلك' },
  { k: 'Housing',             ar: 'بيانات الإسكان' },
  { k: 'Inflation',           ar: 'التضخم' },
  { k: 'ADP',                 ar: 'تقرير ADP' },
  { k: 'Fed ',                ar: 'المتحدث الفيدرالي' },
];

function translateEvent(title) {
  for (const { k, ar } of NAMES_AR_MAP) {
    if (title.includes(k)) return ar;
  }
  return title;
}

// ─── Build response from raw events array ─────────────────────────────────────
function buildResponse(raw, sourceLog) {
  const now = Date.now();

  const seen = new Set();
  const unique = raw.filter(e => {
    const key = `${e.title}_${e.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const events = unique
    .filter(e => e.title && e.date && e.impact === 'High')
    .map(e => ({
      title: e.title,
      nameAr: translateEvent(e.title),
      date: e.date,
      ts: new Date(e.date).getTime(),
      impact: 'High',
      forecast: e.forecast || '—',
      previous: e.previous || '—',
      actual: e.actual || null,
      isPast: new Date(e.date).getTime() < now,
    }))
    .sort((a, b) => a.ts - b.ts);

  return {
    ok: true,
    upcoming: events.filter(e => !e.isPast),
    past: events.filter(e => e.isPast).reverse().slice(0, 5),
    count: events.length,
    sources: sourceLog,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const now = new Date();
  const dayUTC = now.getUTCDay(); // 0=Sun … 4=Thu … 6=Sat

  // Only request next week data on Thu/Fri (when it's actually published)
  const tryNextWeek = dayUTC >= 4;

  // Sources — only the working host; cdn-nfs.faireconomy.media has DNS issues
  const sources = [
    { host: 'nfs.faireconomy.media', path: '/ff_calendar_thisweek.json', required: true },
  ];
  if (tryNextWeek) {
    sources.push({ host: 'nfs.faireconomy.media', path: '/ff_calendar_nextweek.json', required: false });
  }

  const results = await Promise.allSettled(
    sources.map(s => fetchUrl(s.host, s.path))
  );

  const raw = [];
  const sourceLog = [];

  results.forEach((r, i) => {
    const s = sources[i];
    if (r.status === 'fulfilled') {
      raw.push(...r.value);
      sourceLog.push({ src: s.host + s.path, ok: true });
    } else {
      sourceLog.push({ src: s.host + s.path, ok: false, err: r.reason?.message });
    }
  });

  // If we got data → update cache and respond
  if (raw.length > 0) {
    const response = buildResponse(raw, sourceLog);
    _cache = response;
    _cacheTs = Date.now();
    return res.status(200).json(response);
  }

  // All required sources failed → serve from in-memory cache if available
  if (_cache && (Date.now() - _cacheTs) < CACHE_TTL) {
    return res.status(200).json({
      ..._cache,
      cached: true,
      cacheAgeMin: Math.round((Date.now() - _cacheTs) / 60000),
      sources: sourceLog,
    });
  }

  // Nothing available
  return res.status(200).json({
    ok: false,
    error: 'All sources failed and no cache available',
    upcoming: [],
    past: [],
    sources: sourceLog,
  });
};
