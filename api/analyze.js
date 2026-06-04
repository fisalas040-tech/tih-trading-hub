const MASSIVE_KEY = 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';

const SYMBOL_MAP = {
  'US500': 'SPX', 'NDX': 'NDX', 'DJI': 'DJI', 'SPX': 'SPX',
  'XAUUSD': 'XAUUSD', 'BTC': 'BTCUSD', 'ETH': 'ETHUSD',
  'SOL': 'SOLUSD', 'BNB': 'BNBUSD', 'XRP': 'XRPUSD',
  'EURUSD': 'EURUSD', 'GBPUSD': 'GBPUSD', 'USDJPY': 'USDJPY',
};

async function fetchMassive(endpoint) {
  const r = await fetch(`https://api.massiveapi.com/v1/${endpoint}`, {
    headers: { 'X-API-Key': MASSIVE_KEY }
  });
  if (!r.ok) throw new Error(`Massive ${r.status}`);
  return r.json();
}

// حساب RSI
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - (100 / (1 + rs))).toFixed(2);
}

// حساب EMA
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return +ema.toFixed(4);
}

// حساب MACD
function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = calcEMA(closes.slice(-26), 12);
  const ema26 = calcEMA(closes.slice(-26), 26);
  const macd = +(ema12 - ema26).toFixed(4);
  return { macd, signal: 0, histogram: macd };
}

// حساب Fibonacci
function calcFib(high, low) {
  const diff = high - low;
  return {
    '0':    +(high).toFixed(2),
    '236':  +(high - diff * 0.236).toFixed(2),
    '382':  +(high - diff * 0.382).toFixed(2),
    '500':  +(high - diff * 0.5).toFixed(2),
    '618':  +(high - diff * 0.618).toFixed(2),
    '786':  +(high - diff * 0.786).toFixed(2),
    '1000': +(low).toFixed(2),
  };
}

// تحديد الاتجاه
function getTrend(closes, ema20, ema50) {
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 6] || closes[0];
  if (last > ema20 && ema20 > ema50) return 'bullish';
  if (last < ema20 && ema20 < ema50) return 'bearish';
  if (last > prev * 1.01) return 'bullish';
  if (last < prev * 0.99) return 'bearish';
  return 'neutral';
}

