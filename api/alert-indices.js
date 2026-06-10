const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';
const TWELVE_KEY    = process.env.TWELVE_DATA_API_KEY      || '8a2a10389f45439fa4bb70ab582f3f58';
const TWELVE_BASE   = 'api.twelvedata.com';
const MASSIVE_KEY   = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const MASSIVE_BASE  = 'api.polygon.io';

const INDICES = {
  'US500': { symbol: 'SPY',     name: 'S&P 500',      tv: 'OANDA:SPX500USD' },
  'NDX':   { symbol: 'QQQ',     name: 'Nasdaq 100',   tv: 'NASDAQ:NDX'      },
  'DJI':   { symbol: 'DIA',     name: 'Dow Jones',    tv: 'DJ:DJI'          },
  'XAUUSD':{ symbol: 'GLD',     name: 'Gold',         tv: 'OANDA:XAUUSD'    },
};

const CRYPTO_SYMS = new Set([]);
const TV_INTERVAL = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };

const INTERVALS = {
  weekly: { interval: '1wk', range: '52wk' },
  trend:  { interval: '1h',  range: '30d'  },
  entry:  { interval: '15m', range: '5d'   },
  fast:   { interval: '5m',  range: '2d'   },
};

const ATR_MULT = { sl: 1.5, t1: 2.0, t2: 3.5, t3: 5.0 };
const MIN_SCORE = 12;

let vixCache = { value: null, ts: 0 };

function toTwelveInterval(interval) {
  const map = { '1wk':'1week', '1d':'1day', '1h':'1h', '15m':'15min', '5m':'5min', '1m':'1min' };
  return map[interval] || '1day';
}

function rangeToOutputSize(range) {
  const map = { '52wk':52, '180d':180, '30d':500, '5d':480, '2d':576, '1d':390 };
  return map[range] || 100;
}


