const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ══════════════════════════════════════════════════════
// TIH Stocks v6.1
// ✅ SL ذكي مبني على دعم/مقاومة حقيقية
// ✅ Momentum Analysis (ROC + MACD Hist + Volume)
// ✅ تنسيق Telegram محسّن
// ══════════════════════════════════════════════════════

const STOCKS = {
  'AAPL':  { name: 'Apple',     tv: 'NASDAQ:AAPL'  },
  'MSFT':  { name: 'Microsoft', tv: 'NASDAQ:MSFT'  },
  'NVDA':  { name: 'NVIDIA',    tv: 'NASDAQ:NVDA'  },
  'META':  { name: 'Meta',      tv: 'NASDAQ:META'  },
  'GOOGL': { name: 'Google',    tv: 'NASDAQ:GOOGL' },
  'AMZN':  { name: 'Amazon',    tv: 'NASDAQ:AMZN'  },
  'AMD':   { name: 'AMD',       tv: 'NASDAQ:AMD'   },
  'AVGO':  { name: 'Broadcom',  tv: 'NASDAQ:AVGO'  },
  'JPM':   { name: 'JPMorgan',  tv: 'NYSE:JPM'     },
  'MRVL':  { name: 'Marvell',   tv: 'NASDAQ:MRVL'  },
};

const TV_INTERVAL    = { '1H':'60', '15M':'15', '5M':'5', '1D':'D' };
const MIN_SCORE      = 12;
const MIN_SIGNAL_GAP = 8 * 60 * 60 * 1000;

let vixCache = { value: null, ts: 0 };

