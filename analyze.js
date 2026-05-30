// Vercel Serverless Function — Trading Intelligence Hub Backend
// Fetches Yahoo Finance data + applies multi-methodology analysis

// Allow only GET requests, enable CORS for the frontend
const ALLOWED_ORIGINS = '*';

// Yahoo Finance symbol mapping
const YAHOO_MAP = {
  'SPX': '^GSPC', 'NDX': '^NDX', 'DJI': '^DJI', 'RUT': '^RUT',
  'VIX': '^VIX', 'DXY': 'DX-Y.NYB',
  'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X', 'USDJPY': 'JPY=X',
  'AUDUSD': 'AUDUSD=X', 'USDCAD': 'CAD=X', 'XAUUSD': 'GC=F',
  'BTC': 'BTC-USD', 'ETH': 'ETH-USD', 'SOL': 'SOL-USD',
  'BNB': 'BNB-USD', 'XRP': 'XRP-USD', 'ADA': 'ADA-USD'
};

// ============ TECHNICAL CALCULATIONS ============
function calcSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i-1];
    if (diff > 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i-1]),
      Math.abs(lows[i] - closes[i-1])
    );
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ============ ANALYSIS METHODOLOGIES ============
function analyzeMurphy(data) {
  const closes = data.closes;
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const price = closes[closes.length - 1];

  let score = 0, trend = 'محايد', observation = '';

  if (sma20 && sma50 && sma200) {
    if (sma20 > sma50 && sma50 > sma200 && price > sma20) {
      score = 80; trend = 'صعود قوي';
      observation = 'كل المتوسطات مرتّبة صعودياً (20 > 50 > 200) والسعر فوقها';
    } else if (sma20 > sma50 && price > sma20) {
      score = 60; trend = 'صعود متوسط';
      observation = 'MA 20 > MA 50 — اتجاه قصير المدى صاعد';
    } else if (sma20 < sma50 && sma50 < sma200 && price < sma20) {
      score = -80; trend = 'هبوط قوي';
      observation = 'كل المتوسطات مرتّبة هبوطياً والسعر تحتها';
    } else if (sma20 < sma50 && price < sma20) {
      score = -60; trend = 'هبوط متوسط';
      observation = 'MA 20 < MA 50 — اتجاه قصير المدى هابط';
    } else {
      score = 0;
      observation = 'المتوسطات متشابكة — السوق في حالة عدم وضوح';
    }
  }

  return {
    name: 'Murphy التقليدي',
    source: 'Technical Analysis of Financial Markets',
    icon: 'JM',
    score, observation,
    details: {
      'الاتجاه': trend,
      'MA 20': sma20 ? sma20.toFixed(2) : '—',
      'MA 50': sma50 ? sma50.toFixed(2) : '—',
      'MA 200': sma200 ? sma200.toFixed(2) : '—'
    }
  };
}

