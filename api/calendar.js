const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();

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
        r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
  }

  try {
    const now = Date.now();

    // جلب هذا الأسبوع والأسبوع القادم معاً
    const [thisWeek, nextWeek] = await Promise.allSettled([
      fetchJson('/ff_calendar_thisweek.json'),
      fetchJson('/ff_calendar_nextweek.json'),
    ]);

    const raw = [
      ...(thisWeek.status === 'fulfilled' ? thisWeek.value : []),
      ...(nextWeek.status === 'fulfilled' ? nextWeek.value : []),
    ];

    const events = raw
      .filter(e => {
        if (!e.title || !e.date) return false;
        const isHigh = e.impact === 'High' || HIGH_IMPACT.some(k => e.title.includes(k));
        return isHigh;
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

    // مهم: الأحداث القادمة = لم تصدر بعد (بغض النظر عن هذا الأسبوع أو القادم)
    const upcoming = events.filter(e => !e.isPast && !e.actual);
    const past     = events.filter(e => e.isPast || e.actual).reverse().slice(0, 5);

    return res.status(200).json({ ok: true, upcoming, past, count: events.length });

  } catch(e) {
    return res.status(200).json({ ok: false, error: e.message, upcoming: [], past: [] });
  }
};
