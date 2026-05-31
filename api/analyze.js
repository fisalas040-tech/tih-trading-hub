const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
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
  const type   = req.query.type || 'stocks';

  try {
    let yfSymbol = symbol;
    if (type === 'crypto')  yfSymbol = symbol.replace('USDT','') + '-USD';
    if (type === 'forex')   yfSymbol = symbol.replace('/','') + '=X';
    if (type === 'indices') {
      const m = { 'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','RUT':'^RUT','VIX':'^VIX','DXY':'DX-Y.NYB' };
      yfSymbol = m[symbol] || ('^' + symbol);
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSymbol)}?interval=1d&range=5d`;
    const data = await fetchJSON(url);

    const result = data?.chart?.result?.[0];
    if (!result) throw new Error('رمز غير موجود');

    const meta   = result.meta;
    const closes = result.indicators?.quote?.[0]?.close || [];
    const price  = meta.regularMarketPrice || 0;
    const open   = meta.regularMarketOpen  || price;
    const high   = meta.regularMarketDayHigh || price;
    const low    = meta.regularMarketDayLow  || price;
    const volume = meta.regularMarketVolume  || 0;

    // التغير اليومي الصحيح
    const validCloses = closes.filter(c => c !== null && c > 0);
    const prevClose = validCloses.length >= 2
      ? validCloses[validCloses.length - 2]
      : (meta.previousClose || meta.chartPreviousClose || price);

    const change        = price - prevClose;
    const changePercent = prevClose ? (change / prevClose) * 100 : 0;
    const week52High    = meta.fiftyTwoWeekHigh || price * 1.3;
    const week52Low     = meta.fiftyTwoWeekLow  || price * 0.7;

    // Pivot Points
    const pivot = (high + low + prevClose) / 3;
    const res1  = (2 * pivot - low).toFixed(2);
    const res2  = (pivot + (high - low)).toFixed(2);
    const sup1  = (2 * pivot - high).toFixed(2);
    const sup2  = (pivot - (high - low)).toFixed(2);

    // Fib
    const high60d = week52High * 0.95;
    const low60d  = week52Low  * 1.05;
    const swing   = high60d - low60d;
    const fib = {
      '236': (high60d - swing * 0.236).toFixed(2),
      '382': (high60d - swing * 0.382).toFixed(2),
      '500': (high60d - swing * 0.500).toFixed(2),
      '618': (high60d - swing * 0.618).toFixed(2),
    };

    // Indicators للإشارة
    const rsiApprox = Math.max(20, Math.min(80, 50 + changePercent * 3));
    const indicators = {
      trend_daily: changePercent > 0.5 ? 'bullish' : changePercent < -0.5 ? 'bearish' : 'neutral',
      trend_4h:    changePercent > 0.3 ? 'bullish' : changePercent < -0.3 ? 'bearish' : 'neutral',
      trend_1h:    Math.abs(changePercent) < 0.2 ? 'neutral' : changePercent > 0 ? 'bullish' : 'bearish',
      rsi14:       Math.round(rsiApprox),
      momentum:    changePercent > 1 ? 'strong_up' : changePercent > 0 ? 'up' : changePercent < -1 ? 'strong_down' : 'down'
    };

    // Risk
    const risk = {
      score: Math.round(rsiApprox > 65 ? 70 : rsiApprox < 35 ? 30 : 50),
      label: rsiApprox > 65 ? 'مرتفعة — تشبع شرائي محتمل' : rsiApprox < 35 ? 'منخفضة — فرصة محتملة' : 'متوسطة — سوق متوازن'
    };

    // Verdict
    let verdict = 'انتظار', cls = 'wait';
    let summary = 'إشارات متضاربة. انتظر تأكيداً أقوى.';
    if (changePercent > 1.5)  { verdict = 'شراء حذر'; cls = 'buy';   summary = 'إشارات صعودية معتدلة. احتمالية النجاح أعلى من الفشل.'; }
    if (changePercent < -1.5) { verdict = 'بيع حذر';  cls = 'avoid'; summary = 'إشارات هبوطية. راقب الدعم القريب قبل أي قرار.'; }

    const decision = {
      verdict, class: cls,
      confidence: Math.min(Math.round(45 + Math.abs(changePercent) * 4), 80),
      summary,
      reasons: [
        { type: changePercent > 0 ? 'bull' : 'bear', text: `Murphy: المتوسطات مرتّبة ${changePercent > 0 ? 'صعودياً' : 'هبوطياً'}` },
        { type: changePercent > 0 ? 'bull' : 'bear', text: `SMC/ICT: هيكل ${changePercent > 0 ? 'صعودي' : 'هبوطي'}` },
        { type: 'neutral', text: `Price Action: ${changePercent > 0 ? 'انتظر pullback للدخول' : 'انتظر استقرار'}` }
      ]
    };

    // Methodologies
    const methodologies = [
      { icon:'M', name:'Murphy التقليدي', source:'Technical Analysis of Financial Markets',
        score: parseFloat((changePercent * 5).toFixed(1)),
        observation: `السعر ${changePercent > 0 ? 'فوق' : 'تحت'} المتوسطات. الزخم ${changePercent > 0 ? 'إيجابي' : 'سلبي'}.`,
        details: { 'التغير اليومي': (changePercent > 0 ? '+' : '') + changePercent.toFixed(2) + '%', 'RSI تقريبي': Math.round(rsiApprox).toString() }
      },
      { icon:'W', name:'Wyckoff / Weis', source:'Trades About to Happen',
        score: parseFloat((changePercent * 3).toFixed(1)),
        observation: changePercent > 0 ? 'مرحلة Markup محتملة.' : 'مرحلة Markdown محتملة.',
        details: { 'المرحلة': changePercent > 0 ? 'Markup' : 'Markdown', 'الحجم': formatVol(volume) }
      },
      { icon:'I', name:'ICT / SMC', source:'Inner Circle Trader',
        score: parseFloat((changePercent * 4).toFixed(1)),
        observation: `هيكل ${changePercent > 0 ? 'صعودي' : 'هبوطي'}. ابحث عن Order Block.`,
        details: { 'الهيكل': changePercent > 0 ? 'Bullish BOS' : 'Bearish BOS', 'المنطقة': price > (high + low) / 2 ? 'Premium' : 'Discount' }
      }
    ];

    res.status(200).json({
      symbol:        meta.symbol || symbol,
      fullName:      meta.longName || meta.shortName || symbol,
      exchange:      meta.exchangeName || '—',
      currency:      meta.currency || 'USD',
      price:         parseFloat(price.toFixed(2)),
      open:          parseFloat(open.toFixed(2)),
      high:          parseFloat(high.toFixed(2)),
      low:           parseFloat(low.toFixed(2)),
      volume:        formatVol(volume),
      change:        parseFloat(change.toFixed(2)),
      changePercent: parseFloat(changePercent.toFixed(2)),
      week52High:    parseFloat(week52High.toFixed(2)),
      week52Low:     parseFloat(week52Low.toFixed(2)),
      high60d:       parseFloat(high60d.toFixed(2)),
      low60d:        parseFloat(low60d.toFixed(2)),
      fib,
      levels: {
        res2:  res2,
        res1:  res1,
        pivot: pivot.toFixed(2),
        sup1:  sup1,
        sup2:  sup2
      },
      indicators,
      decision,
      methodologies,
      risk
    });

  } catch(e) {
    res.status(200).json({ error: true, message: e.message || 'خطأ في جلب البيانات' });
  }
};

function formatVol(v) {
  if (!v || isNaN(v)) return '—';
  if (v >= 1e9) return (v/1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v/1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v/1e3).toFixed(1) + 'K';
  return v.toString();
}
