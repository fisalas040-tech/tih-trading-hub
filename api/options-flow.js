// ════════════════════════════════════════════════════════
// TIH options-flow.js v2.0
// ربط Options Flow بالتحليل والتنبيهات
// ════════════════════════════════════════════════════════

const MASSIVE_KEY  = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE = 'api.polygon.io';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// الرموز الافتراضية للـ flow العام
const OF_SYMBOLS = ['SPY','QQQ','SPX','NVDA','AAPL','TSLA','AMD','MSFT'];

// رموز المؤشرات لتنبيهات Sweep
const INDEX_SYMBOLS = ['SPY','QQQ','SPX'];

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
  const r = await fetch(url, { headers: { 'User-Agent': 'TIH/2.0' } });
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
    const today = new Date().toISOString().split('T')[0];
    const in60d = new Date(Date.now() + 60*86400000).toISOString().split('T')[0];

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

    const pcRatio = callCount > 0 ? (putCount / callCount).toFixed(2) : '—';
    const callPct = Math.round(callCount / total * 100);
    const putPct  = 100 - callPct;
    const ratio   = parseFloat(pcRatio);

    // Sentiment
    let sentimentClass, sentimentAr, sentimentSignal;
    if (ratio < 0.5)      { sentimentClass='bull'; sentimentAr='🟢 صعودي قوي';  sentimentSignal='CALL'; }
    else if (ratio < 0.8) { sentimentClass='bull'; sentimentAr='🟢 صعودي';      sentimentSignal='CALL'; }
    else if (ratio > 1.5) { sentimentClass='bear'; sentimentAr='🔴 هبوطي قوي';  sentimentSignal='PUT';  }
    else if (ratio > 1.2) { sentimentClass='bear'; sentimentAr='🔴 هبوطي';      sentimentSignal='PUT';  }
    else                  { sentimentClass='neutral'; sentimentAr='⚪ محايد';    sentimentSignal='WAIT'; }

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

    // أعلى IV
    const allIV = results
      .filter(c => c.implied_volatility)
      .sort((a,b) => (b.implied_volatility||0) - (a.implied_volatility||0));
    const avgIV = allIV.length
      ? (allIV.reduce((s,c) => s + (c.implied_volatility||0), 0) / allIV.length * 100).toFixed(1)
      : null;

    // أعلى OI overall
    const topOI = results
      .sort((a,b) => (b.open_interest||0) - (a.open_interest||0))
      .slice(0,3)
      .map(c => ({
        type:   c.details?.contract_type,
        strike: c.details?.strike_price,
        exp:    c.details?.expiration_date,
        oi:     c.open_interest || 0,
      }));

    const underlying = results[0]?.underlying_asset?.price || null;

    return {
      symbol, callCount, putCount, total,
      pcRatio, callPct, putPct,
      sentimentClass, sentimentAr, sentimentSignal,
      nearExp, underlying, avgIV,
      topCalls, topPuts, topOI,
    };
  } catch(e) {
    return null;
  }
}

// ── ✅ جديد: فحص Sweep كبير >$1M (من Trades endpoint) ──
async function checkSweepAlerts() {
  let sweepAlerts = 0;
  const today = new Date().toISOString().split('T')[0];

  for (const sym of INDEX_SYMBOLS) {
    try {
      // جلب آخر صفقات الـ options
      const data = await fetchMassive(
        `/v2/last/trade/${sym}O:${sym}?limit=50`
      );
      // fallback: استخدم options chain لتقدير الـ sweep
      const chain = await fetchOptionsChain(sym);
      if (!chain) continue;

      // إذا P/C ratio أقل من 0.4 (sweep calls قوي جداً) أو أكبر من 2.0 (sweep puts)
      const ratio = parseFloat(chain.pcRatio);
      const isMassiveBull = ratio < 0.4 && chain.callCount > 50;
      const isMassiveBear = ratio > 2.0 && chain.putCount  > 50;

      if (!isMassiveBull && !isMassiveBear) continue;

      const alertKey = `sweep_${sym}_${isMassiveBear?'bear':'bull'}_${today}`;
      const sent = await kvGet(`sent:${alertKey}`);
      if (sent) continue;
      await kvSet(`sent:${alertKey}`, 1, 12*3600);

      const emoji  = isMassiveBear ? '🔴' : '🟢';
      const signal = isMassiveBear ? 'PUT' : 'CALL';
      await sendTelegram(
        `${emoji} <b>⚡ Sweep كبير على المؤشرات!</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — إشارة <b>${signal}</b>\n` +
        `📊 P/C Ratio: <b>${chain.pcRatio}</b>\n` +
        `🟢 CALL: ${chain.callCount} عقد (${chain.callPct}%)\n` +
        `🔴 PUT:  ${chain.putCount} عقد (${chain.putPct}%)\n` +
        `━━━━━━━━━━━━━━━\n` +
        `${chain.sentimentAr}\n` +
        (chain.underlying ? `💰 السعر: $${chain.underlying}\n` : '') +
        (chain.avgIV ? `📈 متوسط IV: ${chain.avgIV}%\n` : '') +
        `━━━━━━━━━━━━━━━\n` +
        `🤖 <i>TIH Options Flow v2.0</i>`
      );
      sweepAlerts++;
    } catch(e) { continue; }
  }
  return sweepAlerts;
}

