const https = require('https');

// Cache في الذاكرة — يمنع تجاوز rate limit
let memCache = { data: null, ts: 0 };
const CACHE_TTL = 10 * 60 * 1000; // 10 دقائق

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // إرجاع من Cache إذا لم تمر 10 دقائق
  if (memCache.data && (Date.now() - memCache.ts) < CACHE_TTL) {
    return res.status(200).json(memCache.data);
  }

  const HIGH_IMPACT = ['NFP','CPI','FOMC','GDP','PCE','Retail Sales','Jobless Claims','PPI','ISM','Fed'];
  const NAMES_AR = {
    'NFP':'الوظائف خارج الزراعة','CPI':'مؤشر أسعار المستهلك',
    'FOMC':'قرار الفيدرالي','GDP':'الناتج المحلي الإجمالي',
    'PCE':'نفقات الاستهلاك الشخصي','Retail Sales':'مبيعات التجزئة',
    'Jobless Claims':'طلبات البطالة الأسبوعية','PPI':'أسعار المنتجين',
    'ISM':'مؤشر التصنيع ISM','Fed':'المتحدث الفيدرالي'
  };

  function fetchJson(path) {
    return new Promise((resolve, reject) => {
      https.get({
        hostname: 'nfs.faireconomy.media',
        path,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, (r) => {
        let d = '';
        r.on('data', c => d += c);
        r.on('end', () => {
          // تحقق أن الرد JSON وليس HTML (rate limit page)
          if (d.trim().startsWith('<')) { reject(new Error('Rate limited')); return; }
          try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
        });
      }).on('error', reject);
    });
  }

  try {
    const now = Date.now();

    const [thisWeek, nextWeek] = await Promise.allSettled([
      fetchJson('/ff_calendar_thisweek.json'),
      fetchJson('/ff_calendar_nextweek.json'),
    ]);

    const raw = [
      ...(thisWeek.status === 'fulfilled' ? thisWeek.value : []),
      ...(nextWeek.status === 'fulfilled' ? nextWeek.value : []),
    ];

    if (!raw.length) {
      // إذا فشل الجلب، أرجع آخر cache حتى لو قديم
      if (memCache.data) return res.status(200).json(memCache.data);
      return res.status(200).json({ ok: false, error: 'Rate limited', upcoming: [], past: [] });
    }

    const events = raw
      .filter(e => {
        if (!e.title || !e.date) return false;
        return e.impact === 'High' || HIGH_IMPACT.some(k => e.title.includes(k));
      })
      .map(e => {
        const ts = new Date(e.date).getTime();
        const nameKey = HIGH_IMPACT.find(k => e.title.includes(k));
        return {
          title: e.title,
          nameAr: nameKey && NAMES_AR[nameKey] ? NAMES_AR[nameKey] : e.title,
          date: e.date,
          ts,
          impact: e.impact || 'High',
          forecast: e.forecast || '—',
          previous: e.previous || '—',
          actual: e.actual || null,
          isPast: ts < now,
        };
      })
      .sort((a, b) => a.ts - b.ts);

    const upcoming = events.filter(e => !e.isPast);
    const past     = events.filter(e => e.isPast).reverse().slice(0, 5);

    const result = { ok: true, upcoming, past, count: events.length };
    memCache = { data: result, ts: Date.now() };

    return res.status(200).json(result);

  } catch(e) {
    if (memCache.data) return res.status(200).json(memCache.data);
    return res.status(200).json({ ok: false, error: e.message, upcoming: [], past: [] });
  }
};