function analyzeWyckoff(data) {
  const closes = data.closes;
  const volumes = data.volumes;

  if (closes.length < 50) {
    return { name: 'Wyckoff / Weis', source: 'Modern Wyckoff', icon: 'WY',
      score: 0, observation: 'بيانات غير كافية', details: {} };
  }

  const recent60 = closes.slice(-60);
  const high60 = Math.max(...recent60);
  const low60 = Math.min(...recent60);
  const price = closes[closes.length - 1];
  const range = high60 - low60;
  const positionInRange = ((price - low60) / range) * 100;

  const avgVol = volumes.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const recentVol = volumes[volumes.length - 1];
  const volRatio = recentVol / avgVol;
  const recent10Vol = volumes.slice(-10).reduce((a,b)=>a+b,0) / 10;
  const prev10Vol = volumes.slice(-20, -10).reduce((a,b)=>a+b,0) / 10;
  const volTrend = recent10Vol / prev10Vol;

  let phase = '', score = 0, observation = '';

  if (positionInRange < 25 && volRatio > 1.5) {
    phase = 'Selling Climax محتمل'; score = 60;
    observation = 'سعر منخفض + حجم متفجّر = ذروة بيع قد تشير لقاع';
  } else if (positionInRange < 35 && volTrend < 0.9) {
    phase = 'Accumulation (تجميع)'; score = 40;
    observation = 'سعر بالقرب من القاع + حجم منخفض = تجميع هادئ';
  } else if (positionInRange > 35 && positionInRange < 75 && volTrend > 1.1) {
    phase = 'Markup (ارتفاع)'; score = 50;
    observation = 'صعود مع زيادة الحجم = مرحلة ارتفاع صحية';
  } else if (positionInRange > 75 && volRatio > 1.5) {
    phase = 'Buying Climax محتمل'; score = -60;
    observation = 'سعر مرتفع + حجم متفجّر = ذروة شراء قد تشير لقمة';
  } else if (positionInRange > 65 && volTrend < 0.9) {
    phase = 'Distribution (توزيع)'; score = -40;
    observation = 'سعر بالقرب من القمة + حجم متناقص = توزيع مؤسسي';
  } else {
    phase = 'مرحلة انتقالية'; score = 0;
    observation = 'لا توجد إشارة Wyckoff واضحة';
  }

  return {
    name: 'Wyckoff / Weis',
    source: 'David Weis · Modern Wyckoff',
    icon: 'WY',
    score, observation,
    details: {
      'المرحلة': phase,
      'الموقع في المدى': positionInRange.toFixed(1) + '%',
      'نسبة الحجم': volRatio.toFixed(2) + 'x',
      'اتجاه الحجم': volTrend > 1.05 ? '↑ متزايد' : volTrend < 0.95 ? '↓ متناقص' : '→ ثابت'
    }
  };
}

function analyzeSMC(data) {
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;

  if (closes.length < 30) {
    return { name: 'SMC / ICT', source: 'Smart Money Concepts', icon: 'SM',
      score: 0, observation: 'بيانات غير كافية', details: {} };
  }

  // Find swing points
  const swings = { highs: [], lows: [] };
  const lookback = 3;
  for (let i = lookback; i < highs.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= lookback; k++) {
      if (highs[i] <= highs[i-k] || highs[i] <= highs[i+k]) isHigh = false;
      if (lows[i] >= lows[i-k] || lows[i] >= lows[i+k]) isLow = false;
    }
    if (isHigh) swings.highs.push({ idx: i, value: highs[i] });
    if (isLow) swings.lows.push({ idx: i, value: lows[i] });
  }

  const lastHigh = swings.highs[swings.highs.length - 1];
  const prevHigh = swings.highs[swings.highs.length - 2];
  const lastLow = swings.lows[swings.lows.length - 1];
  const prevLow = swings.lows[swings.lows.length - 2];

  let score = 0, structure = 'غير واضح', observation = '';

  if (lastHigh && prevHigh && lastLow && prevLow) {
    if (lastHigh.value > prevHigh.value && lastLow.value > prevLow.value) {
      structure = 'هيكل صاعد (HH/HL)'; score = 60;
      observation = 'قمم وقيعان أعلى = هيكل صعودي سليم';
    } else if (lastHigh.value < prevHigh.value && lastLow.value < prevLow.value) {
      structure = 'هيكل هابط (LH/LL)'; score = -60;
      observation = 'قمم وقيعان أدنى = هيكل هبوطي';
    } else if (lastHigh.value > prevHigh.value && lastLow.value < prevLow.value) {
      structure = 'كسر هيكل (BOS)'; score = 30;
      observation = 'قمة أعلى مع قاع أدنى = توسّع التذبذب';
    } else {
      structure = 'انعكاس محتمل';
      observation = 'إشارات مختلطة في الهيكل';
    }
  }

  let fvgCount = 0;
  for (let i = 2; i < highs.length; i++) {
    if (lows[i] > highs[i-2]) fvgCount++;
    else if (highs[i] < lows[i-2]) fvgCount++;
  }

  const price = closes[closes.length - 1];
  const recent20High = Math.max(...highs.slice(-20));
  const recent20Low = Math.min(...lows.slice(-20));
  let liquidityNote = 'لا يوجد';
  if (price > recent20High * 0.998) liquidityNote = 'قرب سيولة علوية';
  else if (price < recent20Low * 1.002) liquidityNote = 'قرب سيولة سفلية';

  return {
    name: 'SMC / ICT',
    source: 'Smart Money Concepts',
    icon: 'SM',
    score, observation,
    details: {
      'الهيكل': structure,
      'FVGs (الفترة)': fvgCount + ' فجوة',
      'السيولة': liquidityNote,
      'آخر قمة': lastHigh ? lastHigh.value.toFixed(2) : '—',
      'آخر قاع': lastLow ? lastLow.value.toFixed(2) : '—'
    }
  };
}

