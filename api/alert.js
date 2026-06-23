// alert.js — يعيد التوجيه لـ alert-stocks.js (للتوافق مع الروابط القديمة)
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

  const action = req.query.action || 'check';

  // ── test ──
  if (action === 'test') {
    try {
      const r = await fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/alert-stocks?action=test`);
      const d = await r.json();
      return res.status(200).json(d);
    } catch(e) {
      return res.status(200).json({ ok: true, message: 'test redirect failed', error: e.message });
    }
  }

  // ── check — يقرأ من Redis keys الجديدة ──
  try {
    const [stkActive, stkPerf] = await Promise.all([
      kvGet('stk_active'),
      kvGet('stk_perf'),
    ]);

    const active = stkActive || {};
    const perf   = stkPerf   || { total:0, wins:0, losses:0, totalR:0 };

    const signals = Object.values(active).map(s => ({
      sym:    s.symbol || s.sym,
      signal: s.signal,
      grade:  s.grade || 'A',
      entry:  s.entry,
      sl:     s.sl,
      t1:     s.t1,
      t2:     s.t2,
      t3:     s.t3,
      t1Hit:  s.t1Hit,
      t2Hit:  s.t2Hit,
      age:    Math.round((Date.now() - (s.openedAt || Date.now())) / 60000),
    }));

    return res.status(200).json({
      ok: true,
      newAlerts: 0,
      active: signals.length,
      signals,
      winRate: perf.total > 0 ? Math.round((perf.wins / perf.total) * 100) : 0,
      totalR:  perf.totalR || 0,
      total:   perf.total  || 0,
      message: 'يرجى استخدام /api/alert-stocks للإشارات الجديدة'
    });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
