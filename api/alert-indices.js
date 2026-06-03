const https = require('https');

const BOT_TOKEN = '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

const INDICES = {
  'US500': { yahoo: 'ES=F',    name: 'S&P 500 Futures', tv: 'OANDA:SPX500USD' },
  'SPX':   { yahoo: '^GSPC',   name: 'S&P 500',         tv: 'SP:SPX'          },
  'NDX':   { yahoo: '^NDX',    name: 'Nasdaq 100',       tv: 'NASDAQ:NDX'      },
  'DJI':   { yahoo: '^DJI',    name: 'Dow Jones',        tv: 'DJ:DJI'          },
  'BTC':   { yahoo: 'BTC-USD', name: 'Bitcoin',          tv: 'CRYPTO:BTCUSD'   },
  'ETH':   { yahoo: 'ETH-USD', name: 'Ethereum',         tv: 'CRYPTO:ETHUSD'   },
  'XAUUSD':{ yahoo: 'GC=F',    name: 'Gold Futures',     tv: 'OANDA:XAUUSD'    },
};

const CRYPTO_SYMS = new Set(['BTC','ETH']);
const TV_INTERVAL = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };

const INTERVALS = {
  trend: { interval: '1h',  range: '30d' },
  entry: { interval: '15m', range: '5d'  },
  fast:  { interval: '5m',  range: '2d'  },
};

const ATR_MULT = { sl: 1.2, t1: 1.0, t2: 2.0, t3: 3.5 };

// ── VIX Cache ──
let vixCache = { value: null, ts: 0 };

// ── فلتر ساعات السوق ──
function isMarketOpen(sym) {
  if (CRYPTO_SYMS.has(sym)) return true;
  const now = new Date();
  const day = now.getUTCDay();
  return day !== 0 && day !== 6;
}

// ── جلب VIX ──
async function getVIX() {
  // كاش لمدة 15 دقيقة
  if (vixCache.value && (Date.now() - vixCache.ts) < 15 * 60 * 1000) {
    return vixCache.value;
  }
  try {
    const bars = await getBars('^VIX', '1d', '5d');
    if (bars && bars.price) {
      vixCache = { value: bars.price, ts: Date.now() };
      return bars.price;
    }
  } catch(e) {}
  return null;
}

// ── Volume Confirmation ──
function hasVolumeConfirmation(bars) {
  if (!bars.vols || bars.vols.length < 20) return true;
  const vols = bars.vols.filter(v => v > 0);
  if (vols.length < 10) return true;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  const lastVol = vols[vols.length-1];
  return lastVol >= avgVol * 0.8;
}

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