function analyzeCandles(data) {
  const opens = data.opens;
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;

  if (closes.length < 3) {
    return { name: 'الشموع اليابانية', source: 'Al-Qasim', icon: '蝋',
      score: 0, observation: 'بيانات غير كافية', details: {} };
  }

  const last = closes.length - 1;
  const body = Math.abs(closes[last] - opens[last]);
  const range = highs[last] - lows[last];
  const bodyRatio = range > 0 ? body / range : 0;
  const upperWick = highs[last] - Math.max(opens[last], closes[last]);
  const lowerWick = Math.min(opens[last], closes[last]) - lows[last];

  let pattern = 'شمعة عادية', score = 0, observation = '';

  if (bodyRatio < 0.15 && upperWick > body * 2 && lowerWick > body * 2) {
    pattern = 'دوجي طويل الساق';
    observation = 'عدم يقين شديد — انتظر التأكيد';
  } else if (lowerWick > body * 2 && upperWick < body * 0.5 && closes[last] > opens[last]) {
    pattern = 'مطرقة (Hammer)'; score = 50;
    observation = 'انعكاس صعودي محتمل (في قاع)';
  } else if (upperWick > body * 2 && lowerWick < body * 0.5 && closes[last] < opens[last]) {
    pattern = 'نجم شهاب (Shooting Star)'; score = -50;
    observation = 'انعكاس هبوطي محتمل (في قمة)';
  } else if (bodyRatio > 0.85 && closes[last] > opens[last]) {
    pattern = 'ماروبوزو صعودي'; score = 40;
    observation = 'قوة شرائية مهيمنة';
  } else if (bodyRatio > 0.85 && closes[last] < opens[last]) {
    pattern = 'ماروبوزو هبوطي'; score = -40;
    observation = 'قوة بيعية مهيمنة';
  } else if (closes[last] > opens[last] && closes[last-1] < opens[last-1] && 
             closes[last] > opens[last-1] && opens[last] < closes[last-1]) {
    pattern = 'ابتلاع صعودي'; score = 60;
    observation = 'انعكاس صعودي قوي';
  } else if (closes[last] < opens[last] && closes[last-1] > opens[last-1] && 
             closes[last] < opens[last-1] && opens[last] > closes[last-1]) {
    pattern = 'ابتلاع هبوطي'; score = -60;
    observation = 'انعكاس هبوطي قوي';
  } else {
    observation = 'لا توجد شمعة انعكاسية واضحة';
  }

  return {
    name: 'الشموع اليابانية',
    source: 'Al-Qasim · من الألف إلى الياء',
    icon: '蝋',
    score, observation,
    details: {
      'النمط': pattern,
      'نسبة الجسم': (bodyRatio * 100).toFixed(0) + '%',
      'الفتيل العلوي': upperWick.toFixed(2),
      'الفتيل السفلي': lowerWick.toFixed(2)
    }
  };
}