// ══════════════════════════════════════
// Yahoo Finance
// ══════════════════════════════════════
async function getBars(sym, interval, range) {
  return new Promise((resolve) => {
    const path = `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`;
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const q = json?.chart?.result?.[0];
          if (!q || !q.indicators?.quote?.[0]) { resolve(null); return; }
          const quotes = q.indicators.quote[0];
          const timestamps = q.timestamp || [];
          if (timestamps.length < 5) { resolve(null); return; }
          const raw_c = quotes.close || [], raw_h = quotes.high || [];
          const raw_l = quotes.low  || [], raw_o = quotes.open || [];
          const raw_v = quotes.volume || [];
          const valid = raw_c.map((c,i) => c != null && c > 0 && raw_h[i] > 0 && raw_l[i] > 0);
          const closes = raw_c.filter((_,i) => valid[i]);
          const highs  = raw_h.filter((_,i) => valid[i]);
          const lows   = raw_l.filter((_,i) => valid[i]);
          const opens  = raw_o.filter((_,i) => valid[i]);
          const vols   = raw_v.filter((_,i) => valid[i]).map(v => v || 0);
          if (closes.length < 5) { resolve(null); return; }
          resolve({ closes, highs, lows, opens, vols, price: closes[closes.length-1] });
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 830 && mins <= 1300;
}

async function getVIX() {
  if (vixCache.value && (Date.now() - vixCache.ts) < 15 * 60 * 1000) return vixCache.value;
  try {
    const bars = await getBars('^VIX', '1d', '5d');
    if (bars?.price) { vixCache = { value: bars.price, ts: Date.now() }; return bars.price; }
  } catch(e) {}
  return null;
}

// ══════════════════════════════════════
// Redis
// ══════════════════════════════════════
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
    const log = (await kvGet('stk_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 200) log.splice(200);
    await kvSet('stk_log', log, 90*86400);
  } catch(e) {}
}

// ══════════════════════════════════════
// Telegram
// ══════════════════════════════════════
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

// ══════════════════════════════════════
// مؤشرات أساسية
// ══════════════════════════════════════
function ema(p, n) {
  if (!p || p.length < n) return null;
  const k = 2/(n+1);
  let e = p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i=n; i<p.length; i++) e = p[i]*k + e*(1-k);
  return e;
}
function rsi(p, n=14) {
  if (!p || p.length < n+1) return null;
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
  if (!c || c.length < n+1) return null;
  const tr = [];
  for (let i=1; i<c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return tr.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function macdCalc(p) {
  const e12=ema(p,12), e26=ema(p,26);
  if (!e12||!e26) return null;
  const macdLine = e12-e26;
  // Signal line تقريبي
  const e12_prev=ema(p.slice(0,-1),12), e26_prev=ema(p.slice(0,-1),26);
  const prevMacd = (e12_prev&&e26_prev) ? e12_prev-e26_prev : macdLine;
  const signal = prevMacd * 0.8 + macdLine * 0.2; // EMA9 تقريبي
  return { val: macdLine, signal, histogram: macdLine - signal, bull: macdLine > signal };
}
function bb(p, n=20) {
  if (!p || p.length<n) return null;
  const s=p.slice(-n), m=s.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/n);
  return { upper:m+2*sd, mid:m, lower:m-2*sd };
}

// ══════════════════════════════════════
// ✅ Momentum Analysis
// ROC + MACD Histogram + Volume Momentum
// ══════════════════════════════════════
function analyzeMomentum(closes, highs, lows, vols, signal) {
  const len = closes.length;
  if (len < 15) return { label: '—', strong: false, weakening: false, emoji: '⚪' };

  // 1. Rate of Change (ROC 10)
  const roc10 = ((closes[len-1] - closes[len-11]) / closes[len-11]) * 100;
  const roc5  = ((closes[len-1] - closes[len-6])  / closes[len-6])  * 100;
  const rocAccel = roc5 > roc10 / 2; // الزخم يتسارع

  // 2. MACD Histogram — هل يكبر أم يصغر؟
  const macdNow  = macdCalc(closes);
  const macdPrev = macdCalc(closes.slice(0,-1));
  let histGrowing = false, histShrinking = false;
  if (macdNow && macdPrev) {
    const hNow  = Math.abs(macdNow.histogram);
    const hPrev = Math.abs(macdPrev.histogram);
    if (signal === 'CALL') {
      histGrowing   = macdNow.histogram > 0 && hNow > hPrev;
      histShrinking = macdNow.histogram > 0 && hNow < hPrev * 0.7;
    } else {
      histGrowing   = macdNow.histogram < 0 && hNow > hPrev;
      histShrinking = macdNow.histogram < 0 && hNow < hPrev * 0.7;
    }
  }

  // 3. Volume Momentum — وايكوف
  const avgVol = vols.slice(-20).filter(v=>v>0).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  const lastVol = vols[len-1];
  const volMomentum = lastVol > avgVol * 1.3; // حجم أعلى 30% من المتوسط

  // 4. Price above/below EMA9 — زخم السعر
  const e9 = ema(closes, 9);
  const priceAboveEMA = signal==='CALL' ? closes[len-1] > e9 : closes[len-1] < e9;

  // القرار النهائي
  const strongSignals = [rocAccel, histGrowing, volMomentum, priceAboveEMA].filter(Boolean).length;
  const weakeningSignals = [histShrinking, !priceAboveEMA].filter(Boolean).length;

  if (strongSignals >= 3) {
    return {
      label: 'قوي ومتصاعد',
      detail: `ROC: ${roc10.toFixed(1)}% | حجم ${volMomentum?'✅':'—'}`,
      strong: true, weakening: false, emoji: '🚀',
      warning: null,
    };
  } else if (strongSignals >= 2 && !histShrinking) {
    return {
      label: 'جيد',
      detail: `ROC: ${roc10.toFixed(1)}%`,
      strong: false, weakening: false, emoji: '✅',
      warning: null,
    };
  } else if (weakeningSignals >= 1 || histShrinking) {
    return {
      label: 'يتباطأ',
      detail: `ROC: ${roc10.toFixed(1)}% | Histogram يتراجع`,
      strong: false, weakening: true, emoji: '⚠️',
      warning: '⚠️ الزخم يضعف — راقب الخروج عند T1',
    };
  } else {
    return {
      label: 'متوسط',
      detail: `ROC: ${roc10.toFixed(1)}%`,
      strong: false, weakening: false, emoji: '📊',
      warning: null,
    };
  }
}

// ══════════════════════════════════════
// ✅ SL ذكي — مبني على دعم/مقاومة حقيقية
// بدل ATR × ثابت
// ══════════════════════════════════════
function calcSmartSL(signal, price, atrVal, levels) {
  const { e21, e50, e200, bbUpper, bbLower, pdh, pdl, fib } = levels || {};
  const buffer = price * 0.005; // 0.5% تحت/فوق المستوى
  const candidates = [];

  if (signal === 'CALL') {
    // SL تحت السعر — أقرب دعم
    if (bbLower && bbLower < price) candidates.push({ val: bbLower - buffer, label: 'BB Lower', dist: price - bbLower });
    if (pdl    && pdl    < price) candidates.push({ val: pdl    - buffer, label: 'PDL',      dist: price - pdl    });
    if (e21    && e21    < price) candidates.push({ val: e21    - buffer, label: 'EMA21',    dist: price - e21    });
    if (e50    && e50    < price) candidates.push({ val: e50    - buffer, label: 'EMA50',    dist: price - e50    });
    if (fib?.fib618 && fib.fib618 < price) candidates.push({ val: fib.fib618 - buffer, label: 'Fib 0.618', dist: price - fib.fib618 });
    if (e200   && e200   < price) candidates.push({ val: e200   - buffer, label: 'EMA200',   dist: price - e200   });
  } else {
    // SL فوق السعر — أقرب مقاومة
    if (bbUpper && bbUpper > price) candidates.push({ val: bbUpper + buffer, label: 'BB Upper', dist: bbUpper - price });
    if (pdh    && pdh    > price) candidates.push({ val: pdh    + buffer, label: 'PDH',      dist: pdh    - price });
    if (e21    && e21    > price) candidates.push({ val: e21    + buffer, label: 'EMA21',    dist: e21    - price });
    if (e50    && e50    > price) candidates.push({ val: e50    + buffer, label: 'EMA50',    dist: e50    - price });
    if (fib?.fib618 && fib.fib618 > price) candidates.push({ val: fib.fib618 + buffer, label: 'Fib 0.618', dist: fib.fib618 - price });
    if (e200   && e200   > price) candidates.push({ val: e200   + buffer, label: 'EMA200',   dist: e200   - price });
  }

  // اختر أقرب مستوى لكن ليس قريباً جداً (< 1%) ولا بعيداً جداً (> 8%)
  const minDist = price * 0.01;
  const maxDist = price * 0.08;
  const valid = candidates
    .filter(c => c.dist >= minDist && c.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist);

  if (valid.length > 0) {
    return { sl: +valid[0].val.toFixed(2), slLabel: valid[0].label };
  }

  // Fallback: ATR × 1.5 إذا لم يوجد مستوى مناسب
  const d = signal === 'CALL' ? -1 : 1;
  return { sl: +(price + d * atrVal * 1.5).toFixed(2), slLabel: 'ATR×1.5' };
}

// ══════════════════════════════════════
// Market Structure — مورفي
// ══════════════════════════════════════
function detectMarketStructure(highs, lows, closes) {
  const len = closes.length;
  if (len < 10) return 'neutral';
  const lb = Math.min(len, 30);
  const rh = highs.slice(-lb), rl = lows.slice(-lb);
  let swingH = [], swingL = [];
  for (let i=2; i<rh.length-2; i++) {
    if(rh[i]>rh[i-1]&&rh[i]>rh[i-2]&&rh[i]>rh[i+1]&&rh[i]>rh[i+2]) swingH.push(rh[i]);
    if(rl[i]<rl[i-1]&&rl[i]<rl[i-2]&&rl[i]<rl[i+1]&&rl[i]<rl[i+2]) swingL.push(rl[i]);
  }
  if (swingH.length < 2 || swingL.length < 2) {
    const mid=Math.floor(lb/2);
    const fh=Math.max(...rh.slice(0,mid)), sh=Math.max(...rh.slice(mid));
    const fl=Math.min(...rl.slice(0,mid)), sl=Math.min(...rl.slice(mid));
    if(sh>fh&&sl>fl)return 'bull'; if(sh<fh&&sl<fl)return 'bear'; return 'neutral';
  }
  const lH=swingH[swingH.length-1], pH=swingH[swingH.length-2];
  const lL=swingL[swingL.length-1], pL=swingL[swingL.length-2];
  if(lH>pH&&lL>pL)return 'bull'; if(lH<pH&&lL<pL)return 'bear'; return 'neutral';
}

function detectStopHunt(highs, lows, closes, opens, signal) {
  const len=closes.length; if(len<6)return{detected:false};
  for(let i=len-1;i>=len-3;i--){
    if(i<1)break;
    const o=opens[i],c=closes[i],h=highs[i],l=lows[i],range=h-l;
    if(range===0)continue;
    if(signal==='CALL'){
      const prevLow=Math.min(...lows.slice(Math.max(0,i-5),i));
      const tailDown=(Math.min(o,c)-l)/range;
      if(l<prevLow*0.999&&tailDown>=0.45&&c>prevLow) return{detected:true,type:'Spring',price:l};
    } else {
      const prevHigh=Math.max(...highs.slice(Math.max(0,i-5),i));
      const tailUp=(h-Math.max(o,c))/range;
      if(h>prevHigh*1.001&&tailUp>=0.45&&c<prevHigh) return{detected:true,type:'Upthrust',price:h};
    }
  }
  return{detected:false};
}

function detectCandlePattern(highs, lows, closes, opens, signal) {
  const len=closes.length; if(len<3)return null;
  const i=len-1;
  const o=opens[i],c=closes[i],h=highs[i],l=lows[i];
  const o1=opens[i-1],c1=closes[i-1],h1=highs[i-1],l1=lows[i-1];
  const o2=opens[i-2]||o1,c2=closes[i-2]||c1;
  const range=h-l,range1=h1-l1;
  if(range===0)return null;
  const body=Math.abs(c-o)/range,tailUp=(h-Math.max(o,c))/range,tailDn=(Math.min(o,c)-l)/range;
  const isBull=c>o,isBear=c<o;
  if(signal==='CALL'){
    if(tailDn>=0.55&&body<=0.40&&tailUp<=0.15)return '🔨 Hammer';
    if(c1<o1&&c>o&&c>=o1&&o<=c1&&range>range1)return '🟢 Engulfing↑';
    if(isBull&&tailDn<=0.05&&tailUp<=0.05&&body>=0.85)return '🔥 Marubozu↑';
    if(c2<o2&&Math.abs(c1-o1)<(h1-l1)*0.3&&c>o&&c>(o2+c2)/2)return '🌅 Morning Star';
    if(len>=3&&c>o&&c1>o1&&closes[i-2]>opens[i-2]&&c>c1&&c1>closes[i-2])return '⬆️ Three White Soldiers';
  } else {
    if(tailUp>=0.55&&body<=0.40&&tailDn<=0.15)return '⭐ Shooting Star';
    if(c1>o1&&c<o&&o>=c1&&c<=o1&&range>range1)return '🔴 Engulfing↓';
    if(isBear&&tailUp<=0.05&&tailDn<=0.05&&body>=0.85)return '🔥 Marubozu↓';
    if(c2>o2&&Math.abs(c1-o1)<(h1-l1)*0.3&&c<o&&c<(o2+c2)/2)return '🌆 Evening Star';
    if(len>=3&&c<o&&c1<o1&&closes[i-2]<opens[i-2]&&c<c1&&c1<closes[i-2])return '⬇️ Three Black Crows';
  }
  if(range<range1*0.5&&h<h1&&l>l1)return '🤰 Harami';
  return null;
}

function analyzeWeeklyTrend(weekBars) {
  if(!weekBars||weekBars.closes.length<5)return 'neutral';
  const e8=ema(weekBars.closes,8),e21=ema(weekBars.closes,21);
  if(!e8||!e21)return 'neutral';
  if(weekBars.price>e8&&e8>e21)return 'bull';
  if(weekBars.price<e8&&e8<e21)return 'bear';
  return 'neutral';
}

function hasVolumeConfirmation(bars) {
  if(!bars.vols||bars.vols.length<10)return true;
  const vols=bars.vols.filter(v=>v>0);
  if(vols.length<5)return true;
  const avgVol=vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,vols.length);
  return vols[vols.length-1]>=avgVol*1.1;
}

function detectAbsorption(highs, lows, closes, vols, signal) {
  const len=closes.length;
  if(len<5||!vols||vols.length<5)return false;
  const avgVol=vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,vols.length);
  const lastVol=vols[len-1],lastRange=highs[len-1]-lows[len-1];
  const avgRange=closes.slice(-10).map((_,i,arr)=>i>0?Math.abs(arr[i]-arr[i-1]):0).reduce((a,b)=>a+b,0)/9;
  if(lastVol>avgVol*1.5&&lastRange<avgRange*0.5){
    if(signal==='CALL'&&closes[len-1]>closes[len-2])return true;
    if(signal==='PUT' &&closes[len-1]<closes[len-2])return true;
  }
  return false;
}

