const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ══════════════════════════════════════════════════════
// TIH Indices v6.0
// مبني على: مورفي + القاسم + أبو سهيل + وايكوف
// بدون Kill Zone — يعمل طوال ساعات السوق
// ══════════════════════════════════════════════════════

const INDICES = {
  'US500': { yahoo: 'ES=F',    name: 'S&P 500',    tv: 'OANDA:SPX500USD' },
  'NDX':   { yahoo: '^NDX',    name: 'Nasdaq 100',  tv: 'NASDAQ:NDX'      },
  'DJI':   { yahoo: '^DJI',    name: 'Dow Jones',   tv: 'DJ:DJI'          },
  'BTC':   { yahoo: 'BTC-USD', name: 'Bitcoin',     tv: 'CRYPTO:BTCUSD'   },
  'ETH':   { yahoo: 'ETH-USD', name: 'Ethereum',    tv: 'CRYPTO:ETHUSD'   },
  'XAUUSD':{ yahoo: 'GC=F',    name: 'Gold',        tv: 'OANDA:XAUUSD'    },
};

const CRYPTO_SYMS = new Set(['BTC','ETH']);
const TV_INTERVAL = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };
const MIN_SCORE   = 10;
const MIN_SIGNAL_GAP = 4 * 60 * 60 * 1000; // 4 ساعات بين إشارات نفس الرمز

let vixCache = { value: null, ts: 0 };