function analyzePriceAction(data) {
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;
  const ma50 = calcSMA(closes, 50);
  const price = closes[closes.length - 1];
  const atr = calcATR(highs, lows, closes, 14);

  if (!ma50 || !atr) {
    return { name: 'Price Action', source: 'Rayner Teo · MAEE', icon: 'PA',
      score: 0, observation: 'بيانات غير كافية', details: {} };
  }

  const distanceFromMA = ((price - ma50) / ma50) * 100;
  const isPullback = Math.abs(distanceFromMA) < 5 && Math.abs(price - ma50) < atr;
  const last10 = closes.slice(-10);
  const range10 = Math.max(...last10) - Math.min(...last10);
  const totalMove = Math.abs(last10[last10.length-1] - last10[0]);
  const efficiency = range10 > 0 ? totalMove / range10 : 0;

  let score = 0, phase = '', observation = '';

  if (price > ma50 && isPullback) {
    phase = 'Pullback في اتجاه صاعد'; score = 50;
    observation = 'فرصة دخول كلاسيكية (MAEE)';
  } else if (price < ma50 && isPullback) {
    phase = 'Pullback في اتجاه هابط'; score = -50;
    observation = 'فرصة دخول شورت كلاسيكية';
  } else if (efficiency > 0.7 && price > ma50) {
    phase = 'Impulse صاعد قوي'; score = 40;
    observation = 'اندفاع شرائي — انتظر pullback للدخول';
  } else if (efficiency > 0.7 && price < ma50) {
    phase = 'Impulse هابط قوي'; score = -40;
    observation = 'اندفاع بيعي — انتظر pullback للشورت';
  } else {
    phase = 'تذبذب جانبي';
    observation = 'لا توجد فرصة MAEE واضحة';
  }

  return {
    name: 'Price Action',
    source: 'Rayner Teo · MAEE',
    icon: 'PA',
    score, observation,
    details: {
      'المرحلة': phase,
      'البعد عن MA50': distanceFromMA.toFixed(2) + '%',
      'كفاءة الحركة': (efficiency * 100).toFixed(0) + '%',
      'ATR(14)': atr.toFixed(2)
    }
  };
}

function analyzeBehavioral(data) {
  const closes = data.closes;

  if (closes.length < 60) {
    return { name: 'علم النفس السوقي', source: 'Kahneman + Soros', icon: 'ψ',
      score: 0, observation: 'بيانات غير كافية', details: {} };
  }

  const rsi = calcRSI(closes, 14);
  const price = closes[closes.length - 1];
  const high60 = Math.max(...closes.slice(-60));
  const low60 = Math.min(...closes.slice(-60));
  const distFromHigh = ((high60 - price) / high60) * 100;
  const distFromLow = ((price - low60) / low60) * 100;
  const recent5 = closes.slice(-5);
  const velocity = ((recent5[4] - recent5[0]) / recent5[0]) * 100;

  let sentiment = '', score = 0, observation = '', fomoLevel = 'منخفض';

  if (rsi > 75 && distFromHigh < 3 && velocity > 10) {
    sentiment = 'FOMO شديد'; fomoLevel = 'عالٍ جداً'; score = -70;
    observation = 'الجميع يشتري بهلع — تاريخياً علامة قمة';
  } else if (rsi > 70 && velocity > 5) {
    sentiment = 'حماس متزايد'; fomoLevel = 'متوسط'; score = -30;
    observation = 'حذر — قد يكون السوق متطرفاً';
  } else if (rsi < 25 && distFromLow < 3 && velocity < -10) {
    sentiment = 'ذعر بيعي'; fomoLevel = 'منخفض (Fear)'; score = 70;
    observation = 'الجميع يبيع — تاريخياً علامة قاع';
  } else if (rsi < 30 && velocity < -5) {
    sentiment = 'تشاؤم'; score = 30;
    observation = 'مزاج سلبي — فرصة محتملة';
  } else {
    sentiment = 'متوازن';
    observation = 'مزاج السوق طبيعي — لا تطرف';
  }

  return {
    name: 'علم النفس السوقي',
    source: 'Kahneman + Reflexivity (Soros)',
    icon: 'ψ',
    score, observation,
    details: {
      'المزاج': sentiment,
      'مستوى FOMO': fomoLevel,
      'RSI(14)': rsi ? rsi.toFixed(1) : '—',
      'السرعة (5 شموع)': velocity.toFixed(2) + '%'
    }
  };
}

