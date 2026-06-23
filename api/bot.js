const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

// ── Telegram ──
function tg(chatId, msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
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

// ── تسجيل Webhook ──
function setWebhook(url) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ url });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/setWebhook`,
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

// ── معالج الأوامر ──
async function handleCommand(chatId, text) {
  const cmd = (text || '').split(' ')[0].toLowerCase().replace('@tih_alerts_bot', '');

  // ── /start ──
  if (cmd === '/start' || cmd === 'start') {
    await tg(chatId,
      `🚀 <b>TIH Trading Intelligence Hub</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `مرحباً! أنا بوت تنبيهات التداول الذكي.\n\n` +
      `📋 <b>الأوامر المتاحة:</b>\n` +
      `/stats — إحصائيات الأداء الكاملة\n` +
      `/active — الإشارات النشطة الآن\n` +
      `/today — ملخص اليوم\n` +
      `/log — آخر 10 إشارات منتهية\n` +
      `/market — حالة السوق\n` +
      `/help — قائمة الأوامر\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🤖 <i>TIH Bot v1.0</i>`
    );
    return;
  }

  // ── /help ──
  if (cmd === '/help') {
    await tg(chatId,
      `📚 <b>قائمة الأوامر</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 /stats — Win Rate، Total R، الإجمالي\n` +
      `📡 /active — الإشارات النشطة + Entry/SL/T1\n` +
      `📅 /today — إشارات وأداء اليوم\n` +
      `📋 /log — آخر 10 إشارات منتهية\n` +
      `🌍 /market — حالة المؤشرات الرئيسية\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🤖 <i>TIH Bot v1.0</i>`
    );
    return;
  }

  // ── /stats ──
  if (cmd === '/stats') {
    const [idxPerf, stkPerf] = await Promise.all([
      kvGet('idx_perf'),
      kvGet('stk_perf'),
    ]);
    const ip = idxPerf || { total:0,wins:0,losses:0,totalR:0 };
    const sp = stkPerf || { total:0,wins:0,losses:0,totalR:0 };
    const total = ip.total + sp.total;
    const wins  = ip.wins  + sp.wins;
    const totalR = (ip.totalR||0) + (sp.totalR||0);
    const wr = total > 0 ? ((wins/total)*100).toFixed(0) : 0;
    const wrEmoji = wr>=60?'🟢':wr>=45?'🟡':'🔴';

    await tg(chatId,
      `📊 <b>إحصائيات الأداء</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📈 <b>الإجمالي:</b> ${total} إشارة\n` +
      `✅ ربح: ${wins} | ❌ خسارة: ${ip.losses+sp.losses}\n` +
      `${wrEmoji} <b>Win Rate: ${wr}%</b>\n` +
      `💰 <b>Total R: ${totalR>=0?'+':''}${totalR.toFixed(1)}R</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 المؤشرات:\n` +
      `  • الكلي: ${ip.total} | ✅ ${ip.wins} | ❌ ${ip.losses}\n` +
      `  • R: ${ip.totalR>=0?'+':''}${(ip.totalR||0).toFixed(1)}R\n\n` +
      `📈 الأسهم:\n` +
      `  • الكلي: ${sp.total} | ✅ ${sp.wins} | ❌ ${sp.losses}\n` +
      `  • R: ${sp.totalR>=0?'+':''}${(sp.totalR||0).toFixed(1)}R\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🤖 <i>TIH Bot v1.0</i>`
    );
    return;
  }

  // ── /active ──
  if (cmd === '/active') {
    const [idxActive, stkActive] = await Promise.all([
      kvGet('idx_active'),
      kvGet('stk_active'),
    ]);
    const ia = idxActive || {};
    const sa = stkActive || {};
    const all = [
      ...Object.values(ia).map(s=>({...s,src:'مؤشر'})),
      ...Object.values(sa).map(s=>({...s,src:'سهم'})),
    ];

    if (!all.length) {
      await tg(chatId, `📡 <b>الإشارات النشطة</b>\n━━━━━━━━━━━━━━━\nلا توجد إشارات نشطة حالياً\n🤖 <i>TIH Bot</i>`);
      return;
    }

    const now = Date.now();
    let msg = `📡 <b>الإشارات النشطة (${all.length})</b>\n━━━━━━━━━━━━━━━\n`;
    all.forEach(function(s) {
      const age = Math.floor((now-(s.openedAt||now))/3600000);
      const emoji = s.signal==='CALL'?'🟢':'🔴';
      const t1Status = s.t1Hit?'✅':'⏳';
      const t2Status = s.t2Hit?'✅':'⏳';
      msg += `${emoji} <b>${s.sym}</b> ${s.signal} [${s.grade||'?'}] — ${s.src}\n`;
      msg += `  💰 Entry: $${s.entry} | SL: $${s.sl}\n`;
      msg += `  🎯 T1${t1Status}: $${s.t1} | T2${t2Status}: $${s.t2}\n`;
      msg += `  ⏱️ عمر: ${age} ساعة\n`;
      msg += `━━━━━━━━━━━━━━━\n`;
    });
    msg += `🤖 <i>TIH Bot v1.0</i>`;
    await tg(chatId, msg);
    return;
  }

  // ── /today ──
  if (cmd === '/today') {
    const [idxLog, stkLog] = await Promise.all([
      kvGet('idx_log'),
      kvGet('stk_log'),
    ]);
    const allLog = [...(idxLog||[]), ...(stkLog||[])];
    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    const todaySignals = allLog.filter(function(x){
      return (x.closedAt||0) >= todayStart.getTime();
    });

    const wins   = todaySignals.filter(function(x){return x.result!=='SL';}).length;
    const losses = todaySignals.filter(function(x){return x.result==='SL';}).length;
    const totalR = todaySignals.reduce(function(s,x){return s+(x.r||0);},0);

    let msg = `📅 <b>ملخص اليوم</b>\n━━━━━━━━━━━━━━━\n`;
    if (!todaySignals.length) {
      msg += `لا توجد إشارات منتهية اليوم\n`;
    } else {
      msg += `📈 الإشارات: ${todaySignals.length}\n`;
      msg += `✅ ربح: ${wins} | ❌ خسارة: ${losses}\n`;
      msg += `💰 R اليوم: ${totalR>=0?'+':''}${totalR.toFixed(1)}R\n`;
      msg += `━━━━━━━━━━━━━━━\n`;
      todaySignals.slice(0,5).forEach(function(x){
        const isWin = x.result!=='SL';
        msg += `${isWin?'✅':'❌'} ${x.sym} ${x.signal} → ${x.result} (${x.r>=0?'+':''}${x.r}R)\n`;
      });
    }
    msg += `━━━━━━━━━━━━━━━\n🤖 <i>TIH Bot v1.0</i>`;
    await tg(chatId, msg);
    return;
  }

  // ── /log ──
  if (cmd === '/log') {
    const [idxLog, stkLog] = await Promise.all([
      kvGet('idx_log'),
      kvGet('stk_log'),
    ]);
    const allLog = [...(idxLog||[]), ...(stkLog||[])]
      .sort(function(a,b){return (b.closedAt||0)-(a.closedAt||0);})
      .slice(0, 10);

    if (!allLog.length) {
      await tg(chatId, `📋 <b>آخر الإشارات</b>\n━━━━━━━━━━━━━━━\nلا توجد سجلات بعد\n🤖 <i>TIH Bot</i>`);
      return;
    }

    let msg = `📋 <b>آخر 10 إشارات</b>\n━━━━━━━━━━━━━━━\n`;
    allLog.forEach(function(x) {
      const isWin = x.result!=='SL';
      const date = x.closedAt ? new Date(x.closedAt).toLocaleDateString('ar-SA',{month:'short',day:'numeric',timeZone:'Asia/Riyadh'}) : '—';
      msg += `${isWin?'✅':'❌'} <b>${x.sym}</b> ${x.signal} [${x.grade}] → ${x.result} <b>${x.r>=0?'+':''}${x.r}R</b> — ${date}\n`;
    });
    msg += `━━━━━━━━━━━━━━━\n🤖 <i>TIH Bot v1.0</i>`;
    await tg(chatId, msg);
    return;
  }

  // ── /market ──
  if (cmd === '/market') {
    const [idxActive] = await Promise.all([kvGet('idx_active')]);
    const active = idxActive || {};
    const calls = Object.values(active).filter(function(s){return s.signal==='CALL';}).length;
    const puts  = Object.values(active).filter(function(s){return s.signal==='PUT';}).length;
    const sentiment = calls > puts ? '🟢 صاعد' : puts > calls ? '🔴 هابط' : '⚪ محايد';

    await tg(chatId,
      `🌍 <b>حالة السوق</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📊 المشاعر العامة: <b>${sentiment}</b>\n` +
      `🟢 CALL: ${calls} | 🔴 PUT: ${puts}\n` +
      `📌 إشارات نشطة: ${Object.keys(active).length}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `🕐 ${new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'})}\n` +
      `🤖 <i>TIH Bot v1.0</i>`
    );
    return;
  }

  // ── أمر غير معروف ──
  await tg(chatId,
    `❓ أمر غير معروف: <code>${text}</code>\n\n` +
    `اكتب /help لعرض الأوامر المتاحة\n` +
    `🤖 <i>TIH Bot</i>`
  );
}

// ── الدالة الرئيسية ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── تسجيل Webhook ──
  if (req.method === 'GET' && req.query.setup === '1') {
    const webhookUrl = `https://tih-trading-hub.vercel.app/api/bot`;
    const result = await setWebhook(webhookUrl);
    return res.status(200).json({ ok:true, webhook: webhookUrl, result });
  }

  // ── استقبال رسائل Telegram ──
  if (req.method === 'POST') {
    try {
      const update = req.body;
      const message = update?.message || update?.edited_message;
      if (!message) return res.status(200).json({ ok:true });

      const chatId = message.chat?.id;
      const text   = message.text || '';

      // التحقق من أن الرسالة من المستخدم المصرح
      if (String(chatId) !== String(CHAT_ID)) {
        await tg(chatId, '⛔ غير مصرح لك باستخدام هذا البوت');
        return res.status(200).json({ ok:true });
      }

      await handleCommand(chatId, text);
    } catch(e) {
      console.error('Bot error:', e);
    }
    return res.status(200).json({ ok:true });
  }

  return res.status(200).json({ ok:true, message:'TIH Bot ready. Send ?setup=1 to register webhook.' });
};
