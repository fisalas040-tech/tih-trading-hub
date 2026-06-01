const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

const DEFAULT_WATCHLIST = (process.env.WATCHLIST ||
  'AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL,META,AMD,AVGO,MRVL,SPX,NDX,DJI,VIX,BTC,ETH,XAUUSD'
).split(',').map(s => s.trim()).filter(Boolean);

const YAHOO_MAP = {
  'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','VIX':'^VIX','DXY':'DX-Y.NYB',
  'BTC':'BTC-USD','ETH':'ETH-USD','XAUUSD':'GC=F','SOL':'SOL-USD'
};

const NO_FILTER_SYMBOLS = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','SPX','NDX','DJI'
]);

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

async function kvSet(key, value, exSeconds = 86400) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${exSeconds}`, {
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

// ── Sent Signals (منع التكرار) ──
async function isSent(key) {
  const val = await kvGet(`sent:${key}`);
  return val !== null;
}
async function markSent(key) {
  await kvSet(`sent:${key}`, 1, 4 * 3600); // 4 ساعات
}

// ── Active Signals (متابعة T1/T2/T3/SL) ──
async function getActiveSignals() {
  return (await kvGet('active_signals')) || {};
}
async function saveActiveSignals(signals) {
  await kvSet('active_signals', signals, 7 * 86400);
}

// ── Performance ──
async function getPerformance() {
  return (await kvGet('performance')) || {
    total: 0, wins: 0, losses: 0,
    t1Hits: 0, t2Hits: 0, t3Hits: 0, slHits: 0,
    totalR: 0
  };
}
async function savePerformance(perf) {
  await kvSet('performance', perf, 365 * 86400);
}

// ── Market Open/Close ──
async function checkMarketOpenClose() {
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const hours = riyadh.getHours();
  const minutes = riyadh.getMinutes();
  const totalMin = hours * 60 + minutes;
  const day = riyadh.getDay();
  if (day === 0 || day === 6) return;

  const todayKey = riyadh.toISOString().slice(0, 10);

  if (totalMin >= 16*60+30 && totalMin < 16*60+35) {
    const sent = await isSent(`market_open_${todayKey}`);
    if (!sent) {
      await markSent(`market_open_${todayKey}`);
      await sendTelegram(
        `🔔 <b>السوق فتح الآن!</b>\n━━━━━━━━━━━━━━━\n` +
        `⏰ 4:30 م — بدأت جلسة نيويورك\n🔥 Open Killzone نشطة\n` +
        `━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`
      );
    }
  }

  if (totalMin >= 22*60 && totalMin < 22*60+5) {
    const sent = await isSent(`market_close_${todayKey}`);
    if (!sent) {
      await markSent(`market_close_${todayKey}`);
      await sendTelegram(
        `🔕 <b>السوق أغلق</b>\n━━━━━━━━━━━━━━━\n` +
        `⏰ 10:00 م — انتهت جلسة نيويورك\n⏭️ الفتح القادم: غداً 4:30 م\n` +
        `━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`
      );
    }
  }
}

function isMarketOpen(symbol) {
  if (NO_FILTER_SYMBOLS.has(symbol)) return { open: true, session: '24/7' };
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const hours = riyadh.getHours();
  const minutes = riyadh.getMinutes();
  const totalMin = hours * 60 + minutes;
  const day = riyadh.getDay();
  if (day === 0 || day === 6) return { open: false, session: 'weekend' };
  const openTime = 16 * 60 + 30;
  const closeTime = 22 * 60;
  if (totalMin >= openTime && totalMin < closeTime) {
    let session = 'midday';
    if (totalMin < openTime + 90) session = '🔥 Open Killzone';
    else if (totalMin >= 20*60+30) session = '🔥 Power Hour';
    return { open: true, session };
  }
  return { open: false, session: 'closed' };
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function calcSMA(p, n) { if (p.length < n) return null; return p.slice(-n).reduce((a, b) => a + b, 0) / n; }
function calcEMA(p, n) {
  if (p.length < n) return null;
  let k = 2 / (n + 1), e = p.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < p.length; i++) e = p[i] * k + e * (1 - k);
  return e;
}
function calcRSI(p, n = 14) {
  if (p.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = p[i] - p[i-1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < p.length; i++) { const d = p[i] - p[i-1]; if (d > 0) { ag = (ag*(n-1)+d)/n; al = al*(n-1)/n; } else { ag = ag*(n-1)/n; al = (al*(n-1)-d)/n; } }
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}
function calcATR(h, l, c, n = 14) {
  if (c.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < c.length; i++) trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function calcPowerZones(highs, lows, atr) {
  const n = Math.min(130, highs.length);
  const zoneAtr = atr * 0.5;
  const zoneHi = Math.max(...highs.slice(-n));
  const zoneLo = Math.min(...lows.slice(-n));
  return { resTop: zoneHi + zoneAtr, resBot: zoneHi - zoneAtr, supTop: zoneLo + zoneAtr, supBot: zoneLo - zoneAtr };
}

function detectFalseBreakout(closes, highs, lows, supTop, supBot, resTop, resBot) {
  if (closes.length < 3) return null;
  const prev = closes[closes.length - 2], curr = closes[closes.length - 1];
  const prevL = lows[lows.length - 2], prevH = highs[highs.length - 2];
  if (prevL < supBot && prev < supTop && curr > supTop) return 'CALL_FALSE_BREAK';
  if (prevH > resTop && prev > resBot && curr < resBot) return 'PUT_FALSE_BREAK';
  return null;
}

function detectRoleReversal(closes, highs, lows, supTop, supBot, resTop, resBot, atr) {
  if (closes.length < 10) return null;
  const curr = closes[closes.length - 1], tolerance = atr * 0.5;
  if (curr >= resBot - tolerance && curr <= resTop + tolerance) {
    if (closes.slice(-10, -3).some(c => c > resTop)) return 'CALL_ROLE_REVERSAL';
  }
  if (curr >= supBot - tolerance && curr <= supTop + tolerance) {
    if (closes.slice(-10, -3).some(c => c < supBot)) return 'PUT_ROLE_REVERSAL';
  }
  return null;
}

function calcRiskReward(signal, price, closes, highs, lows, atr, zones, htfBull, htfBear) {
  const { resTop, resBot, supTop, supBot } = zones;
  const isCT = signal === 'CALL' ? htfBear : htfBull;
  const ema9 = calcEMA(closes, 9) || price, ema21 = calcEMA(closes, 21) || price;
  if (isCT && Math.abs(ema9 - ema21) / atr > 2.0) return null;
  let entry, stop, risk, t1, t2, t3, sigType;
  if (signal === 'CALL') {
    entry = price;
    stop = isCT ? entry - atr * 1.5 : Math.min(supBot - atr * 0.2, entry - atr * 1.0);
    stop = Math.max(stop, entry * 0.97);
    risk = entry - stop;
    if (risk <= 0) return null;
    t1 = entry + 2 * risk; t2 = entry + 3 * risk;
    t3 = resBot > entry ? Math.max(resBot, t2 + risk) : t2 + risk;
    sigType = isCT ? '⚠️ CALL (عكسي)' : '📈 CALL';
  } else {
    entry = price;
    stop = isCT ? entry + atr * 1.5 : Math.max(resTop + atr * 0.2, entry + atr * 1.0);
    stop = Math.min(stop, entry * 1.03);
    risk = stop - entry;
    if (risk <= 0) return null;
    t1 = entry - 2 * risk; t2 = entry - 3 * risk;
    t3 = supTop < entry ? Math.min(supTop, t2 - risk) : t2 - risk;
    sigType = isCT ? '⚠️ PUT (عكسي)' : '📉 PUT';
  }
  const rr1 = Math.abs(t1 - entry) / risk;
  if (rr1 < 1.5) return null;
  return {
    entry: +entry.toFixed(2), stop: +stop.toFixed(2),
    t1: +t1.toFixed(2), t2: +t2.toFixed(2), t3: +t3.toFixed(2),
    risk: +risk.toFixed(2), rr1: rr1.toFixed(2),
    rr2: (Math.abs(t2 - entry) / risk).toFixed(2),
    slPct: ((stop - entry) / entry * 100).toFixed(2),
    t1Pct: ((t1 - entry) / entry * 100).toFixed(2),
    t2Pct: ((t2 - entry) / entry * 100).toFixed(2),
    sigType, isCT, signal
  };
}

async function getCurrentPrice(symbol) {
  const yfSym = YAHOO_MAP[symbol] || symbol;
  const json = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1m&range=1d`);
  return json?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
}

