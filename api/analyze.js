const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      } 
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = (req.query.symbol || 'AAPL').toUpperCase().replace(/[^A-Z0-9.\-\/^]/g, '');
  const tf     = req.query.tf || '1D';
  const type   = req.query.type || 'stocks';

  // Map to Yahoo symbol
  let yfSym = symbol;
  if (type === 'crypto')  yfSym = symbol + '-USD';
  if (type === 'forex')   yfSym = symbol + '=X';
  if (type === 'indices') {
    const m = { 'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','RUT':'^RUT','VIX':'^VIX','DXY':'DX-Y.NYB' };
    yfSym = m[symbol] || ('^' + symbol);
  }

  // Map TF to Yahoo interval + range
  const tfMap = {
    '1m':  { interval:'1m',  range:'1d'  },
    '5m':  { interval:'5m',  range:'5d'  },
    '15m': { interval:'15m', range:'5d'  },
    '1H':  { interval:'60m', range:'30d' },
    '1D':  { interval:'1d',  range:'6mo' },
    '1W':  { interval:'1wk', range:'2y'  },
  };
  const { interval, range } = tfMap[tf] || tfMap['1D'];

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${interval}&range=${range}`;
    const data = await fetchJSON(url);

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('No data');

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};

    const candles = timestamps.map((t, i) => ({
      time:  t,
      open:  parseFloat((q.open?.[i]  || 0).toFixed(4)),
      high:  parseFloat((q.high?.[i]  || 0).toFixed(4)),
      low:   parseFloat((q.low?.[i]   || 0).toFixed(4)),
      close: parseFloat((q.close?.[i] || 0).toFixed(4)),
    })).filter(c => c.open && c.high && c.low && c.close && c.time);

    res.status(200).json({ candles, symbol: result.meta?.symbol || symbol });

  } catch(e) {
    res.status(500).json({ error: e.message, candles: [] });
  }
};
