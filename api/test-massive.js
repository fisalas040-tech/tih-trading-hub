// api/test-massive.js
// اختبار Massive.com API — ما البيانات المتاحة؟

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const API_KEY = process.env.MASSIVE_API_KEY;
  if (!API_KEY) return res.status(200).json({ error: 'MASSIVE_API_KEY غير موجود في Vercel' });

  const sym = req.query.sym || 'AAPL';
  const results = {};

  // دالة مساعدة للطلبات
  async function tryEndpoint(name, url, headers={}) {
    try {
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'x-api-key': API_KEY,
          'Content-Type': 'application/json',
          ...headers,
        }
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch(e) { data = text.slice(0, 300); }
      results[name] = { status: r.status, data };
    } catch(e) {
      results[name] = { error: e.message };
    }
  }

  // اختبار endpoints مختلفة
  await Promise.all([

    // بيانات السعر اليومية
    tryEndpoint('daily_bars',
      `https://api.massive.com/v1/stocks/${sym}/bars?timeframe=1Day&limit=5`),

    // بيانات الساعة
    tryEndpoint('hourly_bars',
      `https://api.massive.com/v1/stocks/${sym}/bars?timeframe=1Hour&limit=5`),

    // Options Chain
    tryEndpoint('options_chain',
      `https://api.massive.com/v1/stocks/${sym}/options`),

    // Options OI + IV
    tryEndpoint('options_iv',
      `https://api.massive.com/v1/stocks/${sym}/options/iv`),

    // Put/Call Ratio
    tryEndpoint('put_call_ratio',
      `https://api.massive.com/v1/stocks/${sym}/options/put-call-ratio`),

    // Quote
    tryEndpoint('quote',
      `https://api.massive.com/v1/stocks/${sym}/quote`),

    // Technical Indicators
    tryEndpoint('technicals',
      `https://api.massive.com/v1/stocks/${sym}/technicals`),

    // Market overview
    tryEndpoint('market_overview',
      `https://api.massive.com/v1/market/overview`),

  ]);

  return res.status(200).json({
    ok: true,
    sym,
    apiKey: API_KEY ? `${API_KEY.slice(0,6)}...` : 'غير موجود',
    results,
  });
};