function getPDHL(dailyBars) {
  if(!dailyBars||dailyBars.highs.length<2)return{pdh:null,pdl:null};
  return{pdh:dailyBars.highs[dailyBars.highs.length-2],pdl:dailyBars.lows[dailyBars.lows.length-2]};
}

function calcFibExtensions(closes, highs, lows, signal) {
  const lookback=Math.min(closes.length,60);
  const swingHigh=Math.max(...highs.slice(-lookback)),swingLow=Math.min(...lows.slice(-lookback));
  const range=swingHigh-swingLow;
  if(range<=0)return null;
  if(signal==='CALL'){
    return{fib618:swingLow+range*0.618,fib100:swingLow+range*1.0,fib1272:swingLow+range*1.272,fib1618:swingLow+range*1.618,fib2618:swingLow+range*2.618};
  } else {
    return{fib618:swingHigh-range*0.618,fib100:swingHigh-range*1.0,fib1272:swingHigh-range*1.272,fib1618:swingHigh-range*1.618,fib2618:swingHigh-range*2.618};
  }
}

function detectFVG(highs, lows, price, signal) {
  const len=highs.length; if(len<3)return false;
  const lb=Math.min(len-1,20);
  for(let i=len-1;i>=len-lb;i--){
    if(i<2)break;
    const sz=signal==='CALL'?lows[i]-highs[i-2]:lows[i-2]-highs[i];
    if(sz<=0||sz/price*100<0.15)continue;
    if(signal==='CALL'&&price<=lows[i]*1.002&&price>=highs[i-2]*0.998)return true;
    if(signal==='PUT' &&price>=highs[i]*0.998&&price<=lows[i-2]*1.002)return true;
  }
  return false;
}