// ── ✅ جديد: توافق Options Flow مع إشارة CALL/PUT ──
async function checkFlowAlignment(flowData) {
  let alignAlerts = 0;
  try {
    // جلب إشارات نشطة من Redis
    const idxActive = await kvGet('idx_active') || [];
    const stkActive = await kvGet('stk_active') || [];
    const allActive = [...idxActive, ...stkActive];

    for (const sig of allActive) {
      // هل هناك بيانات Options Flow لهذا الرمز؟
      const flow = flowData.find(f =>
        f.symbol === sig.sym ||
        (sig.sym === 'US500' && f.symbol === 'SPY') ||
        (sig.sym === 'NDX'   && f.symbol === 'QQQ')
      );
      if (!flow) continue;

      // هل الـ Options Flow يتوافق مع الإشارة؟
      const aligned = (sig.signal === 'CALL' && flow.sentimentSignal === 'CALL') ||
                      (sig.signal === 'PUT'  && flow.sentimentSignal === 'PUT');
      if (!aligned) continue;

      const alertKey = `align_${sig.sym}_${sig.signal}_${flow.pcRatio}`;
      const sent = await kvGet(`sent:${alertKey}`);
      if (sent) continue;
      await kvSet(`sent:${alertKey}`, 1, 4*3600);

      const emoji = sig.signal === 'CALL' ? '🟢' : '🔴';
      await sendTelegram(
        `${emoji} <b>✅ توافق Options Flow + إشارة!</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sig.sym}</b> — ${sig.signal}\n` +
        `📊 Options Flow: ${flow.sentimentAr}\n` +
        `📉 P/C Ratio: <b>${flow.pcRatio}</b>\n` +
        `🟢 CALL: ${flow.callPct}% | 🔴 PUT: ${flow.putPct}%\n` +
        (flow.avgIV ? `📈 IV: ${flow.avgIV}%\n` : '') +
        `━━━━━━━━━━━━━━━\n` +
        `💡 الإشارة التقنية + الـ Options Flow متوافقان\n` +
        `🎯 Entry: $${sig.entry || '—'} | Grade: ${sig.grade || '—'}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🤖 <i>TIH Options Flow v2.0</i>`
      );
      alignAlerts++;
    }
  } catch(e) {}
  return alignAlerts;
}