// ── فحص الإشارات النشطة (T1/T2/T3/SL) من Redis ──
async function checkActiveSignals() {
  const activeSignals = await getActiveSignals();
  const perf = await getPerformance();
  let notifications = 0;
  let changed = false;

  for (const [key, sig] of Object.entries(activeSignals)) {
    try {
      const price = await getCurrentPrice(sig.symbol);
      if (!price) continue;
      const isCall = sig.signal === 'CALL';

      // SL
      if (!sig.slHit && ((isCall && price <= sig.stop) || (!isCall && price >= sig.stop))) {
        sig.slHit = true;
        delete activeSignals[key];
        perf.losses++; perf.slHits++; perf.totalR -= 1;
        changed = true;
        await sendTelegram(
          `🛑 <b>Stop Loss ضُرب!</b>\n━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.symbol}</b> — ${sig.sigType}\n` +
          `💰 السعر: <b>$${price.toFixed(2)}</b>\n🛡️ SL: $${sig.stop}\n` +
          `━━━━━━━━━━━━━━━\n📊 النتيجة: <b>-1R خسارة</b>\n` +
          `📈 Win Rate: ${perf.total > 0 ? ((perf.wins/perf.total)*100).toFixed(0) : 0}%\n` +
          `━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`
        );
        notifications++;
        continue;
      }

      // T1
      if (!sig.t1Hit && ((isCall && price >= sig.t1) || (!isCall && price <= sig.t1))) {
        sig.t1Hit = true; sig.stop = sig.entry;
        perf.t1Hits++; perf.wins++; perf.totalR += 2;
        changed = true;
        await sendTelegram(
          `🎯 <b>T1 تحقق! +2R</b>\n━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.symbol}</b> — ${sig.sigType}\n` +
          `💰 السعر: <b>$${price.toFixed(2)}</b>\n🏆 T1: $${sig.t1}\n` +
          `⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n` +
          `━━━━━━━━━━━━━━━\n📊 +2R ✅ | SL → Break Even\n` +
          `━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`
        );
        notifications++;
      }

      // T2
      if (sig.t1Hit && !sig.t2Hit && ((isCall && price >= sig.t2) || (!isCall && price <= sig.t2))) {
        sig.t2Hit = true;
        perf.t2Hits++; perf.totalR += 1;
        changed = true;
        await sendTelegram(
          `🎯🎯 <b>T2 تحقق! +3R</b>\n━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.symbol}</b> — ${sig.sigType}\n` +
          `💰 السعر: <b>$${price.toFixed(2)}</b>\n🏆 T2: $${sig.t2}\n` +
          `⏭️ T3: $${sig.t3}\n━━━━━━━━━━━━━━━\n📊 +3R 🔥\n` +
          `━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`
        );
        notifications++;
      }

      // T3
      if (sig.t2Hit && !sig.t3Hit && ((isCall && price >= sig.t3) || (!isCall && price <= sig.t3))) {
        sig.t3Hit = true;
        delete activeSignals[key];
        perf.t3Hits++; perf.totalR += 1;
        changed = true;
        await sendTelegram(
          `🏆🏆🏆 <b>T3 تحقق! الهدف الكامل!</b>\n━━━━━━━━━━━━━━━\n` +
          `📌 <b>${sig.symbol}</b> — ${sig.sigType}\n` +
          `💰 السعر: <b>$${price.toFixed(2)}</b>\n🏆 T3: $${sig.t3}\n` +
          `━━━━━━━━━━━━━━━\n📊 +4R+ 💎\n` +
          `Win Rate: ${((perf.wins/perf.total)*100).toFixed(0)}% | إجمالي R: ${perf.totalR > 0 ? '+' : ''}${perf.totalR.toFixed(1)}R\n` +
          `━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`
        );
        notifications++;
      }

      activeSignals[key] = sig;
    } catch(e) {}
  }

  if (changed) {
    await saveActiveSignals(activeSignals);
    await savePerformance(perf);
  }
  return notifications;
}

