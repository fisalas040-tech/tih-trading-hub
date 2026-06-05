const https = require('https');

const BOT_TOKEN = '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ✅ قائمة أسهم محدودة — أعلى سيولة وأقوى علاقة بـ S&P500
const STOCKS = {
  'AAPL':  { yahoo: 'AAPL',  name: 'Apple',       tv: 'NASDAQ:AAPL'  },
  'MSFT':  { yahoo: 'MSFT',  name: 'Microsoft',   tv: 'NASDAQ:MSFT'  },
  'NVDA':  { yahoo: 'NVDA',  name: 'NVIDIA',      tv: 'NASDAQ:NVDA'  },
  'META':  { yahoo: 'META',  name: 'Meta',        tv: 'NASDAQ:META'  },
  'GOOGL': { yahoo: 'GOOGL', name: 'Google',      tv: 'NASDAQ:GOOGL' },
  'AMZN':  { yahoo: 'AMZN',  name: 'Amazon',      tv: 'NASDAQ:AMZN'  },
  'AMD':   { yahoo: 'AMD',   name: 'AMD',         tv: 'NASDAQ:AMD'   },
  'AVGO':  { yahoo: 'AVGO',  name: 'Broadcom',    tv: 'NASDAQ:AVGO'  },
  'JPM':   { yahoo: 'JPM',   name: 'JPMorgan',    tv: 'NYSE:JPM'     },
  'MRVL':  { yahoo: 'MRVL',  name: 'Marvell',     tv: 'NASDAQ:MRVL'  },
};
// ✅ حذف: TSLA (تقلب عالٍ)، SNOW/SMCI/INTC (سيولة أقل)، MU/SPY (مكررة)، NFLX

const TV_INTERVAL    = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };
const MIN_SIGNAL_GAP = 6 * 60 * 60 * 1000; // ✅ 6 ساعات بدل 4

const INTERVALS = {
  weekly: { interval: '1wk', range: '52wk' }, // ✅ Weekly trend
  trend:  { interval: '1d',  range: '180d' },
  entry:  { interval: '1h',  range: '30d'  },
  fast:   { interval: '15m', range: '5d'   },
};

const MIN_SCORE = 14; // ✅ رُفع من 9 إلى 14 للأسهم

let vixCache = { value: null, ts: 0 };

// ✅ NY AM Kill Zone فقط للأسهم (13:30-16:00 UTC = 16:30-19:00 KSA)
function isStockKillZone() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 810 && mins <= 960; // NY AM فقط
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 840 && mins <= 1290;
}

async function getVIX() {
  if (vixCache.value && (Date.now() - vixCache.ts) < 15 * 60 * 1000) return vixCache.value;
  try {
    const bars = await getBars('^VIX', '1d', '5d');
    if (bars && bars.price) { vixCache = { value: bars.price, ts: Date.now() }; return bars.price; }
  } catch(e) {}
  return null;
}

// ✅ Volume Confirmation مرفوعة للأسهم
function hasVolumeConfirmation(bars) {
  if (!bars.vols || bars.vols.length < 20) return true;
  const vols = bars.vols.filter(v => v > 0);
  if (vols.length < 10) return true;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  const lastVol = vols[vols.length-1];
  return lastVol >= avgVol * 1.1; // ✅ 1.1x للأسهم (أصعب)
}

// ✅ Liquidity Sweep
function hasLiquiditySweep(bars, signal) {
  if (!bars || bars.highs.length < 5) return true;
  const prevHigh = Math.max(...bars.highs.slice(-6, -1));
  const prevLow  = Math.min(...bars.lows.slice(-6, -1));
  if (signal === 'CALL') {
    const recentLow = Math.min(...bars.lows.slice(-3));
    return recentLow < prevLow * 0.999;
  } else {
    const recentHigh = Math.max(...bars.highs.slice(-3));
    return recentHigh > prevHigh * 1.001;
  }
}

