const MASSIVE_KEY  = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const MASSIVE_BASE = 'api.polygon.io'; // Massive = Polygon rebranded

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

const OF_SYMBOLS = ['SPY','QQQ','SPX','NVDA','AAPL','TSLA','AMD','MSFT','AMZN'];

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, value, ex = 3600) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}

// ── Massive/Polygon API ──
async function fetchMassive(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://${MASSIVE_BASE}${path}${sep}apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'TIH/1.0' } });
  if (!r.ok) throw new Error(`Massive ${r.status}: ${path}`);
  return r.json();
}

// ── Telegram ──
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' })
    });
  } catch(e) {}
}

// ── جلب Options Chain لرمز ──
async function fetchOptionsChain(symbol) {
  try {
    const today  = new Date().toISOString().split('T')[0];
    const in60d  = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];

    // Option Chain Snapshot — أفضل endpoint
    const data = await fetchMassive(
      `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in60d}&limit=250`
    );

    const results = data.results || [];
    if (!results.length) return null;

    const calls = results.filter(c => c.details?.contract_type === 'call');
    const puts  = results.filter(c => c.details?.contract_type === 'put');

    const callCount = calls.length;
    const putCount  = puts.length;
    const total     = callCount + putCount;
    if (!total) return null;

    const pcRatio  = callCount > 0 ? (putCount / callCount).toFixed(2) : '—';
    const callPct  = Math.round(callCount / total * 100);
    const putPct   = 100 - callPct;
    const ratio    = parseFloat(pcRatio);

    // Sentiment
    let sentimentClass, sentimentAr;
    if (ratio < 0.5)       { sentimentClass = 'bull'; sentimentAr = '🟢 صعودي قوي'; }
    else if (ratio < 0.8)  { sentimentClass = 'bull'; sentimentAr = '🟢 صعودي'; }
    else if (ratio > 1.5)  { sentimentClass = 'bear'; sentimentAr = '🔴 هبوطي قوي'; }
    else if (ratio > 1.2)  { sentimentClass = 'bear'; sentimentAr = '🔴 هبوطي'; }
    else                   { sentimentClass = 'neutral'; sentimentAr = '⚪ محايد'; }

    // أقرب انتهاء
    const nearExp = results[0]?.details?.expiration_date || '—';

    // أعلى Open Interest
    const topCalls = calls
      .sort((a,b) => (b.open_interest||0) - (a.open_interest||0))
      .slice(0,5)
      .map(c => ({
        strike: c.details?.strike_price,
        exp:    c.details?.expiration_date,
        oi:     c.open_interest || 0,
        iv:     c.implied_volatility ? (c.implied_volatility*100).toFixed(1)+'%' : '—',
        delta:  c.greeks?.delta?.toFixed(2) || '—',
      }));

    const topPuts = puts
      .sort((a,b) => (b.open_interest||0) - (a.open_interest||0))
      .slice(0,5)
      .map(c => ({
        strike: c.details?.strike_price,
        exp:    c.details?.expiration_date,
        oi:     c.open_interest || 0,
        iv:     c.implied_volatility ? (c.implied_volatility*100).toFixed(1)+'%' : '—',
        delta:  c.greeks?.delta?.toFixed(2) || '—',
      }));

    // Underlying price
    const underlying = results[0]?.underlying_asset?.price || null;

    return {
      symbol, callCount, putCount, total,
      pcRatio, callPct, putPct,
      sentimentClass, sentimentAr,
      nearExp, underlying,
      topCalls, topPuts,
    };
  } catch(e) {
    return null;
  }
}

// ── فحص التنبيهات ──
async function checkAlerts(flowData) {
  let alerts = 0;
  for (const d of flowData) {
    const ratio = parseFloat(d.pcRatio);
    if (isNaN(ratio)) continue;
    const isBear = ratio > 1.5;
    const isBull = ratio < 0.5;
    if (!isBear && !isBull) continue;

    const alertKey = `of_${d.symbol}_${isBear?'bear':'bull'}_${new Date().toISOString().slice(0,10)}`;
    const sent = await kvGet(`sent:${alertKey}`);
    if (sent) continue;
    await kvSet(`sent:${alertKey}`, 1, 6*3600);

    const emoji = isBear ? '🔴' : '🟢';
    await sendTelegram(
      `${emoji} <b>Options Flow Alert!</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📌 <b>${d.symbol}</b>\n` +
      `📊 Put/Call Ratio: <b>${d.pcRatio}</b>\n` +
      `🟢 CALL: ${d.callCount} عقد (${d.callPct}%)\n` +
      `🔴 PUT:  ${d.putCount} عقد (${d.putPct}%)\n` +
      `━━━━━━━━━━━━━━━\n` +
      `${d.sentimentAr}\n` +
      `📅 أقرب انتهاء: ${d.nearExp}\n` +
      (d.underlying ? `💰 السعر: $${d.underlying}\n` : '') +
      `━━━━━━━━━━━━━━━\n` +
      `🤖 <i>TIH Options Flow</i>`
    );
    alerts++;
  }
  return alerts;
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'flow';

  try {
    // cache 10 دقائق
    if (action === 'flow') {
      const cached = await kvGet('options_flow_cache');
      if (cached && (Date.now() - cached.ts) < 10*60*1000) {
        return res.status(200).json({ ok: true, cached: true, data: cached.data });
      }
    }

    // جلب البيانات
    const results = await Promise.all(
      OF_SYMBOLS.map(sym => fetchOptionsChain(sym).catch(() => null))
    );
    const flowData = results.filter(Boolean);

    if (!flowData.length) {
      return res.status(200).json({ ok: false, message: 'لا توجد بيانات — تحقق من صلاحية API Key', data: [] });
    }

    // حفظ cache
    await kvSet('options_flow_cache', { ts: Date.now(), data: flowData }, 600);

    // تنبيهات
    const alerts = await checkAlerts(flowData);

    return res.status(200).json({
      ok: true, cached: false,
      alerts, count: flowData.length,
      data: flowData
    });

  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
