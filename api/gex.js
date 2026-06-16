// ════════════════════════════════════════════════════════
// TIH gex.js v3 — GEX حقيقي من Yahoo Finance
// GEX = (Call OI × Call Gamma - Put OI × Put Gamma) × 100 × Spot
// ════════════════════════════════════════════════════════

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';

const GEX_SYMBOLS = {
  'SPY':'S&P 500 ETF','QQQ':'Nasdaq ETF',
  'NVDA':'NVIDIA','AAPL':'Apple','TSLA':'Tesla','AMD':'AMD','MSFT':'Microsoft',
};

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e){return null;}
}
async function kvSet(key,value,ex=900) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
  } catch(e){}
}

// ── الوقت بتوقيت السعودية ──
function nowKSA() {
  return new Date().toLocaleString('ar-SA',{
    timeZone:'Asia/Riyadh',
    weekday:'short',month:'short',day:'numeric',
    hour:'2-digit',minute:'2-digit'
  });
}

// ── جلب Options Chain من Yahoo Finance ──
async function fetchYahooChain(symbol, expiration) {
  try {
    let url = `https://query2.finance.yahoo.com/v7/finance/options/${symbol}`;
    if(expiration) url += `?date=${expiration}`;
    url += (expiration ? '&' : '?') + 'formatted=false&lang=en-US&region=US';

    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        'Accept': 'application/json',
      }
    });
    if(!r.ok) throw new Error(`Yahoo ${r.status}`);
    return r.json();
  } catch(e) {
    throw new Error(`Yahoo fetch failed: ${e.message}`);
  }
}

// ── حساب GEX الكامل ──
async function calcGEX(symbol) {
  try {
    // جلب أول expiration (الأقرب = 0DTE أو هذا الأسبوع)
    const data = await fetchYahooChain(symbol);
    const result = data?.optionChain?.result?.[0];
    if(!result) return null;

    const spot = result.quote?.regularMarketPrice || 0;
    if(!spot) return null;

    // كل انتهاءات الأسبوعين القادمين
    const expirations = (result.expirationDates || []).slice(0, 4); // أقرب 4 تواريخ
    const allContracts = [];

    // جلب كل الانتهاءات
    for(const exp of expirations) {
      try {
        const expData = await fetchYahooChain(symbol, exp);
        const expResult = expData?.optionChain?.result?.[0];
        if(!expResult?.options?.[0]) continue;

        const opts = expResult.options[0];
        const expDate = new Date(exp * 1000).toISOString().split('T')[0];

        (opts.calls || []).forEach(c => {
          allContracts.push({
            type: 'call',
            strike: c.strike,
            oi: c.openInterest || 0,
            gamma: c.impliedVolatility ? estimateGamma(c, spot, 'call') : 0,
            iv: c.impliedVolatility || 0,
            delta: c.delta || 0,
            exp: expDate,
          });
        });

        (opts.puts || []).forEach(p => {
          allContracts.push({
            type: 'put',
            strike: p.strike,
            oi: p.openInterest || 0,
            gamma: p.impliedVolatility ? estimateGamma(p, spot, 'put') : 0,
            iv: p.impliedVolatility || 0,
            delta: p.delta || 0,
            exp: expDate,
          });
        });
      } catch(e) { continue; }
    }

    if(!allContracts.length) return null;

    // تجميع GEX لكل Strike
    const gexMap = {};
    for(const c of allContracts) {
      const key = c.strike.toString();
      if(!gexMap[key]) {
        gexMap[key] = {strike:c.strike, callGEX:0, putGEX:0, callOI:0, putOI:0, netGEX:0, iv:0, ivCount:0};
      }
      const gexValue = c.oi * c.gamma * 100 * spot;
      if(c.type === 'call') {
        gexMap[key].callGEX += gexValue;
        gexMap[key].callOI  += c.oi;
      } else {
        gexMap[key].putGEX  += gexValue;
        gexMap[key].putOI   += c.oi;
      }
      if(c.iv > 0) { gexMap[key].iv += c.iv; gexMap[key].ivCount++; }
    }

    const strikes = Object.values(gexMap).map(s => {
      s.netGEX = s.callGEX - s.putGEX;
      s.avgIV  = s.ivCount > 0 ? (s.iv/s.ivCount*100).toFixed(1) : null;
      return s;
    }).sort((a,b) => a.strike - b.strike);

    if(!strikes.length) return null;

    const totalCallGEX = strikes.reduce((s,x)=>s+x.callGEX,0);
    const totalPutGEX  = strikes.reduce((s,x)=>s+x.putGEX,0);
    const totalNetGEX  = totalCallGEX - totalPutGEX;

    // Call Wall = أعلى Call GEX فوق السعر
    const callWall = strikes.filter(s=>s.strike>spot).sort((a,b)=>b.callGEX-a.callGEX)[0];
    // Put Wall  = أعلى Put GEX تحت السعر
    const putWall  = strikes.filter(s=>s.strike<spot).sort((a,b)=>b.putGEX-a.putGEX)[0];

    // HVL — Gamma Flip
    let hvl = null;
    for(let i=1; i<strikes.length; i++) {
      if(strikes[i-1].netGEX<0 && strikes[i].netGEX>=0) { hvl=strikes[i].strike; break; }
    }
    if(!hvl) hvl = strikes.reduce((p,c)=>Math.abs(c.netGEX)<Math.abs(p.netGEX)?c:p).strike;

    // Long/Short Gamma
    const isLongGamma  = totalNetGEX > 0;
    const gammaRegime  = isLongGamma ? 'LONG GAMMA' : 'SHORT GAMMA';
    const gammaRegimeAr= isLongGamma ? '🟢 Long Gamma — حركة محدودة ومستقرة' : '🔴 Short Gamma — تقلبات عالية';

    // GEX Ratio
    const gexRatio = totalPutGEX > 0 ? (totalCallGEX/totalPutGEX).toFixed(2) : '—';

    // أعلى 20 Strike
    const topStrikes = [...strikes]
      .sort((a,b)=>Math.abs(b.netGEX)-Math.abs(a.netGEX))
      .slice(0,20)
      .sort((a,b)=>b.strike-a.strike);

    return {
      symbol, spot,
      totalCallGEX, totalPutGEX, totalNetGEX,
      gexRatio, gammaRegime, gammaRegimeAr,
      isLongGamma,
      callWall: callWall?.strike||null,
      putWall:  putWall?.strike||null,
      hvl, aboveHVL: spot>(hvl||0),
      strikes: topStrikes,
      contractCount: allContracts.length,
      source: 'Yahoo Finance',
      method: 'real_gamma',
      ts: Date.now(),
    };

  } catch(e) {
    console.error(`GEX v3 error ${symbol}:`, e.message);
    return null;
  }
}