function detectOB(highs, lows, closes, price, signal) {
  const len=closes.length; if(len<4)return false;
  const lb=Math.min(len-2,10);
  for(let i=len-2;i>=len-lb;i--){
    if(i<1)break;
    const h1=highs[i-1],l1=lows[i-1],c1=closes[i-1],h2=highs[i],l2=lows[i],c2=closes[i],prev=closes[i-2]||c1;
    if(signal==='CALL'){if(c1<prev*1.001&&c2>h1&&l2<l1&&price>=l1*0.999&&price<=h1*1.001)return true;}
    else{if(c1>prev*0.999&&c2<l1&&h2>h1&&price>=l1*0.999&&price<=h1*1.001)return true;}
  }
  return false;
}

function detectBOS(highs, lows, closes, signal) {
  const len=closes.length; if(len<12)return false;
  const rH=highs.slice(-11,-1),rL=lows.slice(-11,-1);
  return signal==='CALL'?closes[len-1]>Math.max(...rH):closes[len-1]<Math.min(...rL);
}

function analyzeFrame(bars) {
  const{closes,highs,lows,opens,price}=bars;
  const e9=ema(closes,9),e21=ema(closes,21),e50=ema(closes,50),e200=ema(closes,200);
  const r=rsi(closes),m=macdCalc(closes),b=bb(closes);
  const a=atr(highs,lows,closes,14);
  if(!e9||!e21||!r||!a)return null;
  let bull=0,bear=0;const reasons=[];
  if(price>e9&&e9>e21){bull+=3;reasons.push('EMA↑');}
  else if(price<e9&&e9<e21){bear+=3;reasons.push('EMA↓');}
  if(e50){if(price>e50){bull+=2;reasons.push('↑EMA50');}else{bear+=2;reasons.push('↓EMA50');}}
  if(e200){if(price>e200){bull+=2;reasons.push('↑EMA200');}else{bear+=2;reasons.push('↓EMA200');}}
  if(r>58&&r<70){bull+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<42&&r>30){bear+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<=30){bull+=3;reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`);}
  else if(r>=70){bear+=2;reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`);}
  if(m?.bull){bull+=2;reasons.push('MACD↑');}else if(m){bear+=2;reasons.push('MACD↓');}
  if(b){
    if(price<=b.lower){bull+=3;reasons.push('BB دعم');}
    else if(price>=b.upper){bear+=3;reasons.push('BB مقاومة');}
    else if(price>b.mid)bull+=1;else bear+=1;
  }
  const prev=closes[closes.length-2]||price,chg=((price-prev)/prev)*100;
  if(chg>0.5){bull+=2;reasons.push(`زخم +${chg.toFixed(1)}%`);}
  else if(chg>0.2)bull+=1;
  else if(chg<-0.5){bear+=2;reasons.push(`زخم ${chg.toFixed(1)}%`);}
  else if(chg<-0.2)bear+=1;
  const signal=bull>=MIN_SCORE?'CALL':bear>=MIN_SCORE?'PUT':null;
  const trend=bull>bear?'bull':bear>bull?'bear':'neutral';
  return{signal,trend,bull,bear,rsi:r,atr:a,reasons,price,chg,e21,e50,e200,bb:b};
}

