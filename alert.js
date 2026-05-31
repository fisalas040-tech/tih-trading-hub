const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function analyzeSymbol(symbol) {
  const YAHOO_MAP = {
    'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','VIX':'^VIX','DXY':'DX-Y.NYB',
    'BTC':'BTC-USD','ETH':'ETH-USD','XAUUSD':'GC=F'
  };
  const yfSym = YAHOO_MAP[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1d&range=3mo`;
  const json = await fetchJSON(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta;
  const q = result.indicators.quote[0];
  const vi = q.close.map((v,i) => v!==null?i:-1).filter(i=>i>=0);
  const closes  = vi.map(i => q.close[i]);
  const highs   = vi.map(i => q.high[i]);
  const lows    = vi.map(i => q.low[i]);

  const price     = meta.regularMarketPrice || closes[closes.length-1];
  const prevClose = closes.length >= 2 ? closes[closes.length-2] : price;
  const change    = price - prevClose;
  const changePct = ((change / prevClose) * 100).toFixed(2);

  // RSI
  function calcRSI(p, n=14) {
    if(p.length<n+1) return null;
    let g=0,l=0;
    for(let i=1;i<=n;i++){const d=p[i]-p[i-1];if(d>0)g+=d;else l-=d;}
    let ag=g/n,al=l/n;
    for(let i=n+1;i<p.length;i++){const d=p[i]-p[i-1];if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}}
    if(al===0)return 100; return 100-(100/(1+ag/al));
  }
  function calcSMA(p, n) { if(p.length<n)return null; return p.slice(-n).reduce((a,b)=>a+b,0)/n; }

  const rsi   = calcRSI(closes);
  const sma20 = calcSMA(closes, 20);
  const sma50 = calcSMA(closes, 50);

  // Pivot
  const H = highs[highs.length-1], L = lows[lows.length-1];
  const pivot = ((H + L + prevClose) / 3);
  const res1  = (2*pivot - L).toFixed(2);
  const sup1  = (2*pivot - H).toFixed(2);

  // Signal score
  let score = 0;
  if(price > pivot) score+=2; else score-=2;
  if(parseFloat(changePct) > 1) score+=2; else if(parseFloat(changePct) > 0) score+=1; else if(parseFloat(changePct) < -1) score-=2; else score-=1;
  if(sma20 && sma50 && price > sma20 && sma20 > sma50) score+=2; else if(sma20 && price < sma20) score-=2;
  if(rsi && rsi > 70) score-=1; else if(rsi && rsi < 30) score+=1; else if(rsi && rsi > 55) score+=1;

  const signal = score >= 4 ? 'CALL' : score <= -4 ? 'PUT' : null;

  return {
    symbol, price: price.toFixed(2), changePct,
    rsi: rsi ? rsi.toFixed(1) : '—',
    sma20: sma20 ? sma20.toFixed(2) : '—',
    pivot: pivot.toFixed(2), res1, sup1,
    signal, score,
    currency: meta.currency || 'USD'
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  // Test: إرسال رسالة تجريبية
  if (action === 'test') {
    try {
      await sendTelegram(
        '🤖 <b>TIH Trading Hub</b>\n' +
        '━━━━━━━━━━━━━━━\n' +
        '✅ نظام التنبيهات يعمل بشكل صحيح!\n\n' +
        '📊 سيتم إرسال تنبيهات عند ظهور إشارات CALL/PUT قوية.'
      );
      return res.status(200).json({ ok: true, message: 'Test sent!' });
    } catch(e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Check: فحص الأسهم وإرسال التنبيهات
  const symbols = (req.query.symbols || 'AAPL,NVDA,TSLA,BTC,SPX').split(',');
  const alerts  = [];

  await Promise.all(symbols.map(async (sym) => {
    try {
      const data = await analyzeSymbol(sym.trim().toUpperCase());
      if (data && data.signal) {
        alerts.push(data);
        const emoji  = data.signal === 'CALL' ? '🟢' : '🔴';
        const action = data.signal === 'CALL' ? '📈 CALL — شراء' : '📉 PUT — بيع';
        const msg =
          `${emoji} <b>${action}</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `📌 الرمز: <b>${data.symbol}</b>\n` +
          `💰 السعر: <b>$${data.price}</b>\n` +
          `📊 التغير: ${parseFloat(data.changePct) >= 0 ? '+' : ''}${data.changePct}%\n` +
          `📈 RSI: ${data.rsi}\n` +
          `🎯 مقاومة: $${data.res1}\n` +
          `🛡️ دعم: $${data.sup1}\n` +
          `⚡ Pivot: $${data.pivot}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `🤖 <i>TIH Trading Hub</i>`;
        await sendTelegram(msg);
      }
    } catch(e) {}
  }));

  return res.status(200).json({
    ok: true,
    checked: symbols.length,
    alerts: alerts.length,
    signals: alerts.map(a => ({ symbol: a.symbol, signal: a.signal, score: a.score }))
  });
};
