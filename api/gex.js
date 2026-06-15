// ════════════════════════════════════════════════════════
// TIH gex.js — GEX Heatmap من Massive API (Polygon.io)
// GEX = (Call OI × Call Gamma - Put OI × Put Gamma) × 100 × Spot
// ════════════════════════════════════════════════════════

const MASSIVE_KEY  = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const MASSIVE_BASE = 'api.polygon.io';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// الرموز المدعومة
const GEX_SYMBOLS = {
  'SPY': 'S&P 500 ETF',
  'QQQ': 'Nasdaq ETF',
  'SPX': 'S&P 500 Index',
  'NVDA': 'NVIDIA',
  'AAPL': 'Apple',
  'TSLA': 'Tesla',
  'AMD': 'AMD',
  'MSFT': 'Microsoft',
};

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, value, ex = 3600) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}

// ── Massive API ──
async function fetchMassive(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://${MASSIVE_BASE}${path}${sep}apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'TIH/2.0' } });
  if (!r.ok) throw new Error(`Massive ${r.status}: ${path}`);
  return r.json();
}

// ── حساب GEX لرمز محدد ──
async function calcGEX(symbol) {
  try {
    const today  = new Date().toISOString().split('T')[0];
    const in45d  = new Date(Date.now() + 45*86400000).toISOString().split('T')[0];

    // جلب كل العقود مع Greeks
    const data = await fetchMassive(
      `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in45d}&limit=250`
    );

    const results = data.results || [];
    if (!results.length) return null;

    // السعر الحالي
    const spot = results[0]?.underlying_asset?.price || 0;
    if (!spot) return null;

    // تجميع GEX لكل Strike
    const gexMap = {};

    for (const c of results) {
      const strike = c.details?.strike_price;
      const type   = c.details?.contract_type; // 'call' | 'put'
      const oi     = c.open_interest || 0;
      const gamma  = c.greeks?.gamma || 0;
      const exp    = c.details?.expiration_date || '';
      const iv     = c.implied_volatility || 0;

      if (!strike || !oi) continue;

      const key = strike.toString();
      if (!gexMap[key]) {
        gexMap[key] = {
          strike,
          callGEX: 0,
          putGEX:  0,
          callOI:  0,
          putOI:   0,
          netGEX:  0,
          nearExp: exp,
          iv:      0,
          ivCount: 0,
        };
      }

      // GEX = OI × Gamma × 100 × Spot
      const gexValue = oi * gamma * 100 * spot;

      if (type === 'call') {
        gexMap[key].callGEX += gexValue;
        gexMap[key].callOI  += oi;
      } else {
        gexMap[key].putGEX  += gexValue;
        gexMap[key].putOI   += oi;
      }

      if (iv > 0) {
        gexMap[key].iv     += iv;
        gexMap[key].ivCount++;
      }
    }

    // حساب Net GEX لكل Strike
    const strikes = Object.values(gexMap).map(s => {
      s.netGEX = s.callGEX - s.putGEX;
      s.avgIV  = s.ivCount > 0 ? (s.iv / s.ivCount * 100).toFixed(1) : null;
      return s;
    }).sort((a, b) => a.strike - b.strike);

    if (!strikes.length) return null;

    // Total GEX
    const totalCallGEX = strikes.reduce((s, x) => s + x.callGEX, 0);
    const totalPutGEX  = strikes.reduce((s, x) => s + x.putGEX,  0);
    const totalNetGEX  = totalCallGEX - totalPutGEX;

    // Call Wall = أعلى Call GEX فوق السعر
    const callWall = strikes
      .filter(s => s.strike > spot)
      .sort((a, b) => b.callGEX - a.callGEX)[0];

    // Put Wall = أعلى Put GEX تحت السعر
    const putWall = strikes
      .filter(s => s.strike < spot)
      .sort((a, b) => b.putGEX - a.putGEX)[0];

    // HVL = أقرب Strike حيث Net GEX يتغير من سالب لموجب (Gamma Flip)
    let hvl = null;
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i-1].netGEX < 0 && sorted[i].netGEX >= 0) {
        hvl = sorted[i].strike;
        break;
      }
    }
    if (!hvl) {
      // HVL تقريبي = أقرب Strike لـ Net GEX = 0
      hvl = strikes.reduce((prev, curr) =>
        Math.abs(curr.netGEX) < Math.abs(prev.netGEX) ? curr : prev
      ).strike;
    }

    // أعلى 15 Strike بـ Net GEX للعرض
    const topStrikes = [...strikes]
      .sort((a, b) => Math.abs(b.netGEX) - Math.abs(a.netGEX))
      .slice(0, 15)
      .sort((a, b) => b.strike - a.strike);

    // Sentiment من GEX
    let gexSentiment, gexSentimentAr;
    if (totalNetGEX > 0) {
      gexSentiment = 'bull';
      gexSentimentAr = totalNetGEX > 1e9 ? '🟢 صعودي قوي — Positive GEX' : '🟢 صعودي — Positive GEX';
    } else {
      gexSentiment = 'bear';
      gexSentimentAr = totalNetGEX < -1e9 ? '🔴 هبوطي قوي — Negative GEX' : '🔴 هبوطي — Negative GEX';
    }

    // السعر فوق أو تحت HVL
    const aboveHVL = spot > (hvl || 0);

    return {
      symbol,
      spot,
      totalCallGEX,
      totalPutGEX,
      totalNetGEX,
      callWall:  callWall?.strike || null,
      putWall:   putWall?.strike  || null,
      hvl,
      aboveHVL,
      gexSentiment,
      gexSentimentAr,
      strikes: topStrikes,
      contractCount: results.length,
      ts: Date.now(),
    };

  } catch(e) {
    console.error(`GEX error ${symbol}:`, e.message);
    return null;
  }
}

// ── Format GEX value ──
function fmtGEX(v) {
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v/1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (v/1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = ((req.query.symbol || 'SPY')).toUpperCase();
  const force  = req.query.force === '1';

  // Map للمؤشرات
  const mapped = {
    'US500': 'SPY', 'NDX': 'QQQ', 'DJI': 'DIA',
    'SPX': 'SPX', 'XAUUSD': 'GLD'
  };
  const apiSym = mapped[symbol] || symbol;

  if (!GEX_SYMBOLS[apiSym]) {
    return res.status(200).json({
      ok: false,
      message: `${symbol} غير مدعوم — الرموز المتاحة: ${Object.keys(GEX_SYMBOLS).join(', ')}`
    });
  }

  try {
    // Cache 15 دقيقة
    const cacheKey = `gex_${apiSym}`;
    if (!force) {
      const cached = await kvGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < 15*60*1000) {
        return res.status(200).json({ ok: true, cached: true, data: cached });
      }
    }

    const gexData = await calcGEX(apiSym);
    if (!gexData) {
      return res.status(200).json({ ok: false, message: `لا توجد بيانات GEX لـ ${symbol}` });
    }

    await kvSet(cacheKey, gexData, 900);
    return res.status(200).json({ ok: true, cached: false, data: gexData });

  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