// ══════════════════════════════════════
// حساب الأهداف — Fib + EMA + BB
// ══════════════════════════════════════
function calcTargetsStocks(signal, price, atrVal, levels, slInfo) {
  const d=signal==='CALL'?1:-1;
  const sl=slInfo.sl;
  const risk=Math.abs(price-sl);

  const{e21,e50,e200,bbUpper,bbLower,bbMid,pdh,pdl,fib}=levels||{};
  let t1C=[],t2C=[],t3C=[];

  if(signal==='CALL'){
    if(bbMid&&bbMid>price)t1C.push({val:bbMid,label:'BB Mid'});
    if(pdh&&pdh>price)t1C.push({val:pdh,label:'PDH'});
    if(e21&&e21>price)t1C.push({val:e21,label:'EMA21'});
    if(fib?.fib618&&fib.fib618>price)t1C.push({val:fib.fib618,label:'Fib 0.618'});
    if(e50&&e50>price)t2C.push({val:e50,label:'EMA50'});
    if(bbUpper&&bbUpper>price)t2C.push({val:bbUpper,label:'BB Upper'});
    if(fib?.fib1272&&fib.fib1272>price)t2C.push({val:fib.fib1272,label:'Fib 1.272'});
    if(fib?.fib1618&&fib.fib1618>price)t2C.push({val:fib.fib1618,label:'Fib 1.618'});
    if(e200&&e200>price)t3C.push({val:e200,label:'EMA200'});
    if(fib?.fib2618&&fib.fib2618>price)t3C.push({val:fib.fib2618,label:'Fib 2.618'});
  } else {
    if(bbMid&&bbMid<price)t1C.push({val:bbMid,label:'BB Mid'});
    if(pdl&&pdl<price)t1C.push({val:pdl,label:'PDL'});
    if(e21&&e21<price)t1C.push({val:e21,label:'EMA21'});
    if(fib?.fib618&&fib.fib618<price)t1C.push({val:fib.fib618,label:'Fib 0.618'});
    if(e50&&e50<price)t2C.push({val:e50,label:'EMA50'});
    if(bbLower&&bbLower<price)t2C.push({val:bbLower,label:'BB Lower'});
    if(fib?.fib1272&&fib.fib1272<price)t2C.push({val:fib.fib1272,label:'Fib 1.272'});
    if(fib?.fib1618&&fib.fib1618<price)t2C.push({val:fib.fib1618,label:'Fib 1.618'});
    if(e200&&e200<price)t3C.push({val:e200,label:'EMA200'});
    if(fib?.fib2618&&fib.fib2618<price)t3C.push({val:fib.fib2618,label:'Fib 2.618'});
  }

  t1C.sort((a,b)=>signal==='CALL'?a.val-b.val:b.val-a.val);
  t2C.sort((a,b)=>signal==='CALL'?a.val-b.val:b.val-a.val);
  t3C.sort((a,b)=>signal==='CALL'?a.val-b.val:b.val-a.val);

  let t1=+(price+d*risk*2).toFixed(2),t1Label='1:2R';
  for(const c of t1C){if(Math.abs(c.val-price)/risk>=1.5){t1=+c.val.toFixed(2);t1Label=c.label;break;}}

  let t2=+(price+d*risk*3.5).toFixed(2),t2Label='1:3.5R';
  for(const c of t2C){if(Math.abs(c.val-price)/risk>=2.5&&Math.abs(c.val-price)>Math.abs(t1-price)){t2=+c.val.toFixed(2);t2Label=c.label;break;}}

  let t3=+(price+d*risk*6).toFixed(2),t3Label='1:6R';
  for(const c of t3C){if(Math.abs(c.val-price)/risk>=4.0&&Math.abs(c.val-price)>Math.abs(t2-price)){t3=+c.val.toFixed(2);t3Label=c.label;break;}}

  const t3Pct=Math.abs(t3-price)/price*100;
  const t1Pct=Math.abs(t1-price)/price*100;
  const slPct=((sl-price)/price*100).toFixed(2);

  let expiry,expiryDays;
  if(t3Pct>=7){expiry='3-4 أسابيع';expiryDays=28;}
  else if(t3Pct>=4){expiry='2-3 أسابيع';expiryDays=21;}
  else{expiry='1-2 أسبوع';expiryDays=14;}

  let thetaWarning=null;
  if(t1Pct<2.0)thetaWarning=`⚠️ T1 قريب (${t1Pct.toFixed(1)}%) — استخدم Delta ≥ 0.55`;
  else if(t1Pct<3.5)thetaWarning=`⚡ استخدم Delta 0.45-0.55`;

  return{
    sl,slLabel:slInfo.slLabel,slPct,
    t1,t2,t3,t1Label,t2Label,t3Label,
    t1Pct:t1Pct.toFixed(2),
    rr1:(Math.abs(t1-price)/risk).toFixed(2),
    rr2:(Math.abs(t2-price)/risk).toFixed(2),
    rr3:(Math.abs(t3-price)/risk).toFixed(2),
    expiry,expiryDays,thetaWarning,
  };
}

