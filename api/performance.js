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

  try {
    // جلب بيانات النظامين
    const [idxPerf, idxActive, stkPerf, stkActive] = await Promise.all([
      kvGet('idx_perf'),
      kvGet('idx_active'),
      kvGet('perf_v2'),
      kvGet('active_v2'),
    ]);

    // دمج الأداء
    const ip = idxPerf || { total:0, wins:0, losses:0, totalR:0 };
    const sp = stkPerf || { total:0, wins:0, losses:0, totalR:0 };

    const total   = ip.total   + sp.total;
    const wins    = ip.wins    + sp.wins;
    const losses  = ip.losses  + sp.losses;
    const totalR  = +(ip.totalR + sp.totalR).toFixed(1);
    const winRate = total > 0 ? Math.round((wins/total)*100) : 0;

    // الإشارات النشطة
    const idxActObj = idxActive || {};
    const stkActObj = stkActive || {};
    const active = Object.keys(idxActObj).length + Object.keys(stkActObj).length;

    // قائمة الإشارات النشطة
    const activeList = [
      ...Object.values(idxActObj).map(s => ({
        sym: s.sym, signal: s.signal,
        entry: s.entry, sl: s.sl,
        t1: s.t1, t2: s.t2, t3: s.t3,
        t1Hit: s.t1Hit, t2Hit: s.t2Hit,
        type: 'index',
        age: Math.round((Date.now() - s.openedAt) / 60000) // دقائق
      })),
      ...Object.values(stkActObj).map(s => ({
        sym: s.symbol, signal: s.signal,
        entry: s.entry, sl: s.sl,
        t1: s.t1, t2: s.t2, t3: s.t3,
        t1Hit: s.t1Hit, t2Hit: s.t2Hit,
        type: 'stock',
        age: Math.round((Date.now() - s.openedAt) / 60000)
      }))
    ].sort((a,b) => a.age - b.age); // الأحدث أولاً

    // تفصيل النتائج
    const breakdown = [
      { label: `✅ المؤشرات — ${ip.wins}/${ip.total}`, value: ip.wins, total: ip.total, type: 'win', r: ip.totalR },
      { label: `✅ الأسهم — ${sp.wins}/${sp.total}`,   value: sp.wins, total: sp.total, type: 'win', r: sp.totalR },
    ];

    return res.status(200).json({
      ok: true,
      total, wins, losses, totalR, winRate, active,
      indices: { total: ip.total, wins: ip.wins, losses: ip.losses, totalR: ip.totalR },
      stocks:  { total: sp.total, wins: sp.wins, losses: sp.losses, totalR: sp.totalR },
      activeList, breakdown
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
