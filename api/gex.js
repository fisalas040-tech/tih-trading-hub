// ════════════════════════════════════════════════════════
// TIH gex.js v3.0
// GEX + DEX + Vanna + Charm
// مصدر مزدوج: CBOE (مجاني) + Polygon (احتياطي)
// تصفية: 0DTE / 1DTE / 5DTE
// ════════════════════════════════════════════════════════

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MASSIVE_KEY   = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE  = 'api.polygon.io';

const GEX_SYMBOLS = {
  'SPY' :'S&P 500 ETF',
  'QQQ' :'Nasdaq ETF',
  'NVDA':'NVIDIA',
  'AAPL':'Apple',
  'TSLA':'Tesla',
  'AMD' :'AMD',
  'MSFT':'Microsoft',
  'SPX' :'S&P 500 Index',
};

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers:{ Authorization:`Bearer ${UPSTASH_TOKEN}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, value, ex=900) {
  try {
    await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`,
      { headers:{ Authorization:`Bearer ${UPSTASH_TOKEN}` } }
    );
  } catch(e) {}
}

// ════════════════════════════════════════════════════════
// CBOE — المصدر المجاني (متأخر ~15 دقيقة)
// ════════════════════════════════════════════════════════
async function fetchCBOE(symbol) {
  // SPX يُعالَج بشكل خاص في CBOE
  const cboeSymbol = symbol === 'SPX' ? 'SPX' : symbol;
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${cboeSymbol}.json`;

  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json',
      'Referer': 'https://www.cboe.com/',
    }
  });

  if (!r.ok) throw new Error(`CBOE ${r.status} for ${symbol}`);
  const data = await r.json();

  const spot = data.data?.current_price || data.data?.close || 0;
  const options = data.data?.options || [];

  if (!options.length) throw new Error(`CBOE: لا بيانات options لـ ${symbol}`);

  // تحويل بيانات CBOE إلى صيغة موحدة
  const contracts = options.map(opt => {
    // CBOE option symbol: e.g. "SPXW240624C05000000"
    const raw = opt.option || '';
    const isCall = raw.includes('C') && !raw.includes('P') ? true :
                   raw.includes('P') ? false : null;
    if (isCall === null) return null;

    const strike = opt.strike_price || parseFloat(opt.option?.match(/[CP](\d+)/)?.[1] / 1000) || 0;
    const expStr = opt.expiration_date || '';

    return {
      type: isCall ? 'call' : 'put',
      strike,
      expiration_date: expStr,
      open_interest: opt.open_interest || 0,
      volume: opt.volume || 0,
      implied_volatility: opt.iv ? opt.iv / 100 : 0.25,
      delta: opt.delta || null,
      gamma: opt.gamma || null,
      vanna: opt.vanna || null,
      charm: opt.charm || null,
      theo: opt.theo || opt.last || 0,
    };
  }).filter(Boolean);

  return { contracts, spot, source: 'CBOE' };
}

// ════════════════════════════════════════════════════════
// Polygon — المصدر الاحتياطي
// ════════════════════════════════════════════════════════
async function fetchPolygon(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const in60d = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];

  const sep = `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in60d}&limit=250`;
  const url = `https://${MASSIVE_BASE}${sep}&apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url, { headers:{ 'User-Agent':'TIH/2.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status}`);
  const data = await r.json();

  const contracts = (data.results || []).map(c => ({
    type: c.details?.contract_type,
    strike: c.details?.strike_price,
    expiration_date: c.details?.expiration_date,
    open_interest: c.open_interest || 0,
    volume: c.day?.volume || 0,
    implied_volatility: c.implied_volatility || 0.25,
    delta: c.greeks?.delta || null,
    gamma: c.greeks?.gamma || null,
    vanna: null,
    charm: null,
    theo: c.last_quote?.midpoint || 0,
  }));

  let spot = data.results?.[0]?.underlying_asset?.price || 0;
  if (!spot) {
    const agg = await fetch(
      `https://${MASSIVE_BASE}/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${MASSIVE_KEY}`,
      { headers:{ 'User-Agent':'TIH/2.0' } }
    ).then(r=>r.json()).catch(()=>({results:[]}));
    spot = agg.results?.[0]?.c || 0;
  }

  return { contracts, spot, source: 'Polygon' };
}

// ════════════════════════════════════════════════════════
// حساب اليونانيات (BSM)
// ════════════════════════════════════════════════════════
function norm(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x<0 ? -1 : 1;
  const t = 1/(1+p*Math.abs(x));
  const poly = ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t;
  return 0.5*(1+sign*(1-poly*Math.exp(-x*x/2)));
}
function normPdf(x) { return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }

