const https = require('https');

const YAHOO_MAP = {
  'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','VIX':'^VIX','DXY':'DX-Y.NYB',
  'BTC':'BTC-USD','ETH':'ETH-USD','XAUUSD':'GC=F','SOL':'SOL-USD'
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers:{'User-Agent':'Mozilla/5.0'} }, (res) => {
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(data));}catch(e){reject(e);} });
    }).on('error',reject);
  });
}

function calcEMA(p,n){
  if(p.length<n)return null;
  let k=2/(n+1), e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<p.length;i++) e=p[i]*k+e*(1-k);
  return e;
}
function calcRSI(p,n=14){
  if(p.length<n+1)return null;
  let g=0,l=0;
  for(let i=1;i<=n;i++){const d=p[i]-p[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/n,al=l/n;
  for(let i=n+1;i<p.length;i++){const d=p[i]-p[i-1];if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}}
  if(al===0)return 100; return 100-(100/(1+ag/al));
}
function calcATR(h,l,c,n=14){
  if(c.length<n+1)return null;
  const trs=[];
  for(let i=1;i<c.length;i++) trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function calcSMA(p,n){if(p.length<n)return null;return p.slice(-n).reduce((a,b)=>a+b,0)/n;}

async function backtestSymbol(symbol, days = 30) {
  const yfSym = YAHOO_MAP[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1d&range=6mo`;
  const json = await fetchJSON(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const q = result.indicators.quote[0];
  const vi = q.close.map((v,i)=>v!==null?i:-1).filter(i=>i>=0);
  const closes = vi.map(i=>q.close[i]);
  const highs  = vi.map(i=>q.high[i]);
  const lows   = vi.map(i=>q.low[i]);

  if (closes.length < days + 30) return null;

  const signals = [];
  const startIdx = closes.length - days;

  for (let i = startIdx; i < closes.length - 1; i++) {
    // بيانات حتى اليوم i
    const c = closes.slice(0, i+1);
    const h = highs.slice(0, i+1);
    const l = lows.slice(0, i+1);

    const price = c[c.length-1];
    const prev  = c[c.length-2];
    const changePct = ((price-prev)/prev*100);

    const ema9  = calcEMA(c, 9)  || price;
    const ema21 = calcEMA(c, 21) || price;
    const sma200= calcSMA(c, 200);
    const rsi   = calcRSI(c);
    const atr   = calcATR(h, l, c, 14) || price * 0.01;

    let score = 0;
    if (price > ema9 && ema9 > ema21)   score += 2;
    if (price < ema9 && ema9 < ema21)   score -= 2;
    if (changePct > 1)                   score += 2;
    else if (changePct > 0)              score += 1;
    else if (changePct < -1)             score -= 2;
    else                                 score -= 1;
    if (sma200 && price > sma200)        score += 1;
    else if (sma200 && price < sma200)   score -= 1;
    if (rsi && rsi > 55)                 score += 1;
    else if (rsi && rsi < 45)            score -= 1;
    if (rsi && rsi > 70)                 score -= 1;
    else if (rsi && rsi < 30)            score += 1;

    const signal = score >= 4 ? 'CALL' : score <= -4 ? 'PUT' : null;
    if (!signal) continue;

    // حساب SL/TP
    const risk = atr * 1.0;
    const entry = price;
    const stop  = signal === 'CALL' ? Math.max(entry - risk, entry * 0.97) : Math.min(entry + risk, entry * 1.03);
    const t1    = signal === 'CALL' ? entry + 2 * risk : entry - 2 * risk;
    const t2    = signal === 'CALL' ? entry + 3 * risk : entry - 3 * risk;

    // فحص النتيجة في الأيام التالية (حتى 10 أيام)
    let result_type = 'open';
    let rGain = 0;
    const lookAhead = Math.min(10, closes.length - i - 1);

    for (let j = 1; j <= lookAhead; j++) {
      const futHigh = highs[i+j];
      const futLow  = lows[i+j];

      if (signal === 'CALL') {
        if (futLow <= stop)  { result_type = 'SL'; rGain = -1; break; }
        if (futHigh >= t2)   { result_type = 'T2'; rGain = 3;  break; }
        if (futHigh >= t1)   { result_type = 'T1'; rGain = 2;  break; }
      } else {
        if (futHigh >= stop) { result_type = 'SL'; rGain = -1; break; }
        if (futLow <= t2)    { result_type = 'T2'; rGain = 3;  break; }
        if (futLow <= t1)    { result_type = 'T1'; rGain = 2;  break; }
      }
    }

    if (result_type === 'open') continue; // لم يُغلق بعد

    signals.push({
      date:   new Date(result.timestamp[vi[i]] * 1000).toISOString().slice(0,10),
      signal, entry: entry.toFixed(2),
      result: result_type, rGain, score
    });
  }

  // إحصائيات
  const total  = signals.length;
  const wins   = signals.filter(s=>s.rGain>0).length;
  const losses = signals.filter(s=>s.rGain<0).length;
  const totalR = signals.reduce((sum,s)=>sum+s.rGain, 0);
  const winRate = total > 0 ? ((wins/total)*100).toFixed(0) : 0;
  const t1Hits = signals.filter(s=>s.result==='T1').length;
  const t2Hits = signals.filter(s=>s.result==='T2').length;
  const slHits = signals.filter(s=>s.result==='SL').length;

  return {
    symbol, total, wins, losses, winRate,
    totalR: parseFloat(totalR.toFixed(1)),
    t1Hits, t2Hits, slHits,
    avgR: total > 0 ? parseFloat((totalR/total).toFixed(2)) : 0,
    signals: signals.slice(-10) // آخر 10 إشارات فقط
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();

  const symbols = (req.query.symbols || 'AAPL,NVDA,TSLA,MSFT,AMD,SPX,NDX,BTC,ETH,XAUUSD')
    .split(',').map(s=>s.trim().toUpperCase()).slice(0,10);
  const days = parseInt(req.query.days || '30');

  try {
    const results = await Promise.all(
      symbols.map(sym => backtestSymbol(sym, days).catch(()=>null))
    );

    const valid = results.filter(Boolean);
    const totalSignals = valid.reduce((s,r)=>s+r.total, 0);
    const totalWins    = valid.reduce((s,r)=>s+r.wins, 0);
    const totalR       = valid.reduce((s,r)=>s+r.totalR, 0);
    const overallWR    = totalSignals > 0 ? ((totalWins/totalSignals)*100).toFixed(0) : 0;

    // ترتيب حسب الأداء
    valid.sort((a,b) => b.totalR - a.totalR);

    return res.status(200).json({
      ok: true,
      period: days + ' يوم',
      summary: {
        totalSignals,
        totalWins,
        totalLosses: totalSignals - totalWins,
        overallWinRate: overallWR + '%',
        totalR: parseFloat(totalR.toFixed(1))
      },
      symbols: valid
    });
  } catch(e) {
    return res.status(500).json({ok:false, error:e.message});
  }
};