// ══════════════════════════════════════
// Yahoo Finance
// ══════════════════════════════════════
async function getBars(sym, interval, range) {
  const yahooSym = sym === '^VIX' ? '^VIX' : (INDICES[sym]?.yahoo || sym);
  return new Promise((resolve) => {
    const path = `/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${interval}&range=${range}`;
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
          const raw_c = quotes.close  || [];
          const raw_h = quotes.high   || [];
          const raw_l = quotes.low    || [];
          const raw_o = quotes.open   || [];
          const raw_v = quotes.volume || [];
          const valid = raw_c.map((c,i) => c != null && c > 0 && raw_h[i] > 0 && raw_l[i] > 0);
          const closes = raw_c.filter((_,i) => valid[i]);
          const highs  = raw_h.filter((_,i) => valid[i]);
          const lows   = raw_l.filter((_,i) => valid[i]);
          const opens  = raw_o.filter((_,i) => valid[i]);
          const vols   = raw_v.filter((_,i) => valid[i]).map(v => v || 0);
          if (closes.length < 5) { resolve(null); return; }
          resolve({ closes, highs, lows, opens, vols, price: closes[closes.length-1], ts: timestamps[timestamps.length-1] });
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function isMarketOpen(sym) {
  if (CRYPTO_SYMS.has(sym)) return true;
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
    const log = (await kvGet('idx_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 200) log.splice(200);
    await kvSet('idx_log', log, 90*86400);
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
function sma(p, n) {
  if (!p || p.length < n) return null;
  return p.slice(-n).reduce((a,b)=>a+b,0)/n;
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
function macd(p) {
  const e12=ema(p,12), e26=ema(p,26);
  if (!e12||!e26) return null;
  return { val: e12-e26, bull: e12>e26 };
}
function bb(p, n=20) {
  if (!p || p.length<n) return null;
  const s=p.slice(-n), m=s.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/n);
  return { upper:m+2*sd, mid:m, lower:m-2*sd };
}

// ══════════════════════════════════════
// VWAP يومي (تقريبي من بيانات intraday)
// ══════════════════════════════════════
function calcVWAP(highs, lows, closes, vols) {
  if (!highs || highs.length < 2) return null;
  let tpv = 0, vol = 0;
  const len = Math.min(highs.length, 78); // ~تقريب يوم كامل على 5m
  for (let i = highs.length - len; i < highs.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const v  = vols[i] || 1;
    tpv += tp * v;
    vol += v;
  }
  return vol > 0 ? tpv / vol : null;
}

// ══════════════════════════════════════
// PDH/PDL — من البيانات اليومية
// ══════════════════════════════════════
function getPDHL(dailyBars) {
  if (!dailyBars || dailyBars.highs.length < 2) return { pdh: null, pdl: null };
  const idx = dailyBars.highs.length - 2;
  return { pdh: dailyBars.highs[idx], pdl: dailyBars.lows[idx] };
}

// ══════════════════════════════════════
// Market Structure — مورفي + وايكوف
// HH/HL = Uptrend | LH/LL = Downtrend
// ══════════════════════════════════════
function detectMarketStructure(highs, lows, closes) {
  const len = closes.length;
  if (len < 10) return 'neutral';
  const lb = Math.min(len, 20);
  const recent_h = highs.slice(-lb);
  const recent_l = lows.slice(-lb);
  // تحديد Swing Highs و Swing Lows
  let swingHighs = [], swingLows = [];
  for (let i = 2; i < recent_h.length - 2; i++) {
    if (recent_h[i] > recent_h[i-1] && recent_h[i] > recent_h[i-2] &&
        recent_h[i] > recent_h[i+1] && recent_h[i] > recent_h[i+2]) swingHighs.push(recent_h[i]);
    if (recent_l[i] < recent_l[i-1] && recent_l[i] < recent_l[i-2] &&
        recent_l[i] < recent_l[i+1] && recent_l[i] < recent_l[i+2]) swingLows.push(recent_l[i]);
  }
  if (swingHighs.length < 2 || swingLows.length < 2) {
    // fallback بسيط
    const mid = Math.floor(lb/2);
    const firstHalf_h = Math.max(...recent_h.slice(0, mid));
    const secondHalf_h = Math.max(...recent_h.slice(mid));
    const firstHalf_l = Math.min(...recent_l.slice(0, mid));
    const secondHalf_l = Math.min(...recent_l.slice(mid));
    if (secondHalf_h > firstHalf_h && secondHalf_l > firstHalf_l) return 'bull'; // HH + HL
    if (secondHalf_h < firstHalf_h && secondHalf_l < firstHalf_l) return 'bear'; // LH + LL
    return 'neutral';
  }
  const lastH = swingHighs[swingHighs.length-1], prevH = swingHighs[swingHighs.length-2];
  const lastL = swingLows[swingLows.length-1],  prevL = swingLows[swingLows.length-2];
  if (lastH > prevH && lastL > prevL) return 'bull'; // HH + HL
  if (lastH < prevH && lastL < prevL) return 'bear'; // LH + LL
  return 'neutral';
}

// ══════════════════════════════════════
// Stop Hunt Detection — وايكوف (Spring/Upthrust)
// السعر يخترق قمة/قاع ثم يرتد بسرعة
// ══════════════════════════════════════
function detectStopHunt(highs, lows, closes, opens, signal) {
  const len = closes.length;
  if (len < 6) return { detected: false };
  // نبحث في آخر 3 شموع
  for (let i = len-1; i >= len-3; i--) {
    if (i < 1) break;
    const o = opens[i], c = closes[i], h = highs[i], l = lows[i];
    const range = h - l;
    if (range === 0) continue;

    if (signal === 'CALL') {
      // Spring: اختراق قاع ثم إغلاق فوقه — وايكوف
      const prevLow = Math.min(...lows.slice(Math.max(0,i-5), i));
      const tailDown = (Math.min(o,c) - l) / range;
      const bodyUp   = (c - o) / range;
      if (l < prevLow * 0.999 && tailDown >= 0.45 && c > prevLow) {
        return { detected: true, type: 'Spring', price: l };
      }
    } else {
      // Upthrust: اختراق قمة ثم إغلاق تحتها — وايكوف
      const prevHigh = Math.max(...highs.slice(Math.max(0,i-5), i));
      const tailUp   = (h - Math.max(o,c)) / range;
      const bodyDown = (o - c) / range;
      if (h > prevHigh * 1.001 && tailUp >= 0.45 && c < prevHigh) {
        return { detected: true, type: 'Upthrust', price: h };
      }
    }
  }
  return { detected: false };
}

// ══════════════════════════════════════
// Candle Patterns — القاسم + مورفي
// ══════════════════════════════════════
function detectCandlePattern(highs, lows, closes, opens, signal) {
  const len = closes.length;
  if (len < 3) return null;
  const patterns = [];
  const i = len - 1;
  const o=opens[i], c=closes[i], h=highs[i], l=lows[i];
  const o1=opens[i-1], c1=closes[i-1], h1=highs[i-1], l1=lows[i-1];
  const range = h-l, range1 = h1-l1;
  if (range === 0) return null;

  const body    = Math.abs(c-o)/range;
  const tailUp  = (h - Math.max(o,c)) / range;
  const tailDn  = (Math.min(o,c) - l) / range;
  const body1   = range1 > 0 ? Math.abs(c1-o1)/range1 : 0;
  const isBull  = c > o;
  const isBear  = c < o;

  if (signal === 'CALL') {
    // Hammer (المطرقة) — القاسم: ظل سفلي طويل ≥ 2× الجسد، ظل علوي قصير
    if (tailDn >= 0.55 && body <= 0.40 && tailUp <= 0.15) patterns.push('🔨 Hammer');
    // Bullish Engulfing (الابتلاع الصاعد) — القاسم
    if (c1 < o1 && c > o && c >= o1 && o <= c1 && range > range1) patterns.push('🟢 Engulfing↑');
    // Bullish Marubozu — جسد كبير بدون ظلال
    if (isBull && tailDn <= 0.05 && tailUp <= 0.05 && body >= 0.85) patterns.push('🔥 Marubozu↑');
    // Dragonfly Doji — القاسم: ظل سفلي طويل جداً
    if (tailDn >= 0.70 && body <= 0.10) patterns.push('🐉 Dragonfly Doji');
    // Piercing Pattern — شمعة حمراء ثم خضراء تفتح تحت وتغلق فوق المنتصف
    if (c1 < o1 && c > o && o < l1 && c > (o1+c1)/2 && c < o1) patterns.push('🔰 Piercing');
  } else {
    // Shooting Star (النيزك) — القاسم: ظل علوي طويل ≥ 2× الجسد
    if (tailUp >= 0.55 && body <= 0.40 && tailDn <= 0.15) patterns.push('⭐ Shooting Star');
    // Bearish Engulfing — القاسم
    if (c1 > o1 && c < o && o >= c1 && c <= o1 && range > range1) patterns.push('🔴 Engulfing↓');
    // Bearish Marubozu
    if (isBear && tailUp <= 0.05 && tailDn <= 0.05 && body >= 0.85) patterns.push('🔥 Marubozu↓');
    // Gravestone Doji — القاسم: ظل علوي طويل جداً
    if (tailUp >= 0.70 && body <= 0.10) patterns.push('🪦 Gravestone Doji');
    // Dark Cloud Cover — شمعة خضراء ثم حمراء تفتح فوق وتغلق تحت المنتصف
    if (c1 > o1 && c < o && o > h1 && c < (o1+c1)/2 && c > o1) patterns.push('☁️ Dark Cloud');
  }
  // Doji عام (تردد)
  if (body <= 0.08 && (tailDn >= 0.35 || tailUp >= 0.35)) patterns.push('➕ Doji');

  return patterns.length > 0 ? patterns[0] : null; // أهم نموذج فقط
}

// ══════════════════════════════════════
// Weekly Trend
// ══════════════════════════════════════
function analyzeWeeklyTrend(weekBars) {
  if (!weekBars || weekBars.closes.length < 5) return 'neutral';
  const e8  = ema(weekBars.closes, 8);
  const e21 = ema(weekBars.closes, 21);
  if (!e8 || !e21) return 'neutral';
  if (weekBars.price > e8 && e8 > e21) return 'bull';
  if (weekBars.price < e8 && e8 < e21) return 'bear';
  return 'neutral';
}

// ══════════════════════════════════════
// Volume Confirmation — وايكوف
// ══════════════════════════════════════
function hasVolumeConfirmation(bars) {
  if (!bars.vols || bars.vols.length < 10) return true;
  const vols = bars.vols.filter(v => v > 0);
  if (vols.length < 5) return true;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  return vols[vols.length-1] >= avgVol * 0.8;
}

// ══════════════════════════════════════
// ICT v6 — FVG/OB/BOS/REJ
// ══════════════════════════════════════
function detectFVG(highs, lows, price, signal) {
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
function detectOB(highs, lows, closes, price, signal) {
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
function detectBOS(highs, lows, closes, signal) {
  const len=closes.length; if(len<12)return false;
  const rH=highs.slice(-11,-1), rL=lows.slice(-11,-1);
  const last=closes[len-1];
  return signal==='CALL'?last>Math.max(...rH):last<Math.min(...rL);
}

// ══════════════════════════════════════
// التحليل الكامل — MTF
// ══════════════════════════════════════
function analyzeFrame(bars, minScore=MIN_SCORE) {
  const { closes, highs, lows, opens, price } = bars;
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50), e200=ema(closes,200);
  const r=rsi(closes), m=macd(closes), b=bb(closes);
  const a=atr(highs,lows,closes,14);
  if (!e9||!e21||!r||!a) return null;
  let bull=0, bear=0; const reasons=[];

  // EMA Stack — مورفي
  if(price>e9&&e9>e21){bull+=3;reasons.push('EMA↑');}
  else if(price<e9&&e9<e21){bear+=3;reasons.push('EMA↓');}
  if(e50){if(price>e50){bull+=2;reasons.push('↑EMA50');}else{bear+=2;reasons.push('↓EMA50');}}
  if(e200){if(price>e200){bull+=2;reasons.push('↑EMA200');}else{bear+=2;reasons.push('↓EMA200');}}

  // RSI
  if(r>55&&r<72){bull+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<45&&r>28){bear+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<=28){bull+=3;reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`);}
  else if(r>=72){bear+=2;reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`);}

  // MACD
  if(m?.bull){bull+=2;reasons.push('MACD↑');}else if(m){bear+=2;reasons.push('MACD↓');}

  // Bollinger Bands
  if(b){
    if(price<=b.lower){bull+=3;reasons.push('BB دعم');}
    else if(price>=b.upper){bear+=3;reasons.push('BB مقاومة');}
    else if(price>b.mid)bull+=1; else bear+=1;
  }

  // Momentum
  const prev=closes[closes.length-2]||price, chg=((price-prev)/prev)*100;
  if(chg>0.3){bull+=2;reasons.push(`زخم +${chg.toFixed(1)}%`);}
  else if(chg>0.1)bull+=1;
  else if(chg<-0.3){bear+=2;reasons.push(`زخم ${chg.toFixed(1)}%`);}
  else if(chg<-0.1)bear+=1;

  const signal=bull>=minScore?'CALL':bear>=minScore?'PUT':null;
  const trend=bull>bear?'bull':bear>bull?'bear':'neutral';
  return { signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg, e21, e50, e200, bb:b };
}

// ══════════════════════════════════════
// حساب الأهداف — للمؤشرات
// يعتمد على: VWAP + PDH/PDL + Round Numbers + ATR
// ══════════════════════════════════════
function calcTargetsIndices(signal, price, atrVal, levels) {
  const d = signal === 'CALL' ? 1 : -1;
  const sl  = +(price - d * atrVal * 1.5).toFixed(2);
  const risk = Math.abs(price - sl);

  // أهداف مبنية على مستويات حقيقية — أبو سهيل
  const { vwap, pdh, pdl, e21, e50, bbUpper, bbLower, bbMid } = levels || {};
  let t1Candidates = [], t2Candidates = [], t3Candidates = [];

  if (signal === 'CALL') {
    if (vwap  && vwap  > price) t1Candidates.push({ val: vwap,    label: 'VWAP'     });
    if (pdh   && pdh   > price) t1Candidates.push({ val: pdh,     label: 'PDH'      });
    if (bbMid && bbMid > price) t1Candidates.push({ val: bbMid,   label: 'BB Mid'   });
    if (e21   && e21   > price) t1Candidates.push({ val: e21,     label: 'EMA21'    });
    if (bbUpper && bbUpper > price) t2Candidates.push({ val: bbUpper, label: 'BB Upper' });
    if (e50   && e50   > price) t2Candidates.push({ val: e50,     label: 'EMA50'    });
    // Round Numbers — نقاط مستديرة كـ 5500, 5550
    const rn = Math.ceil(price / 50) * 50;
    if (rn > price) t1Candidates.push({ val: rn, label: `${rn} Round` });
    t3Candidates.push({ val: price + d * risk * 5, label: '1:5R' });
  } else {
    if (vwap  && vwap  < price) t1Candidates.push({ val: vwap,    label: 'VWAP'     });
    if (pdl   && pdl   < price) t1Candidates.push({ val: pdl,     label: 'PDL'      });
    if (bbMid && bbMid < price) t1Candidates.push({ val: bbMid,   label: 'BB Mid'   });
    if (e21   && e21   < price) t1Candidates.push({ val: e21,     label: 'EMA21'    });
    if (bbLower && bbLower < price) t2Candidates.push({ val: bbLower, label: 'BB Lower' });
    if (e50   && e50   < price) t2Candidates.push({ val: e50,     label: 'EMA50'    });
    const rn = Math.floor(price / 50) * 50;
    if (rn < price) t1Candidates.push({ val: rn, label: `${rn} Round` });
    t3Candidates.push({ val: price + d * risk * 5, label: '1:5R' });
  }

  // فرز وأخذ أقرب هدف كافٍ (RR ≥ 1.5)
  t1Candidates.sort((a,b) => signal==='CALL' ? a.val-b.val : b.val-a.val);
  t2Candidates.sort((a,b) => signal==='CALL' ? a.val-b.val : b.val-a.val);

  let t1 = price + d*risk*2, t1Label = '1:2R';
  for (const c of t1Candidates) {
    if (Math.abs(c.val-price)/risk >= 1.5) { t1=c.val; t1Label=c.label; break; }
  }

  let t2 = price + d*risk*3.5, t2Label = '1:3.5R';
  for (const c of t2Candidates) {
    if (Math.abs(c.val-price)/risk >= 3.0 && Math.abs(c.val-price) > Math.abs(t1-price)) {
      t2=c.val; t2Label=c.label; break;
    }
  }

  let t3 = price + d*risk*5, t3Label = '1:5R';

  t1=+t1.toFixed(2); t2=+t2.toFixed(2); t3=+t3.toFixed(2);
  const t1Pct = Math.abs(t1-price)/price*100;

  return {
    sl, t1, t2, t3, t1Label, t2Label, t3Label,
    slPct: ((sl-price)/price*100).toFixed(2),
    t1Pct: t1Pct.toFixed(2),
    rr1: (Math.abs(t1-price)/risk).toFixed(2),
    rr2: (Math.abs(t2-price)/risk).toFixed(2),
    rr3: (Math.abs(t3-price)/risk).toFixed(2),
  };
}

// ══════════════════════════════════════
// التحليل الشامل MTF
// ══════════════════════════════════════
async function analyzeMTF(sym, vix) {
  if (!isMarketOpen(sym)) return null;

  const cfg = INDICES[sym];
  const [weekBars, dailyBars, trendBars, entryBars, fastBars] = await Promise.all([
    CRYPTO_SYMS.has(sym) ? null : getBars(sym, '1wk', '1y'),
    getBars(sym, '1d',  '3mo'),
    getBars(sym, '1h',  '1mo'),
    getBars(sym, '15m', '5d'),
    getBars(sym, '5m',  '2d'),
  ]);

  if (!trendBars) return null;

  // VWAP من بيانات intraday
  const vwapVal = fastBars ? calcVWAP(fastBars.highs, fastBars.lows, fastBars.closes, fastBars.vols) : null;

  // PDH/PDL من اليومي
  const { pdh, pdl } = getPDHL(dailyBars);

  // Weekly Trend
  const weeklyTrend = weekBars ? analyzeWeeklyTrend(weekBars) : 'neutral';

  // Market Structure — مورفي
  const marketStructure = detectMarketStructure(trendBars.highs, trendBars.lows, trendBars.closes);

  // تحليل الفريمات
  const trendResult = analyzeFrame(trendBars);
  const entryResult = entryBars ? analyzeFrame(entryBars) : null;
  const fastResult  = fastBars  ? analyzeFrame(fastBars)  : null;

  if (!trendResult) return null;
  const dominantTrend = trendResult.trend;
  if (dominantTrend === 'neutral') return null;

  // Weekly Trend يجب أن يتوافق
  if (!CRYPTO_SYMS.has(sym) && weeklyTrend !== 'neutral' && weeklyTrend !== dominantTrend) return null;

  // Market Structure يجب أن يتوافق
  if (marketStructure !== 'neutral' && marketStructure !== dominantTrend) return null;

  const requiredSignal = dominantTrend === 'bull' ? 'CALL' : 'PUT';

  // RSI Extremes
  if (requiredSignal === 'CALL' && trendResult.rsi > 78) return null;
  if (requiredSignal === 'PUT'  && trendResult.rsi < 22) return null;

  // إيجاد أفضل فريم دخول
  let entryFrame = null, entryData = null;
  if (fastResult?.signal === requiredSignal)  { entryFrame='5M';  entryData=fastResult;  }
  else if (entryResult?.signal === requiredSignal) { entryFrame='15M'; entryData=entryResult; }
  else if (trendResult.signal === requiredSignal)  { entryFrame='1H';  entryData=trendResult; }
  if (!entryFrame || !entryData) return null;

  // Volume Confirmation — وايكوف
  const volOk = fastBars ? hasVolumeConfirmation(fastBars) : true;

  // Stop Hunt Detection — وايكوف
  const stopHunt = fastBars
    ? detectStopHunt(fastBars.highs, fastBars.lows, fastBars.closes, fastBars.opens, requiredSignal)
    : { detected: false };

  // Candle Pattern — القاسم
  const candlePattern = fastBars
    ? detectCandlePattern(fastBars.highs, fastBars.lows, fastBars.closes, fastBars.opens, requiredSignal)
    : null;

  // ICT
  const fvg = entryBars ? detectFVG(entryBars.highs, entryBars.lows, entryData.price||trendBars.price, requiredSignal) : false;
  const ob  = trendBars ? detectOB(trendBars.highs, trendBars.lows, trendBars.closes, entryData.price||trendBars.price, requiredSignal) : false;
  const bos = entryBars ? detectBOS(entryBars.highs, entryBars.lows, entryBars.closes, requiredSignal) : false;
  const ictDetails = [];
  let ictScore = 0;
  if (fvg) { ictDetails.push('FVG✅'); ictScore+=3; }
  if (ob)  { ictDetails.push('OB✅');  ictScore+=3; }
  if (bos) { ictDetails.push('BOS✅'); ictScore+=2; }

  // VWAP Confluence — أبو سهيل
  let vwapConfluence = false;
  if (vwapVal) {
    const dist = Math.abs(entryData.price - vwapVal) / vwapVal * 100;
    if (dist <= 0.5) vwapConfluence = true;
  }

  // PDH/PDL Confluence
  let pdhlConfluence = false;
  const entryPrice = entryData.price || trendBars.price;
  if (requiredSignal === 'CALL' && pdl) {
    const dist = Math.abs(entryPrice - pdl) / pdl * 100;
    if (dist <= 0.5) pdhlConfluence = true;
  } else if (requiredSignal === 'PUT' && pdh) {
    const dist = Math.abs(entryPrice - pdh) / pdh * 100;
    if (dist <= 0.5) pdhlConfluence = true;
  }

  // التوافق بين الفريمات
  const agreements = [
    trendResult.trend === dominantTrend,
    entryResult?.trend === dominantTrend,
    fastResult?.trend === dominantTrend,
    !CRYPTO_SYMS.has(sym) ? weeklyTrend === dominantTrend : true,
    marketStructure === dominantTrend,
  ].filter(Boolean).length;

  // حساب الدرجة الكلية
  const techScore = dominantTrend === 'bull' ? trendResult.bull : trendResult.bear;
  const bonuses = (ictScore >= 5 ? 2 : ictScore >= 3 ? 1 : 0)
                + (stopHunt.detected ? 3 : 0)    // Stop Hunt = دخول قوي — وايكوف
                + (candlePattern ? 2 : 0)          // نموذج شموع — القاسم
                + (vwapConfluence ? 2 : 0)          // VWAP Confluence — أبو سهيل
                + (pdhlConfluence ? 2 : 0)          // PDH/PDL Confluence
                + (volOk ? 1 : 0);                  // Volume — وايكوف

  const totalScore = Math.round((techScore + bonuses) / 2 * (agreements / 5 + 0.6));

  // Grade
  let grade, gradeLabel, successRate;
  if (agreements >= 4 && totalScore >= 12 && (stopHunt.detected || candlePattern)) {
    grade='S'; gradeLabel='🔥 نسبة نجاح عالية جداً'; successRate=87;
  } else if (agreements >= 3 && totalScore >= 9) {
    grade='A'; gradeLabel='✅ نسبة نجاح عالية'; successRate=73;
  } else if (agreements >= 3 && totalScore >= 7) {
    grade='B'; gradeLabel='📊 إشارة متوسطة'; successRate=60;
  } else {
    return null;
  }

  return {
    sym, signal: requiredSignal, dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price: entryPrice, atr: entryData.atr,
    trendRSI: trendResult.rsi?.toFixed(1),
    entryRSI: entryData.rsi?.toFixed(1),
    weeklyTrend, marketStructure,
    stopHunt, candlePattern,
    ictScore, ictDetails,
    vwapVal, vwapConfluence,
    pdh, pdl, pdhlConfluence,
    agreements, totalScore,
    vix: vix ? vix.toFixed(1) : null,
    levels: {
      vwap: vwapVal, pdh, pdl,
      e21: entryData.e21, e50: entryData.e50,
      bbUpper: entryData.bb?.upper, bbLower: entryData.bb?.lower, bbMid: entryData.bb?.mid,
    },
  };
}

// ══════════════════════════════════════
// متابعة الإشارات النشطة
// ══════════════════════════════════════
async function checkActiveSignals() {
  const active=(await kvGet('idx_active'))||{};
  const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0.0};
  let changed=false, notifs=0;
  for (const [id,sig] of Object.entries(active)) {
    try {
      const cfg=INDICES[sig.sym];
      if(!cfg){delete active[id];changed=true;continue;}
      const bars=await getBars(sig.sym,'5m','2d');
      const price=bars?.price;
      if(!price)continue;
      const isCall=sig.signal==='CALL';

      // Stop Hunt Protection — وايكوف
      // إذا اقترب السعر من SL وظهر Stop Hunt لا نغلق
      if(bars && bars.opens){
        const sh = detectStopHunt(bars.highs, bars.lows, bars.closes, bars.opens, sig.signal);
        if(sh.detected){
          // تحريك SL بشكل ديناميكي
          if(isCall && sig.sl < sh.price * 0.998) { sig.sl = +(sh.price * 0.997).toFixed(2); changed=true; }
          if(!isCall && sig.sl > sh.price * 1.002) { sig.sl = +(sh.price * 1.003).toFixed(2); changed=true; }
        }
      }

      if((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)){
        delete active[id]; perf.losses++; perf.totalR-=1; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'SL',r:-1,type:'index'});
        await tg(`🛑 <b>Stop Loss!</b>\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n💰 $${price.toFixed(2)}\n🛡️ SL: $${sig.sl}\n📊 -1R | WR: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n🤖 <i>TIH Indices v6.0</i>`);
        notifs++; continue;
      }
      if(!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))){
        sig.t1Hit=true; sig.sl=sig.entry; perf.wins++; perf.totalR+=2; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T1',r:2,type:'index'});
        await tg(`🎯 <b>T1 تحقق! +2R</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → BE\n🤖 <i>TIH Indices v6.0</i>`);
        notifs++;
      }
      if(sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))){
        sig.t2Hit=true; perf.totalR+=1.5; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T2',r:3.5,type:'index'});
        await tg(`🎯🎯 <b>T2 تحقق! +3.5R 🔥</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Indices v6.0</i>`);
        notifs++;
      }
      if(sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))){
        delete active[id]; perf.totalR+=1.5; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T3',r:5,type:'index'});
        await tg(`🏆🏆🏆 <b>T3 تحقق! +5R 💎</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n🤖 <i>TIH Indices v6.0</i>`);
        notifs++; continue;
      }
      const age=Date.now()-(sig.openedAt||0);
      if(age>48*60*60*1000&&!sig.t1Hit){
        delete active[id]; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'EXP',r:0,type:'index'});
        await tg(`⏰ <b>انتهت الإشارة</b>\n📌 <b>${sig.sym}</b> — 48س بدون T1\n🤖 <i>TIH Indices v6.0</i>`);
        notifs++; continue;
      }
      active[id]=sig;
    } catch(e) {}
  }
  if(changed){ await kvSet('idx_active',active,7*86400); await kvSet('idx_perf',perf,365*86400); }
  return notifs;
}

