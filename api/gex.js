// ════════════════════════════════════════════════════════
// TIH gex.js v3.1
// GEX + DEX + Vanna + Charm
// المصدر: Polygon.io
// تصفية: 0DTE / 1DTE / 5DTE / ALL
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

// ── Polygon ──
async function poly(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://${MASSIVE_BASE}${path}${sep}apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url, { headers:{ 'User-Agent':'TIH/2.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status}: ${path.split('?')[0]}`);
  return r.json();
}

// ── جلب Options + Spot ──
async function fetchOptionsAndSpot(symbol, dteMode) {
  const today = new Date().toISOString().split('T')[0];

  // حساب نهاية الفترة حسب DTE
  let daysAhead = 60;
  if (dteMode === '0DTE') daysAhead = 1;
  else if (dteMode === '1DTE') daysAhead = 2;
  else if (dteMode === '5DTE') daysAhead = 6;

  const endDate = new Date(Date.now() + daysAhead*86400000).toISOString().split('T')[0];

  const data = await poly(
    `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${endDate}&limit=250`
  );

  let contracts = data.results || [];

  // إذا 0DTE ولا يوجد عقود، جرب اليوم التالي
  if (!contracts.length && dteMode === '0DTE') {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const d2 = await poly(
      `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${tomorrow}&limit=250`
    );
    contracts = d2.results || [];
  }

  // إذا لا يزال فارغاً، جلب كل العقود (ALL)
  if (!contracts.length) {
    const in60d = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];
    const d3 = await poly(
      `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in60d}&limit=250`
    );
    contracts = d3.results || [];
  }

  let spot = contracts[0]?.underlying_asset?.price || 0;
  if (!spot) {
    try {
      const agg = await poly(`/v2/aggs/ticker/${symbol}/prev?adjusted=true`);
      spot = agg.results?.[0]?.c || 0;
    } catch(e) { spot = 0; }
  }

  return { contracts, spot };
}

// ── BSM Greeks ──
function normPdf(x) { return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }
function normCdf(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x<0 ? -1 : 1;
  const t = 1/(1+p*Math.abs(x));
  const poly = ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t;
  return 0.5*(1+sign*(1-poly*Math.exp(-x*x/2)));
}

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
    const delta = isCall ? normCdf(d1) : normCdf(d1)-1;
    const vanna = -nd1 * d2 / sigma;
    const charm = isCall
      ? -nd1*(r/(sigma*sqrtT) - d2/(2*T)) - r*normCdf(d1)
      : -nd1*(r/(sigma*sqrtT) - d2/(2*T)) + r*normCdf(-d1);

    return {
      gamma: isNaN(gamma)||!isFinite(gamma) ? 0 : gamma,
      delta: isNaN(delta)||!isFinite(delta) ? 0 : delta,
      vanna: isNaN(vanna)||!isFinite(vanna) ? 0 : vanna,
      charm: isNaN(charm)||!isFinite(charm) ? 0 : charm,
    };
  } catch(e) {
    return { gamma:0, delta:0, vanna:0, charm:0 };
  }
}

