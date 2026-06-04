// ════════════════════════════════════════════════════════
// TIH report.js — تقرير PDF تلقائي على Telegram
// يومي للمؤشرات (4 مساءً) | أسبوعي للأسهم (الجمعة)
// ════════════════════════════════════════════════════════

const https  = require('https');
const http   = require('http');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

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

// ── جلب بيانات الأداء من Redis ──
async function fetchPerformanceData(type) {
  const logKey  = type === 'index' ? 'idx_log'    : 'stk_log';
  const perfKey = type === 'index' ? 'idx_perf'   : 'stk_perf';
  const actKey  = type === 'index' ? 'idx_active' : 'stk_active';

  const [log, perf, active] = await Promise.all([
    kvGet(logKey), kvGet(perfKey), kvGet(actKey)
  ]);

  const allSignals = log || [];
  const activeObj  = active || {};
  const perfObj    = perf  || { total:0, wins:0, losses:0, totalR:0 };

  // فلترة حسب الفترة الزمنية
  const now   = Date.now();
  const day1  = 24 * 60 * 60 * 1000;
  const week1 = 7  * day1;
  const period = type === 'index' ? day1 : week1;

  const periodSignals = allSignals.filter(s => {
    const ts = s.closedAt || s.openedAt || 0;
    return (now - ts) <= period;
  });

  // تصنيف النتائج
  const won  = periodSignals.filter(s => s.result === 'T1' || s.result === 'T2' || s.result === 'T3');
  const sl   = periodSignals.filter(s => s.result === 'SL');
  const lost = periodSignals.filter(s => s.result !== 'T1' && s.result !== 'T2' && s.result !== 'T3' && s.result !== 'SL' && s.result !== 'EXP');

  const wonR  = won.reduce((s,x)  => s + (x.r || 0), 0);
  const slR   = sl.reduce((s,x)   => s + (x.r || 0), 0);
  const lostR = lost.reduce((s,x) => s + (x.r || 0), 0);
  const netR  = +(wonR + slR + lostR).toFixed(1);

  // تحليل أسباب SL
  const slWithNotes = sl.map(s => {
    let note = '';
    const entry = s.entry || 0;
    const close = s.exitPrice || s.close || 0;
    if (s.slNote) note = s.slNote;
    return { ...s, note };
  });

  // أفضل وأسوأ رمز
  const symMap = {};
  periodSignals.forEach(s => {
    if (!symMap[s.sym]) symMap[s.sym] = { r: 0, count: 0 };
    symMap[s.sym].r     += (s.r || 0);
    symMap[s.sym].count += 1;
  });
  const symArr   = Object.entries(symMap).map(([sym,d]) => ({sym,...d}));
  const bestSym  = symArr.sort((a,b) => b.r-a.r)[0];
  const worstSym = symArr.sort((a,b) => a.r-b.r)[0];

  return {
    period:   type === 'index' ? 'اليوم' : 'الأسبوع',
    total:    periodSignals.length,
    won:      won.length,
    lost:     lost.length,
    sl_hit:   sl.length,
    total_r:  netR,
    won_r:    +wonR.toFixed(1),
    lost_r:   +lostR.toFixed(1),
    sl_r:     +slR.toFixed(1),
    active:   Object.keys(activeObj).length,
    signals:  periodSignals.slice(-15),
    sl_signals: slWithNotes,
    best_sym:  bestSym?.sym  || '—',
    worst_sym: worstSym?.sym || '—',
    // الإجمالي الكلي
    all_total:  perfObj.total    || 0,
    all_wins:   perfObj.wins     || 0,
    all_losses: perfObj.losses   || 0,
    all_r:      perfObj.totalR   || 0,
  };
}