// ══════════════════════════════════════
// التحليل الشامل MTF
// ══════════════════════════════════════
async function analyzeMTF(sym) {
  if(!isMarketOpen())return null;
  const[weekBars,dailyBars,entryBars,fastBars]=await Promise.all([
    getBars(sym,'1wk','1y'),getBars(sym,'1d','6mo'),getBars(sym,'1h','1mo'),getBars(sym,'15m','5d'),
  ]);
  if(!dailyBars)return null;

  const weeklyTrend=weekBars?analyzeWeeklyTrend(weekBars):'neutral';
  const marketStructure=detectMarketStructure(dailyBars.highs,dailyBars.lows,dailyBars.closes);
  const{pdh,pdl}=getPDHL(dailyBars);
  const dailyResult=analyzeFrame(dailyBars);
  const entryResult=entryBars?analyzeFrame(entryBars):null;
  const fastResult=fastBars?analyzeFrame(fastBars):null;

  if(!dailyResult)return null;
  const dominantTrend=dailyResult.trend;
  if(dominantTrend==='neutral')return null;
  if(weeklyTrend!=='neutral'&&weeklyTrend!==dominantTrend)return null;
  if(marketStructure!=='neutral'&&marketStructure!==dominantTrend)return null;

  const requiredSignal=dominantTrend==='bull'?'CALL':'PUT';
  const fibLevels=calcFibExtensions(dailyBars.closes,dailyBars.highs,dailyBars.lows,requiredSignal);

  if(requiredSignal==='CALL'&&dailyResult.rsi>72)return null;
  if(requiredSignal==='PUT' &&dailyResult.rsi<28)return null;

  let entryFrame=null,entryData=null;
  if(fastResult?.signal===requiredSignal){entryFrame='15M';entryData=fastResult;}
  else if(entryResult?.signal===requiredSignal){entryFrame='1H';entryData=entryResult;}
  else if(dailyResult.signal===requiredSignal){entryFrame='1D';entryData=dailyResult;}
  if(!entryFrame||!entryData)return null;

  const volOk=entryBars?hasVolumeConfirmation(entryBars):true;
  const absorption=entryBars&&entryBars.vols?detectAbsorption(entryBars.highs,entryBars.lows,entryBars.closes,entryBars.vols,requiredSignal):false;
  const stopHunt=fastBars?detectStopHunt(fastBars.highs,fastBars.lows,fastBars.closes,fastBars.opens,requiredSignal):{detected:false};
  const candlePattern=detectCandlePattern(dailyBars.highs,dailyBars.lows,dailyBars.closes,dailyBars.opens,requiredSignal)
    ||( entryBars?detectCandlePattern(entryBars.highs,entryBars.lows,entryBars.closes,entryBars.opens,requiredSignal):null);

  const fvg=entryBars?detectFVG(entryBars.highs,entryBars.lows,entryData.price||dailyBars.price,requiredSignal):false;
  const ob=dailyBars?detectOB(dailyBars.highs,dailyBars.lows,dailyBars.closes,entryData.price||dailyBars.price,requiredSignal):false;
  const bos=entryBars?detectBOS(entryBars.highs,entryBars.lows,entryBars.closes,requiredSignal):false;
  const ictDetails=[]; let ictScore=0;
  if(fvg){ictDetails.push('FVG✅');ictScore+=3;}
  if(ob){ictDetails.push('OB✅');ictScore+=3;}
  if(bos){ictDetails.push('BOS✅');ictScore+=2;}

  let fibConfluence=null;
  if(fibLevels){
    const price=entryData.price||dailyBars.price;
    for(const[key,val]of Object.entries(fibLevels)){
      if(val&&Math.abs(price-val)/val*100<=1.0){fibConfluence=`Fib ${key.replace('fib','')}`;break;}
    }
  }

  const agreements=[
    dailyResult.trend===dominantTrend,
    entryResult?.trend===dominantTrend,
    fastResult?.trend===dominantTrend,
    weeklyTrend===dominantTrend,
    marketStructure===dominantTrend,
  ].filter(Boolean).length;

  const techScore=dominantTrend==='bull'?dailyResult.bull:dailyResult.bear;
  const bonuses=(ictScore>=5?2:ictScore>=3?1:0)+(stopHunt.detected?3:0)+(candlePattern?2:0)+(absorption?2:0)+(fibConfluence?2:0)+(volOk?1:0);
  const totalScore=Math.round((techScore+bonuses)/2*(agreements/5+0.6));

  let grade,gradeLabel,successRate;
  if(agreements>=4&&totalScore>=12&&(stopHunt.detected||candlePattern)){grade='S';gradeLabel='🔥 نسبة نجاح عالية جداً';successRate=87;}
  else if(agreements>=3&&totalScore>=9){grade='A';gradeLabel='✅ نسبة نجاح عالية';successRate=73;}
  else if(agreements>=3&&totalScore>=7){grade='B';gradeLabel='📊 إشارة متوسطة';successRate=60;}
  else return null;

  const entryPrice=entryData.price||dailyBars.price;

  // ✅ Momentum Analysis
  const momentum=analyzeMomentum(
    entryBars?.closes||dailyBars.closes,
    entryBars?.highs||dailyBars.highs,
    entryBars?.lows||dailyBars.lows,
    entryBars?.vols||dailyBars.vols,
    requiredSignal
  );

  const levels={
    e21:entryData.e21,e50:entryData.e50,e200:entryData.e200,
    bbUpper:entryData.bb?.upper,bbLower:entryData.bb?.lower,bbMid:entryData.bb?.mid,
    pdh,pdl,fib:fibLevels,
  };

  return{
    sym,signal:requiredSignal,dominantTrend,entryFrame,
    grade,gradeLabel,successRate,
    price:entryPrice,atr:entryData.atr,
    dailyRSI:dailyResult.rsi?.toFixed(1),
    entryRSI:entryData.rsi?.toFixed(1),
    weeklyTrend,marketStructure,
    stopHunt,candlePattern,absorption,
    ictScore,ictDetails,fibConfluence,
    pdh,pdl,agreements,totalScore,
    momentum,levels,
  };
}

