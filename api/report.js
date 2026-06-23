// ════════════════════════════════════════════════════════
// TIH report.js v2.0 — تقرير ذكي شامل
// يومي للمؤشرات | أسبوعي للأسهم
// يكتشف المشاكل ويقترح الحلول تلقائياً
// ════════════════════════════════════════════════════════

const https = require('https');

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ══════════════════════════════════════
// Redis
// ══════════════════════════════════════
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}

// ══════════════════════════════════════
// Telegram
// ══════════════════════════════════════
function tg(msg) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ══════════════════════════════════════
// جلب البيانات وتحليلها
// ══════════════════════════════════════
async function analyzePerformance(type) {
  const logKey  = type === 'index' ? 'idx_log'    : 'stk_log';
  const perfKey = type === 'index' ? 'idx_perf'   : 'stk_perf';
  const actKey  = type === 'index' ? 'idx_active' : 'stk_active';

  const [log, perf, active] = await Promise.all([
    kvGet(logKey), kvGet(perfKey), kvGet(actKey)
  ]);

  const allSignals = (log || []);
  const activeObj  = active || {};
  const perfAll    = perf || { total:0, wins:0, losses:0, totalR:0 };

  const now    = Date.now();
  const period = type === 'index' ? 24*60*60*1000 : 7*24*60*60*1000;

  const recent = allSignals.filter(s => (now - (s.closedAt||0)) <= period);

  // ── تصنيف النتائج ──
  const wins   = recent.filter(s => ['T1','T2','T3'].includes(s.result));
  const slHits = recent.filter(s => s.result === 'SL');
  const expired= recent.filter(s => s.result === 'EXP');
  const netR   = +recent.reduce((sum,s) => sum+(s.r||0), 0).toFixed(1);
  const wr     = recent.length > 0 ? (wins.length/recent.length*100) : 0;

  // ── تحليل Grade ──
  const byGrade = {};
  recent.forEach(s => {
    const g = s.grade || '?';
    if (!byGrade[g]) byGrade[g] = { total:0, wins:0, sl:0, r:0 };
    byGrade[g].total++;
    if (['T1','T2','T3'].includes(s.result)) byGrade[g].wins++;
    if (s.result === 'SL') byGrade[g].sl++;
    byGrade[g].r += (s.r||0);
  });

  // ── تحليل الجلسة (للمؤشرات) ──
  const bySession = {};
  if (type === 'index') {
    recent.forEach(s => {
      const sess = s.sessionName || s.session || 'غير محدد';
      if (!bySession[sess]) bySession[sess] = { total:0, wins:0, sl:0, r:0 };
      bySession[sess].total++;
      if (['T1','T2','T3'].includes(s.result)) bySession[sess].wins++;
      if (s.result === 'SL') bySession[sess].sl++;
      bySession[sess].r += (s.r||0);
    });
  }

  // ── تحليل القطاع (للأسهم) ──
  const bySector = {};
  if (type === 'stock') {
    recent.forEach(s => {
      const sec = s.sector || 'غير محدد';
      if (!bySector[sec]) bySector[sec] = { total:0, wins:0, sl:0, r:0 };
      bySector[sec].total++;
      if (['T1','T2','T3'].includes(s.result)) bySector[sec].wins++;
      if (s.result === 'SL') bySector[sec].sl++;
      bySector[sec].r += (s.r||0);
    });
  }

  // ── تحليل الرمز ──
  const bySym = {};
  recent.forEach(s => {
    if (!bySym[s.sym]) bySym[s.sym] = { total:0, wins:0, sl:0, r:0 };
    bySym[s.sym].total++;
    if (['T1','T2','T3'].includes(s.result)) bySym[s.sym].wins++;
    if (s.result === 'SL') bySym[s.sym].sl++;
    bySym[s.sym].r += (s.r||0);
  });

  // ── تحليل فريم الدخول ──
  const byFrame = {};
  recent.forEach(s => {
    const f = s.entryFrame || '?';
    if (!byFrame[f]) byFrame[f] = { total:0, wins:0, sl:0, r:0 };
    byFrame[f].total++;
    if (['T1','T2','T3'].includes(s.result)) byFrame[f].wins++;
    if (s.result === 'SL') byFrame[f].sl++;
    byFrame[f].r += (s.r||0);
  });

  // ── اكتشاف المشاكل التلقائي ──
  const problems = [];
  const solutions = [];

  // مشكلة 1: Win Rate منخفض
  if (recent.length >= 5 && wr < 40) {
    problems.push(`Win Rate منخفض ${wr.toFixed(0)}% — شروط الدخول ضعيفة`);
    solutions.push(`ارفع الحد الأدنى للـ Agreements من 3 إلى 4`);
    solutions.push(`اشترط ICT Score ≥ 5 قبل كل إشارة`);
  }

  // مشكلة 2: SL مرتفع
  const slRate = recent.length > 0 ? (slHits.length/recent.length*100) : 0;
  if (slRate > 40) {
    problems.push(`نسبة SL ${slRate.toFixed(0)}% — نقاط الدخول سيئة`);
    solutions.push(`تحقق من FVG و OB قبل الدخول`);
    solutions.push(`تجنب الدخول عند PDH/PDL مباشرة`);
  }

  // مشكلة 3: Grade A أداؤها سيئ
  const gradeA = byGrade['A'];
  if (gradeA && gradeA.total >= 3) {
    const gradeAWR = gradeA.wins/gradeA.total*100;
    if (gradeAWR < 35) {
      problems.push(`Grade A ضعيف ${gradeAWR.toFixed(0)}% — ارفع معاييره`);
      solutions.push(`حوّل Grade A إلى B أو أضف شرط إضافي للـ A`);
    }
  }

  // مشكلة 4: جلسة معينة سيئة (للمؤشرات)
  if (type === 'index') {
    Object.entries(bySession).forEach(([sess, d]) => {
      if (d.total >= 3 && d.sl/d.total > 0.6) {
        problems.push(`جلسة "${sess}" نسبة SL ${(d.sl/d.total*100).toFixed(0)}% — توقف عنها`);
        solutions.push(`في جلسة "${sess}": Grade S فقط أو تجنب`);
      }
    });
  }

  // مشكلة 5: فريم دخول سيئ
  Object.entries(byFrame).forEach(([frame, d]) => {
    if (d.total >= 3 && d.sl/d.total > 0.6) {
      problems.push(`فريم ${frame} نسبة SL ${(d.sl/d.total*100).toFixed(0)}% — راجع شروطه`);
    }
  });

  // مشكلة 6: الأداء في التراجع
  if (recent.length >= 3) {
    const last3 = recent.slice(-3);
    const last3Wins = last3.filter(s => ['T1','T2','T3'].includes(s.result)).length;
    if (last3Wins === 0) {
      problems.push(`آخر 3 إشارات كلها خاسرة — السوق في وضع صعب`);
      solutions.push(`قلل حجم الصفقة أو انتظر إشارة Grade S فقط`);
    }
  }

  return {
    type, period: type==='index'?'اليوم':'الأسبوع',
    total: recent.length, wins: wins.length,
    slHits: slHits.length, expired: expired.length,
    netR, wr: +wr.toFixed(1),
    active: Object.keys(activeObj).length,
    byGrade, bySession, bySector, bySym, byFrame,
    problems, solutions,
    // الإجمالي الكلي
    allTotal: perfAll.total, allWins: perfAll.wins,
    allLosses: perfAll.losses, allR: perfAll.totalR,
    allWR: perfAll.total>0 ? +(perfAll.wins/perfAll.total*100).toFixed(1) : 0,
    recentSignals: recent.slice(-10),
  };
}

