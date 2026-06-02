const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ── الرموز وإعداداتها ──
const SYMBOLS = {
  // مؤشرات — 24/7
  'US500': { yahoo: 'ES=F',    type: 'index',  interval: '1h', atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 } },
  'SPX':   { yahoo: '^GSPC',   type: 'index',  interval: '1h', atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 } },
  'NDX':   { yahoo: '^NDX',    type: 'index',  interval: '1h', atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 } },
  'DJI':   { yahoo: '^DJI',    type: 'index',  interval: '1h', atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 } },
  // كريبتو — 24/7
  'BTC':   { yahoo: 'BTC-USD', type: 'crypto', interval: '1h', atrMult: { sl:2.0, t1:2.0, t2:3.5, t3:5.0 } },
  'ETH':   { yahoo: 'ETH-USD', type: 'crypto', interval: '1h', atrMult: { sl:2.0, t1:2.0, t2:3.5, t3:5.0 } },
  // ذهب
  'XAUUSD':{ yahoo: 'GC=F',    type: 'index',  interval: '1h', atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 } },
  // أسهم — جلسة فقط
  'NVDA':  { yahoo: 'NVDA',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'AAPL':  { yahoo: 'AAPL',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'MSFT':  { yahoo: 'MSFT',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'TSLA':  { yahoo: 'TSLA',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'AMD':   { yahoo: 'AMD',     type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'AMZN':  { yahoo: 'AMZN',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'GOOGL': { yahoo: 'GOOGL',   type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'META':  { yahoo: 'META',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'AVGO':  { yahoo: 'AVGO',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'MRVL':  { yahoo: 'MRVL',    type: 'stock',  interval: '1h', atrMult: { sl:1.2, t1:1.5, t2:2.5, t3:4.0 } },
  'VIX':   { yahoo: '^VIX',    type: 'index',  interval: '1d', atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 } },
};

// ── Upstash Redis ──
async function kvGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch(e) { return null; }
}
async function kvSet(key, value, ex = 86400) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}
async function isSent(key) { return (await kvGet(`sent:${key}`)) !== null; }
async function markSent(key, ttl = 4*3600) { await kvSet(`sent:${key}`, 1, ttl); }

// ── Telegram ──
function sendTelegram(msg) {
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
function fetchYahoo(symbol, interval, range) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path, headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── جلب البيانات ──
async function fetchBars(yahooSym, interval) {
  const range = interval === '1h' ? '30d' : interval === '4h' ? '60d' : '6mo';
  try {
    const json = await fetchYahoo(yahooSym, interval, range);
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const vi = q.close.map((v,i) => v !== null ? i : -1).filter(i => i >= 0);
    if (vi.length < 30) return null;
    return {
      closes: vi.map(i => q.close[i]),
      highs:  vi.map(i => q.high[i]),
      lows:   vi.map(i => q.low[i]),
      vols:   vi.map(i => q.volume?.[i] || 0),
      price:  result.meta.regularMarketPrice || q.close[vi[vi.length-1]]
    };
  } catch(e) { return null; }
}

// ── المؤشرات الفنية ──
function calcEMA(p, n) {
  if (p.length < n) return null;
  const k = 2/(n+1);
  let e = p.slice(0,n).reduce((a,b) => a+b,0)/n;
  for (let i = n; i < p.length; i++) e = p[i]*k + e*(1-k);
  return e;
}
function calcRSI(p, n=14) {
  if (p.length < n+1) return null;
  let g=0, l=0;
  for (let i=1; i<=n; i++) { const d=p[i]-p[i-1]; if(d>0) g+=d; else l-=d; }
  let ag=g/n, al=l/n;
  for (let i=n+1; i<p.length; i++) {
    const d=p[i]-p[i-1];
    if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}
    else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}
  }
  return al===0 ? 100 : 100-(100/(1+ag/al));
}
function calcATR(h, l, c, n=14) {
  if (c.length < n+1) return null;
  const trs = [];
  for (let i=1; i<c.length; i++)
    trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return trs.slice(-n).reduce((a,b) => a+b,0)/n;
}
function calcMACD(p) {
  const e12 = calcEMA(p,12), e26 = calcEMA(p,26);
  if (!e12||!e26) return null;
  return { value: e12-e26, bullish: e12>e26 };
}
function calcBB(p, n=20) {
  if (p.length < n) return null;
  const s = p.slice(-n), mean = s.reduce((a,b)=>a+b,0)/n;
  const std = Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/n);
  return { upper: mean+2*std, middle: mean, lower: mean-2*std };
}

// ── تحليل الإشارة ──
function analyzeSignal(bars) {
  const { closes, highs, lows, price } = bars;

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const rsi   = calcRSI(closes);
  const macd  = calcMACD(closes);
  const bb    = calcBB(closes);
  const atr   = calcATR(highs, lows, closes, 14);

  if (!ema9||!ema21||!rsi||!atr) return null;

  let bullScore = 0, bearScore = 0;

  // ── EMA Trend ──
  if (price > ema9 && ema9 > ema21) bullScore += 3;
  else if (price < ema9 && ema9 < ema21) bearScore += 3;

  if (ema50) {
    if (price > ema50) bullScore += 1;
    else bearScore += 1;
  }

  // ── RSI ──
  if (rsi > 55 && rsi < 75) bullScore += 2;
  else if (rsi < 45 && rsi > 25) bearScore += 2;
  else if (rsi >= 75) { bullScore += 1; bearScore += 1; } // تشبع — حذر
  else if (rsi <= 25) { bullScore += 2; } // تشبع بيع → فرصة شراء

  // ── MACD ──
  if (macd?.bullish) bullScore += 2;
  else if (macd) bearScore += 2;

  // ── Bollinger Bands ──
  if (bb) {
    if (price <= bb.lower) bullScore += 3; // اختراق تحتي → شراء
    else if (price >= bb.upper) bearScore += 3; // اختراق علوي → بيع
    else if (price > bb.middle) bullScore += 1;
    else bearScore += 1;
  }

  // ── تغيير السعر ──
  const prev = closes[closes.length-2] || price;
  const chgPct = ((price-prev)/prev)*100;
  if (chgPct > 0.5) bullScore += 1;
  else if (chgPct < -0.5) bearScore += 1;

  // ── القرار: score ≥ 7 ──
  const signal = bullScore >= 7 ? 'CALL' : bearScore >= 7 ? 'PUT' : null;
  if (!signal) return null;

  return {
    signal, bullScore, bearScore,
    price, rsi: rsi.toFixed(1),
    ema9: ema9.toFixed(2), ema21: ema21.toFixed(2),
    macd: macd?.bullish ? '↑' : '↓',
    atr: atr.toFixed(2),
    chgPct: chgPct.toFixed(2),
    confidence: Math.min(95, Math.round(signal==='CALL' ? 50+bullScore*4 : 50+bearScore*4))
  };
}

// ── حساب SL/TP ──
function calcTargets(signal, price, atr, mult) {
  const dir = signal === 'CALL' ? 1 : -1;
  const sl = price - dir * atr * mult.sl;
  const t1 = price + dir * atr * mult.t1;
  const t2 = price + dir * atr * mult.t2;
  const t3 = price + dir * atr * mult.t3;
  const risk = Math.abs(price - sl);
  return {
    sl: +sl.toFixed(2), t1: +t1.toFixed(2),
    t2: +t2.toFixed(2), t3: +t3.toFixed(2),
    slPct: ((sl-price)/price*100).toFixed(2),
    t1Pct: ((t1-price)/price*100).toFixed(2),
    rr1: (Math.abs(t1-price)/risk).toFixed(2)
  };
}

// ── فحص السوق مفتوح ──
function isMarketOpen(type) {
  if (type === 'crypto' || type === 'index') return true;
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const t = riyadh.getHours()*60 + riyadh.getMinutes();
  const day = riyadh.getDay();
  if (day===0||day===6) return false;
  return t >= 16*60+30 && t < 22*60;
}

// ── فحص إشارات نشطة (T1/T2/T3/SL) ──
async function checkActiveSignals() {
  const active = (await kvGet('active_v2')) || {};
  let changed = false, notifs = 0;
  const perf = (await kvGet('perf_v2')) || { total:0, wins:0, losses:0, totalR:0 };

  for (const [id, sig] of Object.entries(active)) {
    try {
      const cfg = SYMBOLS[sig.symbol];
      if (!cfg) continue;
      const bars = await fetchBars(cfg.yahoo, '1m');
      const price = bars?.price;
      if (!price) continue;

      const isCall = sig.signal === 'CALL';

      // SL
      if (!sig.slHit && ((isCall && price <= sig.sl) || (!isCall && price >= sig.sl))) {
        delete active[id];
        perf.losses++; perf.totalR -= 1; changed = true;
        await sendTelegram(
          `🛑 <b>Stop Loss!</b>\n📌 <b>${sig.symbol}</b>\n💰 $${price.toFixed(2)}\n📊 -1R\n🤖 TIH v9`
        );
        notifs++;
        continue;
      }

      // T1
      if (!sig.t1Hit && ((isCall && price >= sig.t1) || (!isCall && price <= sig.t1))) {
        sig.t1Hit = true; sig.sl = sig.entry; // Break Even
        perf.wins++; perf.totalR += 2; changed = true;
        await sendTelegram(
          `🎯 <b>T1 تحقق! +2R</b>\n📌 <b>${sig.symbol}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2}\n🔒 SL → Break Even\n🤖 TIH v9`
        );
        notifs++;
      }

      // T2
      if (sig.t1Hit && !sig.t2Hit && ((isCall && price >= sig.t2) || (!isCall && price <= sig.t2))) {
        sig.t2Hit = true; perf.totalR += 1; changed = true;
        await sendTelegram(
          `🎯🎯 <b>T2 تحقق! +3R</b>\n📌 <b>${sig.symbol}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 TIH v9`
        );
        notifs++;
      }

      // T3
      if (sig.t2Hit && !sig.t3Hit && ((isCall && price >= sig.t3) || (!isCall && price <= sig.t3))) {
        delete active[id]; perf.totalR += 1; changed = true;
        await sendTelegram(
          `🏆 <b>T3 تحقق! +4R</b>\n📌 <b>${sig.symbol}</b>\n💰 $${price.toFixed(2)}\n💎 الهدف الكامل!\n🤖 TIH v9`
        );
        notifs++;
      }

      active[id] = sig;
    } catch(e) {}
  }

  if (changed) {
    await kvSet('active_v2', active, 7*86400);
    await kvSet('perf_v2', perf, 365*86400);
  }
  return notifs;
}

// ── الدالة الرئيسية ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  // ── Test ──
  if (action === 'test') {
    try {
      const perf = (await kvGet('perf_v2')) || { total:0, wins:0, losses:0, totalR:0 };
      const active = (await kvGet('active_v2')) || {};
      const wr = perf.total > 0 ? ((perf.wins/perf.total)*100).toFixed(0) : 0;
      await sendTelegram(
        `🤖 <b>TIH Trading Hub v9</b>\n━━━━━━━━━━━━━━━\n` +
        `✅ النظام يعمل!\n\n` +
        `📋 الرموز: ${Object.keys(SYMBOLS).length}\n` +
        `📊 الإشارات الكلية: ${perf.total}\n` +
        `🎯 Win Rate: ${wr}%\n` +
        `💰 إجمالي R: ${perf.totalR > 0?'+':''}${perf.totalR.toFixed(1)}R\n` +
        `📌 نشطة: ${Object.keys(active).length}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `⚡ شروط الإشارة: score ≥ 7\n` +
        `📈 المؤشرات: EMA+RSI+MACD+BB\n` +
        `🤖 <i>TIH v9 — Clean Build</i>`
      );
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // ── Stats ──
  if (action === 'stats') {
    const perf = (await kvGet('perf_v2')) || { total:0, wins:0, losses:0, totalR:0 };
    const active = (await kvGet('active_v2')) || {};
    const wr = perf.total > 0 ? ((perf.wins/perf.total)*100).toFixed(0) : 0;
    await sendTelegram(
      `📊 <b>تقرير الأداء</b>\n━━━━━━━━━━━━━━━\n` +
      `📈 الكلي: ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: <b>${wr}%</b>\n` +
      `💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n` +
      `📌 نشطة: ${Object.keys(active).length}\n` +
      `━━━━━━━━━━━━━━━\n🤖 TIH v9`
    );
    return res.status(200).json({ ok: true, perf, active: Object.keys(active).length });
  }

  // ── Check ──
  const symbols = req.query.symbols
    ? req.query.symbols.split(',').map(s => s.trim().toUpperCase()).filter(s => SYMBOLS[s])
    : Object.keys(SYMBOLS);

  const perfAlerts = await checkActiveSignals();
  const newAlerts = [], errors = [];

  await Promise.all(symbols.map(async (sym) => {
    try {
      const cfg = SYMBOLS[sym];
      if (!isMarketOpen(cfg.type)) return;

      const bars = await fetchBars(cfg.yahoo, cfg.interval);
      if (!bars) return;

      const analysis = analyzeSignal(bars);
      if (!analysis) return;

      // منع التكرار — 4 ساعات
      const sigKey = `v9_${sym}_${analysis.signal}_${new Date().toISOString().slice(0,13)}`;
      if (await isSent(sigKey)) return;
      await markSent(sigKey, 4*3600);

      const atr = parseFloat(analysis.atr);
      const targets = calcTargets(analysis.signal, analysis.price, atr, cfg.atrMult);

      // حفظ الإشارة النشطة
      const active = (await kvGet('active_v2')) || {};
      const perf = (await kvGet('perf_v2')) || { total:0, wins:0, losses:0, totalR:0 };
      const sigId = `${sym}_${Date.now()}`;
      active[sigId] = {
        symbol: sym, signal: analysis.signal,
        entry: analysis.price, sl: targets.sl,
        t1: targets.t1, t2: targets.t2, t3: targets.t3,
        t1Hit: false, t2Hit: false, t3Hit: false, slHit: false,
        openedAt: Date.now()
      };
      perf.total++;
      await kvSet('active_v2', active, 7*86400);
      await kvSet('perf_v2', perf, 365*86400);

      newAlerts.push({ sym, signal: analysis.signal });

      const emoji = analysis.signal === 'CALL' ? '🟢' : '🔴';
      const sigType = analysis.signal === 'CALL' ? '📈 CALL — شراء' : '📉 PUT — بيع';

      await sendTelegram(
        `${emoji} <b>${sigType}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b>\n` +
        `💰 السعر: <b>$${analysis.price.toFixed(2)}</b> (${parseFloat(analysis.chgPct)>=0?'+':''}${analysis.chgPct}%)\n` +
        `📈 RSI: ${analysis.rsi} | MACD: ${analysis.macd} | 🔥 ${analysis.confidence}%\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 Entry:     $${analysis.price.toFixed(2)}\n` +
        `🛡️ Stop Loss: $${targets.sl} (${targets.slPct}%)\n` +
        `🏆 T1:        $${targets.t1} (${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🏆 T2:        $${targets.t2}\n` +
        `🏆 T3:        $${targets.t3}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📐 ATR: ${analysis.atr}\n` +
        `🤖 <i>TIH v9 — ${new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh'})}</i>`
      );
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }));

  const active = (await kvGet('active_v2')) || {};

  return res.status(200).json({
    ok: true,
    checked: symbols.length,
    newAlerts: newAlerts.length,
    perfAlerts,
    activeSignals: Object.keys(active).length,
    signals: newAlerts,
    errors
  });
};
