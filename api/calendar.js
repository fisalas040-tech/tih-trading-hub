const https = require('https');

// NFP وأحداث اليوم الثابتة كـ fallback
function getTodayFallback() {
  const now = new Date();
  const day = now.getUTCDay(); // 5 = جمعة
  const hour = now.getUTCHours();
  
  // إذا جمعة وقبل 12:30 UTC (15:30 KSA) → NFP محتمل أول جمعة الشهر
  if (day === 5 && hour < 13) {
    return null; // نتركه لـ API
  }
  return null;
}

function fetchUrl(hostname, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      path,
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Referer': 'https://www.forexfactory.com/',
      },
      timeout: 8000
    };
    const req = https.get(options, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        const trimmed = d.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          reject(new Error(`Not JSON (${r.statusCode}): ${trimmed.substring(0, 100)}`));
          return;
        }
        try { resolve(JSON.parse(d)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const NAMES_AR_MAP = [
    { k:'Non-Farm Payroll',    ar:'الوظائف خارج الزراعة (NFP)' },
    { k:'Nonfarm Payroll',     ar:'الوظائف خارج الزراعة (NFP)' },
    { k:'Non-Farm Employment', ar:'الوظائف خارج الزراعة' },
    { k:'Nonfarm Employment',  ar:'الوظائف خارج الزراعة' },
    { k:'Non-Farm',            ar:'الوظائف خارج الزراعة' },
    { k:'Nonfarm',             ar:'الوظائف خارج الزراعة' },
    { k:'Employment Change',   ar:'تغير التوظيف' },
    { k:'Employment',          ar:'بيانات التوظيف' },
    { k:'Unemployment Rate',   ar:'معدل البطالة' },
    { k:'Unemployment',        ar:'معدل البطالة' },
    { k:'Jobless Claims',      ar:'طلبات البطالة' },
    { k:'Average Hourly',      ar:'متوسط الأجور بالساعة' },
    { k:'Participation Rate',  ar:'معدل المشاركة' },
    { k:'CPI',                 ar:'مؤشر أسعار المستهلك' },
    { k:'Core CPI',            ar:'التضخم الأساسي' },
    { k:'PPI',                 ar:'أسعار المنتجين' },
    { k:'PCE',                 ar:'نفقات الاستهلاك' },
    { k:'FOMC',                ar:'قرار الفيدرالي' },
    { k:'Federal Reserve',     ar:'قرار الفيدرالي' },
    { k:'Interest Rate',       ar:'قرار الفائدة' },
    { k:'GDP',                 ar:'الناتج المحلي الإجمالي' },
    { k:'Retail Sales',        ar:'مبيعات التجزئة' },
    { k:'ISM',                 ar:'مؤشر ISM' },
    { k:'PMI',                 ar:'مؤشر PMI' },
    { k:'Trade Balance',       ar:'الميزان التجاري' },
    { k:'Consumer Confidence', ar:'ثقة المستهلك' },
    { k:'Housing',             ar:'بيانات الإسكان' },
    { k:'Inflation',           ar:'التضخم' },
    { k:'ADP',                 ar:'تقرير ADP' },
    { k:'Fed ',                ar:'المتحدث الفيدرالي' },
  ];

  function translateEvent(title) {
    for (const { k, ar } of NAMES_AR_MAP) {
      if (title.includes(k)) return ar;
    }
    return title;
  }

  const now = Date.now();

  // نحاول عدة مصادر
  const sources = [
    { host: 'nfs.faireconomy.media',     path: '/ff_calendar_thisweek.json' },
    { host: 'cdn-nfs.faireconomy.media', path: '/ff_calendar_thisweek.json' },
    { host: 'nfs.faireconomy.media',     path: '/ff_calendar_nextweek.json' },
    { host: 'cdn-nfs.faireconomy.media', path: '/ff_calendar_nextweek.json' },
  ];

  const results = await Promise.allSettled(
    sources.map(s => fetchUrl(s.host, s.path))
  );

  const raw = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') raw.push(...r.value);
    else errors.push(`Source ${i}: ${r.reason?.message}`);
  });

  if (!raw.length) {
    return res.status(200).json({ 
      ok: false, 
      error: 'All sources failed', 
      errors,
      upcoming: [], 
      past: [] 
    });
  }

  // إزالة التكرار
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

  const upcoming = events.filter(e => !e.isPast);
  const past = events.filter(e => e.isPast).reverse().slice(0, 5);

  return res.status(200).json({ 
    ok: true, 
    upcoming, 
    past, 
    count: events.length,
    sources: results.map((r,i) => ({ 
      src: sources[i].host+sources[i].path, 
      ok: r.status === 'fulfilled',
      err: r.reason?.message 
    }))
  });
};