// ══════════════════════════════════════
// بناء رسالة Telegram الشاملة
// ══════════════════════════════════════
function buildReport(data, dateStr) {
  const typeAr = data.type==='index' ? '📊 المؤشرات' : '📈 الأسهم';
  const emoji  = data.netR >= 0 ? '✅' : '⚠️';
  const wrEmoji = data.wr >= 55 ? '🟢' : data.wr >= 40 ? '🟡' : '🔴';

  let msg = '';

  // ── Header ──
  msg += `${typeAr} — تقرير ${data.period}\n`;
  msg += `━━━━━━━━━━━━━━━\n`;
  msg += `📅 ${dateStr}\n\n`;

  // ── KPIs ──
  msg += `📊 <b>الأداء العام</b>\n`;
  msg += `├ إجمالي: ${data.total} | ✅ ${data.wins} | 🛑 ${data.slHits} | ⏰ ${data.expired}\n`;
  msg += `├ ${wrEmoji} Win Rate: <b>${data.wr}%</b>\n`;
  msg += `├ 💰 Net R: <b>${data.netR>=0?'+':''}${data.netR}R</b>\n`;
  msg += `└ 📌 نشطة: ${data.active}\n\n`;

  // ── الكلي التاريخي ──
  if (data.allTotal > 0) {
    msg += `📈 <b>الإجمالي الكلي</b>\n`;
    msg += `├ ${data.allTotal} إشارة | WR: ${data.allWR}%\n`;
    msg += `└ Net R: ${data.allR>=0?'+':''}${data.allR.toFixed(1)}R\n\n`;
  }

  // ── Grade Analysis ──
  if (Object.keys(data.byGrade).length > 0) {
    msg += `🏅 <b>أداء حسب الدرجة</b>\n`;
    ['S','A','B'].forEach(g => {
      const d = data.byGrade[g];
      if (!d) return;
      const gWR = d.total>0?(d.wins/d.total*100).toFixed(0):0;
      const gEmoji = gWR>=55?'🟢':gWR>=40?'🟡':'🔴';
      msg += `├ Grade ${g}: ${d.total} | WR: ${gEmoji}${gWR}% | R: ${d.r>=0?'+':''}${d.r.toFixed(1)}R\n`;
    });
    msg += '\n';
  }

  // ── Session Analysis (للمؤشرات) ──
  if (data.type==='index' && Object.keys(data.bySession).length > 0) {
    msg += `🕐 <b>أداء حسب الجلسة</b>\n`;
    Object.entries(data.bySession)
      .sort((a,b) => b[1].r - a[1].r)
      .forEach(([sess, d]) => {
        const sWR = d.total>0?(d.wins/d.total*100).toFixed(0):0;
        const sEmoji = sWR>=55?'🟢':sWR>=40?'🟡':'🔴';
        msg += `├ ${sess}: ${d.total} | WR: ${sEmoji}${sWR}% | R: ${d.r>=0?'+':''}${d.r.toFixed(1)}R\n`;
      });
    msg += '\n';
  }

  // ── Sector Analysis (للأسهم) ──
  if (data.type==='stock' && Object.keys(data.bySector).length > 0) {
    msg += `🏭 <b>أداء حسب القطاع</b>\n`;
    Object.entries(data.bySector).forEach(([sec, d]) => {
      const secWR = d.total>0?(d.wins/d.total*100).toFixed(0):0;
      msg += `├ ${sec}: ${d.total} | WR: ${secWR}% | R: ${d.r>=0?'+':''}${d.r.toFixed(1)}R\n`;
    });
    msg += '\n';
  }

  // ── Entry Frame Analysis ──
  if (Object.keys(data.byFrame).length > 0) {
    msg += `⏱ <b>أداء حسب فريم الدخول</b>\n`;
    Object.entries(data.byFrame).forEach(([frame, d]) => {
      const fWR = d.total>0?(d.wins/d.total*100).toFixed(0):0;
      const fEmoji = fWR>=55?'🟢':fWR>=40?'🟡':'🔴';
      msg += `├ ${frame}: ${d.total} | WR: ${fEmoji}${fWR}% | R: ${d.r>=0?'+':''}${d.r.toFixed(1)}R\n`;
    });
    msg += '\n';
  }

  // ── Symbol Performance ──
  const symEntries = Object.entries(data.bySym).sort((a,b) => b[1].r-a[1].r);
  if (symEntries.length > 0) {
    msg += `📌 <b>أداء الرموز</b>\n`;
    symEntries.slice(0, 5).forEach(([sym, d]) => {
      const symWR = d.total>0?(d.wins/d.total*100).toFixed(0):0;
      const symEmoji = d.r>=0?'✅':'❌';
      msg += `├ ${sym}: ${symEmoji} WR ${symWR}% | R: ${d.r>=0?'+':''}${d.r.toFixed(1)}R\n`;
    });
    msg += '\n';
  }

  // ── المشاكل والحلول ──
  msg += `━━━━━━━━━━━━━━━\n`;
  if (data.problems.length > 0) {
    msg += `🔍 <b>مشاكل مكتشفة:</b>\n`;
    data.problems.forEach(p => { msg += `⚠️ ${p}\n`; });
    msg += '\n';
    if (data.solutions.length > 0) {
      msg += `💡 <b>الحلول:</b>\n`;
      data.solutions.forEach(s => { msg += `→ ${s}\n`; });
    }
  } else {
    msg += `✅ <b>لا مشاكل واضحة</b>\n`;
    if (data.wr >= 55) msg += `🎯 Win Rate ${data.wr}% ممتاز — النظام يعمل بكفاءة\n`;
  }

  // ── آخر 5 إشارات ──
  if (data.recentSignals.length > 0) {
    msg += `\n━━━━━━━━━━━━━━━\n`;
    msg += `📋 <b>آخر الإشارات</b>\n`;
    data.recentSignals.slice(-5).reverse().forEach(s => {
      const rEmoji = s.result==='SL'?'🛑':['T1','T2','T3'].includes(s.result)?'✅':'⏰';
      const rColor = s.r>=0?`+${s.r}R`:`${s.r}R`;
      msg += `${rEmoji} ${s.sym} ${s.signal} → ${s.result} (${rColor})`;
      if (s.sessionName) msg += ` | ${s.sessionName}`;
      msg += '\n';
    });
  }

  msg += `\n🤖 <i>TIH Report v2.0</i>`;
  return msg;
}

