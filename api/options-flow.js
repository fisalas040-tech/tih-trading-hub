const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';
const MASSIVE_KEY = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const MASSIVE_BASE = 'api.massive.com';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// الرموز التي نراقبها
const OF_SYMBOLS = ['SPY','QQQ','SPX','NVDA','AAPL','TSLA','AMD','MSFT','AMZN'];

// ── Upstash ──
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
async function kvSet(key, value, ex = 3600) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}
async function isSent(key) { return (await kvGet(`sent:${key}`)) !== null; }
async function markSent(key, ttl=4*3600) { await kvSet(`sent:${key}`, 1, ttl); }

// ── Massive API ──
function fetchMassive(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: MASSIVE_BASE,
      path: path,
      headers: { 'Authorization': `Bearer ${MASSIVE_KEY}`, 'User-Agent': 'TIH/1.0' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Telegram ──
function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── جلب عقود Options لرمز معين ──
async function fetchOptionsContracts(symbol) {
  const today = new Date().toISOString().split('T')[0];
  // نوسّع النطاق لـ 90 يوم لنضمن الحصول على كل العقود
  const in90d = new Date(Date.now() + 90*86400000).toISOString().split('T')[0];

  try {
    // نجلب CALL وPUT بشكل منفصل مع pagination
    async function fetchAllPages(url) {
      let results = [];
      let nextUrl = url;
      let pages = 0;
      while (nextUrl && pages < 3) { // max 3 pages = 750 عقد
        const res = await fetchMassive(nextUrl.replace('https://api.massive.com',''));
        const batch = res.results || [];
        results = results.concat(batch);
        // pagination
        nextUrl = res.next_url || null;
        pages++;
        if (batch.length < 250) break; // آخر صفحة
      }
      return results;
    }

    const baseUrl = 'https://api.massive.com';
    // نجلب بدون فلتر contract_type — ونفرز يدوياً
    // هذا يضمن الحصول على كلا النوعين
    const allUrl = `${baseUrl}/v3/reference/options/contracts?underlying_ticker=${symbol}&expiration_date.gte=${today}&expiration_date.lte=${in90d}&limit=250&sort=strike_price&order=asc`;
    
    const allRaw = await fetchAllPages(allUrl);
    
    // فرز يدوي
    const calls_final = allRaw.filter(c => c.contract_type === 'call');
    const puts_final  = allRaw.filter(c => c.contract_type === 'put');

    if (!calls.length && !puts.length) return null;

    const callCount = calls_final.length;
    const putCount  = puts_final.length;
    const total     = callCount + putCount;
    const pcRatio   = callCount > 0 ? (putCount / callCount).toFixed(2) : '—';
    const callPct   = total > 0 ? Math.round(callCount/total*100) : 50;
    const putPct    = 100 - callPct;

    // Sentiment
    const ratio = parseFloat(pcRatio);
    let sentiment, sentimentClass, sentimentAr;
    if (ratio < 0.5) {
      sentiment = 'BULLISH'; sentimentClass = 'bull';
      sentimentAr = '🟢 صعودي قوي';
    } else if (ratio < 0.8) {
      sentiment = 'BULLISH'; sentimentClass = 'bull';
      sentimentAr = '🟢 صعودي';
    } else if (ratio > 1.5) {
      sentiment = 'BEARISH'; sentimentClass = 'bear';
      sentimentAr = '🔴 هبوطي قوي';
    } else if (ratio > 1.2) {
      sentiment = 'BEARISH'; sentimentClass = 'bear';
      sentimentAr = '🔴 هبوطي';
    } else {
      sentiment = 'NEUTRAL'; sentimentClass = 'neutral';
      sentimentAr = '⚪ محايد';
    }

    // أقرب Strike prices
    const nearStrikes = calls_final.slice(0, 5).map(c => c.strike_price);
    const nearExp = (calls_final[0] || puts_final[0])?.expiration_date || '—';

    return {
      symbol, callCount, putCount, total,
      pcRatio, callPct, putPct,
      sentiment, sentimentClass, sentimentAr,
      nearStrikes, nearExp,
      calls: calls_final.slice(0, 15),
      puts:  puts_final.slice(0, 15),
    };
  } catch(e) {
    return null;
  }
}

// ── تحليل Options Flow لكل الرموز ──
async function analyzeOptionsFlow() {
  const results = [];

  await Promise.all(OF_SYMBOLS.map(async (sym) => {
    try {
      const data = await fetchOptionsContracts(sym);
      if (data) results.push(data);
    } catch(e) {}
  }));

  return results;
}

// ── فحص التنبيهات ──
async function checkOptionsAlerts(flowData) {
  let alerts = 0;

  for (const d of flowData) {
    const ratio = parseFloat(d.pcRatio);
    if (isNaN(ratio)) continue;

    // تنبيه عند P/C Ratio متطرف
    const isBearAlert = ratio > 1.5;  // PUT مسيطر بقوة
    const isBullAlert = ratio < 0.5;  // CALL مسيطر بقوة

    if (!isBearAlert && !isBullAlert) continue;

    const alertKey = `of_${d.symbol}_${isBearAlert?'bear':'bull'}_${new Date().toISOString().slice(0,10)}`;
    if (await isSent(alertKey)) continue;
    await markSent(alertKey, 6*3600); // لا تتكرر 6 ساعات

    const emoji = isBearAlert ? '🔴' : '🟢';
    const direction = isBearAlert ? 'PUT مسيطر — هبوط محتمل' : 'CALL مسيطر — صعود محتمل';

    await sendTelegram(
      `${emoji} <b>Options Flow Alert!</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📌 <b>${d.symbol}</b>\n` +
      `📊 Put/Call Ratio: <b>${d.pcRatio}</b>\n` +
      `🟢 CALL: ${d.callCount} عقد (${d.callPct}%)\n` +
      `🔴 PUT:  ${d.putCount} عقد (${d.putPct}%)\n` +
      `━━━━━━━━━━━━━━━\n` +
      `${d.sentimentAr}\n` +
      `💡 ${direction}\n` +
      `📅 أقرب انتهاء: ${d.nearExp}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🤖 <i>TIH Options Flow</i>`
    );
    alerts++;
  }

  return alerts;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'flow';

  // ── جلب البيانات ──
  if (action === 'flow') {
    try {
      // تحقق من الـ cache أولاً (10 دقائق)
      const cached = await kvGet('options_flow_cache');
      if (cached && (Date.now() - cached.ts) < 10*60*1000) {
        return res.status(200).json({ ok: true, cached: true, data: cached.data });
      }

      const flowData = await analyzeOptionsFlow();
      if (!flowData.length) {
        return res.status(200).json({ ok: false, message: 'لا توجد بيانات' });
      }

      // حفظ في cache
      await kvSet('options_flow_cache', { ts: Date.now(), data: flowData }, 600);

      // فحص التنبيهات
      const alerts = await checkOptionsAlerts(flowData);

      return res.status(200).json({
        ok: true, cached: false,
        alerts, count: flowData.length,
        data: flowData
      });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── تنبيه يدوي ──
  if (action === 'check') {
    try {
      const flowData = await analyzeOptionsFlow();
      const alerts = await checkOptionsAlerts(flowData);
      return res.status(200).json({ ok: true, alerts, data: flowData });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(400).json({ ok: false, message: 'action غير معروف' });
};