// ✅ Weekly Trend
function analyzeWeeklyTrend(weekBars) {
  if (!weekBars || weekBars.closes.length < 5) return 'neutral';
  const closes = weekBars.closes;
  const e8  = ema(closes, 8);
  const e21 = ema(closes, 21);
  const price = weekBars.price;
  if (!e8 || !e21) return 'neutral';
  if (price > e8 && e8 > e21) return 'bull';
  if (price < e8 && e8 < e21) return 'bear';
  return 'neutral';
}

async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, val, ex=86400) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}?ex=${ex}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}
async function kvDel(key) {
  try {
    await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}

async function saveLog(entry) {
  try {
    const log = (await kvGet('stk_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 200) log.splice(200);
    await kvSet('stk_log', log, 90*86400);
  } catch(e) {}
}

function tg(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function fetchYahoo(sym, interval, range) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getBars(sym, interval, range) {
  try {
    const json = await fetchYahoo(sym, interval, range);
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    const q = r.indicators.quote[0];
    const vi = q.close.map((v,i) => v!==null?i:-1).filter(i=>i>=0);
    if (vi.length < 10) return null;
    return {
      closes: vi.map(i => q.close[i]),
      highs:  vi.map(i => q.high[i]),
      lows:   vi.map(i => q.low[i]),
      vols:   vi.map(i => q.volume?.[i]||0),
      price:  r.meta.regularMarketPrice || q.close[vi[vi.length-1]],
      ts:     r.timestamp?.[vi[vi.length-1]] || Date.now()/1000
    };
  } catch(e) { return null; }
}

function ema(p, n) {
  if (p.length < n) return null;
  const k = 2/(n+1);
  let e = p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i=n; i<p.length; i++) e = p[i]*k + e*(1-k);
  return e;
}
function rsi(p, n=14) {
  if (p.length < n+1) return null;
  let g=0, l=0;
  for (let i=1; i<=n; i++) { const d=p[i]-p[i-1]; d>0?g+=d:l-=d; }
  let ag=g/n, al=l/n;
  for (let i=n+1; i<p.length; i++) {
    const d=p[i]-p[i-1];
    d>0?(ag=(ag*(n-1)+d)/n,al=al*(n-1)/n):(ag=ag*(n-1)/n,al=(al*(n-1)-d)/n);
  }
  return al===0?100:100-(100/(1+ag/al));
}
function atr(h, l, c, n=14) {
  if (c.length < n+1) return null;
  const tr = [];
  for (let i=1; i<c.length; i++)
    tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return tr.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function macd(p) {
  const e12=ema(p,12), e26=ema(p,26);
  if (!e12||!e26) return null;
  return { val: e12-e26, bull: e12>e26 };
}
function bb(p, n=20) {
  if (p.length<n) return null;
  const s=p.slice(-n), m=s.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/n);
  return { upper:m+2*sd, mid:m, lower:m-2*sd };
}
function getPDHL(closes, highs, lows) {
  if (closes.length < 2) return { pdh: null, pdl: null };
  return { pdh: highs[highs.length-2], pdl: lows[lows.length-2] };
}
function calcFibExtensions(closes, highs, lows, signal) {
  const lookback = Math.min(closes.length, 50);
  const swingHigh = Math.max(...highs.slice(-lookback));
  const swingLow  = Math.min(...lows.slice(-lookback));
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  if (signal === 'CALL') {
    return { fib1272:swingLow+range*1.272, fib1618:swingLow+range*1.618, fib2000:swingLow+range*2.000, fib2618:swingLow+range*2.618 };
  } else {
    return { fib1272:swingHigh-range*1.272, fib1618:swingHigh-range*1.618, fib2000:swingHigh-range*2.000, fib2618:swingHigh-range*2.618 };
  }
}

function analyzeFrame(bars, minScore=MIN_SCORE) {
  const { closes, highs, lows, price } = bars;
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50);
  const r=rsi(closes), m=macd(closes), b=bb(closes);
  const a=atr(highs,lows,closes,14);
  if (!e9||!e21||!r||!a) return null;
  let bull=0, bear=0;
  const reasons=[];
  if(price>e9&&e9>e21){bull+=3;reasons.push('EMA↑');}
  else if(price<e9&&e9<e21){bear+=3;reasons.push('EMA↓');}
  if(e50){if(price>e50){bull+=2;reasons.push('فوق EMA50');}else{bear+=2;reasons.push('تحت EMA50');}}
  // ✅ RSI فلتر صارم للأسهم
  if(r>58&&r<70){bull+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<42&&r>30){bear+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<=30){bull+=3;reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`);}
  else if(r>=70){bear+=2;reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`);}
  if(m?.bull){bull+=2;reasons.push('MACD↑');}else if(m){bear+=2;reasons.push('MACD↓');}
  if(b){
    if(price<=b.lower){bull+=3;reasons.push('BB دعم');}
    else if(price>=b.upper){bear+=3;reasons.push('BB مقاومة');}
    else if(price>b.mid)bull+=1;
    else bear+=1;
  }
  const prev=closes[closes.length-2]||price, chg=((price-prev)/prev)*100;
  if(chg>0.5){bull+=2;reasons.push(`زخم +${chg.toFixed(1)}%`);}
  else if(chg>0.2)bull+=1;
  else if(chg<-0.5){bear+=2;reasons.push(`زخم ${chg.toFixed(1)}%`);}
  else if(chg<-0.2)bear+=1;
  const signal=bull>=minScore?'CALL':bear>=minScore?'PUT':null;
  const trend=bull>bear?'bull':bear>bull?'bear':'neutral';
  const { pdh, pdl } = getPDHL(closes, highs, lows);
  return {
    signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg,
    levels: { e21, e50, bbMid:b?.mid||null, bbUpper:b?.upper||null, bbLower:b?.lower||null, pdh, pdl }
  };
}

function calcTargets(signal, price, atrVal, levels) {
  const d = signal==='CALL'?1:-1;
  const slDist = atrVal * 1.5;
  const sl = +(price - d*slDist).toFixed(2);
  const risk = Math.abs(price - sl);
  const minT1 = price + d*risk*2.0;
  const minT2 = price + d*risk*3.5;
  const minT3 = price + d*risk*6.0;

  let t1Candidates=[];
  if(levels){
    const {e21,e50,bbMid,bbUpper,bbLower,pdh,pdl,fib}=levels;
    if(signal==='CALL'){
      if(bbMid&&bbMid>price)t1Candidates.push({val:bbMid,label:'BB Mid'});
      if(pdh&&pdh>price)t1Candidates.push({val:pdh,label:'PDH'});
      if(e21&&e21>price)t1Candidates.push({val:e21,label:'EMA21'});
      if(e50&&e50>price)t1Candidates.push({val:e50,label:'EMA50'});
      if(bbUpper&&bbUpper>price)t1Candidates.push({val:bbUpper,label:'BB Upper'});
      if(fib?.fib1272&&fib.fib1272>price)t1Candidates.push({val:fib.fib1272,label:'Fib 1.272'});
    } else {
      if(bbMid&&bbMid<price)t1Candidates.push({val:bbMid,label:'BB Mid'});
      if(pdl&&pdl<price)t1Candidates.push({val:pdl,label:'PDL'});
      if(e21&&e21<price)t1Candidates.push({val:e21,label:'EMA21'});
      if(e50&&e50<price)t1Candidates.push({val:e50,label:'EMA50'});
      if(bbLower&&bbLower<price)t1Candidates.push({val:bbLower,label:'BB Lower'});
      if(fib?.fib1272&&fib.fib1272<price)t1Candidates.push({val:fib.fib1272,label:'Fib 1.272'});
    }
    t1Candidates.sort((a,b)=>signal==='CALL'?a.val-b.val:b.val-a.val);
  }

  let t1=minT1, t1Label='1:2 R';
  for(const c of t1Candidates){
    if(Math.abs(c.val-price)/risk>=2.0){t1=c.val;t1Label=c.label;break;}
  }
  t1=+t1.toFixed(2);

  let t2=minT2, t2Label='1:3.5 R';
  if(levels){
    const {bbUpper,bbLower,e50,fib,pdh,pdl}=levels;
    const t2C=[];
    if(signal==='CALL'){
      if(bbUpper&&bbUpper>t1)t2C.push({val:bbUpper,label:'BB Upper'});
      if(e50&&e50>t1)t2C.push({val:e50,label:'EMA50'});
      if(pdh&&pdh>t1)t2C.push({val:pdh,label:'PDH'});
      if(fib?.fib1618&&fib.fib1618>t1)t2C.push({val:fib.fib1618,label:'Fib 1.618'});
    } else {
      if(bbLower&&bbLower<t1)t2C.push({val:bbLower,label:'BB Lower'});
      if(e50&&e50<t1)t2C.push({val:e50,label:'EMA50'});
      if(pdl&&pdl<t1)t2C.push({val:pdl,label:'PDL'});
      if(fib?.fib1618&&fib.fib1618<t1)t2C.push({val:fib.fib1618,label:'Fib 1.618'});
    }
    t2C.sort((a,b)=>signal==='CALL'?a.val-b.val:b.val-a.val);
    for(const c of t2C){if(Math.abs(c.val-price)/risk>=3.5){t2=c.val;t2Label=c.label;break;}}
  }
  t2=+t2.toFixed(2);

  let t3=minT3, t3Label='1:6 R';
  if(levels?.fib){
    const {fib2000,fib2618}=levels.fib;
    const t3Fib=signal==='CALL'?(fib2000&&fib2000>t2?fib2000:fib2618):(fib2000&&fib2000<t2?fib2000:fib2618);
    if(t3Fib&&Math.abs(t3Fib-price)/risk>=5.0){t3=t3Fib;t3Label='Fib 2.0';}
    if(fib2618&&Math.abs(fib2618-price)/risk>=6.0&&Math.abs(fib2618-price)>Math.abs(t3-price)){t3=fib2618;t3Label='Fib 2.618';}
  }
  t3=+t3.toFixed(2);

  const t3Pct=Math.abs(t3-price)/price*100;
  const t1Pct=Math.abs(t1-price)/price*100;
  let expiry,expiryDays;
  if(t3Pct>=5){expiry='3-4 أسابيع';expiryDays=28;}
  else if(t3Pct>=3){expiry='2-3 أسابيع';expiryDays=21;}
  else{expiry='1-2 أسبوع';expiryDays=14;}

  let thetaWarning=null;
  if(t1Pct<2.0)thetaWarning=`⚠️ Theta: T1 (${t1Pct.toFixed(1)}%) قريب — Delta ≥ 0.50`;
  else if(t1Pct<3.0)thetaWarning=`⚡ Theta: Delta 0.40-0.50 على الأقل`;

  return {
    sl,t1,t2,t3,t1Label,t2Label,t3Label,
    slPct:((sl-price)/price*100).toFixed(2),
    t1Pct:t1Pct.toFixed(2),
    rr1:(Math.abs(t1-price)/risk).toFixed(2),
    rr2:(Math.abs(t2-price)/risk).toFixed(2),
    rr3:(Math.abs(t3-price)/risk).toFixed(2),
    expiry,expiryDays,thetaWarning,
  };
}

async function analyzeMTF(sym, vix) {
  if (!isMarketOpen()) return null;
  if (!isStockKillZone()) return null; // ✅ NY AM فقط للأسهم

  const vixLevel = vix || 0;
  if (vixLevel > 35) return null;

  const cfg = STOCKS[sym];
  const [weekBars, trendBars, entryBars, fastBars] = await Promise.all([
    getBars(cfg.yahoo, INTERVALS.weekly.interval, INTERVALS.weekly.range),
    getBars(cfg.yahoo, INTERVALS.trend.interval, INTERVALS.trend.range),
    getBars(cfg.yahoo, INTERVALS.entry.interval, INTERVALS.entry.range),
    getBars(cfg.yahoo, INTERVALS.fast.interval,  INTERVALS.fast.range),
  ]);

  if (!trendBars) return null;
  if (entryBars && !hasVolumeConfirmation(entryBars)) return null;

  // ✅ Weekly Trend — إلزامي للأسهم
  const weeklyTrend = weekBars ? analyzeWeeklyTrend(weekBars) : 'neutral';

  const trendResult = analyzeFrame(trendBars);
  const entryResult = entryBars ? analyzeFrame(entryBars) : null;
  const fastResult  = fastBars  ? analyzeFrame(fastBars)  : null;

  if (!trendResult) return null;

  const dominantTrend = trendResult.trend;
  if (dominantTrend === 'neutral') return null;

  // ✅ Weekly Trend يجب أن يتوافق مع الاتجاه
  if (weeklyTrend !== 'neutral' && weeklyTrend !== dominantTrend) return null;

  const requiredSignal = dominantTrend==='bull'?'CALL':'PUT';

  // ✅ RSI extremes filter
  if (requiredSignal==='CALL' && trendResult.rsi > 72) return null;
  if (requiredSignal==='PUT'  && trendResult.rsi < 28) return null;

  let entryFrame=null, entryData=null;
  if(fastResult?.signal===requiredSignal){entryFrame='15M';entryData=fastResult;}
  else if(entryResult?.signal===requiredSignal){entryFrame='1H';entryData=entryResult;}
  else if(trendResult.signal===requiredSignal){entryFrame='1D';entryData=trendResult;}

  if (!entryFrame||!entryData) return null;

  // ✅ Liquidity Sweep على الـ 1H
  if (entryBars && !hasLiquiditySweep(entryBars, requiredSignal)) return null;

  const agreements = [
    trendResult.trend===dominantTrend,
    entryResult?.trend===dominantTrend,
    fastResult?.trend===dominantTrend,
    weeklyTrend===dominantTrend,
  ].filter(Boolean).length;

  const entryScore = entryData?(dominantTrend==='bull'?entryData.bull:entryData.bear):0;
  const trendScore2 = dominantTrend==='bull'?trendResult.bull:trendResult.bear;
  const combinedScore = Math.round((entryScore+trendScore2)/2);

  // ✅ Grade S و A فقط
  let grade,gradeLabel,successRate;
  if(agreements>=3&&combinedScore>=13){
    grade='S';gradeLabel='🔥 نسبة نجاح عالية جداً';successRate=85;
  } else if(agreements>=3||(agreements>=2&&combinedScore>=11)){
    grade='A';gradeLabel='✅ نسبة نجاح عالية';successRate=72;
  } else {
    return null; // ✅ لا B أو C
  }

  if(vixLevel>=25&&vixLevel<=35&&grade!=='S') return null;

  const trendLevels = trendResult.levels || {};
  const fib = calcFibExtensions(trendBars.closes, trendBars.highs, trendBars.lows, requiredSignal);
  const combinedLevels = { ...trendLevels, fib };

  return {
    sym, signal:requiredSignal, dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price:entryData.price||trendBars.price, atr:entryData.atr,
    trendRSI:trendResult.rsi?.toFixed(1), entryRSI:entryData.rsi?.toFixed(1),
    weeklyTrend,
    trendReasons:trendResult.reasons, entryReasons:entryData.reasons,
    agreements, totalFrames:4,
    trendScore:dominantTrend==='bull'?trendResult.bull:trendResult.bear,
    levels:combinedLevels,
  };
}

async function checkActiveSignals() {
  const active=(await kvGet('stk_active'))||{};
  const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0.0};
  let changed=false, notifs=0;
  for (const [id,sig] of Object.entries(active)) {
    try {
      const cfg=STOCKS[sig.sym];
      if(!cfg){delete active[id];changed=true;continue;}
      const bars=await getBars(cfg.yahoo,'1m','1d');
      const price=bars?.price;
      if(!price)continue;
      const isCall=sig.signal==='CALL';
      if((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)){
        delete active[id]; perf.losses++; perf.totalR-=1; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'SL',r:-1,type:'stock'});
        await tg(`🛑 <b>Stop Loss!</b>\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n💰 $${price.toFixed(2)}\n🛡️ SL: $${sig.sl}\n📊 -1R | WR: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n🤖 <i>TIH Stocks v5.0</i>`);
        notifs++; continue;
      }
      if(!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))){
        sig.t1Hit=true; sig.sl=sig.entry; perf.wins++; perf.totalR+=2; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T1',r:2,type:'stock'});
        await tg(`🎯 <b>T1 تحقق! +2R</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → BE\n🤖 <i>TIH Stocks v5.0</i>`);
        notifs++;
      }
      if(sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))){
        sig.t2Hit=true; perf.totalR+=1; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T2',r:3,type:'stock'});
        await tg(`🎯🎯 <b>T2 تحقق! +3R 🔥</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Stocks v5.0</i>`);
        notifs++;
      }
      if(sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))){
        delete active[id]; perf.totalR+=1; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T3',r:4,type:'stock'});
        await tg(`🏆🏆🏆 <b>T3 تحقق! +4R 💎</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n🤖 <i>TIH Stocks v5.0</i>`);
        notifs++; continue;
      }
      const expiryDays=sig.expiryDays||21;
      const age=Date.now()-(sig.openedAt||0);
      if(age>expiryDays*24*60*60*1000&&!sig.t1Hit){
        delete active[id]; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'EXP',r:0,type:'stock'});
        await tg(`⏰ <b>انتهت الإشارة</b>\n📌 <b>${sig.sym}</b> — ${expiryDays}ي بدون T1\n🤖 <i>TIH Stocks v5.0</i>`);
        notifs++; continue;
      }
      active[id]=sig;
    } catch(e){}
  }
  if(changed){
    await kvSet('stk_active',active,7*86400);
    await kvSet('stk_perf',perf,365*86400);
  }
  return notifs;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  if (action==='test') {
    const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('stk_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const kz=isStockKillZone();
    await tg(
      `🤖 <b>TIH Stocks v5.0</b>\n━━━━━━━━━━━━━━━\n✅ النظام يعمل!\n\n` +
      `📊 ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n━━━━━━━━━━━━━━━\n` +
      `✅ Kill Zone NY AM: ${kz?'🟢 نشط':'🔴 خارج النافذة'}\n` +
      `✅ شرط الإشارة: ${MIN_SCORE} نقطة\n` +
      `✅ Weekly Trend: إلزامي\n✅ Liquidity Sweep: مفعّل\n` +
      `✅ Grade S+A فقط\n✅ أسهم: 10 (أعلى سيولة)\n` +
      `🤖 <i>TIH Stocks v5.0</i>`
    );
    return res.status(200).json({ok:true,killZone:kz});
  }

  if(action==='reset'){await kvDel('stk_active');return res.status(200).json({ok:true});}

  if(action==='cleanup'){
    const active=(await kvGet('stk_active'))||{};
    const latest={};
    for(const [id,sig] of Object.entries(active)){
      if(!latest[sig.sym]||sig.openedAt>latest[sig.sym].openedAt) latest[sig.sym]={id,...sig};
    }
    const newActive={};
    for(const [sym,sig] of Object.entries(latest)){const{id,...data}=sig;newActive[id]=data;}
    await kvSet('stk_active',newActive,7*86400);
    return res.status(200).json({ok:true,remaining:Object.keys(newActive).length});
  }

  if(action==='active'){
    const active=(await kvGet('stk_active'))||{};
    const sigs=Object.values(active).map(s=>({
      sym:s.sym,signal:s.signal,grade:s.grade,
      entry:s.entry,sl:s.sl,t1:s.t1,t2:s.t2,t3:s.t3,
      t1Hit:s.t1Hit,t2Hit:s.t2Hit,openedAt:s.openedAt,
    }));
    return res.status(200).json({ok:true,signals:sigs,count:sigs.length});
  }

  if(action==='log'){const log=(await kvGet('stk_log'))||[];return res.status(200).json({ok:true,log,count:log.length});}

  if(action==='stats'){
    const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('stk_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    await tg(`📊 <b>أداء الأسهم v5.0</b>\n${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 WR: <b>${wr}%</b>\n💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n📌 نشطة: ${Object.keys(active).length}\n🤖 TIH Stocks v5.0`);
    return res.status(200).json({ok:true,perf,active:Object.keys(active).length});
  }

  if(!isMarketOpen()) return res.status(200).json({ok:true,message:'السوق مغلق',checked:0,newAlerts:0});

  const symbols=req.query.symbols
    ?req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>STOCKS[s])
    :Object.keys(STOCKS);

  const perfNotifs=await checkActiveSignals();
  const newAlerts=[],errors=[];
  const vix=await getVIX();

  if(vix&&vix>25){
    const lastVixAlert=await kvGet('stk_vix_alert');
    const today=new Date().toISOString().split('T')[0];
    if(lastVixAlert!==today){
      await kvSet('stk_vix_alert',today,86400);
      await tg(vix>35
        ?`⚠️ <b>VIX شديد!</b> ${vix.toFixed(1)} — إيقاف كامل\n🤖 TIH Stocks v5.0`
        :`⚠️ <b>VIX مرتفع</b> ${vix.toFixed(1)} — Grade S فقط\n🤖 TIH Stocks v5.0`);
    }
  }

  await Promise.all(symbols.map(async (sym) => {
    try {
      const result=await analyzeMTF(sym,vix);
      if(!result)return;
      const active=(await kvGet('stk_active'))||{};
      if(Object.values(active).some(s=>s.sym===sym))return;
      const lastSignalTime=await kvGet(`stk_last_${sym}`);
      if(lastSignalTime&&(Date.now()-lastSignalTime)<MIN_SIGNAL_GAP)return;
      const targets=calcTargets(result.signal,result.price,result.atr,result.levels);
      const sigId=`${sym}_${Date.now()}`;
      active[sigId]={
        sym,signal:result.signal,entry:result.price,sl:targets.sl,
        t1:targets.t1,t2:targets.t2,t3:targets.t3,
        t1Hit:false,t2Hit:false,t3Hit:false,
        grade:result.grade,openedAt:Date.now(),expiryDays:targets.expiryDays,
      };
      const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
      perf.total++;
      await kvSet('stk_active',active,7*86400);
      await kvSet('stk_perf',perf,365*86400);
      await kvSet(`stk_last_${sym}`,Date.now(),6*3600);
      newAlerts.push({sym,signal:result.signal,grade:result.grade});

      const emoji=result.signal==='CALL'?'🟢':'🔴';
      const sigType=result.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const now=new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});
      const thetaLine=targets.thetaWarning?`${targets.thetaWarning}\n`:'';
      const weekLine=result.weeklyTrend!=='neutral'?`📅 Trend الأسبوعي: ${result.weeklyTrend==='bull'?'🟢 صاعد':'🔴 هابط'}\n`:'';

      await tg(
        `${emoji} <b>${sigType}</b>\n${result.gradeLabel} — <b>${result.successRate}%</b>\n━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — ${STOCKS[sym].name}\n💰 $${result.price.toFixed(2)}\n` +
        `${weekLine}📊 RSI(1D): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}\n` +
        `🔀 التوافق: ${result.agreements}/${result.totalFrames} فريم | Kill Zone ✅\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 Entry: $${result.price.toFixed(2)}\n🛡️ SL: $${targets.sl} (${targets.slPct}%)\n` +
        `🏆 T1 [${targets.t1Label}]: $${targets.t1} (+${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🏆 T2 [${targets.t2Label}]: $${targets.t2} | 1:${targets.rr2}\n` +
        `🏆 T3 [${targets.t3Label}]: $${targets.t3} | 1:${targets.rr3}\n` +
        `━━━━━━━━━━━━━━━\n📅 انتهاء الأوبشن: <b>${targets.expiry}</b>\n` +
        `${thetaLine}📐 ATR: ${result.atr.toFixed(3)}\n⏰ ${now}\n` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(STOCKS[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">الشارت ↗</a>\n` +
        `🤖 <i>TIH Stocks v5.0</i>`
      );
    } catch(e){errors.push(`${sym}: ${e.message}`);}
  }));

  const active=(await kvGet('stk_active'))||{};
  return res.status(200).json({
    ok:true,checked:symbols.length,
    newAlerts:newAlerts.length,perfNotifs,
    active:Object.keys(active).length,
    signals:newAlerts,errors,
    vix:vix?+vix.toFixed(1):null,
    killZone:isStockKillZone()
  });
};