// ══════════════════════════════════════
// Handler
// ══════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type || 'all';
  const dateStr = new Date().toLocaleDateString('ar-SA', {
    year:'numeric', month:'long', day:'numeric', timeZone:'Asia/Riyadh'
  });

  try {
    if (type === 'index' || type === 'all') {
      const idxData = await analyzePerformance('index');
      if (idxData.total > 0 || idxData.allTotal > 0) {
        await tg(buildReport(idxData, dateStr));
      }
    }

    if (type === 'stock' || type === 'all') {
      const stkData = await analyzePerformance('stock');
      if (stkData.total > 0 || stkData.allTotal > 0) {
        await tg(buildReport(stkData, dateStr));
      }
    }

    // إذا لا يوجد بيانات
    if (type === 'all') {
      const idxData = await analyzePerformance('index');
      const stkData = await analyzePerformance('stock');
      if (idxData.total === 0 && stkData.total === 0 && idxData.allTotal === 0) {
        await tg(`📊 <b>تقرير TIH</b>\n📅 ${dateStr}\n\nلا توجد إشارات بعد — النظام جديد.\n🤖 <i>TIH Report v2.0</i>`);
      }
    }

    return res.status(200).json({ ok: true, message: 'Report sent' });
  } catch(err) {
    await tg(`⚠️ خطأ في التقرير: ${err.message}`).catch(()=>{});
    return res.status(500).json({ ok: false, error: err.message });
  }
};