// ── تحليل نقاط الضعف ──
function analyzeWeaknesses(data, type) {
  const weaknesses = [];
  const solutions  = [];
  const wr = data.total > 0 ? (data.won / data.total * 100) : 0;
  const slRate = data.total > 0 ? (data.sl_hit / data.total * 100) : 0;

  if (slRate > 35) {
    weaknesses.push(`نسبة SL مرتفعة (${slRate.toFixed(0)}%) — مشكلة في تحديد نقاط الدخول`);
    solutions.push(`تجنب SL عند PDH/PDL مباشرة — ابتعد 0.5 ATR`);
  }

  const stopHunts = data.sl_signals.filter(s =>
    s.note && (s.note.includes('Hunt') || s.note.includes('سيولة') || s.note.includes('EQH') || s.note.includes('BSL'))
  ).length;

  if (stopHunts > 0) {
    weaknesses.push(`${stopHunts} إشارة ضربت SL بسبب Stop Hunt / سحب سيولة`);
    solutions.push(`فعّل كشف BSL/SSL/EQH قبل تحديد SL`);
    solutions.push(`تحقق من FVG و Order Blocks قبل الدخول`);
  }

  if (wr < 45) {
    weaknesses.push(`Win Rate منخفض (${wr.toFixed(0)}%) — يحتاج مراجعة شروط الدخول`);
    solutions.push(`ارفع عتبة Score من 5 إلى 7 في analyzeTF()`);
    solutions.push(`اشترط توافق 3+ فريمات قبل الإشارة`);
  }

  if (data.total_r < 0) {
    weaknesses.push(`Net R سلبي (${data.total_r}R) — راجع نسبة R:R`);
    solutions.push(`تأكد أن T1 >= 2R مقابل SL = 1R`);
  }

  if (weaknesses.length === 0) {
    solutions.push(`النظام يعمل بكفاءة — Win Rate ${wr.toFixed(0)}% و Net R ${data.total_r}R`);
  }

  return { weaknesses, solutions };
}