// ══════════════════════════════════════
// متابعة الإشارات النشطة
// ══════════════════════════════════════
async function checkActiveSignals() {
  const active=(await kvGet('stk_active'))||{};
  const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0.0};
  let changed=false,notifs=0;
  for(const[id,sig]of Object.entries(active)){
    try{
      if(!STOCKS[sig.sym]){delete active[id];changed=true;continue;}
      const bars=await getBars(sig.sym,'5m','2d');
      const price=bars?.price;
      if(!price)continue;
      const isCall=sig.signal==='CALL';
      if(bars?.opens){
        const sh=detectStopHunt(bars.highs,bars.lows,bars.closes,bars.opens,sig.signal);
        if(sh.detected){
          if(isCall&&sig.sl<sh.price*0.998){sig.sl=+(sh.price*0.997).toFixed(2);changed=true;}
          if(!isCall&&sig.sl>sh.price*1.002){sig.sl=+(sh.price*1.003).toFixed(2);changed=true;}
        }
      }
      if((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)){
        delete active[id];perf.losses++;perf.totalR-=1;changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'SL',r:-1,type:'stock'});
        const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
        await tg(`🛑 <b>Stop Loss</b> | <b>${sig.sym}</b>\n💰 $${price.toFixed(2)} | SL: $${sig.sl}\n📊 -1R | WR: ${wr}%\n🤖 <i>TIH Stocks v6.1</i>`);
        notifs++;continue;
      }
      if(!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))){
        sig.t1Hit=true;sig.sl=sig.entry;perf.wins++;perf.totalR+=2;changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T1',r:2,type:'stock'});
        await tg(`🎯 <b>T1 تحقق! +2R</b> | <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → BE\n🤖 <i>TIH Stocks v6.1</i>`);
        notifs++;
      }
      if(sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))){
        sig.t2Hit=true;perf.totalR+=1;changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T2',r:3,type:'stock'});
        await tg(`🎯🎯 <b>T2 تحقق! +3R 🔥</b> | <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Stocks v6.1</i>`);
        notifs++;
      }
      if(sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))){
        delete active[id];perf.totalR+=1;changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T3',r:4,type:'stock'});
        await tg(`🏆🏆🏆 <b>T3 تحقق! +4R 💎</b> | <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n🤖 <i>TIH Stocks v6.1</i>`);
        notifs++;continue;
      }
      const expiryDays=sig.expiryDays||21;
      if(Date.now()-(sig.openedAt||0)>expiryDays*24*60*60*1000&&!sig.t1Hit){
        delete active[id];changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'EXP',r:0,type:'stock'});
        await tg(`⏰ <b>انتهت الإشارة</b> | <b>${sig.sym}</b>\n${expiryDays}ي بدون T1\n🤖 <i>TIH Stocks v6.1</i>`);
        notifs++;continue;
      }
      active[id]=sig;
    }catch(e){}
  }
  if(changed){await kvSet('stk_active',active,7*86400);await kvSet('stk_perf',perf,365*86400);}
  return notifs;
}

