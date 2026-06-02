const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ── الأسهم الأمريكية ──
const STOCKS = {
  'AAPL':  { yahoo: 'AAPL',  name: 'Apple',       tv: 'NASDAQ:AAPL'  },
  'MSFT':  { yahoo: 'MSFT',  name: 'Microsoft',   tv: 'NASDAQ:MSFT'  },
  'NVDA':  { yahoo: 'NVDA',  name: 'NVIDIA',      tv: 'NASDAQ:NVDA'  },
  'AMZN':  { yahoo: 'AMZN',  name: 'Amazon',      tv: 'NASDAQ:AMZN'  },
  'GOOGL': { yahoo: 'GOOGL', name: 'Google',      tv: 'NASDAQ:GOOGL' },
  'META':  { yahoo: 'META',  name: 'Meta',        tv: 'NASDAQ:META'  },
  'TSLA':  { yahoo: 'TSLA',  name: 'Tesla',       tv: 'NASDAQ:TSLA'  },
  'JPM':   { yahoo: 'JPM',   name: 'JPMorgan',    tv: 'NYSE:JPM'     },
  'AMD':   { yahoo: 'AMD',   name: 'AMD',         tv: 'NASDAQ:AMD'   },
  'SPY':   { yahoo: 'SPY',   name: 'S&P 500 ETF', tv: 'AMEX:SPY'     },
  'AVGO':  { yahoo: 'AVGO',  name: 'Broadcom',    tv: 'NASDAQ:AVGO'  },
  'MU':    { yahoo: 'MU',    name: 'Micron',      tv: 'NASDAQ:MU'    },
  'MRVL':  { yahoo: 'MRVL',  name: 'Marvell',     tv: 'NASDAQ:MRVL'  },
  'SNOW':  { yahoo: 'SNOW',  name: 'Snowflake',   tv: 'NYSE:SNOW'    },
  'SMCI':  { yahoo: 'SMCI',  name: 'Super Micro', tv: 'NASDAQ:SMCI'  },
  'INTC':  { yahoo: 'INTC',  name: 'Intel',       tv: 'NASDAQ:INTC'  },
  'NFLX':  { yahoo: 'NFLX',  name: 'Netflix',     tv: 'NASDAQ:NFLX'  },
};

// TradingView interval map
const TV_INTERVAL = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };

// فريمات التحليل للأسهم — Daily اتجاه + 1H دخول + 15M سريع
const INTERVALS = {
  trend: { interval: '1d',  range: '180d' },
  entry: { interval: '1h',  range: '30d'  },
  fast:  { interval: '15m', range: '5d'   },
};

// معاملات ATR
const ATR_MULT = {
  sl: 1.2,
  t1: 1.0,
  t2: 2.0,
  t3: 3.5,
};

// ── Redis ──
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

// ── Telegram ──
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

// ── Yahoo Finance ──
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
    if (vi.length < 20) return null;
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

// ── المؤشرات الفنية ──
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

// ── تحليل فريم واحد ──
function analyzeFrame(bars) {
  const { closes, highs, lows, price } = bars;
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r   = rsi(closes);
  const m   = macd(closes);
  const b   = bb(closes);
  const a   = atr(highs, lows, closes, 14);

  if (!e9||!e21||!r||!a) return null;

  let bull=0, bear=0;
  const reasons = [];

  if (price>e9 && e9>e21) { bull+=3; reasons.push('EMA↑'); }
  else if (price<e9 && e9<e21) { bear+=3; reasons.push('EMA↓'); }

  if (e50) {
    if (price>e50) { bull+=1; reasons.push('فوق EMA50'); }
    else { bear+=1; reasons.push('تحت EMA50'); }
  }

  if (r>55 && r<72) { bull+=2; reasons.push(`RSI ${r.toFixed(0)}`); }
  else if (r<45 && r>28) { bear+=2; reasons.push(`RSI ${r.toFixed(0)}`); }
  else if (r<=28) { bull+=2; reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`); }
  else if (r>=72) { bear+=1; reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`); }

  if (m?.bull) { bull+=2; reasons.push('MACD↑'); }
  else if (m) { bear+=2; reasons.push('MACD↓'); }

  if (b) {
    if (price<=b.lower) { bull+=3; reasons.push('BB دعم'); }
    else if (price>=b.upper) { bear+=3; reasons.push('BB مقاومة'); }
    else if (price>b.mid) bull+=1;
    else bear+=1;
  }

  const prev = closes[closes.length-2]||price;
  const chg = ((price-prev)/prev)*100;
  if (chg>0.3) bull+=1; else if (chg<-0.3) bear+=1;

  const signal = bull>=7?'CALL':bear>=7?'PUT':null;
  const trend  = bull>bear?'bull':bear>bull?'bear':'neutral';

  return { signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg };
}