// ── الحساب الرئيسي ──
async function calcGEX(symbol, dteMode = 'ALL') {
  const { contracts, spot } = await fetchOptionsAndSpot(symbol, dteMode);

  if (!contracts.length) throw new Error(`لا توجد بيانات options لـ ${symbol}`);
  if (!spot)             throw new Error(`تعذّر الحصول على سعر ${symbol}`);

  const gexMap = {};

  for (const c of contracts) {
    const det    = c.details || {};
    const type   = det.contract_type;
    const strike = det.strike_price;
    const expStr = det.expiration_date;
    if (!type || !strike || !expStr) continue;

    const oi     = c.open_interest || 0;
    const volume = c.day?.volume || 0;
    const iv     = c.implied_volatility || 0.25;
    const expMs  = new Date(expStr + 'T21:00:00Z').getTime();
    const isCall = type === 'call';

    // استخدم Greeks من Polygon إذا متوفرة
    const g = c.greeks;
    const greeks = (g?.gamma)
      ? {
          gamma: g.gamma,
          delta: g.delta || 0,
          vanna: 0,  // Polygon لا يوفر vanna
          charm: 0,
        }
      : bsmGreeks(spot, strike, iv, expMs, isCall);

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
      gexMap[key].callVol   += volume;
    } else {
      gexMap[key].putGEX    += gexVal;
      gexMap[key].putDEX    += dexVal;
      gexMap[key].putVanna  += vannaVal;
      gexMap[key].putCharm  += charmVal;
      gexMap[key].putOI     += oi;
      gexMap[key].putVol    += volume;
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
  const callWall = [...strikes].filter(s=>s.strike>spot).sort((a,b)=>b.callGEX-a.callGEX)[0];
  const putWall  = [...strikes].filter(s=>s.strike<spot).sort((a,b)=>b.putGEX-a.putGEX)[0];

  // ── HVL ──
  let hvl = null;
  for (let j=1; j<strikes.length; j++) {
    if (strikes[j-1].netGEX<0 && strikes[j].netGEX>=0) { hvl=strikes[j].strike; break; }
  }
  if (!hvl) hvl = strikes.reduce((p,c)=>Math.abs(c.netGEX)<Math.abs(p.netGEX)?c:p).strike;

  // ── Expected Move ──
  const atmIV = contracts.find(c=>
    c.details?.contract_type==='call' && Math.abs(c.details?.strike_price-spot)<spot*0.02
  )?.implied_volatility || 0.20;

  const dteDays = dteMode==='0DTE' ? 1 : dteMode==='1DTE' ? 1 : dteMode==='5DTE' ? 5 : 30;
  const expectedMove    = spot * atmIV * Math.sqrt(dteDays/365);
  const expectedMovePct = (atmIV * Math.sqrt(dteDays/365) * 100).toFixed(2);

  // ── Regime ──
  const isLongGamma  = totalNetGEX > 0;
  const vannaRegime  = totalNetVanna > 0
    ? 'صانع السوق بصافي دلتا موجبة (DEX+)'
    : 'صانع السوق بصافي دلتا سالبة (DEX-)';
  const charmBias = totalNetCharm > 0
    ? 'تشارم موجبة — هبوط التقلب يرفع التحوّط'
    : 'تشارم سالبة — الوقت يدعم حتى الإغلاق (تثبيت)';

  // ── Top Strikes (أقرب 20 للسعر) ──
  const topStrikes = [...strikes]
    .sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot))
    .slice(0,20)
    .sort((a,b)=>b.strike-a.strike);

  return {
    symbol, spot, dteMode,
    source: 'Polygon.io',
    // GEX
    totalCallGEX, totalPutGEX, totalNetGEX,
    gexRatio: totalPutGEX>0 ? (totalCallGEX/totalPutGEX).toFixed(2) : '—',
    // DEX
    totalNetDEX,
    dexRegime: vannaRegime,
    // Vanna
    totalNetVanna, vannaRegime,
    // Charm
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
    hvl, aboveHVL: spot>(hvl||0),
    // Expected Move
    expectedMove:    parseFloat(expectedMove.toFixed(2)),
    expectedMovePct,
    expectedMoveHigh: parseFloat((spot+expectedMove).toFixed(2)),
    expectedMoveLow:  parseFloat((spot-expectedMove).toFixed(2)),
    // Strikes
    strikes: topStrikes,
    contractCount: contracts.length,
    method: 'BSM_greeks',
    ts: Date.now(),
  };
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if (req.method==='OPTIONS') return res.status(200).end();

  const rawSym  = ((req.query.symbol||'SPY')+'').toUpperCase();
  const dteMode = ['0DTE','1DTE','5DTE','ALL'].includes(req.query.dte) ? req.query.dte : 'ALL';
  const mapped  = { 'US500':'SPY','NDX':'QQQ','DJI':'DIA' };
  const apiSym  = mapped[rawSym] || rawSym;

  if (!GEX_SYMBOLS[apiSym])
    return res.status(200).json({ ok:false, message:`${rawSym} غير مدعوم` });

  try {
    const cacheKey = `gex31_${apiSym}_${dteMode}`;
    if (req.query.force !== '1') {
      const cached = await kvGet(cacheKey);
      if (cached && (Date.now()-cached.ts) < 15*60*1000)
        return res.status(200).json({ ok:true, cached:true, data:cached });
    }
    const gexData = await calcGEX(apiSym, dteMode);
    await kvSet(cacheKey, gexData, 900);
    return res.status(200).json({ ok:true, cached:false, data:gexData });
  } catch(e) {
    return res.status(200).json({ ok:false, error:e.message });
  }
};
