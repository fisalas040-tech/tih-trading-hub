const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL  || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN|| 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

async function kvGet(key) {
  try {
    const r = await fetch(UPSTASH_URL + '/get/' + encodeURIComponent(key), {
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN },
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}

function calcStats(entries) {
  if (!entries || !entries.length) return { total:0, wins:0, losses:0, expired:0, wr:0, totalR:0 };
  const wins    = entries.filter(function(e){ return ['T1','T2','T3'].includes(e.result); }).length;
  const losses  = entries.filter(function(e){ return e.result === 'SL'; }).length;
  const expired = entries.filter(function(e){ return e.result === 'EXP'; }).length;
  const totalR  = +entries.reduce(function(s,e){ return s + (e.r || 0); }, 0).toFixed(1);
  const wr      = entries.length ? Math.round(wins / entries.length * 100) : 0;
  return { total: entries.length, wins, losses, expired, wr, totalR };
}

function period(log, days) {
  const cutoff = Date.now() - days * 86400000;
  return (log || []).filter(function(e){ return (e.closedAt || e.openedAt || 0) >= cutoff; });
}

function dailyCurve(log, days) {
  days = days || 30;
  const map = {};
  const cutoff = Date.now() - days * 86400000;
  for (const e of (log || [])) {
    const ts = e.closedAt || e.openedAt || 0;
    if (ts < cutoff) continue;
    const day = new Date(ts).toISOString().split('T')[0];
    map[day] = (map[day] || 0) + (e.r || 0);
  }
  const sorted = [];
  let cum = 0;
  for (let d = days - 1; d >= 0; d--) {
    const dt  = new Date(Date.now() - d * 86400000);
    const key = dt.toISOString().split('T')[0];
    cum += map[key] || 0;
    sorted.push({ date: key, daily: +(map[key] || 0).toFixed(2), cum: +cum.toFixed(2) });
  }
  return sorted;
}

function topSymbols(log, limit) {
  limit = limit || 5;
  const map = {};
  for (const e of (log || [])) {
    if (!map[e.sym]) map[e.sym] = { sym: e.sym, total:0, wins:0, r:0 };
    map[e.sym].total++;
    if (['T1','T2','T3'].includes(e.result)) map[e.sym].wins++;
    map[e.sym].r += (e.r || 0);
  }
  return Object.values(map)
    .sort(function(a,b){ return b.r - a.r; })
    .slice(0, limit)
    .map(function(s){ return Object.assign({}, s, { r: +s.r.toFixed(1), wr: Math.round(s.wins/s.total*100) }); });
}

async function buildData() {
  const [idxLog, stkLog] = await Promise.all([kvGet('idx_log'), kvGet('stk_log')]);
  const allLog = [].concat(idxLog || [], stkLog || []);
  return {
    generatedAt: new Date().toISOString(),
    indices:  { weekly:calcStats(period(idxLog,7)),  monthly:calcStats(period(idxLog,30)),  allTime:calcStats(idxLog),  curve30:dailyCurve(idxLog,30),  topSymbols:topSymbols(idxLog)  },
    stocks:   { weekly:calcStats(period(stkLog,7)),  monthly:calcStats(period(stkLog,30)),  allTime:calcStats(stkLog),  curve30:dailyCurve(stkLog,30),  topSymbols:topSymbols(stkLog)  },
    combined: { weekly:calcStats(period(allLog,7)),  monthly:calcStats(period(allLog,30)),  allTime:calcStats(allLog),  curve30:dailyCurve(allLog,30) },
  };
}

function renderHTML(data) {
  const c   = data.combined;
  const idx = data.indices;
  const stk = data.stocks;

  function card(label, icon, s) {
    const rColor = s.totalR >= 0 ? '#22c55e' : '#ef4444';
    const rSign  = s.totalR >= 0 ? '+' : '';
    return '<div class="card">' +
      '<div class="card-title">' + icon + ' ' + label + '</div>' +
      '<div class="stat-row"><span>الإشارات</span><strong>' + s.total + '</strong></div>' +
      '<div class="stat-row"><span>Win Rate</span><strong>' + s.wr + '%</strong></div>' +
      '<div class="stat-row"><span>إجمالي R</span><strong style="color:' + rColor + '">' + rSign + s.totalR + 'R</strong></div>' +
      '</div>';
  }

  function symbolTable(syms) {
    if (!syms || !syms.length) return '<p style="color:#666">لا بيانات</p>';
    const rows = syms.map(function(s) {
      const col  = s.r >= 0 ? '#22c55e' : '#ef4444';
      const sign = s.r >= 0 ? '+' : '';
      return '<tr><td><b>' + s.sym + '</b></td><td>' + s.total + '</td><td>' + s.wr + '%</td><td style="color:' + col + '">' + sign + s.r + 'R</td></tr>';
    }).join('');
    return '<table><tr><th>الرمز</th><th>الإشارات</th><th>WR%</th><th>إجمالي R</th></tr>' + rows + '</table>';
  }

  const labels  = JSON.stringify(c.curve30.map(function(d){ return d.date; }));
  const cAllCum = JSON.stringify(c.curve30.map(function(d){ return d.cum; }));
  const cIdxCum = JSON.stringify(idx.curve30.map(function(d){ return d.cum; }));
  const cStkCum = JSON.stringify(stk.curve30.map(function(d){ return d.cum; }));
  const ts = new Date(data.generatedAt).toLocaleString('ar-SA', {timeZone:'Asia/Riyadh'});

  return '<!DOCTYPE html><html lang="ar" dir="rtl"><head>' +
    '<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>TIH - تقرير الأداء</title>' +
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"><\/script>' +
    '<style>*{box-sizing:border-box;margin:0;padding:0}' +
    'body{font-family:\'Segoe UI\',Arial,sans-serif;background:#0f172a;color:#e2e8f0;padding:20px 16px 40px}' +
    'h1{text-align:center;font-size:1.6rem;margin-bottom:4px;color:#fff}' +
    '.subtitle{text-align:center;color:#94a3b8;font-size:.85rem;margin-bottom:24px}' +
    '.tabs{display:flex;gap:8px;justify-content:center;margin-bottom:24px;flex-wrap:wrap}' +
    '.tab{padding:8px 20px;border-radius:999px;cursor:pointer;font-size:.85rem;border:1px solid #334155;background:transparent;color:#94a3b8}' +
    '.tab.active{background:#3b82f6;border-color:#3b82f6;color:#fff}' +
    '.section{display:none}.section.active{display:block}' +
    '.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:24px}' +
    '.card{background:#1e293b;border-radius:12px;padding:16px;border:1px solid #1e3a5f}' +
    '.card-title{font-size:.8rem;color:#94a3b8;text-transform:uppercase;margin-bottom:10px}' +
    '.stat-row{display:flex;justify-content:space-between;padding:4px 0;font-size:.9rem;border-bottom:1px solid #0f172a}' +
    '.stat-row:last-child{border:none}' +
    '.chart-box{background:#1e293b;border-radius:12px;padding:16px;border:1px solid #1e3a5f;margin-bottom:24px}' +
    '.chart-box h3{font-size:.9rem;color:#94a3b8;margin-bottom:12px}' +
    'table{width:100%;border-collapse:collapse;font-size:.85rem}' +
    'th{color:#64748b;padding:6px 8px;text-align:right;font-weight:600;border-bottom:1px solid #334155}' +
    'td{padding:6px 8px;border-bottom:1px solid #1e293b}' +
    '.section-title{font-size:1rem;font-weight:700;color:#cbd5e1;margin-bottom:12px}' +
    '</style></head><body>' +
    '<h1>📊 TIH — لوحة الأداء</h1>' +
    '<p class="subtitle">آخر تحديث: ' + ts + '</p>' +
    '<div class="tabs">' +
    '<button class="tab active" onclick="show(\'combined\',this)">🌐 الكل</button>' +
    '<button class="tab" onclick="show(\'indices\',this)">📈 مؤشرات</button>' +
    '<button class="tab" onclick="show(\'stocks\',this)">📊 أسهم</button>' +
    '</div>' +
    '<div id="combined" class="section active">' +
    '<p class="section-title">الأسبوع الماضي</p><div class="grid">' + card('الكل','🌐',c.weekly) + card('مؤشرات','📈',idx.weekly) + card('أسهم','📊',stk.weekly) + '</div>' +
    '<p class="section-title">الشهر الماضي</p><div class="grid">' + card('الكل','🌐',c.monthly) + card('مؤشرات','📈',idx.monthly) + card('أسهم','📊',stk.monthly) + '</div>' +
    '<p class="section-title">منذ البداية</p><div class="grid">' + card('الكل','🌐',c.allTime) + card('مؤشرات','📈',idx.allTime) + card('أسهم','📊',stk.allTime) + '</div>' +
    '<div class="chart-box"><h3>📈 منحنى R التراكمي — آخر 30 يوم</h3><canvas id="curveAll" height="100"></canvas></div>' +
    '</div>' +
    '<div id="indices" class="section">' +
    '<div class="grid">' + card('أسبوع','📅',idx.weekly) + card('شهر','🗓',idx.monthly) + card('الكل','♾️',idx.allTime) + '</div>' +
    '<div class="chart-box"><h3>📈 منحنى R — المؤشرات</h3><canvas id="curveIdx" height="100"></canvas></div>' +
    '<div class="chart-box"><h3>🏆 أفضل المؤشرات</h3>' + symbolTable(idx.topSymbols) + '</div>' +
    '</div>' +
    '<div id="stocks" class="section">' +
    '<div class="grid">' + card('أسبوع','📅',stk.weekly) + card('شهر','🗓',stk.monthly) + card('الكل','♾️',stk.allTime) + '</div>' +
    '<div class="chart-box"><h3>📈 منحنى R — الأسهم</h3><canvas id="curveStk" height="100"></canvas></div>' +
    '<div class="chart-box"><h3>🏆 أفضل الأسهم</h3>' + symbolTable(stk.topSymbols) + '</div>' +
    '</div>' +
    '<script>' +
    'function show(id,btn){document.querySelectorAll(".section").forEach(function(s){s.classList.remove("active")});document.querySelectorAll(".tab").forEach(function(b){b.classList.remove("active")});document.getElementById(id).classList.add("active");btn.classList.add("active");}' +
    'var labels=' + labels + ';' +
    'var opts={responsive:true,plugins:{legend:{labels:{color:"#94a3b8"}}},scales:{x:{ticks:{color:"#475569",maxTicksLimit:8},grid:{color:"#1e293b"}},y:{ticks:{color:"#475569"},grid:{color:"#1e293b"}}}};' +
    'function ds(label,data,color){return{label:label,data:data,borderColor:color,backgroundColor:color+"22",fill:true,tension:.35,pointRadius:0,borderWidth:2};}' +
    'new Chart(document.getElementById("curveAll"),{type:"line",data:{labels:labels,datasets:[ds("الكل",' + cAllCum + ',"#3b82f6"),ds("مؤشرات",' + cIdxCum + ',"#22c55e"),ds("أسهم",' + cStkCum + ',"#f59e0b")]},options:opts});' +
    'new Chart(document.getElementById("curveIdx"),{type:"line",data:{labels:labels,datasets:[ds("مؤشرات",' + cIdxCum + ',"#22c55e")]},options:opts});' +
    'new Chart(document.getElementById("curveStk"),{type:"line",data:{labels:labels,datasets:[ds("أسهم",' + cStkCum + ',"#f59e0b")]},options:opts});' +
    '<\/script></body></html>';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    const data = await buildData();
    if (req.query.format === 'json') return res.status(200).json({ ok:true, ...data });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(renderHTML(data));
  } catch(err) {
    return res.status(500).json({ ok:false, error:err.message });
  }
};