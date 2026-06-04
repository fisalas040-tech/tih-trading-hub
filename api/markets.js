const https = require('https');

const MASSIVE_KEY = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';

// رموز الأسواق في Massive
// US500 = SPY (ETF) أو ES (Futures)
// GOLD  = GLD أو /GC (Futures)
// NDX   = QQQ أو NQ (Futures)
// BTC   = X:BTCUSD
// ETH   = X:ETHUSD
const SYMBOLS = [
  { id: 'US500', ticker: 'SPY',       type: 'stocks' },
  { id: 'BTC',   ticker: 'X:BTCUSD', type: 'crypto' },
  { id: 'GOLD',  ticker: 'GLD',       type: 'stocks' },
  { id: 'NDX',   ticker: 'QQQ',       type: 'stocks' },
  { id: 'ETH',   ticker: 'X:ETHUSD', type: 'crypto' },
];

function fetchMassive(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.massive.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${MASSIVE_KEY}`,
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // جلب snapshot لكل الرموز في طلب واحد
    const tickers = SYMBOLS.map(s => s.ticker).join(',');
    const path = `/v3/snapshot?ticker=${encodeURIComponent(tickers)}&limit=10`;

    const data = await fetchMassive(path);

    if (!data.results) {
      return res.status(200).json({ ok: false, error: 'No results', raw: data });
    }

    // بناء الرد
    const markets = {};
    (data.results || []).forEach(item => {
      const sym = SYMBOLS.find(s => s.ticker === item.ticker);
      if (!sym) return;

      const session = item.session || {};
      const lastTrade = item.last_trade || {};
      const lastMinute = item.last_minute || {};

      // السعر: last_trade أو close من session
      const price = lastTrade.p || lastMinute.c || session.close || 0;
      const prevClose = session.prev_close || session.close || price;
      const chg = prevClose ? ((price - prevClose) / prevClose * 100) : 0;

      markets[sym.id] = {
        price: +price.toFixed(2),
        change: +chg.toFixed(2),
        prevClose: +prevClose.toFixed(2),
      };
    });

    return res.status(200).json({ ok: true, markets, ts: Date.now() });

  } catch(e) {
    return res.status(200).json({ ok: false, error: e.message });
  }
};