// ══════════════════════════════════════
// ✅ Options Flow من Massive API
// ══════════════════════════════════════
async function fetchOptionsFlow(symbol) {
  try {
    const mapped = symbol === 'US500' ? 'SPY' :
                   symbol === 'NDX'   ? 'QQQ' :
                   symbol === 'DJI'   ? 'DIA' : symbol;
    const today = new Date().toISOString().split('T')[0];
    const in30d = new Date(Date.now() + 30*86400000).toISOString().split('T')[0];
    const sep = '?';
    const url = `https://${MASSIVE_BASE}/v3/snapshot/options/${mapped}${sep}expiration_date.gte=${today}&expiration_date.lte=${in30d}&limit=150&apiKey=${MASSIVE_KEY}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'TIH/2.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const results = data.results || [];
    if (!results.length) return null;
    const calls = results.filter(c => c.details?.contract_type === 'call');
    const puts  = results.filter(c => c.details?.contract_type === 'put');
    const callCount = calls.length, putCount = puts.length;
    const total = callCount + putCount;
    if (!total) return null;
    const pcRatio = callCount > 0 ? putCount / callCount : 999;
    const callPct = Math.round(callCount / total * 100);
    let flowSignal = 'WAIT';
    if (pcRatio < 0.6) flowSignal = 'CALL';
    else if (pcRatio > 1.3) flowSignal = 'PUT';
    return { symbol: mapped, pcRatio: +pcRatio.toFixed(2), callPct, putPct: 100-callPct, flowSignal, callCount, putCount };
  } catch(e) { return null; }
}

async function getBars(sym, interval, range) {
  const symbol = sym === '^VIX' ? 'VIXY' : (INDICES[sym]?.symbol || sym);
  const tdInterval = toTwelveInterval(interval);
  const outputsize = rangeToOutputSize(range);

  return new Promise((resolve) => {
    const path = `/time_series?symbol=${encodeURIComponent(symbol)}&interval=${tdInterval}&outputsize=${outputsize}&order=ASC&apikey=${TWELVE_KEY}`;
    https.get({
      hostname: TWELVE_BASE,
      path,
      headers: { 'User-Agent': 'TIH/1.0', 'Accept': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          if (json.status === 'error' || !json.values || json.values.length < 5) { resolve(null); return; }
          const results = json.values;
          const closes = results.map(r => parseFloat(r.close));
          const highs  = results.map(r => parseFloat(r.high));
          const lows   = results.map(r => parseFloat(r.low));
          const vols   = results.map(r => parseFloat(r.volume || 0));
          resolve({
            closes, highs, lows, vols,
            price: closes[closes.length - 1],
            ts: new Date(results[results.length - 1].datetime).getTime() / 1000
          });
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ══════════════════════════════════════
// ✅ جلسات التداول — دقة أعلى
// ══════════════════════════════════════
function getTradingSession() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return { name: 'عطلة', code: 'weekend', minGrade: null };
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins >= 0   && mins < 420)  return { name: '🌏 آسيا',             code: 'asia',        minGrade: 'S' };
  if (mins >= 420 && mins < 480)  return { name: '🇬🇧 لندن (فتح)',      code: 'london_open', minGrade: 'A' };
  if (mins >= 480 && mins < 810)  return { name: '🇬🇧 لندن',            code: 'london',      minGrade: 'A' };
  if (mins >= 810 && mins < 960)  return { name: '🔥 Overlap NY+London', code: 'overlap',     minGrade: 'A' };
  if (mins >= 960 && mins < 1140) return { name: '🇺🇸 نيويورك',          code: 'ny_mid',      minGrade: 'A' };
  if (mins >= 1140&& mins < 1200) return { name: '⚠️ NY إغلاق',          code: 'ny_close',    minGrade: 'S' };
  return { name: '😴 بين جلسات', code: 'off', minGrade: 'S' };
}

function isKillZone() {
  const s = getTradingSession();
  return s.code !== 'weekend' && s.minGrade !== null;
}

// ══════════════════════════════════════
// ✅ ADX — Market Regime
// ══════════════════════════════════════
function calcADX(highs, lows, closes, n=14) {
  if (closes.length < n*2) return null;
  const trs=[], pDMs=[], mDMs=[];
  for (let i=1; i<closes.length; i++) {
    trs.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
    pDMs.push(highs[i]-highs[i-1]>lows[i-1]-lows[i]?Math.max(highs[i]-highs[i-1],0):0);
    mDMs.push(lows[i-1]-lows[i]>highs[i]-highs[i-1]?Math.max(lows[i-1]-lows[i],0):0);
  }
  const av=trs.slice(-n).reduce((a,b)=>a+b,0)/n;
  const pDI=av>0?pDMs.slice(-n).reduce((a,b)=>a+b,0)/n/av*100:0;
  const mDI=av>0?mDMs.slice(-n).reduce((a,b)=>a+b,0)/n/av*100:0;
  const dx=pDI+mDI>0?Math.abs(pDI-mDI)/(pDI+mDI)*100:0;
  return { adx:+dx.toFixed(1), pDI:+pDI.toFixed(1), mDI:+mDI.toFixed(1), trending:dx>18, strong:dx>28 };
}

// ══════════════════════════════════════
// ✅ Momentum (ROC)
// ══════════════════════════════════════
function calcMomentum(closes, signal) {
  const len=closes.length; if(len<10)return{ok:true,label:'—'};
  const roc5=((closes[len-1]-closes[len-6])/closes[len-6])*100;
  const roc10=((closes[len-1]-closes[len-11])/closes[len-11])*100;
  const accel=Math.abs(roc5)>Math.abs(roc10/2);
  if(signal==='CALL'){
    if(roc5>0.3&&accel)return{ok:true,label:'🚀 زخم قوي',roc:+roc5.toFixed(2)};
    if(roc5>0)         return{ok:true,label:'✅ زخم إيجابي',roc:+roc5.toFixed(2)};
    if(roc5<-0.5)      return{ok:false,label:'❌ زخم عكسي',roc:+roc5.toFixed(2)};
  } else {
    if(roc5<-0.3&&accel)return{ok:true,label:'🚀 زخم هبوطي قوي',roc:+roc5.toFixed(2)};
    if(roc5<0)          return{ok:true,label:'✅ زخم سلبي',roc:+roc5.toFixed(2)};
    if(roc5>0.5)        return{ok:false,label:'❌ زخم عكسي',roc:+roc5.toFixed(2)};
  }
  return{ok:true,label:'📊 محايد',roc:+roc5.toFixed(2)};
}

function isMarketOpen(sym) {
  if (CRYPTO_SYMS.has(sym)) return true;
  const now = new Date();
  const day = now.getUTCDay();
  return day !== 0 && day !== 6;
}

async function getVIX() {
  if (vixCache.value && (Date.now() - vixCache.ts) < 15 * 60 * 1000) return vixCache.value;
  try {
    const bars = await getBars('^VIX', '1d', '5d');
    if (bars && bars.price) { vixCache = { value: bars.price, ts: Date.now() }; return bars.price; }
  } catch(e) {}
  return null;
}

function hasVolumeConfirmation(bars) {
  if (!bars.vols || bars.vols.length < 20) return true;
  const vols = bars.vols.filter(v => v > 0);
  if (vols.length < 10) return true;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  return vols[vols.length-1] >= avgVol * 1.0;
}

function hasLiquiditySweep(bars, signal) {
  if (!bars || bars.highs.length < 5) return true;
  const prevHigh = Math.max(...bars.highs.slice(-6,-1));
  const prevLow  = Math.min(...bars.lows.slice(-6,-1));
  if (signal === 'CALL') return Math.min(...bars.lows.slice(-3)) < prevLow * 0.999;
  else return Math.max(...bars.highs.slice(-3)) > prevHigh * 1.001;
}

function analyzeWeeklyTrend(weekBars) {
  if (!weekBars || weekBars.closes.length < 5) return 'neutral';
  const e8  = ema(weekBars.closes, 8);
  const e21 = ema(weekBars.closes, 21);
  if (!e8 || !e21) return 'neutral';
  if (weekBars.price > e8 && e8 > e21) return 'bull';
  if (weekBars.price < e8 && e8 < e21) return 'bear';
  return 'neutral';
}

async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, val, ex=86400) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}?ex=${ex}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  } catch(e) {}
}
async function kvDel(key) {
  try { await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }); } catch(e) {}
}

async function saveLog(entry) {
  try {
    const log = (await kvGet('idx_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 500) log.splice(500);
    await kvSet('idx_log', log, 180*86400);
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
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body); req.end();
  });
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
  for (let i=1; i<c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
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

function detectFVG_idx(highs, lows, price, signal) {
  const len=highs.length; if(len<3)return false;
  const lb=Math.min(len-1,8);
  for(let i=len-1;i>=len-lb;i--){
    if(i<2)break;
    const sz=signal==='CALL'?lows[i]-highs[i-2]:lows[i-2]-highs[i];
    if(sz<=0||sz/price*100<0.05)continue;
    if(signal==='CALL'&&price<=lows[i]*1.002&&price>=highs[i-2]*0.998)return true;
    if(signal==='PUT' &&price>=highs[i]*0.998&&price<=lows[i-2]*1.002)return true;
  }
  return false;
}
function detectIFVG_idx(highs, lows, closes, price, signal) {
  const len=highs.length; if(len<5)return false;
  const lb=Math.min(len-1,15);
  for(let i=len-3;i>=len-lb;i--){
    if(i<2)break;
    const bFvg=lows[i]-highs[i-2], rFvg=lows[i-2]-highs[i];
    let top,bot,wasBull;
    if(bFvg>0&&bFvg/price*100>=0.05){top=lows[i];bot=highs[i-2];wasBull=true;}
    else if(rFvg>0&&rFvg/price*100>=0.05){top=lows[i-2];bot=highs[i];wasBull=false;}
    else continue;
    let mit=false;
    for(let j=i+1;j<len-1;j++){if(closes[j]>bot&&closes[j]<top){mit=true;break;}}
    if(!mit)continue;
    if(signal==='CALL'&&!wasBull&&price>=bot*0.998&&price<=top*1.002)return true;
    if(signal==='PUT' &&wasBull &&price>=bot*0.998&&price<=top*1.002)return true;
  }
  return false;
}
function detectOB_idx(highs, lows, closes, price, signal) {
  const len=closes.length; if(len<4)return false;
  const lb=Math.min(len-2,8);
  for(let i=len-2;i>=len-lb;i--){
    if(i<1)break;
    const h1=highs[i-1],l1=lows[i-1],c1=closes[i-1];
    const h2=highs[i],l2=lows[i],c2=closes[i];
    const prev=closes[i-2]||c1;
    if(signal==='CALL'){if(c1<prev*1.001&&c2>h1&&l2<l1&&price>=l1*0.999&&price<=h1*1.001)return true;}
    else{if(c1>prev*0.999&&c2<l1&&h2>h1&&price>=l1*0.999&&price<=h1*1.001)return true;}
  }
  return false;
}
function detectBOS_idx(highs, lows, closes, signal) {
  const len=closes.length; if(len<12)return false;
  const rH=highs.slice(-11,-1), rL=lows.slice(-11,-1);
  const last=closes[len-1];
  return signal==='CALL'?last>Math.max(...rH):last<Math.min(...rL);
}
function detectRej_idx(highs, lows, closes, signal) {
  const len=closes.length;
  for(let i=len-1;i>=Math.max(0,len-2);i--){
    const o=closes[i-1]||closes[i],c=closes[i],h=highs[i],l=lows[i];
    const range=h-l; if(range===0)continue;
    const body=Math.abs(c-o)/range;
    const upper=(h-Math.max(o,c))/range;
    const lower=(Math.min(o,c)-l)/range;
    if(signal==='CALL'&&lower>=0.55&&body<=0.40)return true;
    if(signal==='PUT' &&upper>=0.55&&body<=0.40)return true;
  }
  return false;
}
function calcICT_idx(trendBars, entryBars, fastBars, price, signal) {
  let score=0; const details=[];
  if(entryBars&&detectFVG_idx(entryBars.highs,entryBars.lows,price,signal)){score+=3;details.push('FVG✅');}
  if(trendBars&&detectIFVG_idx(trendBars.highs,trendBars.lows,trendBars.closes,price,signal)){score+=3;details.push('IFVG✅');}
  if(trendBars&&detectOB_idx(trendBars.highs,trendBars.lows,trendBars.closes,price,signal)){score+=3;details.push('OB✅');}
  if(entryBars&&detectBOS_idx(entryBars.highs,entryBars.lows,entryBars.closes,signal)){score+=2;details.push('BOS✅');}
  if(fastBars&&detectRej_idx(fastBars.highs,fastBars.lows,fastBars.closes,signal)){score+=2;details.push('REJ✅');}
  return {score,details};
}

function analyzeFrame(bars, minScore=MIN_SCORE) {
  const { closes, highs, lows, price } = bars;
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50);
  const r=rsi(closes), m=macd(closes), b=bb(closes);
  const a=atr(highs,lows,closes,14);
  if (!e9||!e21||!r||!a) return null;
  let bull=0, bear=0; const reasons=[];
  if(price>e9&&e9>e21){bull+=3;reasons.push('EMA↑');}
  else if(price<e9&&e9<e21){bear+=3;reasons.push('EMA↓');}
  if(e50){if(price>e50){bull+=2;reasons.push('فوق EMA50');}else{bear+=2;reasons.push('تحت EMA50');}}
  if(r>58&&r<72){bull+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<42&&r>28){bear+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<=28){bull+=3;reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`);}
  else if(r>=72){bear+=2;reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`);}
  if(m?.bull){bull+=2;reasons.push('MACD↑');}else if(m){bear+=2;reasons.push('MACD↓');}
  if(b){
    if(price<=b.lower){bull+=3;reasons.push('BB دعم');}
    else if(price>=b.upper){bear+=3;reasons.push('BB مقاومة');}
    else if(price>b.mid)bull+=1; else bear+=1;
  }
  const prev=closes[closes.length-2]||price, chg=((price-prev)/prev)*100;
  if(chg>0.5){bull+=2;reasons.push(`زخم +${chg.toFixed(1)}%`);}
  else if(chg>0.2)bull+=1;
  else if(chg<-0.5){bear+=2;reasons.push(`زخم ${chg.toFixed(1)}%`);}
  else if(chg<-0.2)bear+=1;
  const signal=bull>=minScore?'CALL':bear>=minScore?'PUT':null;
  const trend=bull>bear?'bull':bear>bull?'bear':'neutral';
  return { signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg };
}

async function analyzeMTF(sym, vix) {
  if (!isMarketOpen(sym)) return null;
  const vixLevel = vix || 0;
  if (vixLevel > 35 && !CRYPTO_SYMS.has(sym)) return null;

  // ✅ جلسة التداول
  const session = getTradingSession();
  if (session.code === 'weekend') return null;

  const [weekBars, trendBars, entryBars, fastBars] = await Promise.all([
    CRYPTO_SYMS.has(sym) ? null : getBars(sym, INTERVALS.weekly.interval, INTERVALS.weekly.range),
    getBars(sym, INTERVALS.trend.interval, INTERVALS.trend.range),
    getBars(sym, INTERVALS.entry.interval, INTERVALS.entry.range),
    getBars(sym, INTERVALS.fast.interval,  INTERVALS.fast.range),
  ]);
  if (!trendBars) return null;
  if (!hasVolumeConfirmation(trendBars)) return null;

  const weeklyTrend = weekBars ? analyzeWeeklyTrend(weekBars) : 'neutral';

  // ✅ Options Flow من Massive — تأكيد إضافي
  let optionsFlow = null;
  try { optionsFlow = await fetchOptionsFlow(sym); } catch(e) {}
  // إذا Options Flow يعارض الإشارة بقوة → تجاهل
  if (optionsFlow && optionsFlow.flowSignal !== 'WAIT') {
    const trendDir = dominantTrend === 'bull' ? 'CALL' : 'PUT';
    if (optionsFlow.flowSignal !== trendDir) {
      // تعارض قوي: P/C ratio عكسي جداً → skip
      if ((trendDir === 'CALL' && optionsFlow.pcRatio > 2.0) ||
          (trendDir === 'PUT'  && optionsFlow.pcRatio < 0.4)) {
        return null; // Options Flow يعارض بشدة
      }
    }
  }
  const trendResult=analyzeFrame(trendBars);
  const entryResult=entryBars?analyzeFrame(entryBars):null;
  const fastResult=fastBars?analyzeFrame(fastBars):null;
  if (!trendResult) return null;
  const dominantTrend=trendResult.trend;
  if (dominantTrend==='neutral') return null;

  // Weekly: تحذير فقط بدل إيقاف للمؤشرات
  const weeklyConflict = !CRYPTO_SYMS.has(sym) && weeklyTrend !== 'neutral' && weeklyTrend !== dominantTrend;

  const requiredSignal=dominantTrend==='bull'?'CALL':'PUT';
  if (requiredSignal==='CALL' && trendResult.rsi > 75) return null;
  if (requiredSignal==='PUT'  && trendResult.rsi < 25) return null;

  let entryFrame=null, entryData=null;
  if(fastResult?.signal===requiredSignal){entryFrame='5M';entryData=fastResult;}
  else if(entryResult?.signal===requiredSignal){entryFrame='15M';entryData=entryResult;}
  else if(trendResult.signal===requiredSignal){entryFrame='1H';entryData=trendResult;}
  if (!entryFrame||!entryData) return null;

  const entryBarsCheck = entryBars || trendBars;
  if (!hasLiquiditySweep(entryBarsCheck, requiredSignal)) return null;

  // ✅ ADX — Market Regime
  const adxData = calcADX(trendBars.highs, trendBars.lows, trendBars.closes);

  // ✅ Momentum
  const momentum = calcMomentum(entryBars?.closes || trendBars.closes, requiredSignal);

  const agreements=[
    trendResult.trend===dominantTrend,
    entryResult?.trend===dominantTrend,
    fastResult?.trend===dominantTrend,
    !CRYPTO_SYMS.has(sym) ? weeklyTrend===dominantTrend : true,
  ].filter(Boolean).length;

  const entryScore=entryData?(dominantTrend==='bull'?entryData.bull:entryData.bear):0;
  const trendScore2=dominantTrend==='bull'?trendResult.bull:trendResult.bear;
  const combinedScore=Math.round((entryScore+trendScore2)/2);
  const ict = calcICT_idx(trendBars, entryBars, fastBars, entryData.price||trendBars.price, requiredSignal);

  // بونص ADX + Momentum
  const adxBonus  = adxData?.strong ? 2 : adxData?.trending ? 1 : 0;
  const momBonus  = momentum.ok && momentum.label.includes('قوي') ? 1 : 0;

  let grade,gradeLabel,successRate;
  // ✅ بونص Options Flow
  const ofBonus = optionsFlow && optionsFlow.flowSignal !== 'WAIT' &&
                  optionsFlow.flowSignal === (dominantTrend==='bull'?'CALL':'PUT') ? 1 : 0;
  const totalScore = combinedScore + (ict.score>=5?2:ict.score>=3?1:0) + adxBonus + momBonus + ofBonus;
  if(agreements>=3&&totalScore>=12){grade='S';gradeLabel='🔥 نسبة نجاح عالية جداً';successRate=87;}
  else if(agreements>=3||(agreements>=2&&totalScore>=10)){grade='A';gradeLabel='✅ نسبة نجاح عالية';successRate=73;}
  else return null;

  // في جلسة آسيا أو بين جلسات: Grade S فقط
  if (session.minGrade === 'S' && grade !== 'S' && !CRYPTO_SYMS.has(sym)) return null;

  // إذا VIX مرتفع: Grade S فقط
  if(vixLevel>=25&&vixLevel<=35&&grade!=='S'&&!CRYPTO_SYMS.has(sym)) return null;

  return {
    sym, signal:requiredSignal, dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price:entryData.price||trendBars.price, atr:entryData.atr,
    trendRSI:trendResult.rsi?.toFixed(1), entryRSI:entryData.rsi?.toFixed(1),
    weeklyTrend, weeklyConflict,
    trendReasons:trendResult.reasons, entryReasons:entryData.reasons,
    agreements, totalFrames:4,
    trendScore:dominantTrend==='bull'?trendResult.bull:trendResult.bear,
    vix:vixLevel>0?vixLevel.toFixed(1):null,
    ictScore:ict.score, ictDetails:ict.details,
    session, adxData, momentum,
    optionsFlow, ofBonus,
  };
}

function calcTargets(signal, price, atrVal) {
  const d=signal==='CALL'?1:-1;
  const sl=price-d*atrVal*ATR_MULT.sl;
  const t1=price+d*atrVal*ATR_MULT.t1;
  const t2=price+d*atrVal*ATR_MULT.t2;
  const t3=price+d*atrVal*ATR_MULT.t3;
  const risk=Math.abs(price-sl);
  return {
    sl:+sl.toFixed(2),t1:+t1.toFixed(2),t2:+t2.toFixed(2),t3:+t3.toFixed(2),
    slPct:((sl-price)/price*100).toFixed(2),
    t1Pct:((t1-price)/price*100).toFixed(2),
    rr1:(Math.abs(t1-price)/risk).toFixed(2),
    rr2:(Math.abs(t2-price)/risk).toFixed(2),
    rr3:(Math.abs(t3-price)/risk).toFixed(2),
  };
}

async function checkActiveSignals() {
  const active=(await kvGet('idx_active'))||{};
  const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0.0};
  let changed=false, notifs=0;
  for (const [id,sig] of Object.entries(active)) {
    try {
      const cfg=INDICES[sig.sym];
      if(!cfg){delete active[id];changed=true;continue;}
      const bars=await getBars(sig.sym,'5m','1d');
      const price=bars?.price;
      if(!price)continue;
      const isCall=sig.signal==='CALL';
      if((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)){
        delete active[id]; perf.losses++; perf.totalR-=1; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'SL', r:-1, type:'index',
          agreements:sig.agreements, entryFrame:sig.entryFrame,
          trendRSI:sig.trendRSI, session:sig.session,
          sessionName:sig.sessionName, ictScore:sig.ictScore,
          adx:sig.adx, vixAtEntry:sig.vixAtEntry,
          slNote:'خطأ تحليل — راجع مناطق السيولة',
        });
        await tg(`🛑 <b>Stop Loss!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n💰 $${price.toFixed(2)}\n🛡️ SL: $${sig.sl}\n📊 -1R | WR: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n🤖 <i>TIH Indices v5.1</i>`);
        notifs++; continue;
      }
      if(!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))){
        sig.t1Hit=true; sig.sl=sig.entry; perf.wins++; perf.totalR+=2; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'T1', r:2, type:'index',
          agreements:sig.agreements, entryFrame:sig.entryFrame,
          trendRSI:sig.trendRSI, session:sig.session, sessionName:sig.sessionName,
        });
        await tg(`🎯 <b>T1 تحقق! +2R</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → BE\n🤖 <i>TIH Indices v5.1</i>`);
        notifs++;
      }
      if(sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))){
        sig.t2Hit=true; perf.totalR+=1.5; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'T2', r:3.5, type:'index',
          agreements:sig.agreements, session:sig.session, sessionName:sig.sessionName,
        });
        await tg(`🎯🎯 <b>T2 تحقق! +3.5R 🔥</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Indices v5.1</i>`);
        notifs++;
      }
      if(sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))){
        delete active[id]; perf.totalR+=1.5; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'T3', r:5, type:'index',
          agreements:sig.agreements, session:sig.session, sessionName:sig.sessionName,
        });
        await tg(`🏆🏆🏆 <b>T3 تحقق! +5R 💎</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n🤖 <i>TIH Indices v5.1</i>`);
        notifs++; continue;
      }
      const age=Date.now()-(sig.openedAt||0);
      if(age>36*60*60*1000&&!sig.t1Hit){
        delete active[id]; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'EXP', r:0, type:'index',
          agreements:sig.agreements, session:sig.session, sessionName:sig.sessionName,
        });
        await tg(`⏰ <b>انتهت الإشارة</b>\n📌 <b>${sig.sym}</b> — 36س بدون T1\n🤖 <i>TIH Indices v5.1</i>`);
        notifs++; continue;
      }
      active[id]=sig;
    } catch(e) {}
  }
  if(changed){ await kvSet('idx_active',active,7*86400); await kvSet('idx_perf',perf,365*86400); }
  return notifs;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method==='OPTIONS') return res.status(200).end();
  const action = req.query.action || 'check';

  if (action==='test') {
    const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('idx_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    const kz=isKillZone();
    await tg(
      `🤖 <b>TIH Indices v5.1</b>\n━━━━━━━━━━━━━━━\n✅ النظام يعمل!\n\n` +
      `📊 ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n━━━━━━━━━━━━━━━\n` +
      `✅ Kill Zones: ${kz?'🟢 نشط':'🔴 خارج النافذة'}\n` +
      `✅ شرط الإشارة: ${MIN_SCORE} نقطة\n` +
      `✅ Weekly Trend: مفعّل\n✅ Liquidity Sweep: مفعّل\n` +
      `✅ Grade S+A فقط\n` +
      `📊 VIX: ${vix?vix.toFixed(1):'—'}\n` +
      `📡 مصدر البيانات: Twelve Data\n🤖 <i>TIH Indices v5.1</i>`
    );
    return res.status(200).json({ ok:true, vix, killZone:kz });
  }

  if (action==='reset') { await kvDel('idx_active'); await tg('🔄 تم مسح الإشارات النشطة\n🤖 TIH Indices v5.1'); return res.status(200).json({ ok:true }); }

  if (action==='reset-all') {
    await Promise.all([kvDel('idx_active'),kvDel('idx_log'),kvDel('idx_perf'),kvDel('idx_vix_alert')]);
    await tg('🔄 <b>بداية جديدة</b> — تم مسح كل بيانات المؤشرات\n🤖 TIH Indices v6.0');
    return res.status(200).json({ok:true,message:'all cleared'});
  }

  if (action==='cleanup') {
    const active=(await kvGet('idx_active'))||{};
    const latest={};
    for(const [id,sig] of Object.entries(active)){ if(!latest[sig.sym]||sig.openedAt>latest[sig.sym].openedAt) latest[sig.sym]={id,...sig}; }
    const newActive={};
    for(const [sym,sig] of Object.entries(latest)){const{id,...data}=sig;newActive[id]=data;}
    await kvSet('idx_active',newActive,7*86400);
    return res.status(200).json({ok:true,removed:Object.keys(active).length-Object.keys(newActive).length,remaining:Object.keys(newActive).length});
  }

  if (action==='active') {
    const active=(await kvGet('idx_active'))||{};
    const sigs=Object.values(active).map(s=>({sym:s.sym,signal:s.signal,grade:s.grade,entry:s.entry,sl:s.sl,t1:s.t1,t2:s.t2,t3:s.t3,t1Hit:s.t1Hit,t2Hit:s.t2Hit,openedAt:s.openedAt}));
    return res.status(200).json({ok:true,signals:sigs,count:sigs.length});
  }

  if (action==='log') { const log=(await kvGet('idx_log'))||[]; return res.status(200).json({ok:true,log,count:log.length}); }

  if (action==='stats') {
    const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('idx_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    await tg(`📊 <b>أداء المؤشرات v5.1</b>\n━━━━━━━━━━━━━━━\n${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 Win Rate: <b>${wr}%</b>\n💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n📌 نشطة: ${Object.keys(active).length}\n📊 VIX: ${vix?vix.toFixed(1):'—'}\n🤖 TIH Indices v5.1`);
    return res.status(200).json({ok:true,perf,active:Object.keys(active).length,vix});
  }

  const force = req.query.force === '1';
  const symbols=req.query.symbols?req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>INDICES[s]):Object.keys(INDICES);
  const perfNotifs=await checkActiveSignals();
  const newAlerts=[],errors=[],skipped=[];
  const vix=await getVIX();

  if(vix&&vix>25){
    const lastVixAlert=await kvGet('idx_vix_alert');
    const today=new Date().toISOString().split('T')[0];
    if(lastVixAlert!==today){
      await kvSet('idx_vix_alert',today,86400);
      await tg(vix>35?`⚠️ <b>VIX شديد!</b> ${vix.toFixed(1)} — إيقاف كامل\n🤖 TIH Indices v5.1`:`⚠️ <b>VIX مرتفع</b> ${vix.toFixed(1)} — Grade S فقط\n🤖 TIH Indices v5.1`);
    }
  }

  await Promise.all(symbols.map(async (sym) => {
    try {
      if(!force&&!isMarketOpen(sym)){skipped.push(sym);return;}
      const result=await analyzeMTF(sym,vix);
      if(!result)return;
      const active=(await kvGet('idx_active'))||{};
      if(!force&&Object.values(active).some(s=>s.sym===sym))return;
      const targets=calcTargets(result.signal,result.price,result.atr);
      const sigId=`${sym}_${Date.now()}`;
      active[sigId]={
        sym, signal:result.signal, entry:result.price,
        sl:targets.sl, t1:targets.t1, t2:targets.t2, t3:targets.t3,
        t1Hit:false, t2Hit:false, t3Hit:false,
        grade:result.grade, openedAt:Date.now(),
        // ✅ بيانات إضافية للتقرير
        agreements:result.agreements,
        entryFrame:result.entryFrame,
        trendRSI:result.trendRSI,
        entryRSI:result.entryRSI,
        weeklyTrend:result.weeklyTrend,
        session:result.session?.code||'unknown',
        sessionName:result.session?.name||'—',
        ictScore:result.ictScore||0,
        adx:result.adxData?.adx||null,
        momentum:result.momentum?.label||null,
        vixAtEntry:result.vix||null,
      };
      const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
      perf.total++;
      await kvSet('idx_active',active,7*86400);
      await kvSet('idx_perf',perf,365*86400);
      newAlerts.push({sym,signal:result.signal,grade:result.grade});
      const emoji=result.signal==='CALL'?'🟢':'🔴';
      const sigType=result.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const now=new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});
      const weekLine = result.weeklyTrend!=='neutral'
        ? `📅 Weekly: ${result.weeklyTrend==='bull'?'🟢 صاعد':'🔴 هابط'}${result.weeklyConflict?' ⚠️ عكس الاتجاه':''}
`
        : '';
      const ictLine = result.ictDetails?.length
        ? `🔬 ICT: ${result.ictDetails.join(' ')} (${result.ictScore}/13)
` : '';
      const sessionLine = `🕐 الجلسة: ${result.session?.name||'—'}
`;
      const adxLine = result.adxData
        ? `📊 ADX: ${result.adxData.adx} ${result.adxData.strong?'🔥 قوي':result.adxData.trending?'✅ اتجاه':'⚪ تذبذب'}
` : '';
      const momLine = result.momentum?.label
        ? `⚡ الزخم: ${result.momentum.label} (ROC: ${result.momentum.roc>0?'+':''}${result.momentum.roc}%)
` : '';
      const ofLine = result.optionsFlow
        ? `🐋 Options: P/C ${result.optionsFlow.pcRatio} | CALL ${result.optionsFlow.callPct}% | ${result.optionsFlow.flowSignal==='CALL'?'🟢 صعودي':result.optionsFlow.flowSignal==='PUT'?'🔴 هبوطي':'⚪ محايد'}
` : '';
      await tg(
        `${emoji} <b>${sigType}</b>  |  درجة <b>${result.grade}</b>
` +
        `${result.gradeLabel} — <b>${result.successRate}%</b>
` +
        `━━━━━━━━━━━━━━━
` +
        `📌 <b>${sym}</b> — ${INDICES[sym].name}
` +
        `💰 السعر: <b>$${result.price.toFixed(2)}</b>
` +
        `
📊 <b>التحليل</b>
` +
        `${sessionLine}${weekLine}${ictLine}` +
        `├ RSI(1H): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}
` +
        `└ توافق: ${result.agreements}/${result.totalFrames} فريم
` +
        `
${adxLine}${momLine}${ofLine||''}` +
        `━━━━━━━━━━━━━━━
` +
        `🎯 Entry : <b>$${result.price.toFixed(2)}</b>
` +
        `🛡 SL    : $${targets.sl} (${targets.slPct}%)
` +
        `🥇 T1    : $${targets.t1} (+${targets.t1Pct}%) | 1:${targets.rr1}
` +
        `🥈 T2    : $${targets.t2} | 1:${targets.rr2}
` +
        `🥉 T3    : $${targets.t3} | 1:${targets.rr3}
` +
        `━━━━━━━━━━━━━━━
` +
        `📐 ATR: ${result.atr.toFixed(2)} | VIX: ${result.vix||'—'} | ⏰ ${now}
` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(INDICES[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">الشارت ↗</a>
` +
        `🤖 <i>TIH Indices v6.0</i>`
      );
    } catch(e){ errors.push(`${sym}: ${e.message}`); }
  }));

  const active=(await kvGet('idx_active'))||{};
  return res.status(200).json({
    ok:true, checked:symbols.length,
    newAlerts:newAlerts.length, perfNotifs,
    active:Object.keys(active).length,
    signals:newAlerts, skipped, errors,
    vix:vix?+vix.toFixed(1):null,
    killZone:isKillZone()
  });
};
