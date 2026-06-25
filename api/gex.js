// ════════════════════════════════════════════════════════
// TIH gex.js v4.0
// GEX + DEX + Vanna + Charm
// المصدر: Tradier (Greeks حقيقية) + Polygon (احتياطي)
// ════════════════════════════════════════════════════════

const UPSTASH_URL    = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN  = process.env.UPSTASH_REDIS_REST_TOKEN;
const MASSIVE_KEY    = process.env.MASSIVE_API_KEY;
const TRADIER_TOKEN  = process.env.TRADIER_TOKEN;
const MASSIVE_BASE   = 'api.polygon.io';
const TRADIER_BASE   = 'https://api.tradier.com/v1';

const GEX_SYMBOLS = {
  'SPY' : 'S&P 500 ETF',
  'QQQ' : 'Nasdaq ETF',
  'NVDA': 'NVIDIA',
  'AAPL': 'Apple',
  'TSLA': 'Tesla',
  'AMD' : 'AMD',
  'MSFT': 'Microsoft',
  'SPX' : 'S&P 500 Index',
};

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, value, ex = 900) {
  try {
    await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
  } catch(e) {}
}

// ════════════════════════════════════════════════════════
// Tradier — Greeks حقيقية
// ════════════════════════════════════════════════════════
async function fetchTradier(symbol) {
  if (!TRADIER_TOKEN) throw new Error('TRADIER_TOKEN غير موجود');

  // جلب السعر الحالي
  const quoteRes = await fetch(
    `${TRADIER_BASE}/markets/quotes?symbols=${symbol}&greeks=false`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  );
  if (!quoteRes.ok) throw new Error(`Tradier quote ${quoteRes.status}`);
  const quoteData = await quoteRes.json();
  const spot = quoteData?.quotes?.quote?.last || 0;
  if (!spot) throw new Error('تعذّر جلب السعر من Tradier');

  // جلب تواريخ الانتهاء
  const expRes = await fetch(
    `${TRADIER_BASE}/markets/options/expirations?symbol=${symbol}&includeAllRoots=true`,
    { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
  );
  if (!expRes.ok) throw new Error(`Tradier expirations ${expRes.status}`);
  const expData = await expRes.json();
  const expirations = expData?.expirations?.date || [];
  if (!expirations.length) throw new Error('لا تواريخ انتهاء متاحة');

  // جلب أول 3 تواريخ فقط (0DTE + أقرب)
  const targetExps = expirations.slice(0, 3);
  const contracts = [];

  for (const exp of targetExps) {
    try {
      const chainRes = await fetch(
        `${TRADIER_BASE}/markets/options/chains?symbol=${symbol}&expiration=${exp}&greeks=true`,
        { headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' } }
      );
      if (!chainRes.ok) continue;
      const chainData = await chainRes.json();
      const options = chainData?.options?.option || [];

      options.forEach(opt => {
        if (!opt.strike || !opt.option_type) return;
        contracts.push({
          type:               opt.option_type === 'call' ? 'call' : 'put',
          strike:             opt.strike,
          expiration_date:    exp,
          open_interest:      opt.open_interest || 0,
          volume:             opt.volume || 0,
          implied_volatility: opt.greeks?.smv_vol || opt.greeks?.mid_iv || 0.25,
          delta:              opt.greeks?.delta || null,
          gamma:              opt.greeks?.gamma || null,
          vanna:              opt.greeks?.vanna || null,
          charm:              opt.greeks?.charm || null,
          theta:              opt.greeks?.theta || null,
          vega:               opt.greeks?.vega  || null,
        });
      });
    } catch(e) { continue; }
  }

  if (!contracts.length) throw new Error('لا بيانات options من Tradier');
  return { contracts, spot, source: 'Tradier' };
}

// ════════════════════════════════════════════════════════
// Polygon — احتياطي
// ════════════════════════════════════════════════════════
async function fetchPolygon(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const in30d = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
  const url = `https://${MASSIVE_BASE}/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in30d}&limit=250&apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'TIH/2.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status}`);
  const data = await r.json();

  const contracts = (data.results || []).map(c => ({
    type:               c.details?.contract_type,
    strike:             c.details?.strike_price,
    expiration_date:    c.details?.expiration_date,
    open_interest:      c.open_interest || 0,
    volume:             c.day?.volume || 0,
    implied_volatility: c.implied_volatility || 0.25,
    delta:              c.greeks?.delta || null,
    gamma:              c.greeks?.gamma || null,
    vanna:              null,
    charm:              null,
  }));

  let spot = data.results?.[0]?.underlying_asset?.price || 0;
  if (!spot) {
    const agg = await fetch(
      `https://${MASSIVE_BASE}/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${MASSIVE_KEY}`,
      { headers: { 'User-Agent': 'TIH/2.0' } }
    ).then(r => r.json()).catch(() => ({}));
    spot = agg.results?.[0]?.c || 0;
  }

  return { contracts, spot, source: 'Polygon' };
}

// ════════════════════════════════════════════════════════
// BSM Greeks (للاحتياط فقط إذا غابت الـ Greeks)
// ════════════════════════════════════════════════════════
function normPdf(x) { return Math.exp(-0.5*x*x) / Math.sqrt(2*Math.PI); }
function normCdf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const s = x < 0 ? -1 : 1, t = 1/(1+p*Math.abs(x));
  return 0.5*(1+s*(1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x/2)));
}
function bsmGreeks(S, K, iv, expMs, isCall) {
  try {
    const T = Math.max(0.0001, (expMs - Date.now()) / (365*86400000));
    const sigma = Math.max(0.01, iv), sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S/K) + (0.05 + 0.5*sigma*sigma)*T) / (sigma*sqrtT);
    const d2 = d1 - sigma*sqrtT, nd1 = normPdf(d1);
    const gamma = nd1 / (S*sigma*sqrtT);
    const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
    const vanna = -nd1 * d2 / sigma;
    const charm = isCall
      ? -nd1*(0.05/(sigma*sqrtT) - d2/(2*T)) - 0.05*normCdf(d1)
      : -nd1*(0.05/(sigma*sqrtT) - d2/(2*T)) + 0.05*normCdf(-d1);
    const safe = v => (isNaN(v)||!isFinite(v)) ? 0 : v;
    return { gamma: safe(gamma), delta: safe(delta), vanna: safe(vanna), charm: safe(charm) };
  } catch(e) { return { gamma:0, delta:0, vanna:0, charm:0 }; }
}

