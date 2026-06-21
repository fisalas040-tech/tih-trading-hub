const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';
const MASSIVE_KEY   = process.env.MASSIVE_API_KEY          || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const MASSIVE_BASE  = 'api.polygon.io';

const GEX_SYMBOLS = { 'SPY':'S&P 500 ETF','QQQ':'Nasdaq ETF','NVDA':'NVIDIA','AAPL':'Apple','TSLA':'Tesla','AMD':'AMD','MSFT':'Microsoft' };

async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, { headers:{ Authorization:`Bearer ${UPSTASH_TOKEN}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, value, ex=900) {
  try { await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`, { headers:{ Authorization:`Bearer ${UPSTASH_TOKEN}` } }); } catch(e) {}
}

async function poly(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://${MASSIVE_BASE}${path}${sep}apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url, { headers:{ 'User-Agent':'TIH/2.0' } });
  if (!r.ok) throw new Error(`Polygon ${r.status}: ${path.split('?')[0]}`);
  return r.json();
}

// جلب options snapshot — يعيد {contracts, spot}
async function fetchOptionsAndSpot(symbol) {
  const today = new Date().toISOString().split('T')[0];
  const in60d = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];
  const data  = await poly(`/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in60d}&limit=250`);
  const contracts = data.results || [];

  // محاولة استخراج السعر من underlying_asset
  let spot = 0;
  if (contracts.length > 0) {
    spot = contracts[0]?.underlying_asset?.price || 0;
  }

  // fallback: آخر إغلاق من aggs
  if (!spot) {
    try {
      const agg = await poly(`/v2/aggs/ticker/${symbol}/prev?adjusted=true`);
      spot = agg.results?.[0]?.c || 0;
    } catch(e) { spot = 0; }
  }

  return { contracts, spot };
}

function estimateGamma(S, K, iv, expMs) {
  try {
    const T   = Math.max(0.001, (expMs - Date.now()) / (365*86400000));
    const d1  = (Math.log(S/K) + (0.05 + 0.5*iv*iv)*T) / (iv*Math.sqrt(T));
    const nd1 = Math.exp(-0.5*d1*d1) / Math.sqrt(2*Math.PI);
    const g   = nd1 / (S*iv*Math.sqrt(T));
    return (isNaN(g) || !isFinite(g)) ? 0 : g;
  } catch(e) { return 0; }
}

async function calcGEX(symbol) {
  const { contracts, spot } = await fetchOptionsAndSpot(symbol);
  if (!contracts.length) throw new Error(`Polygon: لا توجد بيانات options لـ ${symbol}`);
  if (!spot)             throw new Error(`تعذّر الحصول على سعر ${symbol}`);

  const gexMap = {};
  for (const c of contracts) {
    const det = c.details || {};
    const type = det.contract_type, strike = det.strike_price, expStr = det.expiration_date;
    if (!type || !strike || !expStr) continue;
    const oi     = c.open_interest || 0;
    const iv     = c.implied_volatility || 0.3;
    const expMs  = new Date(expStr + 'T21:00:00Z').getTime();
    const gexVal = oi * estimateGamma(spot, strike, iv, expMs) * 100 * spot;
    const key    = strike.toString();
    if (!gexMap[key]) gexMap[key] = { strike, callGEX:0, putGEX:0, callOI:0, putOI:0 };
    if (type === 'call') { gexMap[key].callGEX += gexVal; gexMap[key].callOI += oi; }
    else                 { gexMap[key].putGEX  += gexVal; gexMap[key].putOI  += oi; }
  }

  const strikes = Object.values(gexMap)
    .map(s => ({ ...s, netGEX: s.callGEX - s.putGEX }))
    .sort((a,b) => a.strike - b.strike);
  if (!strikes.length) throw new Error('لا توجد strikes صالحة');

  const totalCallGEX = strikes.reduce((s,x) => s+x.callGEX, 0);
  const totalPutGEX  = strikes.reduce((s,x) => s+x.putGEX,  0);
  const totalNetGEX  = totalCallGEX - totalPutGEX;
  const callWall     = [...strikes].filter(s=>s.strike>spot).sort((a,b)=>b.callGEX-a.callGEX)[0];
  const putWall      = [...strikes].filter(s=>s.strike<spot).sort((a,b)=>b.putGEX-a.putGEX)[0];

  let hvl = null;
  for (let j=1;j<strikes.length;j++) {
    if (strikes[j-1].netGEX<0 && strikes[j].netGEX>=0){ hvl=strikes[j].strike; break; }
  }
  if (!hvl) hvl = strikes.reduce((p,c)=>Math.abs(c.netGEX)<Math.abs(p.netGEX)?c:p).strike;

  const isLongGamma = totalNetGEX > 0;
  const topStrikes  = [...strikes].sort((a,b)=>Math.abs(b.netGEX)-Math.abs(a.netGEX)).slice(0,20).sort((a,b)=>b.strike-a.strike);

  return {
    symbol, spot, totalCallGEX, totalPutGEX, totalNetGEX,
    gexRatio:     totalPutGEX>0 ? (totalCallGEX/totalPutGEX).toFixed(2) : '—',
    gammaRegime:  isLongGamma ? 'LONG GAMMA' : 'SHORT GAMMA',
    gammaRegimeAr:isLongGamma ? '🟢 Long Gamma — حركة محدودة ومستقرة' : '🔴 Short Gamma — تقلبات عالية',
    isLongGamma,
    callWall: callWall?.strike || null,
    putWall:  putWall?.strike  || null,
    hvl, aboveHVL: spot > (hvl||0),
    strikes:  topStrikes,
    contractCount: contracts.length,
    source: 'Polygon.io', method: 'estimated_gamma', ts: Date.now(),
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if (req.method==='OPTIONS') return res.status(200).end();

  const rawSym = ((req.query.symbol||'SPY')+'').toUpperCase();
  const mapped = {'US500':'SPY','NDX':'QQQ','SPX':'SPY','DJI':'DIA'};
  const apiSym = mapped[rawSym] || rawSym;

  if (!GEX_SYMBOLS[apiSym])
    return res.status(200).json({ok:false, message:`${rawSym} غير مدعوم`});

  try {
    const cacheKey = `gex5_${apiSym}`;
    if (req.query.force !== '1') {
      const cached = await kvGet(cacheKey);
      if (cached && (Date.now()-cached.ts) < 15*60*1000)
        return res.status(200).json({ok:true, cached:true, data:cached});
    }
    const gexData = await calcGEX(apiSym);
    await kvSet(cacheKey, gexData, 900);
    return res.status(200).json({ok:true, cached:false, data:gexData});
  } catch(e) {
    return res.status(200).json({ok:false, error:e.message});
  }
};