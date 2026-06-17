const https = require('https');

const BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN      || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID       = process.env.TELEGRAM_CHAT_ID        || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL  || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN|| 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ─── Redis helpers ─────────────────────────────────────────────────────────────
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, val, ex = 86400) {
  try {
    await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}?ex=${ex}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
  } catch(e) {}
}

// ─── Telegram ──────────────────────────────────────────────────────────────────
function tg(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ─── Build weekly stats from a log array ──────────────────────────────────────
function weeklyStats(log, daysBack = 7) {
  const cutoff = Date.now() - daysBack * 86400000;
  const week   = log.filter(e => (e.closedAt || 0) >= cutoff);

  if (!week.length) return null;

  const wins   = week.filter(e => ['T1','T2','T3'].includes(e.result));
  const losses = week.filter(e => e.result === 'SL');
  const expired= week.filter(e => e.result === 'EXP');
  const totalR = week.reduce((s, e) => s + (e.r || 0), 0);
  const wr     = week.length > 0 ? (wins.length / week.length * 100) : 0;

  // per-symbol breakdown
  const bySymbol = {};
  for (const e of week) {
    if (!bySymbol[e.sym]) bySymbol[e.sym] = { total:0, wins:0, r:0 };
    bySymbol[e.sym].total++;
    if (['T1','T2','T3'].includes(e.result)) bySymbol[e.sym].wins++;
    bySymbol[e.sym].r += (e.r || 0);
  }

  // best / worst signal (by R)
  const sorted = [...week].sort((a,b) => (b.r||0) - (a.r||0));
  const best   = sorted[0]   || null;
  const worst  = sorted[sorted.length - 1] || null;

  // grade breakdown
  const byGrade = {};
  for (const e of week) {
    const g = e.grade || '?';
    if (!byGrade[g]) byGrade[g] = { total:0, wins:0 };
    byGrade[g].total++;
    if (['T1','T2','T3'].includes(e.result)) byGrade[g].wins++;
  }

  return { total: week.length, wins: wins.length, losses: losses.length, expired: expired.length,
           totalR: +totalR.toFixed(1), wr: +wr.toFixed(0), bySymbol, byGrade, best, worst };
}

// ─── Format one stats block ────────────────────────────────────────────────────
function formatBlock(label, s) {
  if (!s || s.total === 0) return `${label}\nلا توجد إشارات هذا الأسبوع\n`;

  const rStr = s.totalR >= 0 ? `+${s.totalR}R 🟢` : `${s.totalR}R 🔴`;
  const perf = `📊 ${s.total} إشارة | ✅ ${s.wins} | ❌ ${s.losses} | ⏰ ${s.expired}\n`
             + `🎯 Win Rate: <b>${s.wr}%</b> | 💰 <b>${rStr}</b>\n`;

  // symbol table (top 5 by total)
  const symLines = Object.entries(s.bySymbol)
    .sort((a,b) => b[1].total - a[1].total)
    .slice(0, 5)
    .map(([sym, d]) => {
      const symWR = d.total > 0 ? Math.round(d.wins/d.total*100) : 0;
      const symR  = d.r >= 0 ? `+${d.r.toFixed(1)}` : d.r.toFixed(1);
      return `  • ${sym}: ${d.wins}/${d.total} (${symWR}%) ${symR}R`;
    }).join('\n');

  const bestLine  = s.best  ? `🏆 أفضل: <b>${s.best.sym}</b> ${s.best.result} +${(s.best.r||0).toFixed(1)}R\n` : '';
  const worstLine = s.worst && s.worst.r < 0 ? `💔 أسوأ: <b>${s.worst.sym}</b> ${s.worst.result} ${(s.worst.r||0).toFixed(1)}R\n` : '';

  // grade breakdown
  const gradeLines = Object.entries(s.byGrade)
    .sort((a,b) => b[1].total - a[1].total)
    .map(([g, d]) => `  ${g}: ${d.wins}/${d.total}`)
    .join(' | ');

  return `${label}\n${perf}${bestLine}${worstLine}`
       + (symLines ? `\n📌 بالرمز:\n${symLines}\n` : '')
       + (gradeLines ? `📐 بالدرجة: ${gradeLines}\n` : '');
}

// ─── Main report builder ───────────────────────────────────────────────────────
async function buildAndSend() {
  const [idxLog, stkLog, idxPerf, stkPerf] = await Promise.all([
    kvGet('idx_log'),
    kvGet('stk_log'),
    kvGet('idx_perf'),
    kvGet('stk_perf'),
  ]);

  const idxWeek = weeklyStats(idxLog || []);
  const stkWeek = weeklyStats(stkLog || []);

  // cumulative totals
  const idxTotal = idxPerf || { total:0, wins:0, losses:0, totalR:0 };
  const stkTotal = stkPerf || { total:0, wins:0, losses:0, totalR:0 };
  const allTotal  = idxTotal.total  + stkTotal.total;
  const allWins   = idxTotal.wins   + stkTotal.wins;
  const allR      = +(idxTotal.totalR + stkTotal.totalR).toFixed(1);
  const allWR     = allTotal > 0 ? Math.round(allWins / allTotal * 100) : 0;

  const now = new Date().toLocaleString('ar-SA', {
    timeZone:'Asia/Riyadh', weekday:'long', year:'numeric',
    month:'long', day:'numeric',
  });

  const idxBlock = formatBlock('📈 <b>المؤشرات</b>', idxWeek);
  const stkBlock = formatBlock('📊 <b>الأسهم</b>',   stkWeek);

  const weekR = (idxWeek?.totalR || 0) + (stkWeek?.totalR || 0);
  const weekRStr = weekR >= 0 ? `+${weekR.toFixed(1)}R 🟢` : `${weekR.toFixed(1)}R 🔴`;

  const msg =
    `🗓 <b>التقرير الأسبوعي</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `📅 ${now}\n\n` +
    idxBlock +
    `\n` +
    stkBlock +
    `━━━━━━━━━━━━━━━\n` +
    `<b>📦 الأسبوع الإجمالي: ${weekRStr}</b>\n\n` +
    `📂 <b>الأداء الكلي (منذ البداية)</b>\n` +
    `${allTotal} إشارة | ✅ ${allWins} | 🎯 WR: ${allWR}% | 💰 ${allR >= 0 ? '+' : ''}${allR}R\n` +
    `━━━━━━━━━━━━━━━\n` +
    `🤖 <i>TIH Weekly Report</i>`;

  await tg(msg);
  return { idxWeek, stkWeek, weekR };
}

// ─── HTTP handler ──────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'send';

  // ── preview: return JSON without sending to Telegram ──────────────────────
  if (action === 'preview') {
    const [idxLog, stkLog, idxPerf, stkPerf] = await Promise.all([
      kvGet('idx_log'), kvGet('stk_log'),
      kvGet('idx_perf'), kvGet('stk_perf'),
    ]);
    return res.status(200).json({
      ok: true,
      indices:  { weekly: weeklyStats(idxLog || []),  cumulative: idxPerf },
      stocks:   { weekly: weeklyStats(stkLog || []),  cumulative: stkPerf },
    });
  }

  // ── auto: only send once per week (Sunday), skip if already sent today ─────
  if (action === 'auto') {
    const today = new Date().toISOString().split('T')[0];
    const lastSent = await kvGet('weekly_report_sent');
    if (lastSent === today) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'already sent today' });
    }
    const day = new Date().getUTCDay(); // 0 = Sunday
    if (day !== 0) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'not Sunday' });
    }
    await kvSet('weekly_report_sent', today, 7 * 86400);
    const result = await buildAndSend();
    return res.status(200).json({ ok: true, sent: true, ...result });
  }

  // ── send: force-send regardless of day/time ────────────────────────────────
  const result = await buildAndSend();
  return res.status(200).json({ ok: true, sent: true, ...result });
};