// ════════════════════════════════════════════════════════
// الحساب الرئيسي
// ════════════════════════════════════════════════════════
async function calcGEX(symbol) {
  let result;

  // جرب Tradier أولاً
  try {
    result = await fetchTradier(symbol);
    console.log(`✅ Tradier OK for ${symbol}: ${result.contracts.length} contracts`);
  } catch(e) {
    console.log(`Tradier failed for ${symbol}: ${e.message} — trying Polygon`);
    try {
      result = await fetchPolygon(symbol);
    } catch(e2) {
      throw new Error(`كلا المصدرين فشلا: ${e.message} | ${e2.message}`);
    }
  }

  const { contracts, spot, source } = result;
  if (!contracts.length) throw new Error(`لا توجد بيانات options لـ ${symbol}`);
  if (!spot)             throw new Error(`تعذّر الحصول على سعر ${symbol}`);

  const gexMap = {};

  for (const c of contracts) {
    const { type, strike, expiration_date, open_interest, volume, implied_volatility } = c;
    if (!type || !strike || !expiration_date) continue;

    const oi     = open_interest || 0;
    const vol    = volume || 0;
    const iv     = implied_volatility || 0.25;
    const expMs  = new Date(expiration_date + 'T21:00:00Z').getTime();
    const isCall = type === 'call';

    // استخدم Greeks الحقيقية من Tradier إذا متوفرة
    let greeks;
    if (c.gamma !== null && c.gamma !== undefined && c.gamma !== 0) {
      greeks = {
        gamma: c.gamma,
        delta: c.delta || 0,
        vanna: c.vanna || 0,
        charm: c.charm || 0,
      };
    } else {
      greeks = bsmGreeks(spot, strike, iv, expMs, isCall);
    }

    const gexVal   = oi * greeks.gamma * 100 * spot;
    const dexVal   = oi * Math.abs(greeks.delta) * 100;
    const vannaVal = oi * greeks.vanna * spot * iv;
    const charmVal = oi * greeks.charm;

    const key = strike.toString();
    if (!gexMap[key]) {
      gexMap[key] = {
        strike,
        callGEX:0, putGEX:0,
        callDEX:0, putDEX:0,
        callVanna:0, putVanna:0,
        callCharm:0, putCharm:0,
        callOI:0, putOI:0,
        callVol:0, putVol:0,
      };
    }

    if (isCall) {
      gexMap[key].callGEX   += gexVal;
      gexMap[key].callDEX   += dexVal;
      gexMap[key].callVanna += vannaVal;
      gexMap[key].callCharm += charmVal;
      gexMap[key].callOI    += oi;
      gexMap[key].callVol   += vol;
    } else {
      gexMap[key].putGEX    += gexVal;
      gexMap[key].putDEX    += dexVal;
      gexMap[key].putVanna  += vannaVal;
      gexMap[key].putCharm  += charmVal;
      gexMap[key].putOI     += oi;
      gexMap[key].putVol    += vol;
    }
  }

  const strikes = Object.values(gexMap)
    .map(s => ({
      ...s,
      netGEX:   s.callGEX   - s.putGEX,
      netDEX:   s.callDEX   - s.putDEX,
      netVanna: s.callVanna - s.putVanna,
      netCharm: s.callCharm - s.putCharm,
    }))
    .sort((a, b) => a.strike - b.strike);

  if (!strikes.length) throw new Error('لا توجد strikes صالحة');

  // ── الإجماليات ──
  const totalCallGEX  = strikes.reduce((s,x) => s+x.callGEX,  0);
  const totalPutGEX   = strikes.reduce((s,x) => s+x.putGEX,   0);
  const totalNetGEX   = totalCallGEX - totalPutGEX;
  const totalNetDEX   = strikes.reduce((s,x) => s+x.netDEX,   0);
  const totalNetVanna = strikes.reduce((s,x) => s+x.netVanna, 0);
  const totalNetCharm = strikes.reduce((s,x) => s+x.netCharm, 0);

  // ── Walls ──
  const callWall = [...strikes].filter(s => s.strike > spot).sort((a,b) => b.callGEX - a.callGEX)[0];
  const putWall  = [...strikes].filter(s => s.strike < spot).sort((a,b) => b.putGEX  - a.putGEX)[0];

  // ── HVL ──
  let hvl = null;
  for (let j=1; j<strikes.length; j++) {
    if (strikes[j-1].netGEX < 0 && strikes[j].netGEX >= 0) { hvl = strikes[j].strike; break; }
  }
  if (!hvl) hvl = strikes.reduce((p,c) => Math.abs(c.netGEX) < Math.abs(p.netGEX) ? c : p).strike;

  // ── Expected Move ──
  const atmContract = contracts.find(c =>
    c.type === 'call' && Math.abs(c.strike - spot) < spot * 0.02
  );
  const atmIV = atmContract?.implied_volatility || 0.20;
  const expectedMove    = spot * atmIV * Math.sqrt(1/365);
  const expectedMovePct = (atmIV * Math.sqrt(1/365) * 100).toFixed(2);

  // ── Regime ──
  const isLongGamma = totalNetGEX > 0;
  const charmBias   = totalNetCharm > 0
    ? 'تشارم موجبة — هبوط التقلب يرفع التحوّط'
    : 'تشارم سالبة — الوقت يدعم حتى الإغلاق (تثبيت)';
  const vannaRegime = totalNetVanna > 0
    ? 'صانع السوق بصافي دلتا موجبة (DEX+)'
    : 'صانع السوق بصافي دلتا سالبة (DEX-)';

  // ── Top Strikes (أقرب 20 للسعر) ──
  const topStrikes = [...strikes]
    .sort((a,b) => Math.abs(a.strike-spot) - Math.abs(b.strike-spot))
    .slice(0, 20)
    .sort((a,b) => b.strike - a.strike);

  return {
    symbol, spot, source,
    // GEX
    totalCallGEX, totalPutGEX, totalNetGEX,
    gexRatio: totalPutGEX > 0 ? (totalCallGEX/totalPutGEX).toFixed(2) : '—',
    // DEX
    totalNetDEX, dexRegime: vannaRegime,
    // Vanna & Charm
    totalNetVanna, vannaRegime,
    totalNetCharm, charmBias,
    // Regime
    gammaRegime:   isLongGamma ? 'LONG GAMMA' : 'SHORT GAMMA',
    gammaRegimeAr: isLongGamma
      ? '🟢 غاما موجبة — حركة محدودة ومستقرة'
      : '🔴 غاما سالبة — حركات مضخّمة',
    isLongGamma,
    // Walls
    callWall: callWall?.strike || null,
    putWall:  putWall?.strike  || null,
    hvl, aboveHVL: spot > (hvl||0),
    // Expected Move
    expectedMove:     parseFloat(expectedMove.toFixed(2)),
    expectedMovePct,
    expectedMoveHigh: parseFloat((spot + expectedMove).toFixed(2)),
    expectedMoveLow:  parseFloat((spot - expectedMove).toFixed(2)),
    // Strikes
    strikes: topStrikes,
    contractCount: contracts.length,
    greeksSource: source === 'Tradier' ? 'Real Greeks' : 'BSM Estimated',
    ts: Date.now(),
  };
}

// ════════════════════════════════════════════════════════
// Handler
// ════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const rawSym = ((req.query.symbol || 'SPY') + '').toUpperCase();
  const mapped = { 'US500':'SPY', 'NDX':'QQQ', 'DJI':'DIA' };
  const apiSym = mapped[rawSym] || rawSym;

  if (!GEX_SYMBOLS[apiSym])
    return res.status(200).json({ ok:false, message:`${rawSym} غير مدعوم` });

  try {
    const cacheKey = `gex4_${apiSym}`;
    if (req.query.force !== '1') {
      const cached = await kvGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < 15*60*1000)
        return res.status(200).json({ ok:true, cached:true, data:cached });
    }
    const gexData = await calcGEX(apiSym);
    await kvSet(cacheKey, gexData, 900);
    return res.status(200).json({ ok:true, cached:false, data:gexData });
  } catch(e) {
    return res.status(200).json({ ok:false, error:e.message });
  }
};