// حساب ATR
function calcATR(highs, lows, closes, period = 14) {
  const trs = [];
  for (let i = 1; i < Math.min(highs.length, period + 1); i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  return trs.length ? +(trs.reduce((a, b) => a + b) / trs.length).toFixed(2) : 0;
}

// قرار التداول
function makeDecision(rsi, trend, macd, price, ema20, volume, avgVolume) {
  let score = 0;
  const reasons = [];

  // الاتجاه
  if (trend === 'bullish') { score += 3; reasons.push({ type: 'bull', text: 'الاتجاه صاعد — فوق EMA20 و EMA50 (Murphy)' }); }
  else if (trend === 'bearish') { score -= 3; reasons.push({ type: 'bear', text: 'الاتجاه هابط — تحت EMA20 و EMA50 (Murphy)' }); }

  // RSI
  if (rsi < 30) { score += 2; reasons.push({ type: 'bull', text: `RSI ${rsi} — منطقة ذروة البيع (تشبع بيع)` }); }
  else if (rsi > 70) { score -= 2; reasons.push({ type: 'bear', text: `RSI ${rsi} — منطقة ذروة الشراء (تشبع شراء)` }); }
  else if (rsi > 50) { score += 1; reasons.push({ type: 'bull', text: `RSI ${rsi} — زخم صاعد` }); }
  else { score -= 1; reasons.push({ type: 'bear', text: `RSI ${rsi} — زخم هابط` }); }

  // MACD
  if (macd.macd > 0) { score += 1; reasons.push({ type: 'bull', text: 'MACD فوق الصفر — إيجابي (Wyckoff)' }); }
  else { score -= 1; reasons.push({ type: 'bear', text: 'MACD تحت الصفر — سلبي (Wyckoff)' }); }

  // السعر vs EMA20
  if (price > ema20) { score += 1; reasons.push({ type: 'bull', text: 'السعر فوق EMA20 — دعم متحرك' }); }
  else { score -= 1; reasons.push({ type: 'bear', text: 'السعر تحت EMA20 — مقاومة متحركة' }); }

  // الحجم
  if (avgVolume > 0 && volume > avgVolume * 1.5) {
    score += 1; reasons.push({ type: 'bull', text: 'حجم تداول مرتفع — تأكيد الحركة (Weis)' });
  }

  let verdict, cls, confidence;
  if (score >= 4) { verdict = '📈 شراء قوي'; cls = 'buy'; confidence = Math.min(90, 60 + score * 5); }
  else if (score >= 2) { verdict = '🟢 شراء'; cls = 'buy'; confidence = Math.min(80, 55 + score * 5); }
  else if (score <= -4) { verdict = '📉 بيع قوي'; cls = 'avoid'; confidence = Math.min(90, 60 + Math.abs(score) * 5); }
  else if (score <= -2) { verdict = '🔴 بيع'; cls = 'avoid'; confidence = Math.min(80, 55 + Math.abs(score) * 5); }
  else { verdict = '⚪ انتظار'; cls = 'wait'; confidence = 45; }

  const summary = cls === 'buy'
    ? `إشارة شراء بثقة ${confidence}% — بناءً على ${reasons.filter(r => r.type === 'bull').length} عوامل صاعدة`
    : cls === 'avoid'
    ? `إشارة بيع بثقة ${confidence}% — بناءً على ${reasons.filter(r => r.type === 'bear').length} عوامل هابطة`
    : 'السوق في حالة تذبذب — انتظر إشارة واضحة';

  return { verdict, class: cls, confidence, summary, reasons, score };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol = (req.query.symbol || 'NVDA').toUpperCase();
  const massiveSym = SYMBOL_MAP[symbol] || symbol;

  try {
    // جلب البيانات من Massive API
    const [quoteData, histData] = await Promise.all([
      fetchMassive(`quote?symbol=${massiveSym}`).catch(() => null),
      fetchMassive(`history?symbol=${massiveSym}&interval=1d&range=90d`).catch(() => null),
    ]);

    // إذا فشل Massive جرب Yahoo
    let price, open, high, low, volume, prevClose, fullName, exchange;
    let closes = [], highs = [], lows = [], volumes = [];

    if (quoteData && quoteData.price) {
      price     = quoteData.price;
      open      = quoteData.open || price;
      high      = quoteData.dayHigh || price;
      low       = quoteData.dayLow || price;
      volume    = quoteData.volume || 0;
      prevClose = quoteData.previousClose || price;
      fullName  = quoteData.longName || quoteData.shortName || symbol;
      exchange  = quoteData.exchange || 'NASDAQ';
    } else {
      // Fallback: Yahoo Finance عبر allorigins
      const YAHOO_MAP = {
        'US500':'ES=F','SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI',
        'BTC':'BTC-USD','ETH':'ETH-USD','XAUUSD':'GC=F',
        'EURUSD':'EURUSD=X','GBPUSD':'GBPUSD=X','USDJPY':'USDJPY=X',
      };
      const yahooSym = YAHOO_MAP[symbol] || symbol;
      const yUrl = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=90d`;
      const yRes = await fetch(yUrl);
      const yData = await yRes.json();
      const result = yData?.chart?.result?.[0];
      const meta = result?.meta;
      const quotes = result?.indicators?.quote?.[0];

      if (!meta) throw new Error('لا توجد بيانات للرمز: ' + symbol);

      price     = meta.regularMarketPrice;
      open      = meta.regularMarketOpen || price;
      high      = meta.regularMarketDayHigh || price;
      low       = meta.regularMarketDayLow || price;
      volume    = meta.regularMarketVolume || 0;
      prevClose = meta.chartPreviousClose || meta.previousClose || price;
      fullName  = meta.longName || meta.shortName || symbol;
      exchange  = meta.exchangeName || 'NASDAQ';

      closes  = (quotes?.close  || []).filter(Boolean);
      highs   = (quotes?.high   || []).filter(Boolean);
      lows    = (quotes?.low    || []).filter(Boolean);
      volumes = (quotes?.volume || []).filter(Boolean);
    }

    if (histData && histData.closes) {
      closes  = histData.closes;
      highs   = histData.highs  || [];
      lows    = histData.lows   || [];
      volumes = histData.volumes || [];
    }

    // أضف السعر الحالي
    closes.push(price);

    const change        = +(price - prevClose).toFixed(2);
    const changePercent = +((change / prevClose) * 100).toFixed(2);

    // المؤشرات الفنية
    const rsi14   = calcRSI(closes, 14);
    const ema20   = calcEMA(closes.slice(-30), 20);
    const ema50   = calcEMA(closes.slice(-60), 50);
    const macd    = calcMACD(closes);
    const atr     = calcATR(highs, lows, closes);

    const trend_daily = getTrend(closes, ema20, ema50);
    const trend_4h    = trend_daily;
    const trend_1h    = closes.length > 5
      ? (closes[closes.length-1] > closes[closes.length-6] ? 'bullish' : 'bearish')
      : trend_daily;

    // حجم متوسط
    const avgVolume = volumes.length
      ? volumes.slice(-20).reduce((a,b) => a+b, 0) / Math.min(20, volumes.length)
      : 0;

    const momentum = change > price * 0.015 ? 'strong_up'
      : change > 0 ? 'up'
      : change < -price * 0.015 ? 'strong_down'
      : 'down';

    // 60-day high/low
    const high60d = highs.length >= 60 ? +Math.max(...highs.slice(-60)).toFixed(2) : high;
    const low60d  = lows.length  >= 60 ? +Math.min(...lows.slice(-60)).toFixed(2)  : low;

    // Fibonacci
    const fib = calcFib(high60d, low60d);

    // Pivot Points
    const pivot = +((high + low + price) / 3).toFixed(2);
    const res1  = +(2 * pivot - low).toFixed(2);
    const res2  = +(pivot + (high - low)).toFixed(2);
    const sup1  = +(2 * pivot - high).toFixed(2);
    const sup2  = +(pivot - (high - low)).toFixed(2);

    // القرار
    const decision = makeDecision(rsi14, trend_daily, macd, price, ema20, volume, avgVolume);

    // Risk/Reward
    const riskReward = {
      entry:    +price.toFixed(2),
      stopLoss: +(price - atr * 1.2).toFixed(2),
      target1:  +(price + atr * 2.0).toFixed(2),
      target2:  +(price + atr * 3.5).toFixed(2),
      slPct:    +((atr * 1.2 / price) * 100).toFixed(2),
      t1Pct:    +((atr * 2.0 / price) * 100).toFixed(2),
      rr1:      +(2.0 / 1.2).toFixed(1),
      quality:  atr / price < 0.02 ? 'ممتاز' : atr / price < 0.04 ? 'جيد' : 'ضعيف',
    };

    // MTF Signal
    const tfSignals = [
      { tf: 'يومي',    trend: trend_daily, rsi: rsi14 },
      { tf: '4 ساعات', trend: trend_4h,    rsi: rsi14 },
      { tf: 'ساعة',    trend: trend_1h,    rsi: null  },
    ].map(tf => {
      const isC = tf.trend === 'bullish';
      const isP = tf.trend === 'bearish';
      return {
        tf: tf.tf,
        signal: isC ? 'CALL' : isP ? 'PUT' : 'WAIT',
        signalClass: isC ? 'bull' : isP ? 'bear' : 'neutral',
        rsi: tf.rsi,
        reasons: [
          tf.trend === 'bullish' ? 'اتجاه صاعد' : tf.trend === 'bearish' ? 'اتجاه هابط' : 'محايد',
          tf.rsi ? (tf.rsi > 70 ? 'RSI تشبع شراء' : tf.rsi < 30 ? 'RSI تشبع بيع' : `RSI ${tf.rsi}`) : '',
        ].filter(Boolean),
      };
    });

    const bullTFs = tfSignals.filter(t => t.signal === 'CALL').length;
    const bearTFs = tfSignals.filter(t => t.signal === 'PUT').length;
    const mtfFinal = bullTFs >= 2 ? 'CALL' : bearTFs >= 2 ? 'PUT' : 'WAIT';
    const mtfConf  = Math.round((Math.max(bullTFs, bearTFs) / 3) * 100);

    const mtfSignal = {
      finalSignal:    mtfFinal,
      finalClass:     mtfFinal === 'CALL' ? 'bull' : mtfFinal === 'PUT' ? 'bear' : 'neutral',
      confluence:     mtfFinal === 'CALL' ? 'صاعد' : mtfFinal === 'PUT' ? 'هابط' : 'محايد',
      confluenceClass:mtfFinal === 'CALL' ? 'bull' : mtfFinal === 'PUT' ? 'bear' : 'neutral',
      confidence:     mtfConf,
      avgScore:       decision.score,
      timeframes:     tfSignals,
    };

    // مناهج التحليل
    const methodologies = [
      {
        name: 'دو نظرية & ماكروهيكل (Murphy)',
        icon: 'M', source: 'JOHN MURPHY',
        score: trend_daily === 'bullish' ? 20 : trend_daily === 'bearish' ? -20 : 0,
        observation: `الاتجاه ${trend_daily === 'bullish' ? 'صاعد' : trend_daily === 'bearish' ? 'هابط' : 'محايد'} — EMA20: $${ema20} | EMA50: $${ema50}`,
        details: {
          'EMA 20': `$${ema20}`,
          'EMA 50': `$${ema50}`,
          'الاتجاه': trend_daily === 'bullish' ? '↑ صاعد' : trend_daily === 'bearish' ? '↓ هابط' : '— محايد',
          'السعر vs EMA': price > ema20 ? 'فوق EMA20 ✅' : 'تحت EMA20 ⚠️',
        },
      },
      {
        name: 'RSI & الزخم',
        icon: 'R', source: 'RELATIVE STRENGTH INDEX',
        score: rsi14 < 30 ? 25 : rsi14 > 70 ? -25 : rsi14 > 50 ? 10 : -10,
        observation: `RSI ${rsi14} — ${rsi14 < 30 ? 'منطقة ذروة البيع — فرصة شراء محتملة' : rsi14 > 70 ? 'منطقة ذروة الشراء — حذر من التصحيح' : rsi14 > 50 ? 'زخم صاعد — إيجابي' : 'زخم هابط — سلبي'}`,
        details: {
          'RSI(14)': rsi14,
          'الحالة': rsi14 < 30 ? 'تشبع بيع 🟢' : rsi14 > 70 ? 'تشبع شراء 🔴' : 'طبيعي',
          'الزخم': momentum === 'strong_up' ? 'قوي صاعد ↑↑' : momentum === 'up' ? 'صاعد ↑' : momentum === 'strong_down' ? 'قوي هابط ↓↓' : 'هابط ↓',
          'التغيير اليومي': `${change >= 0 ? '+' : ''}${changePercent}%`,
        },
      },
      {
        name: 'MACD & التقاطعات',
        icon: 'Wd', source: 'WYCKOFF / WEIS',
        score: macd.macd > 0 ? 15 : -15,
        observation: `MACD: ${macd.macd} — ${macd.macd > 0 ? 'إيجابي، زخم صاعد' : 'سلبي، ضغط بيعي'}`,
        details: {
          'MACD': macd.macd,
          'الإشارة': macd.macd > 0 ? 'فوق الصفر ✅' : 'تحت الصفر ⚠️',
          'ATR(14)': `$${atr}`,
          'الحجم': volume > avgVolume * 1.5 ? 'مرتفع 🔥' : volume > avgVolume ? 'طبيعي' : 'منخفض',
        },
      },
      {
        name: 'فيبوناتشي & المستويات',
        icon: 'F', source: 'FIBONACCI / ICT',
        score: price > fib['618'] && price < fib['382'] ? 15 : price < fib['618'] ? -10 : 10,
        observation: `Fib 0.618: $${fib['618']} | Fib 0.382: $${fib['382']} | Pivot: $${pivot}`,
        details: {
          'Fib 0.236': `$${fib['236']}`,
          'Fib 0.382': `$${fib['382']}`,
          'Fib 0.500': `$${fib['500']}`,
          'Fib 0.618': `$${fib['618']}`,
          'Pivot':     `$${pivot}`,
        },
      },
      {
        name: 'Price Action & ICT',
        icon: 'PA', source: 'RAYNER TEO / ICT/SMC',
        score: price > pivot ? 10 : -10,
        observation: price > pivot
          ? `السعر فوق Pivot ($${pivot}) — منطقة Premium مؤاتية للشراء`
          : `السعر تحت Pivot ($${pivot}) — منطقة Discount مؤاتية للبيع`,
        details: {
          'Pivot':      `$${pivot}`,
          'مقاومة 1':   `$${res1}`,
          'مقاومة 2':   `$${res2}`,
          'دعم 1':      `$${sup1}`,
          'دعم 2':      `$${sup2}`,
          'الموقع':     price > pivot ? 'Premium Zone' : 'Discount Zone',
        },
      },
    ];

    const riskScore = rsi14 > 70 ? 75 : rsi14 < 30 ? 25 : 50;
    const riskLabel = riskScore > 60 ? 'مخاطرة عالية' : riskScore < 40 ? 'مخاطرة منخفضة' : 'مخاطرة متوسطة';

    return res.status(200).json({
      symbol,
      fullName,
      exchange,
      currency: 'USD',
      price,
      open,
      high,
      low,
      volume: volume >= 1e9 ? (volume/1e9).toFixed(1)+'B' : volume >= 1e6 ? (volume/1e6).toFixed(1)+'M' : volume >= 1e3 ? (volume/1e3).toFixed(0)+'K' : String(volume),
      change,
      changePercent,
      high60d,
      low60d,
      fib,
      levels: { pivot, res1, res2, sup1, sup2 },
      indicators: { rsi14, ema20, ema50, trend_daily, trend_4h, trend_1h, momentum },
      decision,
      methodologies,
      risk: { score: riskScore, label: riskLabel },
      mtfSignal,
      riskReward,
    });

  } catch (err) {
    return res.status(500).json({ error: true, message: err.message || 'خطأ في التحليل' });
  }
};