// ══════════════════════════════════════
// Main Handler
// ══════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method==='OPTIONS') return res.status(200).end();
  const action = req.query.action || 'check';

  if (action==='test') {
    const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('idx_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    await tg(
      `🤖 <b>TIH Indices v6.0</b>\n━━━━━━━━━━━━━━━\n✅ النظام يعمل!\n\n` +
      `📊 ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n━━━━━━━━━━━━━━━\n` +
      `✅ بدون Kill Zone — يعمل طوال ساعات السوق\n` +
      `✅ Market Structure (HH/HL/LH/LL)\n` +
      `✅ Stop Hunt Detection (Spring/Upthrust)\n` +
      `✅ Candle Patterns (Hammer/Engulfing/...)\n` +
      `✅ VWAP + PDH/PDL Confluence\n` +
      `✅ ICT (FVG/OB/BOS)\n` +
      `✅ Volume Confirmation\n` +
      `📊 VIX: ${vix?vix.toFixed(1):'—'}\n` +
      `📡 Yahoo Finance\n🤖 <i>TIH Indices v6.0</i>`
    );
    return res.status(200).json({ ok:true, vix, version:'6.0' });
  }

  if (action==='reset') { await kvDel('idx_active'); await tg('🔄 Reset\n🤖 TIH Indices v6.0'); return res.status(200).json({ ok:true }); }
  if (action==='active') {
    const active=(await kvGet('idx_active'))||{};
    return res.status(200).json({ok:true,signals:Object.values(active),count:Object.keys(active).length});
  }
  if (action==='log') { const log=(await kvGet('idx_log'))||[]; return res.status(200).json({ok:true,log,count:log.length}); }
  if (action==='stats') {
    const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('idx_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    await tg(`📊 <b>أداء المؤشرات v6.0</b>\n${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 WR: <b>${wr}%</b>\n💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n📌 نشطة: ${Object.keys(active).length}\n📊 VIX: ${vix?vix.toFixed(1):'—'}\n🤖 TIH Indices v6.0`);
    return res.status(200).json({ok:true,perf,active:Object.keys(active).length,vix});
  }

  const symbols=req.query.symbols?req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>INDICES[s]):Object.keys(INDICES);
  const perfNotifs=await checkActiveSignals();
  const newAlerts=[],errors=[],skipped=[];
  const vix=await getVIX();

  // تحذير VIX فقط — بدون إيقاف الإشارات
  if(vix&&vix>25){
    const lastVixAlert=await kvGet('idx_vix_alert');
    const today=new Date().toISOString().split('T')[0];
    if(lastVixAlert!==today){
      await kvSet('idx_vix_alert',today,86400);
      await tg(vix>35
        ?`⚠️ <b>VIX شديد!</b> ${vix.toFixed(1)} — تداول بحذر شديد\n🤖 TIH Indices v6.0`
        :`⚠️ <b>VIX مرتفع</b> ${vix.toFixed(1)} — راقب الإشارات بحذر\n🤖 TIH Indices v6.0`);
    }
  }

  await Promise.all(symbols.map(async (sym) => {
    try {
      if(!isMarketOpen(sym)){skipped.push(sym);return;}
      const result=await analyzeMTF(sym,vix);
      if(!result)return;
      const active=(await kvGet('idx_active'))||{};
      if(Object.values(active).some(s=>s.sym===sym))return;
      // فجوة زمنية بين إشارات نفس الرمز
      const lastSig=await kvGet(`idx_last_${sym}`);
      if(lastSig&&(Date.now()-lastSig)<MIN_SIGNAL_GAP)return;

      const targets=calcTargetsIndices(result.signal,result.price,result.atr,result.levels);
      const sigId=`${sym}_${Date.now()}`;
      active[sigId]={
        sym,signal:result.signal,entry:result.price,
        sl:targets.sl,t1:targets.t1,t2:targets.t2,t3:targets.t3,
        t1Hit:false,t2Hit:false,t3Hit:false,
        grade:result.grade,openedAt:Date.now()
      };
      const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
      perf.total++;
      await kvSet('idx_active',active,7*86400);
      await kvSet('idx_perf',perf,365*86400);
      await kvSet(`idx_last_${sym}`,Date.now(),4*3600);
      newAlerts.push({sym,signal:result.signal,grade:result.grade});

      // رسالة Telegram شاملة
      const emoji=result.signal==='CALL'?'🟢':'🔴';
      const sigType=result.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const now=new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});

      const weekLine = result.weeklyTrend!=='neutral'
        ? `📅 Weekly: ${result.weeklyTrend==='bull'?'🟢 صاعد':'🔴 هابط'} | Structure: ${result.marketStructure==='bull'?'HH/HL':'LH/LL'}\n`
        : '';
      const stopHuntLine = result.stopHunt?.detected
        ? `⚡ <b>Stop Hunt!</b> ${result.stopHunt.type} @ $${result.stopHunt.price?.toFixed(2)}\n`
        : '';
      const candleLine = result.candlePattern
        ? `🕯 نموذج: ${result.candlePattern}\n`
        : '';
      const confluenceLine = (result.vwapConfluence || result.pdhlConfluence)
        ? `🎯 Confluence: ${[result.vwapConfluence?'VWAP':null, result.pdhlConfluence?(result.signal==='CALL'?'PDL':'PDH'):null].filter(Boolean).join(' + ')}\n`
        : '';
      const ictLine = result.ictDetails?.length
        ? `🔬 ICT: ${result.ictDetails.join(' ')} (${result.ictScore}/8)\n`
        : '';
      const vwapLine = result.vwapVal
        ? `📊 VWAP: $${result.vwapVal.toFixed(2)} | PDH: ${result.pdh?'$'+result.pdh.toFixed(2):'—'} | PDL: ${result.pdl?'$'+result.pdl.toFixed(2):'—'}\n`
        : '';

      await tg(
        `${emoji} <b>${sigType}</b>\n${result.gradeLabel} — <b>${result.successRate}%</b>\n━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — ${INDICES[sym].name}\n💰 $${result.price.toFixed(2)}\n` +
        `${weekLine}${stopHuntLine}${candleLine}${confluenceLine}${ictLine}${vwapLine}` +
        `📊 RSI(1H): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}\n` +
        `🔀 التوافق: ${result.agreements}/5 فريم\n━━━━━━━━━━━━━━━\n` +
        `🎯 Entry: $${result.price.toFixed(2)}\n` +
        `🛡️ SL: $${targets.sl} (${targets.slPct}%)\n` +
        `🏆 T1 [${targets.t1Label}]: $${targets.t1} (+${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🏆 T2 [${targets.t2Label}]: $${targets.t2} | 1:${targets.rr2}\n` +
        `🏆 T3 [${targets.t3Label}]: $${targets.t3} | 1:${targets.rr3}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📐 ATR: ${result.atr.toFixed(3)} | VIX: ${result.vix||'—'}\n` +
        `⏰ ${now}\n` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(INDICES[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">الشارت ↗</a>\n` +
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
    version:'6.0'
  });
};