// ── بناء HTML للتقرير (يُحوّل لـ PDF عبر WeasyPrint) ──
function buildReportHTML(idxData, stkData, date) {
  const now = new Date(date);
  const dateStr = now.toLocaleDateString('ar-SA', { year:'numeric', month:'long', day:'numeric' });

  const wr_idx = idxData.total > 0 ? (idxData.won / idxData.total * 100).toFixed(0) : 0;
  const wr_stk = stkData.total > 0 ? (stkData.won / stkData.total * 100).toFixed(0) : 0;
  const wr_all = (idxData.total + stkData.total) > 0
    ? ((idxData.won + stkData.won) / (idxData.total + stkData.total) * 100).toFixed(0) : 0;
  const net_all = +(idxData.total_r + stkData.total_r).toFixed(1);

  const { weaknesses: idxW, solutions: idxS } = analyzeWeaknesses(idxData, 'index');
  const { weaknesses: stkW, solutions: stkS } = analyzeWeaknesses(stkData, 'stock');

  const signalRow = (s) => {
    const rc = s.result==='SL' ? '#F75555' : (s.result==='T1'||s.result==='T2'||s.result==='T3') ? '#10D9A3' : '#F59E0B';
    const sc = s.signal==='CALL' ? '#10D9A3' : '#F75555';
    const rStr = s.r >= 0 ? `+${s.r}R` : `${s.r}R`;
    const rColor = s.r >= 0 ? '#10D9A3' : '#F75555';
    const bgColor = s.result==='SL' ? '#1A0808' : s.result==='T2'||s.result==='T1' ? '#041A10' : '#0D1B2A';
    return `<tr style="background:${bgColor}">
      <td style="color:#E2E8F0;font-weight:700">${s.sym||'—'}</td>
      <td style="color:${sc};font-weight:700">${s.signal||'—'}</td>
      <td style="color:${rc};font-weight:700">${s.result||'—'}</td>
      <td style="color:${rColor};font-weight:700">${rStr}</td>
      <td style="color:#94A3B8">${s.note||'—'}</td>
    </tr>`;
  };

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
<meta charset="UTF-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap');
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Cairo',sans-serif; background:#060912; color:#E2E8F0; padding:20px; font-size:12px; }
  .header { text-align:center; padding:20px 0 10px; border-bottom:2px solid #D4AF37; margin-bottom:20px; }
  .header h1 { font-size:28px; color:#D4AF37; font-weight:900; letter-spacing:2px; }
  .header p  { font-size:11px; color:#64748B; margin-top:4px; }
  .section-title { font-size:16px; color:#38BDF8; font-weight:700; margin:20px 0 10px;
                   padding:8px 12px; background:#0D1B2A; border-right:4px solid #38BDF8; border-radius:4px; }
  .kpis { display:grid; grid-template-columns:repeat(6,1fr); gap:8px; margin-bottom:12px; }
  .kpi  { background:#0D1B2A; border:1px solid #1E3A5F; border-radius:8px;
          padding:10px 6px; text-align:center; }
  .kpi-val { font-size:22px; font-weight:900; line-height:1.1; }
  .kpi-lbl { font-size:9px; color:#64748B; margin-top:3px; }
  table { width:100%; border-collapse:collapse; margin-bottom:12px; }
  th { background:#1E3A5F; color:#D4AF37; font-weight:700; padding:7px; font-size:11px; }
  td { padding:6px 8px; font-size:10px; border-bottom:1px solid #1E3A5F; }
  .r-table td:first-child { color:#E2E8F0; font-weight:600; }
  .weak-box { background:#1A0D00; border:1px solid #F59E0B; border-radius:8px; padding:10px 14px; margin-bottom:8px; }
  .weak-title { color:#F59E0B; font-weight:700; font-size:12px; margin-bottom:6px; }
  .weak-item { color:#F59E0B; font-size:10px; margin-bottom:3px; }
  .sol-item  { color:#10D9A3; font-size:10px; margin-bottom:3px; }
  .sol-title { color:#10D9A3; font-weight:700; font-size:12px; margin:8px 0 4px; }
  .summary-table th { background:#0A1628; }
  .summary-total { color:#38BDF8; font-weight:900; }
  .divider { border:none; border-top:1px solid #1E3A5F; margin:16px 0; }
  .footer { text-align:center; margin-top:20px; padding-top:12px;
            border-top:1px solid #1E3A5F; color:#1E3A5F; font-size:9px; }
  .badge-win  { background:rgba(16,217,163,0.1); color:#10D9A3; padding:2px 6px; border-radius:4px; }
  .badge-sl   { background:rgba(247,85,85,0.1);  color:#F75555; padding:2px 6px; border-radius:4px; }
  .badge-loss { background:rgba(245,158,11,0.1); color:#F59E0B; padding:2px 6px; border-radius:4px; }
</style>
</head>
<body>

<!-- HEADER -->
<div class="header">
  <h1>TIH — Trading Intelligence Hub</h1>
  <p>تقرير الأداء التفصيلي  •  ${dateStr}  •  مسلط الحربي  •  khaled14sa</p>
</div>

<!-- SECTION: المؤشرات -->
<div class="section-title">📊 أداء المؤشرات — ${idxData.period}</div>
<div class="kpis">
  <div class="kpi"><div class="kpi-val" style="color:#38BDF8">${idxData.total}</div><div class="kpi-lbl">إجمالي</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#10D9A3">${idxData.won}</div><div class="kpi-lbl">✅ ناجحة</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#F59E0B">${idxData.lost}</div><div class="kpi-lbl">❌ خاسرة</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#F75555">${idxData.sl_hit}</div><div class="kpi-lbl">🛑 ضرب SL</div></div>
  <div class="kpi"><div class="kpi-val" style="color:${wr_idx>=50?'#10D9A3':'#F75555'}">${wr_idx}%</div><div class="kpi-lbl">Win Rate</div></div>
  <div class="kpi"><div class="kpi-val" style="color:${idxData.total_r>=0?'#10D9A3':'#F75555'}">${idxData.total_r>=0?'+':''}${idxData.total_r}R</div><div class="kpi-lbl">Net R</div></div>
</div>

<table class="r-table">
  <tr><th>النوع</th><th>العدد</th><th>الـ R</th><th>% من الإجمالي</th></tr>
  <tr style="background:#041A10"><td>✅ ناجحة (T1/T2/T3)</td><td style="color:#10D9A3;font-weight:700">${idxData.won}</td><td style="color:#10D9A3;font-weight:700">+${idxData.won_r}R</td><td>${idxData.total>0?(idxData.won/idxData.total*100).toFixed(0):0}%</td></tr>
  <tr style="background:#1A0E00"><td>❌ خاسرة</td><td style="color:#F59E0B;font-weight:700">${idxData.lost}</td><td style="color:#F59E0B;font-weight:700">${idxData.lost_r}R</td><td>${idxData.total>0?(idxData.lost/idxData.total*100).toFixed(0):0}%</td></tr>
  <tr style="background:#1A0808"><td>🛑 Stop Loss</td><td style="color:#F75555;font-weight:700">${idxData.sl_hit}</td><td style="color:#F75555;font-weight:700">${idxData.sl_r}R</td><td>${idxData.total>0?(idxData.sl_hit/idxData.total*100).toFixed(0):0}%</td></tr>
  <tr style="background:#0D1B2A"><td>📌 نشطة</td><td style="color:#F59E0B;font-weight:700">${idxData.active}</td><td>—</td><td>—</td></tr>
</table>

${idxData.signals.length > 0 ? `
<div style="font-size:11px;color:#38BDF8;font-weight:700;margin-bottom:6px">تفاصيل الإشارات:</div>
<table>
  <tr><th>الرمز</th><th>الإشارة</th><th>النتيجة</th><th>R</th><th>ملاحظة</th></tr>
  ${idxData.signals.map(signalRow).join('')}
</table>` : ''}

${idxW.length > 0 || idxS.length > 0 ? `
<div class="weak-box">
  ${idxW.length > 0 ? `<div class="weak-title">🔍 نقاط الضعف:</div>${idxW.map(w=>`<div class="weak-item">⚠️ ${w}</div>`).join('')}` : ''}
  ${idxS.length > 0 ? `<div class="sol-title">💡 الحلول المقترحة:</div>${idxS.map(s=>`<div class="sol-item">→ ${s}</div>`).join('')}` : ''}
</div>` : ''}

<hr class="divider">

<!-- SECTION: الأسهم -->
<div class="section-title">📈 أداء الأسهم — ${stkData.period}</div>
<div class="kpis">
  <div class="kpi"><div class="kpi-val" style="color:#38BDF8">${stkData.total}</div><div class="kpi-lbl">إجمالي</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#10D9A3">${stkData.won}</div><div class="kpi-lbl">✅ ناجحة</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#F59E0B">${stkData.lost}</div><div class="kpi-lbl">❌ خاسرة</div></div>
  <div class="kpi"><div class="kpi-val" style="color:#F75555">${stkData.sl_hit}</div><div class="kpi-lbl">🛑 ضرب SL</div></div>
  <div class="kpi"><div class="kpi-val" style="color:${wr_stk>=50?'#10D9A3':'#F75555'}">${wr_stk}%</div><div class="kpi-lbl">Win Rate</div></div>
  <div class="kpi"><div class="kpi-val" style="color:${stkData.total_r>=0?'#10D9A3':'#F75555'}">${stkData.total_r>=0?'+':''}${stkData.total_r}R</div><div class="kpi-lbl">Net R</div></div>
</div>

<table class="r-table">
  <tr><th>النوع</th><th>العدد</th><th>الـ R</th><th>% من الإجمالي</th></tr>
  <tr style="background:#041A10"><td>✅ ناجحة (T1/T2/T3)</td><td style="color:#10D9A3;font-weight:700">${stkData.won}</td><td style="color:#10D9A3;font-weight:700">+${stkData.won_r}R</td><td>${stkData.total>0?(stkData.won/stkData.total*100).toFixed(0):0}%</td></tr>
  <tr style="background:#1A0E00"><td>❌ خاسرة</td><td style="color:#F59E0B;font-weight:700">${stkData.lost}</td><td style="color:#F59E0B;font-weight:700">${stkData.lost_r}R</td><td>${stkData.total>0?(stkData.lost/stkData.total*100).toFixed(0):0}%</td></tr>
  <tr style="background:#1A0808"><td>🛑 Stop Loss</td><td style="color:#F75555;font-weight:700">${stkData.sl_hit}</td><td style="color:#F75555;font-weight:700">${stkData.sl_r}R</td><td>${stkData.total>0?(stkData.sl_hit/stkData.total*100).toFixed(0):0}%</td></tr>
  <tr style="background:#0D1B2A"><td>📌 نشطة</td><td style="color:#F59E0B;font-weight:700">${stkData.active}</td><td>—</td><td>—</td></tr>
</table>

${stkData.signals.length > 0 ? `
<div style="font-size:11px;color:#38BDF8;font-weight:700;margin-bottom:6px">تفاصيل الإشارات:</div>
<table>
  <tr><th>الرمز</th><th>الإشارة</th><th>النتيجة</th><th>R</th><th>ملاحظة</th></tr>
  ${stkData.signals.map(signalRow).join('')}
</table>` : ''}

${stkW.length > 0 || stkS.length > 0 ? `
<div class="weak-box">
  ${stkW.length > 0 ? `<div class="weak-title">🔍 نقاط الضعف:</div>${stkW.map(w=>`<div class="weak-item">⚠️ ${w}</div>`).join('')}` : ''}
  ${stkS.length > 0 ? `<div class="sol-title">💡 الحلول المقترحة:</div>${stkS.map(s=>`<div class="sol-item">→ ${s}</div>`).join('')}` : ''}
</div>` : ''}

<hr class="divider">

<!-- SECTION: الملخص الكلي -->
<div class="section-title">📋 الملخص الكلي والتوصيات</div>
<table class="summary-table">
  <tr><th>المقياس</th><th>المؤشرات</th><th>الأسهم</th><th class="summary-total">الإجمالي</th></tr>
  <tr><td>إجمالي الإشارات</td><td>${idxData.total}</td><td>${stkData.total}</td><td class="summary-total">${idxData.total+stkData.total}</td></tr>
  <tr><td>ناجحة ✅</td><td style="color:#10D9A3">${idxData.won}</td><td style="color:#10D9A3">${stkData.won}</td><td class="summary-total" style="color:#10D9A3">${idxData.won+stkData.won}</td></tr>
  <tr><td>خاسرة ❌</td><td style="color:#F59E0B">${idxData.lost}</td><td style="color:#F59E0B">${stkData.lost}</td><td class="summary-total" style="color:#F59E0B">${idxData.lost+stkData.lost}</td></tr>
  <tr><td>ضرب SL 🛑</td><td style="color:#F75555">${idxData.sl_hit}</td><td style="color:#F75555">${stkData.sl_hit}</td><td class="summary-total" style="color:#F75555">${idxData.sl_hit+stkData.sl_hit}</td></tr>
  <tr><td>Win Rate</td><td style="color:${wr_idx>=50?'#10D9A3':'#F75555'}">${wr_idx}%</td><td style="color:${wr_stk>=50?'#10D9A3':'#F75555'}">${wr_stk}%</td><td class="summary-total" style="color:${wr_all>=50?'#10D9A3':'#F75555'}">${wr_all}%</td></tr>
  <tr><td>Net R</td><td style="color:${idxData.total_r>=0?'#10D9A3':'#F75555'}">${idxData.total_r>=0?'+':''}${idxData.total_r}R</td><td style="color:${stkData.total_r>=0?'#10D9A3':'#F75555'}">${stkData.total_r>=0?'+':''}${stkData.total_r}R</td><td class="summary-total" style="color:${net_all>=0?'#10D9A3':'#F75555'}">${net_all>=0?'+':''}${net_all}R</td></tr>
</table>

<!-- التوصيات النهائية -->
<div class="weak-box">
  <div class="weak-title">🎯 التوصيات النهائية:</div>
  ${(()=>{
    const recs = [];
    const slTotal = idxData.sl_hit + stkData.sl_hit;
    const slRate  = slTotal / (idxData.total + stkData.total) * 100;
    if (slRate > 25) {
      recs.push(`<div class="weak-item">⚠️ نسبة SL الكلية ${slRate.toFixed(0)}% — الأولوية: تحسين منطق Stop Hunt</div>`);
      recs.push(`<div class="sol-item">→ أضف EQH/EQL detection في analyze.js</div>`);
      recs.push(`<div class="sol-item">→ في alert-indices.js: تجنب SL عند PDH/PDL ±0.5 ATR</div>`);
    }
    if (wr_all >= 55) recs.push(`<div class="sol-item">✅ Win Rate ${wr_all}% ممتاز — النظام يعمل بكفاءة عالية</div>`);
    else if (wr_all >= 45) recs.push(`<div class="sol-item">⚡ Win Rate ${wr_all}% مقبول — يحتاج تحسين تدريجي</div>`);
    else recs.push(`<div class="weak-item">⚠️ Win Rate ${wr_all}% منخفض — ارفع شروط الدخول</div>`);
    if (net_all > 0) recs.push(`<div class="sol-item">✅ Net R إجمالي +${net_all}R — النظام مربح</div>`);
    return recs.join('');
  })()}
</div>

<!-- FOOTER -->
<div class="footer">
  <div>Trading Intelligence Hub  •  Built for khaled14sa  •  مسلط الحربي  •  ${dateStr}</div>
  <div style="margin-top:4px">Behavioral  •  Volume Profile  •  ICT/SMC  •  Wyckoff/Weis  •  Murphy  •  Rayner  •  PHASE 2 v4.0</div>
</div>

</body>
</html>`;
}

// ── تحويل HTML إلى PDF باستخدام Puppeteer عبر API ──
// Vercel لا يدعم Puppeteer — نستخدم html2pdf.it API المجانية
async function htmlToPdf(html) {
  const boundary = '----FormBoundary' + Date.now();
  const body = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="html"\r\n\r\n` +
    html + '\r\n' +
    `--${boundary}--\r\n`
  );

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.html2pdf.app',
      path: '/v1/generate',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode === 200) resolve(buf);
        else reject(new Error(`html2pdf error: ${res.statusCode} — ${buf.toString().slice(0,200)}`));
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('html2pdf timeout')));
    req.write(body);
    req.end();
  });
}

// ── إرسال PDF على Telegram ──
async function sendPdfToTelegram(pdfBuffer, caption) {
  const boundary = '----TGBoundary' + Date.now();
  const filename  = `TIH_Report_${new Date().toISOString().slice(0,10)}.pdf`;

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="chat_id"\r\n\r\n${CHAT_ID}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="document"; filename="${filename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    ),
    pdfBuffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendDocument`,
      method:   'POST',
      headers:  {
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── إرسال رسالة نصية على Telegram ──
async function sendText(msg) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ════════════════════════════════════
// الـ Handler الرئيسي
// ════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'send';

  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    // جلب البيانات
    const [idxData, stkData] = await Promise.all([
      fetchPerformanceData('index'),
      fetchPerformanceData('stock'),
    ]);

    // هل يوجد بيانات؟
    if (idxData.total === 0 && stkData.total === 0) {
      await sendText('📊 <b>تقرير TIH</b>\n\nلا توجد إشارات مكتملة في هذه الفترة.');
      return res.status(200).json({ ok: true, message: 'no data' });
    }

    // بناء HTML
    const html = buildReportHTML(idxData, stkData, dateStr);

    // تحويل لـ PDF
    let pdfBuffer;
    try {
      pdfBuffer = await htmlToPdf(html);
    } catch(e) {
      // Fallback: إرسال ملخص نصي فقط
      const wr_idx = idxData.total > 0 ? (idxData.won/idxData.total*100).toFixed(0) : 0;
      const wr_stk = stkData.total > 0 ? (stkData.won/stkData.total*100).toFixed(0) : 0;

      const msg =
        `📊 <b>TIH — تقرير الأداء</b>\n` +
        `📅 ${dateStr}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `<b>المؤشرات — ${idxData.period}:</b>\n` +
        `✅ ناجحة: ${idxData.won} | ❌ خاسرة: ${idxData.lost} | 🛑 SL: ${idxData.sl_hit}\n` +
        `🎯 Win Rate: <b>${wr_idx}%</b> | 💰 Net R: <b>${idxData.total_r>=0?'+':''}${idxData.total_r}R</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `<b>الأسهم — ${stkData.period}:</b>\n` +
        `✅ ناجحة: ${stkData.won} | ❌ خاسرة: ${stkData.lost} | 🛑 SL: ${stkData.sl_hit}\n` +
        `🎯 Win Rate: <b>${wr_stk}%</b> | 💰 Net R: <b>${stkData.total_r>=0?'+':''}${stkData.total_r}R</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🤖 <i>TIH v4.0 — PDF غير متاح حالياً</i>`;

      await sendText(msg);
      return res.status(200).json({ ok: true, message: 'text sent (pdf failed)', error: e.message });
    }

    // إرسال PDF
    const caption =
      `📊 <b>TIH — تقرير الأداء التفصيلي</b>\n` +
      `📅 ${dateStr}\n` +
      `📈 المؤشرات: ${idxData.won}/${idxData.total} • 🛑 SL: ${idxData.sl_hit}\n` +
      `📊 الأسهم: ${stkData.won}/${stkData.total} • 🛑 SL: ${stkData.sl_hit}\n` +
      `🤖 TIH v4.0`;

    const tgRes = await sendPdfToTelegram(pdfBuffer, caption);

    return res.status(200).json({
      ok:       true,
      message:  'PDF sent to Telegram',
      telegram: tgRes?.ok,
      indices:  { total: idxData.total, won: idxData.won, sl: idxData.sl_hit, r: idxData.total_r },
      stocks:   { total: stkData.total, won: stkData.won, sl: stkData.sl_hit, r: stkData.total_r },
    });

  } catch(err) {
    await sendText(`⚠️ خطأ في تقرير TIH: ${err.message}`).catch(()=>{});
    return res.status(500).json({ ok: false, error: err.message });
  }
};