function analyzeVolumeProfile(data) {
  const closes = data.closes;
  const volumes = data.volumes;

  if (closes.length < 30) {
    return { name: 'Volume Profile', source: 'Steidlmayer', icon: 'VP',
      score: 0, observation: 'بيانات غير كافية', details: {} };
  }

  const period = Math.min(30, closes.length);
  const slice = closes.slice(-period);
  const volSlice = volumes.slice(-period);
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const bins = 10;
  const binSize = (max - min) / bins;
  const profile = new Array(bins).fill(0);
  
  for (let i = 0; i < slice.length; i++) {
    const bin = Math.min(Math.floor((slice[i] - min) / binSize), bins - 1);
    profile[bin] += volSlice[i] || 1;
  }

  const maxBin = profile.indexOf(Math.max(...profile));
  const poc = min + (maxBin + 0.5) * binSize;
  const price = closes[closes.length - 1];

  let score = 0, observation = '', zone = '';

  if (price > poc * 1.02) {
    zone = 'فوق POC (Premium)'; score = -20;
    observation = 'السعر فوق نقطة التحكم — احتمال العودة إليها';
  } else if (price < poc * 0.98) {
    zone = 'تحت POC (Discount)'; score = 20;
    observation = 'السعر تحت نقطة التحكم — احتمال الصعود إليها';
  } else {
    zone = 'عند POC';
    observation = 'السعر يتقلب حول نقطة التحكم';
  }

  return {
    name: 'Volume Profile',
    source: 'Steidlmayer · Auction Theory',
    icon: 'VP',
    score, observation,
    details: {
      'المنطقة': zone,
      'POC': poc.toFixed(2),
      'نطاق المدى': (max - min).toFixed(2),
      'البعد عن POC': (((price - poc) / poc) * 100).toFixed(2) + '%'
    }
  };
}

function calculateRisk(data) {
  const closes = data.closes;
  const highs = data.highs;
  const lows = data.lows;
  let riskFactors = 0;

  const high60 = Math.max(...closes.slice(-60));
  const price = closes[closes.length - 1];
  const distFromHigh = ((high60 - price) / high60) * 100;
  if (distFromHigh < 3) riskFactors += 20;
  else if (distFromHigh < 8) riskFactors += 10;

  const rsi = calcRSI(closes, 14);
  if (rsi) {
    if (rsi > 75 || rsi < 25) riskFactors += 20;
    else if (rsi > 70 || rsi < 30) riskFactors += 10;
  }

  const recent5 = closes.slice(-5);
  const velocity = Math.abs((recent5[4] - recent5[0]) / recent5[0]) * 100;
  if (velocity > 10) riskFactors += 20;
  else if (velocity > 5) riskFactors += 10;

  const atr = calcATR(highs, lows, closes, 14);
  if (atr && price) {
    const atrPercent = (atr / price) * 100;
    if (atrPercent > 4) riskFactors += 20;
    else if (atrPercent > 2.5) riskFactors += 10;
  }

  const sma50 = calcSMA(closes, 50);
  if (sma50) {
    const dist = Math.abs((price - sma50) / sma50) * 100;
    if (dist > 15) riskFactors += 20;
    else if (dist > 8) riskFactors += 10;
  }

  let label;
  if (riskFactors < 30) label = 'مخاطرة منخفضة — وضع مريح';
  else if (riskFactors < 60) label = 'مخاطرة متوسطة — حذر مطلوب';
  else label = 'مخاطرة عالية — تجنّب أو قلّل الحجم';

  return { score: riskFactors, label };
}