async function analyzeSymbol(symbol) {
  const yfSym = YAHOO_MAP[symbol] || symbol;
  const json = await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1d&range=6mo`);
  const result = json?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta, q = result.indicators.quote[0];
  const vi = q.close.map((v, i) => v !== null ? i : -1).filter(i => i >= 0);
  const closes = vi.map(i => q.close[i]);
  const highs  = vi.map(i => q.high[i]);
  const lows   = vi.map(i => q.low[i]);
  if (closes.length < 30) return null;

  const price = meta.regularMarketPrice || closes[closes.length - 1];
  const prevClose = closes[closes.length - 2] || price;
  const changePct = ((price - prevClose) / prevClose * 100).toFixed(2);
  const rsi = calcRSI(closes);
  const atr = calcATR(highs, lows, closes, 14) || price * 0.01;
  const ema9 = calcEMA(closes, 9) || price;
  const ema21 = calcEMA(closes, 21) || price;
  const sma200 = calcSMA(closes, 200);
  const htfBull = ema9 > ema21, htfBear = ema9 < ema21;
  const zones = calcPowerZones(highs, lows, atr);
  const falseBreak = detectFalseBreakout(closes, highs, lows, zones.supTop, zones.supBot, zones.resTop, zones.resBot);
  const roleRev = detectRoleReversal(closes, highs, lows, zones.supTop, zones.supBot, zones.resTop, zones.resBot, atr);

  let score = 0;
  if (price > ema9 && ema9 > ema21) score += 2;
  if (price < ema9 && ema9 < ema21) score -= 2;
  if (parseFloat(changePct) > 1) score += 2;
  else if (parseFloat(changePct) > 0) score += 1;
  else if (parseFloat(changePct) < -1) score -= 2;
  else score -= 1;
  if (sma200 && price > sma200) score += 1;
  else if (sma200 && price < sma200) score -= 1;
  if (rsi && rsi > 55) score += 1;
  else if (rsi && rsi < 45) score -= 1;
  if (rsi && rsi > 70) score -= 1;
  else if (rsi && rsi < 30) score += 1;

  let rawSignal = score >= 4 ? 'CALL' : score <= -4 ? 'PUT' : null;
  if (!rawSignal && falseBreak === 'CALL_FALSE_BREAK') rawSignal = 'CALL';
  if (!rawSignal && falseBreak === 'PUT_FALSE_BREAK')  rawSignal = 'PUT';
  if (!rawSignal) return null;

  if (!isMarketOpen(symbol).open) return null;

  const rr = calcRiskReward(rawSignal, price, closes, highs, lows, atr, zones, htfBull, htfBear);
  if (!rr) return null;

  const confidence = Math.min(90, Math.round(50 + Math.abs(score) * 7));
  const tags = [];
  if (falseBreak && falseBreak.startsWith(rawSignal)) tags.push('كسر وهمي');
  if (roleRev && roleRev.startsWith(rawSignal)) tags.push('تبادل أدوار');
  const tagStr = tags.length > 0 ? ' | ' + tags.join(' | ') : '';

  return {
    symbol, fullName: meta.longName || meta.shortName || symbol,
    price: price.toFixed(2), changePct, rsi: rsi ? rsi.toFixed(1) : '—',
    signal: rawSignal, sigType: rr.sigType, score, confidence, rr, zones,
    atr: atr.toFixed(2), currency: meta.currency || 'USD', tagStr, tags
  };
}

// ── Macro Events ──
const MACRO_RULES = {
  'Non-Farm': (a,f) => { const b=a-f; if(b>100)return{label:'🟢🟢 صعود قوي',reason:'وظائف أقوى بكثير'}; if(b>30)return{label:'🟢 صعود متوسط',reason:'وظائف أفضل من التوقعات'}; if(b>-30)return{label:'⚪ تأثير لحظي',reason:'قريب من التوقعات'}; if(b>-100)return{label:'🔴 هبوط متوسط',reason:'وظائف أقل من التوقعات'}; return{label:'🔴🔴 هبوط قوي',reason:'وظائف ضعيفة جداً'}; },
  'CPI': (a,f) => { const b=a-f; if(b>0.3)return{label:'🔴🔴 هبوط قوي',reason:'تضخم أعلى بكثير'}; if(b>0.1)return{label:'🔴 هبوط متوسط',reason:'تضخم أعلى من التوقعات'}; if(b>-0.1)return{label:'⚪ تأثير لحظي',reason:'في خط التوقعات'}; if(b>-0.3)return{label:'🟢 صعود متوسط',reason:'تضخم أقل من التوقعات'}; return{label:'🟢🟢 صعود قوي',reason:'تضخم منخفض جداً'}; },
  'GDP': (a,f) => { const b=a-f; if(b>0.5)return{label:'🟢🟢 صعود قوي',reason:'نمو اقتصادي قوي جداً'}; if(b>0.1)return{label:'🟢 صعود متوسط',reason:'نمو أفضل من المتوقع'}; if(b>-0.1)return{label:'⚪ تأثير لحظي',reason:'في خط التوقعات'}; if(b>-0.5)return{label:'🔴 هبوط متوسط',reason:'نمو أضعف من المتوقع'}; return{label:'🔴🔴 هبوط قوي',reason:'نمو ضعيف جداً'}; },
  'default': (a,f) => { const pct=f?((a-f)/Math.abs(f))*100:0; if(pct>10)return{label:'🟢🟢 صعود قوي',reason:'أفضل بكثير من التوقعات'}; if(pct>3)return{label:'🟢 صعود متوسط',reason:'أفضل من التوقعات'}; if(pct>-3)return{label:'⚪ تأثير لحظي',reason:'قريب من التوقعات'}; if(pct>-10)return{label:'🔴 هبوط متوسط',reason:'أضعف من التوقعات'}; return{label:'🔴🔴 هبوط قوي',reason:'أضعف بكثير من التوقعات'}; }
};

async function checkMacroEvents() {
  try {
    const events = await fetchJSON('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    if (!Array.isArray(events)) return 0;
    const now = new Date(); let sent = 0;
    for (const e of events) {
      if (!e.title || !e.actual) continue;
      if (e.impact !== 'High' && e.impact !== 'Medium') continue;
      const eventTime = new Date(e.date);
      const diffMin = (now - eventTime) / 60000;
      if (diffMin < 0 || diffMin > 15) continue;
      const key = `macro_${e.title}_${e.date}`;
      if (await isSent(key)) continue;
      await markSent(key);
      let fn = MACRO_RULES['default'];
      for (const k of Object.keys(MACRO_RULES)) { if (k !== 'default' && e.title.includes(k)) { fn = MACRO_RULES[k]; break; } }
      const impact = fn(parseFloat(e.actual), parseFloat(e.forecast));
      const timeStr = eventTime.toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });
      await sendTelegram(
        `🌍 <b>بيانة اقتصادية صدرت!</b>\n━━━━━━━━━━━━━━━\n` +
        `📌 <b>${e.title}</b>\n${e.impact === 'High' ? '🔴 عالٍ' : '🟡 متوسط'} | ⏰ ${timeStr}\n` +
        `━━━━━━━━━━━━━━━\n📊 الفعلي: <b>${e.actual}</b>\n🎯 التوقعات: ${e.forecast || '—'}\n📅 السابق: ${e.previous || '—'}\n` +
        `━━━━━━━━━━━━━━━\n${impact.label}\n💡 ${impact.reason}\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`
      );
      sent++;
    }
    return sent;
  } catch(e) { return 0; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  // ── Test ──
  if (action === 'test') {
    try {
      await sendTelegram(
        '🤖 <b>TIH Trading Hub</b>\n━━━━━━━━━━━━━━━\n' +
        '✅ نظام التنبيهات يعمل!\n\n' +
        '📋 القائمة:\n' + DEFAULT_WATCHLIST.map(s => `• ${s}`).join('\n') + '\n\n' +
        '🗄️ التخزين: Upstash Redis ✅\n' +
        '📊 تتبع الأداء: مفعّل (T1/T2/T3/SL)\n' +
        '🌍 الاقتصاد الكلي: مفعّل\n' +
        '⏱️ فحص كل 5 دقائق تلقائياً'
      );
      return res.status(200).json({ ok: true });
    } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
  }

  // ── Stats ──
  if (action === 'stats') {
    const perf = await getPerformance();
    const active = await getActiveSignals();
    const winRate = perf.total > 0 ? ((perf.wins / perf.total) * 100).toFixed(0) : 0;
    await sendTelegram(
      `📊 <b>تقرير الأداء</b>\n━━━━━━━━━━━━━━━\n` +
      `📈 إجمالي الإشارات: <b>${perf.total}</b>\n` +
      `✅ ناجحة: <b>${perf.wins}</b> | ❌ فاشلة: <b>${perf.losses}</b>\n` +
      `🎯 Win Rate: <b>${winRate}%</b>\n━━━━━━━━━━━━━━━\n` +
      `🏆 T1: ${perf.t1Hits} | T2: ${perf.t2Hits} | T3: ${perf.t3Hits} | SL: ${perf.slHits}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `💰 إجمالي R: <b>${perf.totalR > 0 ? '+' : ''}${perf.totalR.toFixed(1)}R</b>\n` +
      `📌 إشارات نشطة: ${Object.keys(active).length}\n` +
      `━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`
    );
    return res.status(200).json({ ok: true, perf, activeCount: Object.keys(active).length });
  }

  // ── Check ──
  const symbols = req.query.symbols
    ? req.query.symbols.split(',').map(s => s.trim().toUpperCase())
    : DEFAULT_WATCHLIST;

  const alerts = [], errors = [];

  await checkMarketOpenClose();
  const perfAlerts = await checkActiveSignals();

  await Promise.all(symbols.map(async (sym) => {
    try {
      const data = await analyzeSymbol(sym);
      if (!data) return;

      // منع التكرار عبر Redis — نفس الإشارة لنفس الرمز خلال 4 ساعات
      const sigKey = `sig_${sym}_${data.signal}_${new Date().toISOString().slice(0, 13)}`;
      if (await isSent(sigKey)) return;
      await markSent(sigKey);

      alerts.push(data);

      const perf = await getPerformance();
      perf.total++;
      await savePerformance(perf);

      const rr = data.rr;
      const ctWarn = rr.isCT ? '\n⚠️ <i>إشارة عكسية — حجم أصغر</i>' : '';
      const confirmTag = data.tagStr ? '\n✅ تأكيد: ' + data.tags.join(' | ') : '';
      const mStatus = isMarketOpen(sym);
      const sessionTag = mStatus.session !== '24/7' ? `\n⏰ الجلسة: ${mStatus.session}` : '';

      // حفظ الإشارة في Redis
      const activeSignals = await getActiveSignals();
      const sigId = `${sym}_${Date.now()}`;
      activeSignals[sigId] = {
        symbol: sym, signal: data.signal, sigType: rr.sigType,
        entry: rr.entry, stop: rr.stop,
        t1: rr.t1, t2: rr.t2, t3: rr.t3,
        t1Pct: rr.t1Pct, t2Pct: rr.t2Pct,
        risk: rr.risk, t1Hit: false, t2Hit: false, t3Hit: false, slHit: false,
        openedAt: Date.now()
      };
      await saveActiveSignals(activeSignals);

      await sendTelegram(
        `${data.signal === 'CALL' ? '🟢' : '🔴'} <b>${rr.sigType}${data.tagStr}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${data.symbol}</b> — ${data.fullName}\n` +
        `💰 السعر: <b>$${data.price}</b>\n` +
        `📊 التغير: ${parseFloat(data.changePct) >= 0 ? '+' : ''}${data.changePct}%\n` +
        `📈 RSI: ${data.rsi}  |  🔥 الثقة: ${data.confidence}%\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🎯 Entry:     $${rr.entry}\n` +
        `🛡️ Stop Loss: $${rr.stop} (${rr.slPct}%)\n` +
        `🏆 T1:        $${rr.t1} (${rr.t1Pct}%) | 1:${rr.rr1}\n` +
        `🏆 T2:        $${rr.t2} (${rr.t2Pct}%) | 1:${rr.rr2}\n` +
        `🏆 T3:        $${rr.t3}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🏛️ دعم: $${data.zones.supBot.toFixed(0)}–${data.zones.supTop.toFixed(0)}\n` +
        `🏛️ مقاومة: $${data.zones.resBot.toFixed(0)}–${data.zones.resTop.toFixed(0)}\n` +
        `📐 ATR: ${data.atr}` + ctWarn +
        (sessionTag ? '\n' + sessionTag : '') +
        (confirmTag ? '\n' + confirmTag : '') +
        `\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub v7.3 + Redis</i>`
      );
    } catch(e) { errors.push(`${sym}: ${e.message}`); }
  }));

  const macroAlerts = await checkMacroEvents();
  const activeSignals = await getActiveSignals();

  return res.status(200).json({
    ok: true, checked: symbols.length,
    newAlerts: alerts.length, perfAlerts, macroAlerts,
    activeSignals: Object.keys(activeSignals).length,
    signals: alerts.map(a => ({ symbol: a.symbol, signal: a.signal, score: a.score, rr1: a.rr?.rr1 })),
    errors
  });
};
