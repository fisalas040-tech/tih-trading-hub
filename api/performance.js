const https = require('https');

const BOT_TOKEN = '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

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

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('ar-SA', {
    day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Riyadh'
  });
}

async function sendWeeklyReport(ip, sp, idxLog, stkLog) {
  const now = Date.now();
  const weekStart = now - 7*24*3600*1000;

  const fromDate = formatDate(weekStart);
  const toDate   = formatDate(now);

  const total  = ip.total  + sp.total;
  const wins   = ip.wins   + sp.wins;
  const losses = ip.losses + sp.losses;
  const totalR = +(ip.totalR + sp.totalR).toFixed(1);
  const wr     = total > 0 ? Math.round((wins/total)*100) : 0;

  // إحصاء آخر 7 أيام
  const recentIdx = (idxLog||[]).filter(e => e.closedAt > weekStart);
  const recentStk = (stkLog||[]).filter(e => e.closedAt > weekStart);
  const recentAll = [...recentIdx, ...recentStk];

  const weekWins   = recentAll.filter(e => ['T1','T2','T3'].includes(e.result)).length;
  const weekLosses = recentAll.filter(e => e.result === 'SL').length;
  const weekExp    = recentAll.filter(e => e.result === 'EXP').length;
  const weekR      = +recentAll.reduce((s,e) => s+(e.r||0), 0).toFixed(1);
  const weekWR     = recentAll.length > 0 ? Math.round(weekWins/recentAll.length*100) : 0;

  const t3List  = recentAll.filter(e=>e.result==='T3').map(e=>e.sym).join(', ') || '—';
  const t2List  = recentAll.filter(e=>e.result==='T2').map(e=>e.sym).join(', ') || '—';
  const slList  = recentAll.filter(e=>e.result==='SL').map(e=>e.sym).slice(0,5).join(', ') || '—';

  // أداء المؤشرات هذا الأسبوع
  const idxWeek = recentIdx.filter(e=>['T1','T2','T3'].includes(e.result)).length;
  const idxSlW  = recentIdx.filter(e=>e.result==='SL').length;
  const idxRW   = +recentIdx.reduce((s,e)=>s+(e.r||0),0).toFixed(1);

  // أداء الأسهم هذا الأسبوع
  const stkWeek = recentStk.filter(e=>['T1','T2','T3'].includes(e.result)).length;
  const stkSlW  = recentStk.filter(e=>e.result==='SL').length;
  const stkRW   = +recentStk.reduce((s,e)=>s+(e.r||0),0).toFixed(1);

  const wrColor  = weekWR>=60?'🟢':weekWR>=45?'🟡':'🔴';
  const rSymbol  = weekR>=0?'📈':'📉';

  await tg(
    `📊 <b>التقرير الأسبوعي — TIH</b>\n` +
    `📅 <b>من:</b> ${fromDate}\n` +
    `📅 <b>إلى:</b> ${toDate}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `<b>🗓️ هذا الأسبوع</b>\n` +
    `📌 إجمالي الإشارات: <b>${recentAll.length}</b>\n` +
    `✅ ناجحة: <b>${weekWins}</b> | ❌ SL: <b>${weekLosses}</b> | ⏰ منتهية: <b>${weekExp}</b>\n` +
    `${wrColor} Win Rate: <b>${weekWR}%</b>\n` +
    `${rSymbol} R هذا الأسبوع: <b>${weekR>0?'+':''}${weekR}R</b>\n\n` +
    `📊 المؤشرات: ✅${idxWeek} ❌${idxSlW} — ${idxRW>0?'+':''}${idxRW}R\n` +
    `📈 الأسهم:   ✅${stkWeek} ❌${stkSlW} — ${stkRW>0?'+':''}${stkRW}R\n\n` +
    `🏆 وصلت T3: ${t3List}\n` +
    `🎯 وصلت T2: ${t2List}\n` +
    `🛑 SL: ${slList}\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `<b>📊 الإجمالي الكلي</b>\n` +
    `📌 الكل: ${total} | ✅ ${wins} | ❌ ${losses}\n` +
    `🎯 Win Rate: <b>${wr}%</b>\n` +
    `💰 Total R: <b>${totalR>0?'+':''}${totalR}R</b>\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    `<b>📋 تفصيل الكلي</b>\n` +
    `📊 المؤشرات: ${ip.wins}/${ip.total} — ${ip.total>0?Math.round(ip.wins/ip.total*100):0}% — ${ip.totalR>0?'+':''}${ip.totalR}R\n` +
    `📈 الأسهم:   ${sp.wins}/${sp.total} — ${sp.total>0?Math.round(sp.wins/sp.total*100):0}% — ${sp.totalR>0?'+':''}${sp.totalR}R\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🤖 <i>TIH Weekly Report</i>`
  );
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const report = req.query.report === '1';
    const weekly = req.query.weekly === '1';

    const [idxPerf, idxActive, stkPerf, stkActive, idxLog, stkLog] = await Promise.all([
      kvGet('idx_perf'),
      kvGet('idx_active'),
      kvGet('stk_perf'),
      kvGet('stk_active'),
      kvGet('idx_log'),
      kvGet('stk_log'),
    ]);

    const ip = idxPerf || { total:0, wins:0, losses:0, totalR:0 };
    const sp = stkPerf || { total:0, wins:0, losses:0, totalR:0 };

    const total   = ip.total   + sp.total;
    const wins    = ip.wins    + sp.wins;
    const losses  = ip.losses  + sp.losses;
    const totalR  = +(ip.totalR + sp.totalR).toFixed(1);
    const winRate = total > 0 ? Math.round((wins/total)*100) : 0;

    const idxActObj = idxActive || {};
    const stkActObj = stkActive || {};
    const active = Object.keys(idxActObj).length + Object.keys(stkActObj).length;

    if (weekly || report) {
      if (weekly) {
        const thisWeekNum = Math.floor(Date.now() / (7*24*3600*1000));
        const lastReport = await kvGet('weekly_report_sent');
        if (lastReport === String(thisWeekNum)) {
          return res.status(200).json({ ok:true, message:'تم إرسال التقرير هذا الأسبوع مسبقاً' });
        }
        await kvSet('weekly_report_sent', String(thisWeekNum), 8*24*3600);
      }
      await sendWeeklyReport(ip, sp, idxLog, stkLog);
      return res.status(200).json({ ok:true, message:'تم إرسال التقرير' });
    }

    const activeList = [
      ...Object.values(idxActObj).map(s => ({
        sym: s.sym, signal: s.signal,
        entry: s.entry, sl: s.sl,
        t1: s.t1, t2: s.t2, t3: s.t3,
        t1Hit: s.t1Hit, t2Hit: s.t2Hit,
        type: 'index',
        age: Math.round((Date.now() - (s.openedAt||0)) / 60000)
      })),
      ...Object.values(stkActObj).map(s => ({
        sym: s.sym, signal: s.signal,
        entry: s.entry, sl: s.sl,
        t1: s.t1, t2: s.t2, t3: s.t3,
        t1Hit: s.t1Hit, t2Hit: s.t2Hit,
        type: 'stock',
        age: Math.round((Date.now() - (s.openedAt||0)) / 60000)
      }))
    ].sort((a,b) => a.age - b.age);

    return res.status(200).json({
      ok: true,
      total, wins, losses, totalR, winRate, active,
      indices: { total: ip.total, wins: ip.wins, losses: ip.losses, totalR: ip.totalR },
      stocks:  { total: sp.total, wins: sp.wins, losses: sp.losses, totalR: sp.totalR },
      activeList,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