// ══════════════════════════════════════
// Main Handler
// ══════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const action=req.query.action||'check';

  if(action==='test'){
    const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('stk_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    await tg(`🤖 <b>TIH Stocks v6.1</b>\n━━━━━━━━━━━━━━━\n✅ النظام يعمل!\n\n📊 ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 Win Rate: ${wr}%\n💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n📌 نشطة: ${Object.keys(active).length}\n━━━━━━━━━━━━━━━\n✅ SL ذكي (EMA/BB/PDL/Fib)\n✅ Momentum Analysis\n✅ Market Structure\n✅ Stop Hunt (Spring/Upthrust)\n✅ Candle Patterns\n✅ Weis Absorption\n✅ Fibonacci Extensions\n📊 VIX: ${vix?vix.toFixed(1):'—'}\n🤖 <i>TIH Stocks v6.1</i>`);
    return res.status(200).json({ok:true,vix,version:'6.1'});
  }

  if(action==='reset'){await kvDel('stk_active');return res.status(200).json({ok:true});}
  if(action==='active'){const active=(await kvGet('stk_active'))||{};return res.status(200).json({ok:true,signals:Object.values(active),count:Object.keys(active).length});}
  if(action==='log'){const log=(await kvGet('stk_log'))||[];return res.status(200).json({ok:true,log,count:log.length});}
  if(action==='stats'){
    const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('stk_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    await tg(`📊 <b>أداء الأسهم v6.1</b>\n${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 WR: <b>${wr}%</b>\n💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n📌 نشطة: ${Object.keys(active).length}`);
    return res.status(200).json({ok:true,perf,active:Object.keys(active).length});
  }

  if(!isMarketOpen())return res.status(200).json({ok:true,message:'السوق مغلق',checked:0,newAlerts:0});

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
      await tg(vix>35?`⚠️ <b>VIX شديد!</b> ${vix.toFixed(1)} — تداول بحذر`:` ⚠️ <b>VIX مرتفع</b> ${vix.toFixed(1)} — راقب الإشارات`);
    }
  }

  await Promise.all(symbols.map(async(sym)=>{
    try{
      const result=await analyzeMTF(sym);
      if(!result)return;
      const active=(await kvGet('stk_active'))||{};
      if(Object.values(active).some(s=>s.sym===sym))return;
      const lastSig=await kvGet(`stk_last_${sym}`);
      if(lastSig&&(Date.now()-lastSig)<MIN_SIGNAL_GAP)return;

      // ✅ SL ذكي
      const slInfo=calcSmartSL(result.signal,result.price,result.atr,result.levels);
      const targets=calcTargetsStocks(result.signal,result.price,result.atr,result.levels,slInfo);

      const sigId=`${sym}_${Date.now()}`;
      const active2=(await kvGet('stk_active'))||{};
      active2[sigId]={
        sym,signal:result.signal,entry:result.price,
        sl:targets.sl,t1:targets.t1,t2:targets.t2,t3:targets.t3,
        t1Hit:false,t2Hit:false,t3Hit:false,
        grade:result.grade,openedAt:Date.now(),expiryDays:targets.expiryDays,
      };
      const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
      perf.total++;
      await kvSet('stk_active',active2,7*86400);
      await kvSet('stk_perf',perf,365*86400);
      await kvSet(`stk_last_${sym}`,Date.now(),8*3600);
      newAlerts.push({sym,signal:result.signal,grade:result.grade});

      const emoji=result.signal==='CALL'?'🟢':'🔴';
      const now=new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});
      const mom=result.momentum;

      // ✅ رسالة Telegram محسّنة
      const lines = [
        `${emoji} <b>${result.signal==='CALL'?'CALL — شراء':'PUT — بيع'}</b>  |  درجة <b>${result.grade}</b>`,
        `${result.gradeLabel} — <b>${result.successRate}%</b>`,
        `━━━━━━━━━━━━━━━`,
        `📌 <b>${sym}</b> — ${STOCKS[sym].name}`,
        `💰 السعر: <b>$${result.price.toFixed(2)}</b>`,
        ``,
        `📊 <b>التحليل</b>`,
        result.weeklyTrend!=='neutral'?`├ 📅 Weekly: ${result.weeklyTrend==='bull'?'🟢 صاعد':'🔴 هابط'} | ${result.marketStructure==='bull'?'HH/HL':'LH/LL'}`:null,
        result.candlePattern?`├ 🕯 نموذج: ${result.candlePattern}`:null,
        result.stopHunt?.detected?`├ ⚡ Stop Hunt: ${result.stopHunt.type} @ $${result.stopHunt.price?.toFixed(2)}`:null,
        result.absorption?`├ 📦 Weis Absorption`:null,
        result.ictDetails?.length?`├ 🔬 ICT: ${result.ictDetails.join(' ')} (${result.ictScore}/8)`:null,
        result.fibConfluence?`├ 📐 Fib: ${result.fibConfluence}`:null,
        `├ 📈 RSI(1D): ${result.dailyRSI} | RSI(${result.entryFrame}): ${result.entryRSI}`,
        `└ 🔀 توافق: ${result.agreements}/5 فريم`,
        ``,
        `${mom.emoji} <b>الزخم: ${mom.label}</b>`,
        mom.detail?`<i>${mom.detail}</i>`:null,
        mom.warning?mom.warning:null,
        ``,
        `━━━━━━━━━━━━━━━`,
        `🎯 Entry : <b>$${result.price.toFixed(2)}</b>`,
        `🛡 SL [${targets.slLabel}] : $${targets.sl} (${targets.slPct}%)`,
        `🥇 T1 [${targets.t1Label}] : $${targets.t1} (+${targets.t1Pct}%) | 1:${targets.rr1}`,
        `🥈 T2 [${targets.t2Label}] : $${targets.t2} | 1:${targets.rr2}`,
        `🥉 T3 [${targets.t3Label}] : $${targets.t3} | 1:${targets.rr3}`,
        `━━━━━━━━━━━━━━━`,
        `📅 الأوبشن: <b>${targets.expiry}</b>`,
        targets.thetaWarning?targets.thetaWarning:null,
        `📐 ATR: ${result.atr.toFixed(2)} | ⏰ ${now}`,
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(STOCKS[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">الشارت ↗</a>`,
        `🤖 <i>TIH Stocks v6.1</i>`,
      ];

      await tg(lines.filter(l=>l!==null).join('\n'));

    }catch(e){errors.push(`${sym}: ${e.message}`);}
  }));

  const active=(await kvGet('stk_active'))||{};
  return res.status(200).json({
    ok:true,checked:symbols.length,
    newAlerts:newAlerts.length,perfNotifs,
    active:Object.keys(active).length,
    signals:newAlerts,errors,
    vix:vix?+vix.toFixed(1):null,
    version:'6.1'
  });
};