// ── MTF Confluence ──
async function analyzeMTF(sym) {
  const cfg = STOCKS[sym];

  const [trendBars, entryBars, fastBars] = await Promise.all([
    getBars(cfg.yahoo, INTERVALS.trend.interval, INTERVALS.trend.range),
    getBars(cfg.yahoo, INTERVALS.entry.interval, INTERVALS.entry.range),
    getBars(cfg.yahoo, INTERVALS.fast.interval,  INTERVALS.fast.range),
  ]);

  if (!trendBars) return null;

  const trendResult = analyzeFrame(trendBars);
  const entryResult = entryBars ? analyzeFrame(entryBars) : null;
  const fastResult  = fastBars  ? analyzeFrame(fastBars)  : null;

  if (!trendResult) return null;

  const dominantTrend = trendResult.trend;
  if (dominantTrend === 'neutral') return null;

  const requiredSignal = dominantTrend === 'bull' ? 'CALL' : 'PUT';

  let entryFrame = null, entryData = null;

  if (fastResult?.signal === requiredSignal) {
    entryFrame = '15M'; entryData = fastResult;
  } else if (entryResult?.signal === requiredSignal) {
    entryFrame = '1H'; entryData = entryResult;
  } else if (trendResult.signal === requiredSignal) {
    entryFrame = '1D'; entryData = trendResult;
  }

  if (!entryFrame || !entryData) return null;

  const agreements = [
    trendResult.trend === dominantTrend,
    entryResult?.trend === dominantTrend,
    fastResult?.trend === dominantTrend,
  ].filter(Boolean).length;

  const entryScore = entryData ? (dominantTrend==='bull' ? entryData.bull : entryData.bear) : 0;
  const trendScore2 = dominantTrend==='bull' ? trendResult.bull : trendResult.bear;
  const combinedScore = Math.round((entryScore + trendScore2) / 2);

  let grade, gradeLabel, successRate;

  if (agreements === 3 && combinedScore >= 9) {
    grade='S'; gradeLabel='🔥 نسبة نجاح عالية جداً'; successRate=85;
  } else if (agreements === 3 || (agreements >= 2 && combinedScore >= 8)) {
    grade='A'; gradeLabel='✅ نسبة نجاح عالية'; successRate=72;
  } else if (agreements === 2 && combinedScore >= 7) {
    grade='B'; gradeLabel='⚡ نسبة نجاح متوسطة'; successRate=58;
  } else {
    grade='C'; gradeLabel='⚠️ نسبة نجاح منخفضة'; successRate=0;
  }

  if (grade === 'C') return null;

  const entryATR = entryData.atr;
  const entryPrice = entryData.price || trendBars.price;

  return {
    sym, signal: requiredSignal,
    dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price: entryPrice, atr: entryATR,
    trendRSI: trendResult.rsi?.toFixed(1),
    entryRSI: entryData.rsi?.toFixed(1),
    trendReasons: trendResult.reasons,
    entryReasons: entryData.reasons,
    agreements, totalFrames: 3,
    trendScore: dominantTrend==='bull'?trendResult.bull:trendResult.bear,
  };
}

// ── حساب الأهداف ──
function calcTargets(signal, price, atrVal) {
  const d = signal==='CALL' ? 1 : -1;
  const sl = price - d*atrVal*ATR_MULT.sl;
  const t1 = price + d*atrVal*ATR_MULT.t1;
  const t2 = price + d*atrVal*ATR_MULT.t2;
  const t3 = price + d*atrVal*ATR_MULT.t3;
  const risk = Math.abs(price-sl);
  return {
    sl:  +sl.toFixed(2),
    t1:  +t1.toFixed(2),
    t2:  +t2.toFixed(2),
    t3:  +t3.toFixed(2),
    slPct: ((sl-price)/price*100).toFixed(2),
    t1Pct: ((t1-price)/price*100).toFixed(2),
    rr1:  (Math.abs(t1-price)/risk).toFixed(2),
    rr2:  (Math.abs(t2-price)/risk).toFixed(2),
  };
}