function generateDecision(methodologies) {
  const weights = {
    'Murphy التقليدي': 1.0,
    'Wyckoff / Weis': 1.4,
    'SMC / ICT': 1.3,
    'الشموع اليابانية': 0.8,
    'Price Action': 1.0,
    'علم النفس السوقي': 1.2,
    'Volume Profile': 1.0
  };

  let totalScore = 0, totalWeight = 0;
  methodologies.forEach(m => {
    const w = weights[m.name] || 1.0;
    totalScore += m.score * w;
    totalWeight += w;
  });
  const finalScore = totalScore / totalWeight;
  const confidence = Math.min(100, Math.abs(finalScore) * 1.5);

  let verdict, summary, summaryClass;
  const reasons = [];

  methodologies.forEach(m => {
    if (Math.abs(m.score) >= 30) {
      reasons.push({
        type: m.score > 0 ? 'bull' : 'bear',
        text: `${m.name}: ${m.observation}`
      });
    }
  });
  if (reasons.length === 0) {
    reasons.push({ type: 'neutral', text: 'إشارات مختلطة من جميع المناهج' });
  }

  if (finalScore > 30) {
    verdict = 'شراء'; summaryClass = 'buy';
    summary = 'الإجماع بين المناهج يميل للصعود. الفرصة موجودة لكن طبّق إدارة مخاطرة صارمة.';
  } else if (finalScore > 15) {
    verdict = 'شراء حذر'; summaryClass = 'buy';
    summary = 'إشارات صعودية معتدلة. احتمالية النجاح أعلى من الفشل، لكن ليست قوية جداً.';
  } else if (finalScore < -30) {
    verdict = 'تجنّب'; summaryClass = 'avoid';
    summary = 'الإشارات السلبية تتفوق. لا تشتري الآن — انتظر تحسّن البنية.';
  } else if (finalScore < -15) {
    verdict = 'حذر'; summaryClass = 'avoid';
    summary = 'مخاطر متزايدة — قلّل التعرّض أو انتظر إشارة أوضح.';
  } else {
    verdict = 'انتظار'; summaryClass = 'wait';
    summary = 'السوق غير حاسم. لا تدخل صفقات حتى تظهر إشارة واضحة.';
  }

  return { verdict, summary, class: summaryClass, confidence, reasons };
}

