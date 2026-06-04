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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // جلب كل البيانات
  const [idxLog, stkLog, idxPerf, stkPerf, idxActive, stkActive] = await Promise.all([
    kvGet('idx_log'),
    kvGet('stk_log'),
    kvGet('idx_perf'),
    kvGet('stk_perf'),
    kvGet('idx_active'),
    kvGet('stk_active'),
  ]);

  const allLog = [
    ...(idxLog || []).map(x => ({ ...x, type: 'index' })),
    ...(stkLog || []).map(x => ({ ...x, type: 'stock' })),
  ].sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

  const ip = idxPerf || { total:0, wins:0, losses:0, totalR:0 };
  const sp = stkPerf || { total:0, wins:0, losses:0, totalR:0 };
  const ia = idxActive || {};
  const sa = stkActive || {};

  const total   = allLog.length;
  const wins    = allLog.filter(x => x.result !== 'SL' && x.result !== 'EXP').length;
  const losses  = allLog.filter(x => x.result === 'SL').length;
  const expired = allLog.filter(x => x.result === 'EXP').length;
  const t1hits  = allLog.filter(x => x.result === 'T1').length;
  const t2hits  = allLog.filter(x => x.result === 'T2').length;
  const t3hits  = allLog.filter(x => x.result === 'T3').length;
  const totalR  = allLog.reduce((s, x) => s + (x.r || 0), 0);
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 0;
  const slRate  = total > 0 ? ((losses / total) * 100).toFixed(1) : 0;
  const expRate = total > 0 ? ((expired / total) * 100).toFixed(1) : 0;

  // تحليل حسب الدرجة
  const byGrade = {};
  allLog.forEach(x => {
    const g = x.grade || '?';
    if (!byGrade[g]) byGrade[g] = { total:0, wins:0, losses:0, totalR:0 };
    byGrade[g].total++;
    if (x.result !== 'SL' && x.result !== 'EXP') byGrade[g].wins++;
    if (x.result === 'SL') byGrade[g].losses++;
    byGrade[g].totalR += (x.r || 0);
  });

  // تحليل حسب الرمز
  const bySym = {};
  allLog.forEach(x => {
    if (!bySym[x.sym]) bySym[x.sym] = { total:0, wins:0, losses:0, totalR:0 };
    bySym[x.sym].total++;
    if (x.result !== 'SL' && x.result !== 'EXP') bySym[x.sym].wins++;
    if (x.result === 'SL') bySym[x.sym].losses++;
    bySym[x.sym].totalR += (x.r || 0);
  });

  // تحليل حسب النوع (CALL/PUT)
  const calls = allLog.filter(x => x.signal === 'CALL');
  const puts  = allLog.filter(x => x.signal === 'PUT');
  const callWins = calls.filter(x => x.result !== 'SL' && x.result !== 'EXP').length;
  const putWins  = puts.filter(x => x.result !== 'SL' && x.result !== 'EXP').length;

  // تقييم النظام العام
  let systemRating, systemLabel, systemColor;
  const wr = parseFloat(winRate);
  const rr = totalR;
  if (total < 10) {
    systemRating = 'insufficient'; systemLabel = '⏳ بيانات غير كافية'; systemColor = 'neutral';
  } else if (wr >= 65 && rr > 0) {
    systemRating = 'excellent'; systemLabel = '🏆 نظام ممتاز — موثوق جداً'; systemColor = 'bull';
  } else if (wr >= 55 && rr > 0) {
    systemRating = 'good'; systemLabel = '✅ نظام جيد — يمكن الاعتماد عليه'; systemColor = 'bull';
  } else if (wr >= 45) {
    systemRating = 'average'; systemLabel = '⚡ نظام متوسط — يحتاج تحسين'; systemColor = 'neutral';
  } else {
    systemRating = 'poor'; systemLabel = '⚠️ نظام ضعيف — يحتاج مراجعة'; systemColor = 'bear';
  }

  return res.status(200).json({
    ok: true,
    summary: {
      total, wins, losses, expired,
      t1hits, t2hits, t3hits,
      totalR: +totalR.toFixed(1),
      winRate: +winRate,
      slRate: +slRate,
      expRate: +expRate,
      active: Object.keys(ia).length + Object.keys(sa).length,
    },
    byGrade: Object.entries(byGrade).map(([grade, d]) => ({
      grade,
      total: d.total,
      wins: d.wins,
      losses: d.losses,
      totalR: +d.totalR.toFixed(1),
      winRate: d.total > 0 ? +((d.wins/d.total)*100).toFixed(1) : 0,
    })).sort((a,b) => b.total - a.total),
    bySymbol: Object.entries(bySym).map(([sym, d]) => ({
      sym,
      total: d.total,
      wins: d.wins,
      losses: d.losses,
      totalR: +d.totalR.toFixed(1),
      winRate: d.total > 0 ? +((d.wins/d.total)*100).toFixed(1) : 0,
    })).sort((a,b) => b.total - a.total).slice(0, 15),
    bySignal: {
      call: { total: calls.length, wins: callWins, winRate: calls.length > 0 ? +((callWins/calls.length)*100).toFixed(1) : 0 },
      put:  { total: puts.length,  wins: putWins,  winRate: puts.length  > 0 ? +((putWins/puts.length)*100).toFixed(1)   : 0 },
    },
    systemRating, systemLabel, systemColor,
    lastUpdated: new Date().toISOString(),
  });
};