function bsmGreeks(S, K, iv, expMs, isCall) {
  try {
    const T = Math.max(0.0001, (expMs - Date.now()) / (365*86400000));
    const r = 0.05;
    const sigma = Math.max(0.01, iv);
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*sqrtT);
    const d2 = d1 - sigma*sqrtT;
    const nd1 = normPdf(d1);

    const gamma = nd1 / (S*sigma*sqrtT);
    const delta = isCall ? norm(d1) : norm(d1)-1;

    // Vanna = dDelta/dVol = -d2 * nd1 / sigma
    const vanna = -nd1 * d2 / sigma;

    // Charm = dDelta/dT
    const charm = isCall
      ? -nd1*(r/(sigma*sqrtT) - d2/(2*T)) - r*norm(d1)
      : -nd1*(r/(sigma*sqrtT) - d2/(2*T)) + r*norm(-d1);

    return {
      gamma:  isNaN(gamma)||!isFinite(gamma)  ? 0 : gamma,
      delta:  isNaN(delta)||!isFinite(delta)  ? 0 : delta,
      vanna:  isNaN(vanna)||!isFinite(vanna)  ? 0 : vanna,
      charm:  isNaN(charm)||!isFinite(charm)  ? 0 : charm,
    };
  } catch(e) {
    return { gamma:0, delta:0, vanna:0, charm:0 };
  }
}

// ════════════════════════════════════════════════════════
// تصفية حسب DTE
// ════════════════════════════════════════════════════════
function filterByDTE(contracts, dteMode) {
  const now = Date.now();
  const MS_PER_DAY = 86400000;

  return contracts.filter(c => {
    if (!c.expiration_date) return false;
    const expMs = new Date(c.expiration_date + 'T21:00:00Z').getTime();
    const dte = (expMs - now) / MS_PER_DAY;

    if (dteMode === '0DTE') return dte >= 0 && dte < 1;
    if (dteMode === '1DTE') return dte >= 0 && dte <= 1;
    if (dteMode === '5DTE') return dte >= 0 && dte <= 5;
    return dte >= 0 && dte <= 60; // الكل
  });
}

