const https = require('https');

// الرموز: Yahoo Finance symbols
const SYMBOLS = [
  { id: 'US500', yahoo: 'ES=F'    },
  { id: 'BTC',   yahoo: 'BTC-USD' },
  { id: 'GOLD',  yahoo: 'GC=F'    },
  { id: 'NDX',   yahoo: '^NDX'    },
  { id: 'ETH',   yahoo: 'ETH-USD' },
];

function fetchYahoo(symbol) {
  return new Promise((resolve, reject) => {
    const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`;
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/json',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const markets = {};
  const errors = [];

  await Promise.all(SYMBOLS.map(async (sym) => {
    try {
      const data = await fetchYahoo(sym.yahoo);
      const meta = data?.chart?.result?.[0]?.meta;
      if (!meta) return;

      const price = meta.regularMarketPrice;
      const prev  = meta.chartPreviousClose || meta.previousClose || price;
      const chg   = prev ? ((price - prev) / prev * 100) : 0;

      markets[sym.id] = {
        price: +price.toFixed(2),
        change: +chg.toFixed(2),
      };
    } catch(e) {
      errors.push(`${sym.id}: ${e.message}`);
    }
  }));

  return res.status(200).json({
    ok: Object.keys(markets).length > 0,
    markets,
    errors,
    ts: Date.now()
  });
};
