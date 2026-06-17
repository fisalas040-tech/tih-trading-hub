const https = require('https');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';
const TWELVE_KEY    = process.env.TWELVE_DATA_API_KEY      || '8a2a10389f45439fa4bb70ab582f3f58';
const TWELVE_BASE   = 'api.twelvedata.com';

// ─── helpers ──────────────────────────────────────────────────────────────────

async function checkRedis() {
  const t0 = Date.now();
  try {
    // write a small probe key then read it back
    const probe = `health_probe_${Date.now()}`;
    const setRes = await fetch(
      `${UPSTASH_URL}/set/${probe}/ok?ex=60`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    if (!setRes.ok) return { ok: false, ms: Date.now() - t0, error: `set ${setRes.status}` };

    const getRes = await fetch(
      `${UPSTASH_URL}/get/${probe}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const body = await getRes.json();
    const ms = Date.now() - t0;
    if (body.result === 'ok') return { ok: true, ms };
    return { ok: false, ms, error: 'probe mismatch' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

async function checkTwelveData() {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const path = `/time_series?symbol=SPY&interval=1day&outputsize=1&apikey=${TWELVE_KEY}`;
    const req = https.get(
      { hostname: TWELVE_BASE, path, headers: { 'User-Agent': 'TIH-Health/1.0' } },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          const ms = Date.now() - t0;
          try {
            const json = JSON.parse(d);
            if (json.status === 'error') return resolve({ ok: false, ms, error: json.message });
            if (json.values?.length) {
              return resolve({ ok: true, ms, price: +parseFloat(json.values[0].close).toFixed(2) });
            }
            resolve({ ok: false, ms, error: 'no values' });
          } catch (e) {
            resolve({ ok: false, ms, error: e.message });
          }
        });
      }
    );
    req.on('error', e => resolve({ ok: false, ms: Date.now() - t0, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, ms: 8000, error: 'timeout' }); });
  });
}

async function checkCalendar() {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: 'nfs.faireconomy.media',
        path: '/ff_calendar_thisweek.json',
        headers: { 'User-Agent': 'TIH-Health/1.0' },
      },
      (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          const ms = Date.now() - t0;
          if (res.statusCode !== 200) return resolve({ ok: false, ms, status: res.statusCode });
          try {
            const json = JSON.parse(d);
            resolve({ ok: true, ms, events: Array.isArray(json) ? json.length : 0 });
          } catch (e) {
            resolve({ ok: false, ms, error: e.message });
          }
        });
      }
    );
    req.on('error', e => resolve({ ok: false, ms: Date.now() - t0, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, ms: 8000, error: 'timeout' }); });
  });
}

async function kvGet(key) {
  try {
    const r = await fetch(
      `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}

function isMarketOpen() {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 840 && mins <= 1290;
}

// ─── handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const t0 = Date.now();

  // Run all checks in parallel
  const [redis, twelveData, calendar,
         idxPerf, stkPerf,
         idxActive, stkActive] = await Promise.all([
    checkRedis(),
    checkTwelveData(),
    checkCalendar(),
    kvGet('idx_perf'),
    kvGet('stk_perf'),
    kvGet('idx_active'),
    kvGet('stk_active'),
  ]);

  const idxPerfData  = idxPerf  || { total:0, wins:0, losses:0, totalR:0 };
  const stkPerfData  = stkPerf  || { total:0, wins:0, losses:0, totalR:0 };
  const idxActiveArr = idxActive ? Object.values(idxActive) : [];
  const stkActiveArr = stkActive ? Object.values(stkActive) : [];

  const idxWR = idxPerfData.total > 0 ? +(idxPerfData.wins / idxPerfData.total * 100).toFixed(1) : null;
  const stkWR = stkPerfData.total > 0 ? +(stkPerfData.wins / stkPerfData.total * 100).toFixed(1) : null;

  const allOk = redis.ok && twelveData.ok;
  const statusCode = allOk ? 200 : 503;

  return res.status(statusCode).json({
    ok: allOk,
    ts: new Date().toISOString(),
    totalMs: Date.now() - t0,
    market: {
      open: isMarketOpen(),
    },
    services: {
      redis:      { ok: redis.ok,       ms: redis.ms,       ...(redis.error      && { error: redis.error      }) },
      twelveData: { ok: twelveData.ok,  ms: twelveData.ms,  ...(twelveData.error && { error: twelveData.error }), price: twelveData.price },
      calendar:   { ok: calendar.ok,    ms: calendar.ms,    ...(calendar.error   && { error: calendar.error   }), events: calendar.events },
    },
    indices: {
      active:   idxActiveArr.length,
      signals:  idxActiveArr.map(s => ({ sym: s.sym, signal: s.signal, grade: s.grade, t1Hit: s.t1Hit, t2Hit: s.t2Hit })),
      perf:     { total: idxPerfData.total, wins: idxPerfData.wins, losses: idxPerfData.losses, totalR: +idxPerfData.totalR.toFixed(1), winRate: idxWR },
    },
    stocks: {
      active:   stkActiveArr.length,
      signals:  stkActiveArr.map(s => ({ sym: s.sym, signal: s.signal, grade: s.grade, t1Hit: s.t1Hit, t2Hit: s.t2Hit })),
      perf:     { total: stkPerfData.total, wins: stkPerfData.wins, losses: stkPerfData.losses, totalR: +stkPerfData.totalR.toFixed(1), winRate: stkWR },
    },
  });
};