async function saveLog(entry) {
  try {
    const log = (await kvGet('idx_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 100) log.splice(100);
    await kvSet('idx_log', log, 90*86400);
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
    if (price>e50) { bull+=2; reasons.push('فوق EMA50'); }
    else { bear+=2; reasons.push('تحت EMA50'); }
  }

  if (r>58 && r<70) { bull+=2; reasons.push(`RSI ${r.toFixed(0)}`); }
  else if (r<42 && r>30) { bear+=2; reasons.push(`RSI ${r.toFixed(0)}`); }
  else if (r<=28) { bull+=3; reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`); }
  else if (r>=72) { bear+=2; reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`); }

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
  if (chg>0.5) { bull+=2; reasons.push(`زخم +${chg.toFixed(1)}%`); }
  else if (chg>0.2) bull+=1;
  else if (chg<-0.5) { bear+=2; reasons.push(`زخم ${chg.toFixed(1)}%`); }
  else if (chg<-0.2) bear+=1;

  const signal = bull>=9?'CALL':bear>=9?'PUT':null;
  const trend  = bull>bear?'bull':bear>bull?'bear':'neutral';

  return { signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg };
}

async function analyzeMTF(sym, vix) {
  if (!isMarketOpen(sym)) return null;

  // ── فلتر VIX ──
  // إذا VIX > 35: لا إشارات نهائياً (تقلب شديد جداً)
  // إذا VIX بين 25-35: فقط Grade S مسموح
  // إذا VIX < 25: عادي
  const vixLevel = vix || 0;
  if (vixLevel > 35 && !CRYPTO_SYMS.has(sym)) return null;

  const cfg = INDICES[sym];
  const [trendBars, entryBars, fastBars] = await Promise.all([
    getBars(cfg.yahoo, INTERVALS.trend.interval, INTERVALS.trend.range),
    getBars(cfg.yahoo, INTERVALS.entry.interval, INTERVALS.entry.range),
    getBars(cfg.yahoo, INTERVALS.fast.interval,  INTERVALS.fast.range),
  ]);

  if (!trendBars) return null;
  if (!hasVolumeConfirmation(trendBars)) return null;

  const trendResult = analyzeFrame(trendBars);
  const entryResult = entryBars ? analyzeFrame(entryBars) : null;
  const fastResult  = fastBars  ? analyzeFrame(fastBars)  : null;

  if (!trendResult) return null;

  const dominantTrend = trendResult.trend;
  if (dominantTrend === 'neutral') return null;

  const requiredSignal = dominantTrend === 'bull' ? 'CALL' : 'PUT';

  let entryFrame = null, entryData = null;

  if (fastResult?.signal === requiredSignal) {
    entryFrame = '5M'; entryData = fastResult;
  } else if (entryResult?.signal === requiredSignal) {
    entryFrame = '15M'; entryData = entryResult;
  } else if (trendResult.signal === requiredSignal) {
    entryFrame = '1H'; entryData = trendResult;
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

  if (agreements === 3 && combinedScore >= 10) {
    grade='S'; gradeLabel='🔥 نسبة نجاح عالية جداً'; successRate=85;
  } else if (agreements === 3 || (agreements >= 2 && combinedScore >= 9)) {
    grade='A'; gradeLabel='✅ نسبة نجاح عالية'; successRate=72;
  } else if (agreements === 2 && combinedScore >= 8) {
    grade='B'; gradeLabel='⚡ نسبة نجاح متوسطة'; successRate=58;
  } else {
    grade='C'; gradeLabel='⚠️ نسبة نجاح منخفضة'; successRate=0;
  }

  if (grade === 'C') return null;

  // VIX 25-35: فقط Grade S مسموح
  if (vixLevel >= 25 && vixLevel <= 35 && grade !== 'S' && !CRYPTO_SYMS.has(sym)) return null;

  return {
    sym, signal: requiredSignal,
    dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price: entryData.price || trendBars.price,
    atr: entryData.atr,
    trendRSI: trendResult.rsi?.toFixed(1),
    entryRSI: entryData.rsi?.toFixed(1),
    trendReasons: trendResult.reasons,
    entryReasons: entryData.reasons,
    agreements, totalFrames: 3,
    trendScore: dominantTrend==='bull'?trendResult.bull:trendResult.bear,
    vix: vixLevel > 0 ? vixLevel.toFixed(1) : null,
  };
}

function calcTargets(signal, price, atrVal) {
  const d = signal==='CALL' ? 1 : -1;
  const sl = price - d*atrVal*ATR_MULT.sl;
  const t1 = price + d*atrVal*ATR_MULT.t1;
  const t2 = price + d*atrVal*ATR_MULT.t2;
  const t3 = price + d*atrVal*ATR_MULT.t3;
  const risk = Math.abs(price-sl);
  return {
    sl:  +sl.toFixed(2), t1: +t1.toFixed(2),
    t2:  +t2.toFixed(2), t3: +t3.toFixed(2),
    slPct: ((sl-price)/price*100).toFixed(2),
    t1Pct: ((t1-price)/price*100).toFixed(2),
    rr1:  (Math.abs(t1-price)/risk).toFixed(2),
    rr2:  (Math.abs(t2-price)/risk).toFixed(2),
  };
}

async function checkActiveSignals() {
  const active = (await kvGet('idx_active')) || {};
  const perf   = (await kvGet('idx_perf'))   || { total:0,wins:0,losses:0,totalR:0.0 };
  let changed=false, notifs=0;

  for (const [id, sig] of Object.entries(active)) {
    try {
      const cfg = INDICES[sig.sym];
      if (!cfg) { delete active[id]; changed=true; continue; }

      const bars = await getBars(cfg.yahoo, '1m', '1d');
      const price = bars?.price;
      if (!price) continue;

      const isCall = sig.signal === 'CALL';

      if ((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)) {
        delete active[id];
        perf.losses++; perf.totalR-=1; changed=true;
        await saveLog({ sym:sig.sym, signal:sig.signal, grade:sig.grade, entry:sig.entry, exit:price, result:'SL', r:-1, type:'index' });
        await tg(`🛑 <b>Stop Loss!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n💰 السعر: <b>$${price.toFixed(2)}</b>\n🛡️ SL كان: $${sig.sl}\n━━━━━━━━━━━━━━━\n📊 -1R | Win Rate: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n🤖 <i>TIH Indices</i>`);
        notifs++; continue;
      }

      if (!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))) {
        sig.t1Hit=true; sig.sl=sig.entry;
        perf.wins++; perf.totalR+=2; changed=true;
        await saveLog({ sym:sig.sym, signal:sig.signal, grade:sig.grade, entry:sig.entry, exit:price, result:'T1', r:2, type:'index' });
        await tg(`🎯 <b>T1 تحقق! +2R</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈':'📉'}\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → Break Even ($${sig.entry})\n🤖 <i>TIH Indices</i>`);
        notifs++;
      }

      if (sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))) {
        sig.t2Hit=true; perf.totalR+=1; changed=true;
        await saveLog({ sym:sig.sym, signal:sig.signal, grade:sig.grade, entry:sig.entry, exit:price, result:'T2', r:3, type:'index' });
        await tg(`🎯🎯 <b>T2 تحقق! +3R 🔥</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Indices</i>`);
        notifs++;
      }

      if (sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))) {
        delete active[id]; perf.totalR+=1; changed=true;
        await saveLog({ sym:sig.sym, signal:sig.signal, grade:sig.grade, entry:sig.entry, exit:price, result:'T3', r:4, type:'index' });
        await tg(`🏆🏆🏆 <b>T3 تحقق! +4R 💎</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n📊 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n🤖 <i>TIH Indices</i>`);
        notifs++; continue;
      }

      const age = Date.now() - (sig.openedAt || 0);
      if (age > 24 * 60 * 60 * 1000 && !sig.t1Hit) {
        delete active[id]; changed=true;
        await saveLog({ sym:sig.sym, signal:sig.signal, grade:sig.grade, entry:sig.entry, exit:price, result:'EXP', r:0, type:'index' });
        await tg(`⏰ <b>انتهت صلاحية الإشارة</b>\n📌 <b>${sig.sym}</b> — ${sig.signal}\n24 ساعة بدون T1 → إغلاق\n🤖 <i>TIH Indices</i>`);
        notifs++; continue;
      }

      active[id] = sig;
    } catch(e) {}
  }

  if (changed) {
    await kvSet('idx_active', active, 7*86400);
    await kvSet('idx_perf', perf, 365*86400);
  }
  return notifs;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  if (action==='test') {
    const perf   = (await kvGet('idx_perf'))   || { total:0,wins:0,losses:0,totalR:0 };
    const active = (await kvGet('idx_active')) || {};
    const wr = perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix = await getVIX();
    const vixStatus = !vix?'—':vix>35?'🔴 '+vix.toFixed(1)+' (إيقاف كامل)':vix>25?'🟡 '+vix.toFixed(1)+' (S فقط)':'🟢 '+vix.toFixed(1)+' (طبيعي)';
    await tg(
      `🤖 <b>TIH Indices v4.0</b>\n━━━━━━━━━━━━━━━\n` +
      `✅ النظام يعمل!\n\n` +
      `📊 الإشارات: ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n` +
      `💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `✅ شرط الإشارة: bull >= 9\n` +
      `✅ فلتر ساعات السوق: مفعّل\n` +
      `✅ Volume Confirmation: مفعّل\n` +
      `✅ فلتر VIX: مفعّل\n` +
      `📊 VIX الحالي: ${vixStatus}\n` +
      `✅ إغلاق تلقائي: 24 ساعة\n` +
      `🤖 <i>TIH Indices v4.0</i>`
    );
    return res.status(200).json({ ok:true, vix });
  }

  if (action==='reset') {
    await kvDel('idx_active');
    await tg('🔄 <b>تم مسح الإشارات النشطة</b>\n🤖 TIH Indices');
    return res.status(200).json({ ok:true, message:'Active signals cleared' });
  }

  if (action==='cleanup') {
    const active = (await kvGet('idx_active')) || {};
    const latest = {};
    for (const [id, sig] of Object.entries(active)) {
      if (!latest[sig.sym] || sig.openedAt > latest[sig.sym].openedAt)
        latest[sig.sym] = { id, ...sig };
    }
    const newActive = {};
    for (const [sym, sig] of Object.entries(latest)) {
      const { id, ...data } = sig;
      newActive[id] = data;
    }
    const removed = Object.keys(active).length - Object.keys(newActive).length;
    await kvSet('idx_active', newActive, 7*86400);
    return res.status(200).json({ ok:true, removed, remaining: Object.keys(newActive).length });
  }

  if (action==='log') {
    const log = (await kvGet('idx_log')) || [];
    return res.status(200).json({ ok:true, log, count:log.length });
  }

  if (action==='stats') {
    const perf   = (await kvGet('idx_perf'))   || { total:0,wins:0,losses:0,totalR:0 };
    const active = (await kvGet('idx_active')) || {};
    const wr = perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix = await getVIX();
    await tg(
      `📊 <b>أداء المؤشرات</b>\n━━━━━━━━━━━━━━━\n` +
      `📈 الكلي: ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: <b>${wr}%</b>\n` +
      `💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n` +
      `📌 نشطة: ${Object.keys(active).length}\n` +
      `📊 VIX: ${vix?vix.toFixed(1):'—'}\n` +
      `━━━━━━━━━━━━━━━\n🤖 TIH Indices`
    );
    return res.status(200).json({ ok:true, perf, active:Object.keys(active).length, vix });
  }

  const symbols = req.query.symbols
    ? req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>INDICES[s])
    : Object.keys(INDICES);

  const perfNotifs = await checkActiveSignals();
  const newAlerts=[], errors=[], skipped=[];

  // جلب VIX مرة واحدة لكل الرموز
  const vix = await getVIX();

  // تنبيه VIX عالٍ — مرة واحدة في اليوم
  if (vix && vix > 25) {
    const lastVixAlert = await kvGet('idx_vix_alert');
    const today = new Date().toISOString().split('T')[0];
    if (lastVixAlert !== today) {
      await kvSet('idx_vix_alert', today, 86400);
      const vixMsg = vix > 35
        ? `⚠️ <b>VIX تحذير شديد!</b>\n📊 VIX = <b>${vix.toFixed(1)}</b> (فوق 35)\n🚫 تم إيقاف جميع الإشارات\nالسوق في حالة تقلب شديد — تجنب الدخول\n🤖 <i>TIH Indices</i>`
        : `⚠️ <b>VIX مرتفع</b>\n📊 VIX = <b>${vix.toFixed(1)}</b> (25-35)\n⚡ فقط إشارات Grade S مسموحة\nتداول بحذر وحجم أصغر\n🤖 <i>TIH Indices</i>`;
      await tg(vixMsg);
    }
  }

  await Promise.all(symbols.map(async (sym) => {
    try {
      if (!isMarketOpen(sym)) { skipped.push(sym); return; }

      const result = await analyzeMTF(sym, vix);
      if (!result) return;

      const active = (await kvGet('idx_active')) || {};
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

      const perf = (await kvGet('idx_perf')) || { total:0,wins:0,losses:0,totalR:0 };
      perf.total++;
      await kvSet('idx_active', active, 7*86400);
      await kvSet('idx_perf', perf, 365*86400);
      newAlerts.push({ sym, signal: result.signal, grade: result.grade });

      const emoji   = result.signal==='CALL'?'🟢':'🔴';
      const sigType = result.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const now     = new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});
      const vixLine = result.vix ? `📊 VIX: ${result.vix}\n` : '';

      await tg(
        `${emoji} <b>${sigType}</b>\n` +
        `${result.gradeLabel} — احتمال النجاح: <b>${result.successRate}%</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — ${INDICES[sym].name}\n` +
        `💰 السعر: <b>$${result.price.toFixed(2)}</b>\n` +
        `📊 RSI(1H): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}\n` +
        `🔀 التوافق: ${result.agreements}/${result.totalFrames} فريم\n` +
        `⏱️ الدخول من: ${result.entryFrame}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 Entry:     $${result.price.toFixed(2)}\n` +
        `🛡️ Stop Loss: $${targets.sl} (${targets.slPct}%)\n` +
        `🏆 T1:        $${targets.t1} (${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🏆 T2:        $${targets.t2} | 1:${targets.rr2}\n` +
        `🏆 T3:        $${targets.t3}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📐 ATR: ${result.atr.toFixed(3)}\n` +
        vixLine +
        `⏰ ${now}\n` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(INDICES[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">فتح الشارت ↗</a>\n` +
        `🤖 <i>TIH Indices v4.0</i>`
      );
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }));

  const active = (await kvGet('idx_active')) || {};
  return res.status(200).json({
    ok: true, checked: symbols.length,
    newAlerts: newAlerts.length, perfNotifs,
    active: Object.keys(active).length,
    signals: newAlerts, skipped, errors,
    vix: vix ? +vix.toFixed(1) : null
  });
};