// ── فحص الأهداف النشطة ──
async function checkActiveSignals() {
  const active = (await kvGet('stk_active')) || {};
  const perf   = (await kvGet('stk_perf'))   || { total:0,wins:0,losses:0,totalR:0.0 };
  let changed=false, notifs=0;

  for (const [id, sig] of Object.entries(active)) {
    try {
      const cfg = STOCKS[sig.sym];
      if (!cfg) continue;

      const bars = await getBars(cfg.yahoo, '1m', '1d');
      const price = bars?.price;
      if (!price) continue;

      const isCall = sig.signal === 'CALL';

      if ((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)) {
        delete active[id];
        perf.losses++; perf.totalR-=1; changed=true;
        await tg(
          `🛑 <b>Stop Loss!</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n` +
          `💰 السعر: <b>$${price.toFixed(2)}</b>\n` +
          `🛡️ SL كان: $${sig.sl}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📊 -1R | Win Rate: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n` +
          `🤖 <i>TIH Stocks</i>`
        );
        notifs++;
        continue;
      }

      if (!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))) {
        sig.t1Hit=true; sig.sl=sig.entry;
        perf.wins++; perf.totalR+=2; changed=true;
        await tg(
          `🎯 <b>T1 تحقق! +2R</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈':'📉'}\n` +
          `💰 $${price.toFixed(2)}\n` +
          `⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n` +
          `🔒 SL → Break Even ($${sig.entry})\n` +
          `🤖 <i>TIH Stocks</i>`
        );
        notifs++;
      }

      if (sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))) {
        sig.t2Hit=true; perf.totalR+=1; changed=true;
        await tg(
          `🎯🎯 <b>T2 تحقق! +3R 🔥</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.sym}</b>\n` +
          `💰 $${price.toFixed(2)}\n` +
          `⏭️ T3: $${sig.t3}\n` +
          `🤖 <i>TIH Stocks</i>`
        );
        notifs++;
      }

      if (sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))) {
        delete active[id]; perf.totalR+=1; changed=true;
        await tg(
          `🏆🏆🏆 <b>T3 تحقق! الهدف الكامل! +4R 💎</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.sym}</b>\n` +
          `💰 $${price.toFixed(2)}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📊 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
          `🤖 <i>TIH Stocks</i>`
        );
        notifs++;
        continue;
      }

      active[id] = sig;
    } catch(e) {}
  }

  if (changed) {
    await kvSet('stk_active', active, 7*86400);
    await kvSet('stk_perf', perf, 365*86400);
  }
  return notifs;
}

// ── الدالة الرئيسية ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  // ── Test ──
  if (action==='test') {
    const perf   = (await kvGet('stk_perf'))   || { total:0,wins:0,losses:0,totalR:0 };
    const active = (await kvGet('stk_active')) || {};
    const wr = perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    await tg(
      `🤖 <b>TIH Stocks System</b>\n━━━━━━━━━━━━━━━\n` +
      `✅ نظام الأسهم يعمل!\n\n` +
      `📋 الأسهم: ${Object.keys(STOCKS).join(', ')}\n\n` +
      `📊 الإشارات: ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n` +
      `💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🔀 MTF: 1D اتجاه + 1H/15M دخول\n` +
      `🏆 التصنيف: S/A/B\n` +
      `🤖 <i>TIH Stocks v1.0</i>`
    );
    return res.status(200).json({ ok:true });
  }

  // ── Reset ──
  if (action==='reset') {
    await kvDel('stk_active');
    await tg('🔄 <b>تم مسح إشارات الأسهم النشطة</b>\nالنظام جاهز لإشارات جديدة\n🤖 TIH Stocks');
    return res.status(200).json({ ok:true, message:'Active signals cleared' });
  }

  // ── Cleanup ──
  if (action==='cleanup') {
    const active = (await kvGet('stk_active')) || {};
    const latest = {};

    for (const [id, sig] of Object.entries(active)) {
      if (!latest[sig.sym] || sig.openedAt > latest[sig.sym].openedAt) {
        latest[sig.sym] = { id, ...sig };
      }
    }

    const newActive = {};
    for (const [sym, sig] of Object.entries(latest)) {
      const { id, ...data } = sig;
      newActive[id] = data;
    }

    const removed = Object.keys(active).length - Object.keys(newActive).length;
    await kvSet('stk_active', newActive, 7*86400);
    await tg(
      '🧹 <b>تنظيف إشارات الأسهم</b>\n' +
      `تم حذف ${removed} إشارة مكررة\n` +
      `المتبقي: ${Object.keys(newActive).length} إشارة\n` +
      '🤖 TIH Stocks'
    );
    return res.status(200).json({ ok:true, removed, remaining: Object.keys(newActive).length });
  }

  // ── Stats ──
  if (action==='stats') {
    const perf   = (await kvGet('stk_perf'))   || { total:0,wins:0,losses:0,totalR:0 };
    const active = (await kvGet('stk_active')) || {};
    const wr = perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    await tg(
      `📊 <b>أداء الأسهم</b>\n━━━━━━━━━━━━━━━\n` +
      `📈 الكلي: ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: <b>${wr}%</b>\n` +
      `💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n` +
      `📌 نشطة: ${Object.keys(active).length}\n` +
      `━━━━━━━━━━━━━━━\n🤖 TIH Stocks`
    );
    return res.status(200).json({ ok:true, perf, active:Object.keys(active).length });
  }

  // ── Check ──
  const symbols = req.query.symbols
    ? req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>STOCKS[s])
    : Object.keys(STOCKS);

  const perfNotifs = await checkActiveSignals();
  const newAlerts=[], errors=[];

  await Promise.all(symbols.map(async (sym) => {
    try {
      const result = await analyzeMTF(sym);
      if (!result) return;

      const active = (await kvGet('stk_active')) || {};
      const existingSignals = Object.values(active).filter(s => s.sym === sym);
      if (existingSignals.length > 0) return;

      const targets = calcTargets(result.signal, result.price, result.atr);
      const sigId = `${sym}_${Date.now()}`;
      active[sigId] = {
        sym, signal: result.signal,
        entry: result.price, sl: targets.sl,
        t1: targets.t1, t2: targets.t2, t3: targets.t3,
        t1Hit:false, t2Hit:false, t3Hit:false,
        grade: result.grade, openedAt: Date.now()
      };

      const perf = (await kvGet('stk_perf')) || { total:0,wins:0,losses:0,totalR:0 };
      perf.total++;
      await kvSet('stk_active', active, 7*86400);
      await kvSet('stk_perf', perf, 365*86400);
      newAlerts.push({ sym, signal: result.signal, grade: result.grade });

      const emoji = result.signal==='CALL'?'🟢':'🔴';
      const sigType = result.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const now = new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});

      await tg(
        `${emoji} <b>${sigType}</b>\n` +
        `${result.gradeLabel} — احتمال النجاح: <b>${result.successRate}%</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — ${STOCKS[sym].name}\n` +
        `💰 السعر: <b>$${result.price.toFixed(2)}</b>\n` +
        `📊 RSI(1D): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}\n` +
        `🔀 التوافق: ${result.agreements}/${result.totalFrames} فريم\n` +
        `⏱️ الدخول من: ${result.entryFrame}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 Entry:     $${result.price.toFixed(2)}\n` +
        `🛡️ Stop Loss: $${targets.sl} (${targets.slPct}%)\n` +
        `🏆 T1:        $${targets.t1} (${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🏆 T2:        $${targets.t2} | 1:${targets.rr2}\n` +
        `🏆 T3:        $${targets.t3}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📐 ATR(${result.entryFrame}): ${result.atr.toFixed(3)}\n` +
        `⏰ ${now}\n` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(STOCKS[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">فتح الشارت ↗</a>\n` +
        `🤖 <i>TIH Stocks v1.0</i>`
      );
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }));

  const active = (await kvGet('stk_active')) || {};
  return res.status(200).json({
    ok: true, checked: symbols.length,
    newAlerts: newAlerts.length, perfNotifs,
    active: Object.keys(active).length,
    signals: newAlerts, errors
  });
};