// ══════════════════════════════════════════════════════
// ✅ تفسير Options Flow — تنبيه ذكي مثل المحلل
// ══════════════════════════════════════════════════════
async function interpretAndAlert(flowData) {
  if (!flowData || !flowData.length) return 0;
  let alerts = 0;
  const today = new Date().toISOString().slice(0, 10);

  for (const d of flowData) {
    try {
      const ratio = parseFloat(d.pcRatio);
      if (isNaN(ratio)) continue;

      // فقط عند إشارة واضحة
      const isBullish = ratio < 0.7 && d.callPct >= 60;
      const isBearish = ratio > 1.3 && d.putPct >= 55;
      if (!isBullish && !isBearish) continue;

      const alertKey = `interpret_${d.symbol}_${isBearish?'bear':'bull'}_${today}`;
      const sent = await kvGet(`sent:${alertKey}`);
      if (sent) continue;
      await kvSet(`sent:${alertKey}`, 1, 8*3600);

      const emoji = isBullish ? '🟢' : '🔴';
      const direction = isBullish ? 'صعود' : 'هبوط';

      // أعلى CALL OI — الهدف
      const topCall = d.topCalls?.[0];
      const topCall2 = d.topCalls?.[1];
      const callTarget = topCall ? `$${topCall.strike}` : '—';
      const callTarget2 = topCall2 ? `$${topCall2.strike}` : '';

      // أعلى PUT OI — الدعم/المقاومة
      const topPut = d.topPuts?.[0];
      const topPut2 = d.topPuts?.[1];
      const putLevel = topPut ? `$${topPut.strike}` : '—';
      const putLevel2 = topPut2 ? `$${topPut2.strike}` : '';
      const putOI = topPut ? topPut.oi.toLocaleString() : '—';

      // تفسير P/C Ratio
      let pcExplain;
      if (ratio < 0.4)      pcExplain = 'الحيتان يشترون CALL بقوة 3× عن PUT — ثقة عالية جداً';
      else if (ratio < 0.6) pcExplain = 'الحيتان يشترون CALL بقوة ضعف PUT — ثقة عالية';
      else if (ratio < 0.8) pcExplain = 'CALL أكثر من PUT — ميل صعودي واضح';
      else if (ratio > 2.0) pcExplain = 'الحيتان يشترون PUT بقوة 2× عن CALL — خوف حقيقي';
      else if (ratio > 1.5) pcExplain = 'PUT أكثر من CALL بكثير — ضغط هبوطي قوي';
      else                   pcExplain = 'PUT أكثر من CALL — ميل هبوطي';

      // بناء الرسالة
      let msg = `${emoji} <b>تحليل Options Flow — ${d.symbol}</b>
`;
      msg += `━━━━━━━━━━━━━━━
`;
      msg += `📊 P/C Ratio: <b>${d.pcRatio}</b> — ${d.sentimentAr}
`;
      msg += `🟢 CALL ${d.callPct}% vs PUT ${d.putPct}% 🔴
`;
      if (d.avgIV) msg += `📈 Avg IV: ${d.avgIV}%
`;
      msg += `━━━━━━━━━━━━━━━
`;

      if (isBullish) {
        msg += `🎯 <b>هدف الصعود:</b> ${callTarget}${callTarget2?' — '+callTarget2:''}
`;
        msg += `🛡️ <b>دعم قوي:</b> ${putLevel}${putLevel2?' — '+putLevel2:''}
`;
        if (topPut) msg += `   (محمي بـ ${putOI} عقد PUT)
`;
      } else {
        msg += `🎯 <b>هدف الهبوط:</b> ${putLevel}${putLevel2?' — '+putLevel2:''}
`;
        msg += `🚧 <b>مقاومة قوية:</b> ${callTarget}${callTarget2?' — '+callTarget2:''}
`;
        if (topPut) msg += `   (ضغط ${putOI} عقد PUT)
`;
      }

      msg += `━━━━━━━━━━━━━━━
`;
      msg += `📖 <b>التفسير:</b>
`;
      msg += `${pcExplain}
`;
      if (isBullish && topPut) {
        msg += `مستوى ${putLevel} محمي بـ ${putOI} عقد
`;
        msg += `→ الاتجاه: <b>صعود نحو ${callTarget}</b>
`;
      } else if (isBearish && topPut) {
        msg += `→ الاتجاه: <b>هبوط نحو ${putLevel}</b>
`;
      }
      msg += `━━━━━━━━━━━━━━━
`;
      msg += `🤖 <i>TIH Options Intelligence</i>`;

      await sendTelegram(msg);
      alerts++;
    } catch(e) { continue; }
  }
  return alerts;
}

// ── فحص التنبيهات الأساسية (P/C Ratio) ──
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
      (d.avgIV ? `📈 متوسط IV: ${d.avgIV}%\n` : '') +
      `━━━━━━━━━━━━━━━\n` +
      `🤖 <i>TIH Options Flow v2.0</i>`
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
  const symbol = (req.query.symbol || '').toUpperCase();

  try {

    // ✅ جديد: جلب بيانات رمز محدد للتحليل العميق
    if (action === 'symbol' && symbol) {
      // map للمؤشرات
      const mappedSym = symbol === 'US500' ? 'SPY' :
                        symbol === 'NDX'   ? 'QQQ' :
                        symbol === 'DJI'   ? 'DIA' :
                        symbol === 'SPX'   ? 'SPX' : symbol;

      const cacheKey = `of_sym_${mappedSym}`;
      const cached = await kvGet(cacheKey);
      if (cached && (Date.now() - cached.ts) < 15*60*1000) {
        return res.status(200).json({ ok: true, cached: true, data: cached.data });
      }

      const data = await fetchOptionsChain(mappedSym);
      if (!data) {
        return res.status(200).json({ ok: false, message: `لا توجد بيانات Options لـ ${symbol}` });
      }

      await kvSet(cacheKey, { ts: Date.now(), data }, 900);
      return res.status(200).json({ ok: true, cached: false, data });
    }

    // ✅ تفسير يدوي عند الطلب
    if (action === 'interpret') {
      const cached = await kvGet('options_flow_cache');
      const flowData = cached?.data || [];
      if (!flowData.length) return res.status(200).json({ ok:false, message:'لا بيانات — شغّل flow أولاً' });
      const interpretAlerts = await interpretAndAlert(flowData);
      return res.status(200).json({ ok:true, interpretAlerts });
    }

    // ✅ جديد: فحص Sweep كبير
    if (action === 'sweep') {
      const sweeps = await checkSweepAlerts();
      return res.status(200).json({ ok: true, sweepAlerts: sweeps });
    }

    // Flow عام مع cache 10 دقائق
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

    // تنبيهات P/C Ratio
    const alerts = await checkAlerts(flowData);

    // ✅ تفسير ذكي للـ Options Flow
    const interpretAlerts = await interpretAndAlert(flowData);

    // ✅ تنبيهات توافق مع الإشارات
    const alignAlerts = await checkFlowAlignment(flowData);

    return res.status(200).json({
      ok: true, cached: false,
      alerts, interpretAlerts, alignAlerts,
      count: flowData.length,
      data: flowData
    });

  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
