const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const HIGH_IMPACT = [
    'Non-Farm','Nonfarm','NFP',
    'CPI','FOMC','GDP','PCE',
    'Retail Sales','Jobless Claims','PPI','ISM','Fed'
  ];
  // ترجمة شاملة لكل أحداث High Impact الشائعة
  const NAMES_AR_MAP = [
    { k:'Non-Farm Payroll',   ar:'الوظائف خارج الزراعة (NFP)' },
    { k:'Nonfarm Payroll',    ar:'الوظائف خارج الزراعة (NFP)' },
    { k:'Non-Farm',           ar:'الوظائف خارج الزراعة' },
    { k:'Nonfarm',           ar:'الوظائف خارج الزراعة' },
    { k:'Employment Change', ar:'تغير التوظيف' },
    { k:'Employment',        ar:'بيانات التوظيف' },
    { k:'Unemployment',      ar:'معدل البطالة' },
    { k:'Jobless Claims',    ar:'طلبات البطالة الأسبوعية' },
    { k:'CPI',               ar:'مؤشر أسعار المستهلك' },
    { k:'Core CPI',          ar:'التضخم الأساسي' },
    { k:'PPI',               ar:'أسعار المنتجين' },
    { k:'PCE',               ar:'نفقات الاستهلاك الشخصي' },
    { k:'FOMC',              ar:'قرار الفيدرالي' },
    { k:'Fed',               ar:'المتحدث الفيدرالي' },
    { k:'Interest Rate',     ar:'قرار الفائدة' },
    { k:'GDP',               ar:'الناتج المحلي الإجمالي' },
    { k:'Retail Sales',      ar:'مبيعات التجزئة' },
    { k:'ISM',               ar:'مؤشر ISM' },
    { k:'PMI',               ar:'مؤشر PMI' },
    { k:'Trade Balance',     ar:'الميزان التجاري' },
    { k:'Consumer Confidence', ar:'ثقة المستهلك' },
    { k:'Housing',           ar:'بيانات الإسكان' },
    { k:'Inflation',         ar:'التضخم' },
    { k:'Average Hourly',    ar:'متوسط الأجور بالساعة' },
    { k:'Participation Rate',ar:'معدل المشاركة' },
    { k:'ADP',               ar:'تقرير ADP للتوظيف' },
  ];
  function translateEvent(title) {
    for (const { k, ar } of NAMES_AR_MAP) {
      if (title.includes(k)) return ar;
    }
    return title; // إذا لم يوجد ترجمة → أبقِ الاسم كما هو
  }

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
          if (!d.trim().startsWith('[') && !d.trim().startsWith('{')) {
            reject(new Error('Not JSON'));
            return;
          }
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
      return res.status(200).json({ ok: false, error: 'No data', upcoming: [], past: [] });
    }

    const events = raw
      .filter(e => {
        if (!e.title || !e.date) return false;
        if (e.impact !== 'High') return false; // High impact فقط
        return true;
      })
      .map(e => {
        const ts = new Date(e.date).getTime();
        const nameKey = HIGH_IMPACT.find(k => e.title.includes(k));
        return {
          title: e.title,
          nameAr: translateEvent(e.title),
          date: e.date,
          ts,
          impact: 'High',
          forecast: e.forecast || '—',
          previous: e.previous || '—',
          actual: e.actual || null,
          isPast: ts < now,
        };
      })
      .sort((a, b) => a.ts - b.ts);

    const upcoming = events.filter(e => !e.isPast);
    const past     = events.filter(e => e.isPast).reverse().slice(0, 5);

    return res.status(200).json({ ok: true, upcoming, past, count: events.length });

  } catch(e) {
    return res.status(200).json({ ok: false, error: e.message, upcoming: [], past: [] });
  }
};
