const https = require('https');

const MASSIVE_KEY = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const BASE = 'api.massive.com';

// خريطة الرموز لـ Massive API
// أسهم: AAPL, MSFT...
// مؤشرات: I:SPX, I:NDX, I:DJI
// كريبتو: X:BTCUSD, X:ETHUSD
// ذهب/فيوتشرز: نستخدم snapshot
const SYMBOLS = {
  US500: { ticker: 'SPY',       name: 'S&P 500',      type: 'stock'  }, // SPY كبديل لـ ES=F
  NDX:   { ticker: 'QQQ',       name: 'Nasdaq 100',   type: 'stock'  }, // QQQ كبديل
  GOLD:  { ticker: 'GLD',       name: 'Gold ETF',     type: 'stock'  }, // GLD كبديل للذهب
  BTC:   { ticker: 'X:BTCUSD',  name: 'Bitcoin',      type: 'crypto' },
  ETH:   { ticker: 'X:ETHUSD',  name: 'Ethereum',     type: 'crypto' },
  VIX:   { ticker: 'I:VIX',     name: 'VIX',          type: 'index'  },
  DXY:   { ticker: 'C:DXYUSD',  name: 'DXY',          type: 'forex'  },
};

function fetchMassive(path) {
  return new Promise((resolve, reject) => {
    const url = `https://${BASE}${path}${path.includes('?') ? '&' : '?'}apiKey=${MASSIVE_KEY}`;
    https.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('Parse error: ' + d.substring(0, 100))); }
      });
    }).on('error', reject);
  });
}

async function getSnapshot(ticker, type) {
  try {
    let path;
    if (type === 'crypto') {
      path = `/v2/snapshot/locale/global/markets/crypto/tickers/${ticker}`;
    } else if (type === 'forex') {
      path = `/v2/snapshot/locale/global/markets/forex/tickers/${ticker}`;
    } else if (type === 'index') {
      path = `/v3/snapshot?ticker.any_of=${ticker}`;
    } else {
      // stocks
      path = `/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`;
    }
    
    const data = await fetchMassive(path);
    
    // استخرج السعر والتغيير
    let price, change, prevClose;
    
    const result = data?.ticker || data?.results?.[0] || data?.tickers?.[0];
    if (!result) return null;
    
    const day = result.day || result.lastQuote || {};
    const prevDay = result.prevDay || {};
    
    price = result.lastTrade?.p || result.lastQuote?.P || day.c || day.vw || result.value;
    prevClose = prevDay.c || result.prevDayClose;
    
    if (price && prevClose) {
      change = ((price - prevClose) / prevClose) * 100;
    } else {
      change = result.todaysChangePerc || day.dp || 0;
      if (!price) price = result.lastPrice || 0;
    }
    
    return { price: +price, change: +change.toFixed(2) };
  } catch(e) {
    return null;
  }
}

// Fallback: نجلب من Yahoo إذا فشل Massive
function fetchYahooFallback(sym, interval, range) {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function getYahooPrice(sym) {
  try {
    const json = await fetchYahooFallback(sym, '1m', '1d');
    const r = json?.chart?.result?.[0];
    if (!r) return null;
    const price = r.meta.regularMarketPrice;
    const prev = r.meta.chartPreviousClose;
    const change = prev ? ((price - prev) / prev) * 100 : 0;
    return { price: +price, change: +change.toFixed(2) };
  } catch(e) { return null; }
}

// Yahoo symbols للـ fallback
const YAHOO_FALLBACK = {
  US500: 'ES=F',
  NDX:   '^NDX',
  GOLD:  'GC=F',
  BTC:   'BTC-USD',
  ETH:   'ETH-USD',
  VIX:   '^VIX',
  DXY:   'DX-Y.NYB',
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const markets = {};
  const errors = [];

  await Promise.all(Object.entries(SYMBOLS).map(async ([id, cfg]) => {
    try {
      // حاول Massive أولاً
      let result = await getSnapshot(cfg.ticker, cfg.type);
      
      // إذا فشل → Yahoo Fallback
      if (!result || !result.price) {
        const yahoSym = YAHOO_FALLBACK[id];
        if (yahoSym) result = await getYahooPrice(yahoSym);
      }
      
      if (result && result.price) {
        markets[id] = { price: result.price, change: result.change };
      } else {
        errors.push(id + ': no data');
      }
    } catch(e) {
      errors.push(id + ': ' + e.message);
      // Yahoo fallback
      try {
        const yahoSym = YAHOO_FALLBACK[id];
        if (yahoSym) {
          const fb = await getYahooPrice(yahoSym);
          if (fb) markets[id] = { price: fb.price, change: fb.change };
        }
      } catch(e2) {}
    }
  }));

  return res.status(200).json({
    ok: true,
    markets,
    source: 'massive+yahoo-fallback',
    errors: errors.length ? errors : undefined,
    ts: Date.now()
  });
};
