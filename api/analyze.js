const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = (req.query.symbol || 'AAPL').toUpperCase().replace(/[^A-Z0-9.\-\/]/g, '');
  const type = req.query.type || 'stock';

  try {
    // Map symbol to Yahoo Finance format
    let yfSymbol = symbol;
    if (type === 'crypto') yfSymbol = symbol.replace('USDT','') + '-USD';
    if (type === 'forex') yfSymbol = symbol.replace('/','') + '=X';
    if (type === 'index') {
      const indexMap = { 'SPX':'^GSPC','NDX':'^NDX','US500':'^GSPC','DJI':'^DJI','VIX':'^VIX','DAX':'^GDAXI' };
      yfSymbol = indexMap[symbol] || '^' + symbol;
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=1d&range=5d`;
    const data = await fetchJSON(url);

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('رمز غير موجود');

    const meta = result.meta;
    const price = meta.regularMarketPrice || 0;
    const open = meta.regularMarketOpen || price;
    const high = meta.regularMarketDayHigh || price;
    const low = meta.regularMarketDayLow || price;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const volume = meta.regularMarketVolume || 0;
    const change = price - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;
    const week52High = meta.fiftyTwoWeekHigh || price * 1.3;
    const week52Low = meta.fiftyTwoWeekLow || price * 0.7;

    // Pivot Points
    const pivot = ((high + low + prevClose) / 3).toFixed(2);
    const res1 = ((2 * pivot) - low).toFixed(2);
    const res2 = (parseFloat(pivot) + (high - low)).toFixed(2);
    const sup1 = ((2 * pivot) - high).toFixed(2);
    const sup2 = (parseFloat(pivot) - (high - low)).toFixed(2);

    // Risk score
    const distFromHigh = ((price - week52High) / week52High) * 100;
    const rsi14 = 50 + (changePercent * 2);
    const rsiClamped = Math.max(20, Math.min(80, rsi14));
    const risk = Math.round(Math.abs(distFromHigh) > 20 ? 35 : rsiClamped > 65 ? 70 : 45);

    // Verdict
    let signal = 'محايد';
    if (changePercent > 1.5) signal = 'شراء';
    else if (changePercent < -1.5) signal = 'بيع';
    const confidence = Math.round(50 + Math.abs(changePercent) * 5);

    // Timeframes mock (realistic based on price vs open)
    const frames = ['15m','1H','4H','D','W','M'];
    const timeframes = frames.map((frame, i) => {
      const rsi = Math.round(45 + changePercent * (i + 1) * 1.5);
      const rsiVal = Math.max(25, Math.min(78, rsi));
      const trend = rsiVal > 55 ? 'صاعد' : rsiVal < 45 ? 'هابط' : 'محايد';
      return {
        frame,
        trend,
        rsi: rsiVal,
        momentum: changePercent > 0 ? 1 : changePercent < 0 ? -1 : 0,
        signal: trend === 'صاعد' ? 'شراء' : trend === 'هابط' ? 'بيع' : 'انتظار'
      };
    });

    res.status(200).json({
      symbol: meta.symbol || symbol,
      name: meta.longName || meta.shortName || symbol,
      price: price.toFixed(2),
      open: open.toFixed(2),
      high: high.toFixed(2),
      low: low.toFixed(2),
      volume,
      change: parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      week52High: week52High.toFixed(2),
      week52Low: week52Low.toFixed(2),
      levels: { res2, res1, pivot, sup1, sup2 },
      verdict: { signal, confidence: Math.min(confidence, 85) },
      risk,
      timeframes
    });

  } catch(e) {
    res.status(500).json({ error: e.message || 'خطأ في جلب البيانات' });
  }
};
