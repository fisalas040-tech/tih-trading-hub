const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';
const TWELVE_KEY    = process.env.TWELVE_DATA_API_KEY      || '8a2a10389f45439fa4bb70ab582f3f58';
const TWELVE_BASE   = 'api.twelvedata.com';

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

const TV_INTERVAL    = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };
const MIN_SIGNAL_GAP = 6 * 60 * 60 * 1000;

const INTERVALS = {
  weekly: { interval: '1wk', range: '52wk' },
  trend:  { interval: '1d',  range: '180d' },
  entry:  { interval: '1h',  range: '30d'  },
  fast:   { interval: '15m', range: '5d'   },
};

const MIN_SCORE = 14;

let vixCache = { value: null, ts: 0 };

function toTwelveInterval(interval) {
  const map = { '1wk':'1week', '1d':'1day', '1h':'1h', '15m':'15min', '5m':'5min', '1m':'1min' };
  return map[interval] || '1day';
}

function rangeToOutputSize(range) {
  const map = { '52wk':52, '180d':180, '30d':500, '5d':480, '2d':576, '1d':390 };
  return map[range] || 100;
}

async function getBars(sym, interval, range) {
  const symbol = sym === '^VIX' ? 'VIXY' : sym;
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

function isStockKillZone() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 13:30 UTC → 19:30 UTC
  return mins >= 810 && mins <= 1170;
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

// ══════════════════════════════════════
// ✅ الفلتر 1 — سياق السوق الكلي
// SPY/QQQ يجب أن يتوافق مع الإشارة
// ══════════════════════════════════════
let marketContextCache = { data: null, ts: 0 };

async function getMarketContext(signal) {
  // كاش 30 دقيقة
  if (marketContextCache.data && (Date.now() - marketContextCache.ts) < 30 * 60 * 1000) {
    return evaluateMarketContext(marketContextCache.data, signal);
  }
  try {
    const [spyBars, qqqBars] = await Promise.all([
      getBars('SPY', '1d', '180d'),
      getBars('QQQ', '1d', '180d'),
    ]);
    marketContextCache = { data: { spyBars, qqqBars }, ts: Date.now() };
    return evaluateMarketContext(marketContextCache.data, signal);
  } catch(e) { return { ok: true, reason: 'خطأ في جلب السياق' }; }
}

function evaluateMarketContext({ spyBars, qqqBars }, signal) {
  if (!spyBars || spyBars.closes.length < 50) return { ok: true, reason: 'بيانات SPY غير كافية' };
  const spyPrice = spyBars.price;
  const spyEMA20 = ema(spyBars.closes, 20);
  const spyEMA50 = ema(spyBars.closes, 50);
  if (!spyEMA20 || !spyEMA50) return { ok: true, reason: 'EMA غير متاح' };

  if (signal === 'CALL') {
    // لا CALL إذا SPY تحت EMA50 اليومي
    if (spyPrice < spyEMA50 * 0.99) return { ok: false, reason: `❌ SPY تحت EMA50 ($${spyEMA50.toFixed(0)}) — سوق هابط` };
    // تحذير إذا SPY بين EMA20 و EMA50
    if (spyPrice < spyEMA20) return { ok: true, warning: `⚠️ SPY تحت EMA20 — حذر`, spyTrend: 'weak' };
    return { ok: true, spyTrend: 'bull', reason: `✅ SPY فوق EMA20/50` };
  } else {
    // لا PUT إذا SPY فوق EMA20 بقوة
    if (spyPrice > spyEMA20 * 1.02) return { ok: false, reason: `❌ SPY قوي فوق EMA20 — سوق صاعد` };
    if (spyPrice > spyEMA50) return { ok: true, warning: `⚠️ SPY فوق EMA50 — حذر للـ PUT`, spyTrend: 'weak' };
    return { ok: true, spyTrend: 'bear', reason: `✅ SPY تحت EMA20 — مناسب للـ PUT` };
  }
}

// ══════════════════════════════════════
// ✅ الفلتر 2 — Relative Strength
// السهم يجب أن يتفوق على SPY
// ══════════════════════════════════════
async function getRelativeStrength(sym, signal) {
  try {
    const [symBars, spyBars] = await Promise.all([
      getBars(sym, '1d', '30d'),
      getBars('SPY', '1d', '30d'),
    ]);
    if (!symBars || !spyBars || symBars.closes.length < 10 || spyBars.closes.length < 10) {
      return { ok: true, rs: null };
    }
    const n = Math.min(10, symBars.closes.length, spyBars.closes.length);
    const symChg = (symBars.closes[symBars.closes.length-1] - symBars.closes[symBars.closes.length-n]) / symBars.closes[symBars.closes.length-n] * 100;
    const spyChg = (spyBars.closes[spyBars.closes.length-1] - spyBars.closes[spyBars.closes.length-n]) / spyBars.closes[spyBars.closes.length-n] * 100;
    const rs = symChg - spyChg;

    if (signal === 'CALL' && rs < -3) {
      return { ok: false, rs, reason: `❌ ${sym} أضعف من SPY بـ ${Math.abs(rs).toFixed(1)}% — لا تفوق نسبي` };
    }
    if (signal === 'PUT' && rs > 3) {
      return { ok: false, rs, reason: `❌ ${sym} أقوى من SPY بـ ${rs.toFixed(1)}% — لا تفوق هبوطي` };
    }
    return { ok: true, rs, symChg: +symChg.toFixed(1), spyChg: +spyChg.toFixed(1) };
  } catch(e) { return { ok: true, rs: null }; }
}

// ══════════════════════════════════════
// ✅ الفلتر 3 — Earnings Filter
// لا دخول قبل Earnings بـ 7 أيام
// ══════════════════════════════════════
async function checkEarnings(sym) {
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=calendarEvents`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await r.json();
    const earnings = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
    if (!earnings?.earningsDate?.[0]) return { safe: true };
    const earningsTs = earnings.earningsDate[0].raw * 1000;
    const daysUntil = Math.floor((earningsTs - Date.now()) / 86400000);
    if (daysUntil >= 0 && daysUntil <= 7) {
      return { safe: false, daysUntil, reason: `⚠️ Earnings خلال ${daysUntil} أيام — IV مرتفع` };
    }
    return { safe: true, daysUntil };
  } catch(e) { return { safe: true }; }
}

// ══════════════════════════════════════
// ✅ الفلتر 4 — Sector Momentum
// السهم في قطاع قوي أم ضعيف؟
// ══════════════════════════════════════
const SECTOR_MAP = {
  'AAPL':'XLK','MSFT':'XLK','NVDA':'XLK','AMD':'XLK','AVGO':'XLK','MRVL':'XLK',
  'META':'XLK','GOOGL':'XLK','AMZN':'XLY',
  'JPM':'XLF',
};

async function getSectorMomentum(sym, signal) {
  try {
    const sector = SECTOR_MAP[sym];
    if (!sector) return { ok: true, sector: null };
    const sectorBars = await getBars(sector, '1d', '30d');
    if (!sectorBars || sectorBars.closes.length < 20) return { ok: true, sector };
    const e20 = ema(sectorBars.closes, 20);
    const sectorPrice = sectorBars.price;
    if (signal === 'CALL' && sectorPrice < e20 * 0.99) {
      return { ok: false, sector, reason: `❌ قطاع ${sector} ضعيف — تحت EMA20` };
    }
    if (signal === 'PUT' && sectorPrice > e20 * 1.01) {
      return { ok: false, sector, reason: `❌ قطاع ${sector} قوي — فوق EMA20` };
    }
    return { ok: true, sector, sectorTrend: sectorPrice > e20 ? 'bull' : 'bear' };
  } catch(e) { return { ok: true, sector: SECTOR_MAP[sym] || null }; }
}

function hasVolumeConfirmation(bars) {
  if (!bars.vols || bars.vols.length < 20) return true;
  const vols = bars.vols.filter(v => v > 0);
  if (vols.length < 10) return true;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  return vols[vols.length-1] >= avgVol * 1.1;
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
    const log = (await kvGet('stk_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 500) log.splice(500);
    await kvSet('stk_log', log, 180*86400);
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

function detectFVG_stk(highs, lows, price, signal) {
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
function detectIFVG_stk(highs, lows, closes, price, signal) {
  const len=highs.length; if(len<5)return false;
  const lb=Math.min(len-1,25);
  for(let i=len-3;i>=len-lb;i--){
    if(i<2)break;
    const bFvg=lows[i]-highs[i-2], rFvg=lows[i-2]-highs[i];
    let top,bot,wasBull;
    if(bFvg>0&&bFvg/price*100>=0.15){top=lows[i];bot=highs[i-2];wasBull=true;}
    else if(rFvg>0&&rFvg/price*100>=0.15){top=lows[i-2];bot=highs[i];wasBull=false;}
    else continue;
    let mit=false;
    for(let j=i+1;j<len-1;j++){if(closes[j]>bot&&closes[j]<top){mit=true;break;}}
    if(!mit)continue;
    if(signal==='CALL'&&!wasBull&&price>=bot*0.998&&price<=top*1.002)return true;
    if(signal==='PUT' &&wasBull &&price>=bot*0.998&&price<=top*1.002)return true;
  }
  return false;
}
function detectOB_stk(highs, lows, closes, price, signal) {
  const len=closes.length; if(len<4)return false;
  const lb=Math.min(len-2,10);
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
function detectBOS_stk(highs, lows, closes, signal) {
  const len=closes.length; if(len<12)return false;
  const rH=highs.slice(-11,-1), rL=lows.slice(-11,-1);
  const last=closes[len-1];
  return signal==='CALL'?last>Math.max(...rH):last<Math.min(...rL);
}
function detectRej_stk(highs, lows, closes, signal) {
  const len=closes.length;
  let count=0;
  for(let i=len-1;i>=Math.max(0,len-3);i--){
    const o=closes[i-1]||closes[i],c=closes[i],h=highs[i],l=lows[i];
    const range=h-l; if(range===0)continue;
    const body=Math.abs(c-o)/range;
    const upper=(h-Math.max(o,c))/range;
    const lower=(Math.min(o,c)-l)/range;
    if(signal==='CALL'&&lower>=0.55&&body<=0.40)count++;
    if(signal==='PUT' &&upper>=0.55&&body<=0.40)count++;
  }
  return count>=1;
}
function calcICT_stk(trendBars, entryBars, fastBars, price, signal) {
  let score=0; const details=[];
  if(entryBars&&detectFVG_stk(entryBars.highs,entryBars.lows,price,signal)){score+=3;details.push('FVG✅');}
  if(trendBars&&detectIFVG_stk(trendBars.highs,trendBars.lows,trendBars.closes,price,signal)){score+=3;details.push('IFVG✅');}
  if(trendBars&&detectOB_stk(trendBars.highs,trendBars.lows,trendBars.closes,price,signal)){score+=3;details.push('OB✅');}
  if(entryBars&&detectBOS_stk(entryBars.highs,entryBars.lows,entryBars.closes,signal)){score+=2;details.push('BOS✅');}
  if(fastBars&&detectRej_stk(fastBars.highs,fastBars.lows,fastBars.closes,signal)){score+=2;details.push('REJ✅');}
  return {score,details};
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
  let bull=0, bear=0; const reasons=[];
  if(price>e9&&e9>e21){bull+=3;reasons.push('EMA↑');}
  else if(price<e9&&e9<e21){bear+=3;reasons.push('EMA↓');}
  if(e50){if(price>e50){bull+=2;reasons.push('فوق EMA50');}else{bear+=2;reasons.push('تحت EMA50');}}
  if(r>58&&r<70){bull+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<42&&r>30){bear+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<=30){bull+=3;reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`);}
  else if(r>=70){bear+=2;reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`);}
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
  const { pdh, pdl } = getPDHL(closes, highs, lows);
  return { signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg, levels:{ e21, e50, bbMid:b?.mid||null, bbUpper:b?.upper||null, bbLower:b?.lower||null, pdh, pdl } };
}

function calcTargets(signal, price, atrVal, levels) {
  const d=signal==='CALL'?1:-1;
  const slDist=atrVal*1.5;
  const sl=+(price-d*slDist).toFixed(2);
  const risk=Math.abs(price-sl);
  const minT1=price+d*risk*2.0, minT2=price+d*risk*3.5, minT3=price+d*risk*6.0;
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
  for(const c of t1Candidates){ if(Math.abs(c.val-price)/risk>=2.0){t1=c.val;t1Label=c.label;break;} }
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
    if(fib2000&&Math.abs(fib2000-price)/risk>=5.0){t3=fib2000;t3Label='Fib 2.0';}
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
  if (!isStockKillZone()) return null;
  const vixLevel = vix || 0;
  if (vixLevel > 35) return null;

  const [weekBars, trendBars, entryBars, fastBars] = await Promise.all([
    getBars(sym, INTERVALS.weekly.interval, INTERVALS.weekly.range),
    getBars(sym, INTERVALS.trend.interval,  INTERVALS.trend.range),
    getBars(sym, INTERVALS.entry.interval,  INTERVALS.entry.range),
    getBars(sym, INTERVALS.fast.interval,   INTERVALS.fast.range),
  ]);
  if (!trendBars) return null;
  if (entryBars && !hasVolumeConfirmation(entryBars)) return null;

  const weeklyTrend = weekBars ? analyzeWeeklyTrend(weekBars) : 'neutral';
  const trendResult=analyzeFrame(trendBars);
  const entryResult=entryBars?analyzeFrame(entryBars):null;
  const fastResult=fastBars?analyzeFrame(fastBars):null;
  if (!trendResult) return null;
  const dominantTrend=trendResult.trend;
  if (dominantTrend==='neutral') return null;
  if (weeklyTrend !== 'neutral' && weeklyTrend !== dominantTrend) return null;
  const requiredSignal=dominantTrend==='bull'?'CALL':'PUT';
  if (requiredSignal==='CALL' && trendResult.rsi > 72) return null;
  if (requiredSignal==='PUT'  && trendResult.rsi < 28) return null;

  let entryFrame=null, entryData=null;
  if(fastResult?.signal===requiredSignal){entryFrame='15M';entryData=fastResult;}
  else if(entryResult?.signal===requiredSignal){entryFrame='1H';entryData=entryResult;}
  else if(trendResult.signal===requiredSignal){entryFrame='1D';entryData=trendResult;}
  if (!entryFrame||!entryData) return null;
  if (entryBars && !hasLiquiditySweep(entryBars, requiredSignal)) return null;

  // ══════════════════════════════════════
  // ✅ الفلاتر الأربعة — جودة ودقة
  // ══════════════════════════════════════

  // الفلتر 1: سياق السوق الكلي
  const marketCtx = await getMarketContext(requiredSignal);
  if (!marketCtx.ok) return null;

  // الفلتر 2: Relative Strength
  const rsResult = await getRelativeStrength(sym, requiredSignal);
  if (!rsResult.ok) return null;

  // الفلتر 3: Earnings — لا دخول قبل 7 أيام
  const earningsCheck = await checkEarnings(sym);
  if (!earningsCheck.safe) return null;

  // الفلتر 4: Sector Momentum
  const sectorResult = await getSectorMomentum(sym, requiredSignal);
  if (!sectorResult.ok) return null;

  const agreements=[
    trendResult.trend===dominantTrend,
    entryResult?.trend===dominantTrend,
    fastResult?.trend===dominantTrend,
    weeklyTrend===dominantTrend,
  ].filter(Boolean).length;
  const entryScore=entryData?(dominantTrend==='bull'?entryData.bull:entryData.bear):0;
  const trendScore2=dominantTrend==='bull'?trendResult.bull:trendResult.bear;
  const combinedScore=Math.round((entryScore+trendScore2)/2);
  const ict=calcICT_stk(trendBars,entryBars,fastBars,entryData.price||trendBars.price,requiredSignal);

  // بونص للفلاتر الجيدة
  const filterBonus = (rsResult.rs && Math.abs(rsResult.rs) > 5 ? 1 : 0)
                    + (sectorResult.sectorTrend === dominantTrend ? 1 : 0)
                    + (marketCtx.spyTrend === dominantTrend ? 1 : 0);

  let grade,gradeLabel,successRate;
  const totalScore=combinedScore+(ict.score>=5?2:ict.score>=3?1:0)+filterBonus;
  if(agreements>=3&&totalScore>=13){grade='S';gradeLabel='🔥 نسبة نجاح عالية جداً';successRate=87;}
  else if(agreements>=3||(agreements>=2&&totalScore>=11)){grade='A';gradeLabel='✅ نسبة نجاح عالية';successRate=73;}
  else return null;
  if(vixLevel>=25&&vixLevel<=35&&grade!=='S') return null;

  const trendLevels=trendResult.levels||{};
  const fib=calcFibExtensions(trendBars.closes,trendBars.highs,trendBars.lows,requiredSignal);
  const combinedLevels={...trendLevels,fib};

  return {
    sym, signal:requiredSignal, dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price:entryData.price||trendBars.price, atr:entryData.atr,
    trendRSI:trendResult.rsi?.toFixed(1), entryRSI:entryData.rsi?.toFixed(1),
    weeklyTrend, trendReasons:trendResult.reasons, entryReasons:entryData.reasons,
    agreements, totalFrames:4,
    trendScore:dominantTrend==='bull'?trendResult.bull:trendResult.bear,
    levels:combinedLevels, ictScore:ict.score, ictDetails:ict.details,
    // بيانات الفلاتر للرسالة
    marketCtx, rsResult, earningsCheck, sectorResult,
  };
}

async function checkActiveSignals() {
  const active=(await kvGet('stk_active'))||{};
  const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0.0};
  let changed=false, notifs=0;
  for (const [id,sig] of Object.entries(active)) {
    try {
      if(!STOCKS[sig.sym]){delete active[id];changed=true;continue;}
      const bars=await getBars(sig.sym,'5m','1d');
      const price=bars?.price;
      if(!price)continue;
      const isCall=sig.signal==='CALL';
      if((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)){
        delete active[id]; perf.losses++; perf.totalR-=1; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'SL', r:-1, type:'stock',
          agreements:sig.agreements, entryFrame:sig.entryFrame,
          trendRSI:sig.trendRSI, sector:sig.sector,
          marketCtxTrend:sig.marketCtxTrend, rs:sig.rs,
          ictScore:sig.ictScore, momentum:sig.momentum,
          slNote:'خطأ تحليل — راجع مناطق السيولة',
        });
        await tg(`🛑 <b>Stop Loss!</b>\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n💰 $${price.toFixed(2)}\n🛡️ SL: $${sig.sl}\n📊 -1R | WR: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n🤖 <i>TIH Stocks v5.1</i>`);
        notifs++; continue;
      }
      if(!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))){
        sig.t1Hit=true; sig.sl=sig.entry; perf.wins++; perf.totalR+=2; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'T1', r:2, type:'stock',
          agreements:sig.agreements, entryFrame:sig.entryFrame,
          sector:sig.sector, momentum:sig.momentum,
        });
        await tg(`🎯 <b>T1 تحقق! +2R</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → BE\n🤖 <i>TIH Stocks v5.1</i>`);
        notifs++;
      }
      if(sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))){
        sig.t2Hit=true; perf.totalR+=1; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'T2', r:3, type:'stock',
          agreements:sig.agreements, sector:sig.sector,
        });
        await tg(`🎯🎯 <b>T2 تحقق! +3R 🔥</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Stocks v5.1</i>`);
        notifs++;
      }
      if(sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))){
        delete active[id]; perf.totalR+=1; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'T3', r:4, type:'stock',
          agreements:sig.agreements, sector:sig.sector,
        });
        await tg(`🏆🏆🏆 <b>T3 تحقق! +4R 💎</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n🤖 <i>TIH Stocks v5.1</i>`);
        notifs++; continue;
      }
      const expiryDays=sig.expiryDays||21;
      if(Date.now()-(sig.openedAt||0)>expiryDays*24*60*60*1000&&!sig.t1Hit){
        delete active[id]; changed=true;
        await saveLog({
          sym:sig.sym, signal:sig.signal, grade:sig.grade,
          entry:sig.entry, exit:price, result:'EXP', r:0, type:'stock',
          agreements:sig.agreements, sector:sig.sector,
        });
        await tg(`⏰ <b>انتهت الإشارة</b>\n📌 <b>${sig.sym}</b> — ${expiryDays}ي بدون T1\n🤖 <i>TIH Stocks v5.1</i>`);
        notifs++; continue;
      }
      active[id]=sig;
    } catch(e){}
  }
  if(changed){ await kvSet('stk_active',active,7*86400); await kvSet('stk_perf',perf,365*86400); }
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
      `🤖 <b>TIH Stocks v5.1</b>\n━━━━━━━━━━━━━━━\n✅ النظام يعمل!\n\n` +
      `📊 ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n━━━━━━━━━━━━━━━\n` +
      `✅ Kill Zone NY AM: ${kz?'🟢 نشط':'🔴 خارج النافذة'}\n` +
      `✅ شرط الإشارة: ${MIN_SCORE} نقطة\n` +
      `✅ Weekly Trend: إلزامي\n✅ Liquidity Sweep: مفعّل\n` +
      `✅ Grade S+A فقط\n✅ أسهم: 10 (أعلى سيولة)\n` +
      `📡 مصدر البيانات: Twelve Data\n🤖 <i>TIH Stocks v5.1</i>`
    );
    return res.status(200).json({ok:true,killZone:kz});
  }

  if(action==='reset'){await kvDel('stk_active');return res.status(200).json({ok:true});}

  if (action==='reset-all') {
    await Promise.all([kvDel('stk_active'),kvDel('stk_log'),kvDel('stk_perf'),kvDel('stk_vix_alert')]);
    await tg('🔄 <b>بداية جديدة</b> — تم مسح كل بيانات الأسهم\n🤖 TIH Stocks v6.2');
    return res.status(200).json({ok:true,message:'all cleared'});
  }

  if(action==='cleanup'){
    const active=(await kvGet('stk_active'))||{};
    const latest={};
    for(const [id,sig] of Object.entries(active)){ if(!latest[sig.sym]||sig.openedAt>latest[sig.sym].openedAt) latest[sig.sym]={id,...sig}; }
    const newActive={};
    for(const [sym,sig] of Object.entries(latest)){const{id,...data}=sig;newActive[id]=data;}
    await kvSet('stk_active',newActive,7*86400);
    return res.status(200).json({ok:true,remaining:Object.keys(newActive).length});
  }

  if(action==='active'){
    const active=(await kvGet('stk_active'))||{};
    const sigs=Object.values(active).map(s=>({sym:s.sym,signal:s.signal,grade:s.grade,entry:s.entry,sl:s.sl,t1:s.t1,t2:s.t2,t3:s.t3,t1Hit:s.t1Hit,t2Hit:s.t2Hit,openedAt:s.openedAt}));
    return res.status(200).json({ok:true,signals:sigs,count:sigs.length});
  }

  if(action==='log'){const log=(await kvGet('stk_log'))||[];return res.status(200).json({ok:true,log,count:log.length});}

  if(action==='test-massive'){
    const MASSIVE_KEY=process.env.MASSIVE_API_KEY;
    const sym=req.query.sym||'AAPL';
    const today=new Date().toISOString().split('T')[0];
    const weekAgo=new Date(Date.now()-7*86400000).toISOString().split('T')[0];
    const results={};
    const endpoints=[
      // بيانات السعر — النمط الصحيح
      ['snapshot',  `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${sym}`],
      ['prev_day',  `https://api.massive.com/v2/aggs/ticker/${sym}/prev`],
      ['daily_bars',`https://api.massive.com/v2/aggs/ticker/${sym}/range/1/day/${weekAgo}/${today}?limit=5`],
      ['hourly',    `https://api.massive.com/v2/aggs/ticker/${sym}/range/1/hour/${weekAgo}/${today}?limit=5`],
      ['minute',    `https://api.massive.com/v2/aggs/ticker/${sym}/range/5/minute/${today}/${today}?limit=5`],
      // Options
      ['options_chain', `https://api.massive.com/v3/snapshot/options/${sym}`],
      ['options_ref',   `https://api.massive.com/v3/reference/options/contracts?underlying_ticker=${sym}&limit=3`],
      // Technical
      ['sma',       `https://api.massive.com/v1/indicators/sma/${sym}?timespan=day&window=20&limit=3`],
      ['rsi',       `https://api.massive.com/v1/indicators/rsi/${sym}?timespan=day&window=14&limit=3`],
      ['macd',      `https://api.massive.com/v1/indicators/macd/${sym}?timespan=day&limit=3`],
    ];
    for(const[name,url]of endpoints){
      try{
        const r=await fetch(url,{headers:{'Authorization':`Bearer ${MASSIVE_KEY}`,'x-api-key':MASSIVE_KEY}});
        const text=await r.text();
        try{results[name]={status:r.status,data:JSON.parse(text)};}
        catch(e){results[name]={status:r.status,raw:text.slice(0,300)};}
      }catch(e){results[name]={error:e.message};}
    }
    return res.status(200).json({ok:true,sym,apiKey:MASSIVE_KEY?`${MASSIVE_KEY.slice(0,6)}...`:'غير موجود',results});
  }

  if(action==='stats'){
    const perf=(await kvGet('stk_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('stk_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    await tg(`📊 <b>أداء الأسهم v5.1</b>\n${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 WR: <b>${wr}%</b>\n💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n📌 نشطة: ${Object.keys(active).length}\n🤖 TIH Stocks v5.1`);
    return res.status(200).json({ok:true,perf,active:Object.keys(active).length});
  }

  if(!isMarketOpen()&&req.query.force!=='1') return res.status(200).json({ok:true,message:'السوق مغلق',checked:0,newAlerts:0});

  const forceRun = req.query.force === '1';
  const symbols=req.query.symbols?req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>STOCKS[s]):Object.keys(STOCKS);
  const perfNotifs=await checkActiveSignals();
  const newAlerts=[],errors=[];
  const vix=await getVIX();

  if(vix&&vix>25){
    const lastVixAlert=await kvGet('stk_vix_alert');
    const today=new Date().toISOString().split('T')[0];
    if(lastVixAlert!==today){
      await kvSet('stk_vix_alert',today,86400);
      await tg(vix>35?`⚠️ <b>VIX شديد!</b> ${vix.toFixed(1)} — إيقاف كامل\n🤖 TIH Stocks v5.1`:`⚠️ <b>VIX مرتفع</b> ${vix.toFixed(1)} — Grade S فقط\n🤖 TIH Stocks v5.1`);
    }
  }

  await Promise.all(symbols.map(async (sym) => {
    try {
      const result=await analyzeMTF(sym,vix);
      if(!result)return;
      const active=(await kvGet('stk_active'))||{};
      if(!forceRun&&Object.values(active).some(s=>s.sym===sym))return;
      const lastSignalTime=await kvGet(`stk_last_${sym}`);
      if(!forceRun&&lastSignalTime&&(Date.now()-lastSignalTime)<MIN_SIGNAL_GAP)return;
      const targets=calcTargets(result.signal,result.price,result.atr,result.levels);
      const sigId=`${sym}_${Date.now()}`;
      active[sigId]={sym,signal:result.signal,entry:result.price,sl:targets.sl,t1:targets.t1,t2:targets.t2,t3:targets.t3,t1Hit:false,t2Hit:false,t3Hit:false,grade:result.grade,openedAt:Date.now(),expiryDays:targets.expiryDays};
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
      const weekLine=result.weeklyTrend!=='neutral'?`📅 Weekly: ${result.weeklyTrend==='bull'?'🟢 صاعد':'🔴 هابط'}\n`:'';
      const ictLine=result.ictDetails?.length?`🔬 ICT: ${result.ictDetails.join(' ')} (${result.ictScore}/13)\n`:'';

      // ✅ بيانات الفلاتر في الرسالة
      const rsLine=result.rsResult?.rs!=null
        ?`📈 RS vs SPY: ${result.rsResult.rs>0?'+':''}${result.rsResult.rs.toFixed(1)}% (${result.rsResult.symChg>0?'+':''}${result.rsResult.symChg}% vs ${result.rsResult.spyChg>0?'+':''}${result.rsResult.spyChg}%)\n`:'';
      const sectorLine=result.sectorResult?.sector
        ?`🏭 القطاع: ${result.sectorResult.sector} ${result.sectorResult.sectorTrend==='bull'?'🟢':'🔴'}\n`:'';
      const earningsLine=result.earningsCheck?.daysUntil!=null&&result.earningsCheck.daysUntil>=0
        ?`📆 Earnings: ${result.earningsCheck.daysUntil} يوم\n`:'';
      const marketLine=result.marketCtx?.spyTrend
        ?`🌍 SPY: ${result.marketCtx.spyTrend==='bull'?'🟢 صاعد':'🔴 هابط'}${result.marketCtx.warning?' ⚠️':''}\n`:'';

      await tg(
        `${emoji} <b>${sigType}</b>  |  درجة <b>${result.grade}</b>\n` +
        `${result.gradeLabel} — <b>${result.successRate}%</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — ${STOCKS[sym].name}\n` +
        `💰 السعر: <b>$${result.price.toFixed(2)}</b>\n` +
        `\n📊 <b>التحليل</b>\n` +
        `${weekLine}${ictLine}` +
        `├ RSI(1D): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}\n` +
        `└ توافق: ${result.agreements}/${result.totalFrames} فريم\n` +
        `\n🔍 <b>فلاتر الجودة</b>\n` +
        `${marketLine}${rsLine}${sectorLine}${earningsLine}` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 Entry : <b>$${result.price.toFixed(2)}</b>\n` +
        `🛡 SL [${targets.slLabel}] : $${targets.sl} (${targets.slPct}%)\n` +
        `🥇 T1 [${targets.t1Label}] : $${targets.t1} (+${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🥈 T2 [${targets.t2Label}] : $${targets.t2} | 1:${targets.rr2}\n` +
        `🥉 T3 [${targets.t3Label}] : $${targets.t3} | 1:${targets.rr3}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📅 الأوبشن: <b>${targets.expiry}</b>\n` +
        `${thetaLine}📐 ATR: ${result.atr.toFixed(2)} | ⏰ ${now}\n` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(STOCKS[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">الشارت ↗</a>\n` +
        `🤖 <i>TIH Stocks v6.2</i>`
      );
    } catch(e){errors.push(`${sym}: ${e.message}`);}
  }));

  const active=(await kvGet('stk_active'))||{};
  return res.status(200).json({ok:true,checked:symbols.length,newAlerts:newAlerts.length,perfNotifs,active:Object.keys(active).length,signals:newAlerts,errors,vix:vix?+vix.toFixed(1):null,killZone:isStockKillZone()});
};