// ── تقدير Gamma من IV (Black-Scholes تقريبي) ──
function estimateGamma(contract, spot, type) {
  try {
    const S = spot;
    const K = contract.strike;
    const iv = contract.impliedVolatility || 0.3;
    const T = Math.max(0.001, (contract.expiration - Date.now()/1000) / (365*86400));
    const r = 0.05;

    const d1 = (Math.log(S/K) + (r + 0.5*iv*iv)*T) / (iv*Math.sqrt(T));
    const nd1 = Math.exp(-0.5*d1*d1) / Math.sqrt(2*Math.PI);
    const gamma = nd1 / (S * iv * Math.sqrt(T));

    return isNaN(gamma) || !isFinite(gamma) ? 0 : gamma;
  } catch(e) { return 0; }
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();

  const symbol = ((req.query.symbol||'SPY')).toUpperCase();
  const force  = req.query.force==='1';
  const mapped = {'US500':'SPY','NDX':'QQQ','SPX':'SPY','DJI':'DIA'};
  const apiSym = mapped[symbol]||symbol;

  if(!GEX_SYMBOLS[apiSym]) {
    return res.status(200).json({ok:false,message:`${symbol} غير مدعوم`});
  }

  try {
    const cacheKey = `gex3_${apiSym}`;
    if(!force) {
      const cached = await kvGet(cacheKey);
      if(cached && (Date.now()-cached.ts)<15*60*1000)
        return res.status(200).json({ok:true,cached:true,data:cached});
    }

    const gexData = await calcGEX(apiSym);
    if(!gexData) return res.status(200).json({ok:false,message:`لا توجد بيانات لـ ${symbol}`});

    await kvSet(cacheKey,gexData,900);
    return res.status(200).json({ok:true,cached:false,data:gexData});

  } catch(e) {
    return res.status(500).json({ok:false,error:e.message});
  }
};