// ============ FETCH FROM YAHOO ============
async function fetchYahoo(symbol) {
  const yahooSymbol = YAHOO_MAP[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1y`;
  
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TIH/1.0)' }
  });
  if (!response.ok) throw new Error(`Yahoo error: ${response.status}`);
  
  const json = await response.json();
  if (!json.chart || !json.chart.result || !json.chart.result[0]) {
    throw new Error('Invalid Yahoo response');
  }
  
  const result = json.chart.result[0];
  const quote = result.indicators.quote[0];
  const meta = result.meta;
  const validIdx = quote.close.map((v, i) => v !== null ? i : -1).filter(i => i >= 0);
  
  return {
    symbol: meta.symbol,
    fullName: meta.longName || meta.shortName || meta.symbol,
    exchange: meta.exchangeName || '—',
    currency: meta.currency || 'USD',
    price: meta.regularMarketPrice,
    previousClose: meta.previousClose || meta.chartPreviousClose,
    opens: validIdx.map(i => quote.open[i]),
    highs: validIdx.map(i => quote.high[i]),
    lows: validIdx.map(i => quote.low[i]),
    closes: validIdx.map(i => quote.close[i]),
    volumes: validIdx.map(i => quote.volume[i] || 0)
  };
}

// ============ FIBONACCI LEVELS ============
function calcFib(data) {
  const high60 = Math.max(...data.highs.slice(-60));
  const low60 = Math.min(...data.lows.slice(-60));
  const range = high60 - low60;
  return {
    high60d: high60,
    low60d: low60,
    fib: {
      '236': high60 - range * 0.236,
      '382': high60 - range * 0.382,
      '500': high60 - range * 0.500,
      '618': high60 - range * 0.618
    }
  };
}

// ============ INDICATORS ============
function calcIndicators(data) {
  const closes = data.closes;
  const rsi14 = calcRSI(closes, 14);
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const price = closes[closes.length - 1];

  let trend_daily = 'neutral';
  if (sma20 && sma50) {
    if (price > sma20 && sma20 > sma50) trend_daily = 'bullish';
    else if (price < sma20 && sma20 < sma50) trend_daily = 'bearish';
  }

  // Approximations for shorter timeframes (based on recent action)
  const recent5 = closes.slice(-5);
  const recent20 = closes.slice(-20);
  const sma5 = calcSMA(recent5, 5);
  const sma20Short = calcSMA(recent20, 20);
  
  let trend_4h = trend_daily, trend_1h = trend_daily;
  if (recent5.length === 5 && sma20Short) {
    if (recent5[4] > sma20Short && recent5[4] > recent5[0]) trend_4h = 'bullish';
    else if (recent5[4] < sma20Short && recent5[4] < recent5[0]) trend_4h = 'bearish';
    else trend_4h = 'neutral';
  }

  let momentum = 'neutral';
  if (sma20) {
    const dist = ((price - sma20) / sma20) * 100;
    if (dist > 5) momentum = 'strong_up';
    else if (dist > 1) momentum = 'up';
    else if (dist < -5) momentum = 'strong_down';
    else if (dist < -1) momentum = 'down';
  }

  return {
    rsi14,
    trend_daily,
    trend_4h,
    trend_1h,
    momentum,
    ma20_status: sma20 && price > sma20 ? 'above' : 'below',
    ma50_status: sma50 && price > sma50 ? 'above' : 'below',
    ma200_status: sma200 && price > sma200 ? 'above' : 'below'
  };
}

// ============ MAIN HANDLER ============
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { symbol } = req.query;
  
  if (!symbol) {
    return res.status(400).json({ error: 'symbol parameter required' });
  }

  try {
    const raw = await fetchYahoo(symbol.toUpperCase());

    // Calculate everything
    const indicators = calcIndicators(raw);
    const fibData = calcFib(raw);
    
    const methodologies = [
      analyzeMurphy(raw),
      analyzeWyckoff(raw),
      analyzeSMC(raw),
      analyzeCandles(raw),
      analyzePriceAction(raw),
      analyzeVolumeProfile(raw),
      analyzeBehavioral(raw)
    ];

    const decision = generateDecision(methodologies);
    const risk = calculateRisk(raw);

    // Build response
    const last = raw.closes.length - 1;
    const price = raw.price || raw.closes[last];
    const prev = raw.previousClose || raw.closes[last - 1];
    const change = price - prev;
    const changePercent = (change / prev) * 100;

    const volume = raw.volumes[last];
    let volumeStr = '—';
    if (volume) {
      if (volume >= 1e9) volumeStr = (volume / 1e9).toFixed(2) + 'B';
      else if (volume >= 1e6) volumeStr = (volume / 1e6).toFixed(2) + 'M';
      else if (volume >= 1e3) volumeStr = (volume / 1e3).toFixed(2) + 'K';
      else volumeStr = volume.toFixed(0);
    }

    const response = {
      symbol: raw.symbol,
      fullName: raw.fullName,
      exchange: raw.exchange,
      currency: raw.currency,
      price,
      change,
      changePercent,
      open: raw.opens[last],
      high: raw.highs[last],
      low: raw.lows[last],
      volume: volumeStr,
      ...fibData,
      indicators,
      methodologies,
      decision,
      risk,
      intermarket: null  // Phase 2
    };

    // Cache for 60 seconds
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(response);

  } catch (e) {
    console.error('Analyze error:', e);
    return res.status(500).json({ error: 'Analysis failed', message: e.message });
  }
}