// ════════════════════════════════════════════════════════
// الحساب الرئيسي
// ════════════════════════════════════════════════════════
async function calcGEX(symbol, dteMode = 'ALL') {
  // جرب CBOE أولاً — إذا فشل انتقل لـ Polygon
  let result;
  let source = 'CBOE';

  try {
    result = await fetchCBOE(symbol);
  } catch(e) {
    console.log(`CBOE failed for ${symbol}: ${e.message} — trying Polygon`);
    try {
      result = await fetchPolygon(symbol);
      source = 'Polygon';
    } catch(e2) {
      throw new Error(`كلا المصدرين فشلا: ${e.message} | ${e2.message}`);
    }
  }

  let { contracts, spot } = result;
  if (!contracts.length) throw new Error(`لا توجد بيانات options لـ ${symbol}`);
  if (!spot) throw new Error(`تعذّر الحصول على سعر ${symbol}`);

  // تطبيق فلتر DTE
  const filtered = filterByDTE(contracts, dteMode);
  if (!filtered.length) throw new Error(`لا توجد عقود لـ ${dteMode} في ${symbol}`);

  // حساب GEX لكل Strike
  const gexMap = {};

  for (const c of filtered) {
    const { type, strike, expiration_date, open_interest, volume, implied_volatility } = c;
    if (!type || !strike || !expiration_date) continue;

    const oi    = open_interest || 0;
    const vol   = volume || 0;
    const iv    = implied_volatility || 0.25;
    const expMs = new Date(expiration_date + 'T21:00:00Z').getTime();
    const isCall = type === 'call';

    // استخدم gamma الفعلي من CBOE إذا متوفر، وإلا احسبه
    const greeks = (c.gamma !== null && c.gamma !== undefined && c.gamma !== 0)
      ? { gamma: c.gamma, delta: c.delta || 0, vanna: c.vanna || 0, charm: c.charm || 0 }
      : bsmGreeks(spot, strike, iv, expMs, isCall);

    const gexVal   = oi * greeks.gamma * 100 * spot;
    const dexVal   = oi * greeks.delta * 100;
    const vannaVal = oi * greeks.vanna * 100;
    const charmVal = oi * greeks.charm * 100;

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
        callIV:0, putIV:0,
      };
    }

    if (isCall) {
      gexMap[key].callGEX   += gexVal;
      gexMap[key].callDEX   += dexVal;
      gexMap[key].callVanna += vannaVal;
      gexMap[key].callCharm += charmVal;
      gexMap[key].callOI    += oi;
      gexMap[key].callVol   += vol;
      gexMap[key].callIV     = iv;
    } else {
      gexMap[key].putGEX    += gexVal;
      gexMap[key].putDEX    += dexVal;
      gexMap[key].putVanna  += vannaVal;
      gexMap[key].putCharm  += charmVal;
      gexMap[key].putOI     += oi;
      gexMap[key].putVol    += vol;
      gexMap[key].putIV      = iv;
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
  const totalCallGEX   = strikes.reduce((s,x) => s+x.callGEX,   0);
  const totalPutGEX    = strikes.reduce((s,x) => s+x.putGEX,    0);
  const totalNetGEX    = totalCallGEX - totalPutGEX;
  const totalNetDEX    = strikes.reduce((s,x) => s+x.netDEX,    0);
  const totalNetVanna  = strikes.reduce((s,x) => s+x.netVanna,  0);
  const totalNetCharm  = strikes.reduce((s,x) => s+x.netCharm,  0);

  // ── Call Wall / Put Wall ──
  const callWall = [...strikes]
    .filter(s => s.strike > spot)
    .sort((a,b) => b.callGEX - a.callGEX)[0];
  const putWall  = [...strikes]
    .filter(s => s.strike < spot)
    .sort((a,b) => b.putGEX - a.putGEX)[0];

  // ── HVL (نقطة الانقلاب) ──
  let hvl = null;
  for (let j=1; j<strikes.length; j++) {
    if (strikes[j-1].netGEX < 0 && strikes[j].netGEX >= 0) {
      hvl = strikes[j].strike;
      break;
    }
  }
  if (!hvl) {
    hvl = strikes.reduce((p,c) =>
      Math.abs(c.netGEX) < Math.abs(p.netGEX) ? c : p
    ).strike;
  }

  // ── الحركة المتوقعة (Expected Move) ──
  const atmContract = filtered.find(c =>
    c.type === 'call' && Math.abs(c.strike - spot) < spot*0.01
  );
  const atmIV = atmContract?.implied_volatility || 0.20;
  const dte = dteMode === '0DTE' ? 1/365 : dteMode === '1DTE' ? 1/365 : dteMode === '5DTE' ? 5/365 : 30/365;
  const expectedMove = spot * atmIV * Math.sqrt(dte);
  const expectedMovePct = (atmIV * Math.sqrt(dte) * 100).toFixed(2);

  // ── Gamma Regime ──
  const isLongGamma = totalNetGEX > 0;

  // ── Top Strikes للعرض (أقرب 20 Strike من السعر) ──
  const nearStrikes = [...strikes]
    .sort((a,b) => Math.abs(a.strike-spot) - Math.abs(b.strike-spot))
    .slice(0, 20)
    .sort((a,b) => b.strike - a.strike);

  // ── Vanna Regime ──
  const vannaRegime = totalNetVanna > 0
    ? 'صانع السوق بصافي دلتا موجبة'
    : 'صانع السوق بصافي دلتا سالبة';

  // ── Charm (تحيز الوقت) ──
  const charmBias = totalNetCharm > 0
    ? 'تشارم موجبة — هبوط التقلب يرفع التحوّط'
    : 'تشارم سالبة — الوقت يدعم حتى الإغلاق (تثبيت)';

  return {
    symbol, spot,
    dteMode,
    source,
    // GEX
    totalCallGEX, totalPutGEX, totalNetGEX,
    gexRatio: totalPutGEX > 0 ? (totalCallGEX/totalPutGEX).toFixed(2) : '—',
    // DEX
    totalNetDEX,
    dexRegime: vannaRegime,
    // Vanna
    totalNetVanna,
    vannaRegime,
    // Charm
    totalNetCharm,
    charmBias,
    // Regime
    gammaRegime:   isLongGamma ? 'LONG GAMMA' : 'SHORT GAMMA',
    gammaRegimeAr: isLongGamma
      ? '🟢 غاما موجبة — حركة محدودة ومستقرة'
      : '🔴 غاما سالبة — حركات مضخّمة',
    isLongGamma,
    // Walls
    callWall: callWall?.strike || null,
    putWall:  putWall?.strike  || null,
    hvl,
    aboveHVL: spot > (hvl||0),
    // Expected Move
    expectedMove:    parseFloat(expectedMove.toFixed(2)),
    expectedMovePct,
    expectedMoveHigh: parseFloat((spot + expectedMove).toFixed(2)),
    expectedMoveLow:  parseFloat((spot - expectedMove).toFixed(2)),
    // Strikes
    strikes: nearStrikes,
    contractCount: filtered.length,
    method: 'BSM_greeks',
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
  const dteMode = (['0DTE','1DTE','5DTE','ALL'].includes(req.query.dte)
    ? req.query.dte : 'ALL');

  // تعيين الرموز
  const mapped = { 'US500':'SPY', 'NDX':'QQQ', 'DJI':'DIA' };
  const apiSym = mapped[rawSym] || rawSym;

  if (!GEX_SYMBOLS[apiSym]) {
    return res.status(200).json({ ok:false, message:`${rawSym} غير مدعوم` });
  }

  try {
    const cacheKey = `gex3_${apiSym}_${dteMode}`;

    if (req.query.force !== '1') {
      const cached = await kvGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < 15*60*1000) {
        return res.status(200).json({ ok:true, cached:true, data:cached });
      }
    }

    const gexData = await calcGEX(apiSym, dteMode);
    await kvSet(cacheKey, gexData, 900);
    return res.status(200).json({ ok:true, cached:false, data:gexData });

  } catch(e) {
    return res.status(200).json({ ok:false, error:e.message });
  }
};
