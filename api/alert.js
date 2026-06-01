const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';
const MASSIVE_KEY   = process.env.MASSIVE_API_KEY || 'VR6xxf1vN1SFMHfzuJ4s2qzxlb3LadOj';
const MASSIVE_BASE  = 'https://api.massive.com';

const DEFAULT_WATCHLIST = (process.env.WATCHLIST ||
  'AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL,META,AMD,AVGO,MRVL,SPX,NDX,DJI,VIX,BTC,ETH,XAUUSD,US500'
).split(',').map(s => s.trim()).filter(Boolean);

// ── Massive API ticker mapping ──
const MASSIVE_MAP = {
  'SPX':   { ticker: 'SPX',   market: 'indices' },
  'NDX':   { ticker: 'NDX',   market: 'indices' },
  'DJI':   { ticker: 'DJI',   market: 'indices' },
  'VIX':   { ticker: 'VIX',   market: 'indices' },
  'US500': { ticker: 'ESM25', market: 'futures' }, // S&P 500 Futures
  'XAUUSD':{ ticker: 'GC',    market: 'futures' }, // Gold Futures
  'BTC':   { ticker: 'BTC',   market: 'crypto'  },
  'ETH':   { ticker: 'ETH',   market: 'crypto'  },
  // الأسهم تبقى كما هي
};

// ── فريمات كل رمز ──
const SYMBOL_INTERVALS = {
  'US500': ['5min','15min','1hour','4hour','1day'],
  'SPX':   ['15min','1hour','4hour','1day'],
  'NDX':   ['15min','1hour','4hour','1day'],
  'BTC':   ['15min','1hour','4hour','1day'],
  'ETH':   ['15min','1hour','4hour','1day'],
  'XAUUSD':['15min','1hour','4hour','1day'],
  'default':['1hour','1day'],
};

// تحويل الفريم لـ Massive API format
const MASSIVE_INTERVAL = {
  '5min':  { multiplier: 5,  timespan: 'minute', range: '7d'  },
  '15min': { multiplier: 15, timespan: 'minute', range: '14d' },
  '1hour': { multiplier: 1,  timespan: 'hour',   range: '60d' },
  '4hour': { multiplier: 4,  timespan: 'hour',   range: '60d' },
  '1day':  { multiplier: 1,  timespan: 'day',    range: '365d'},
};

const TF_LABEL = {
  '5min':'⚡ 5M', '15min':'⏱️ 15M',
  '1hour':'⏱️ 1H', '4hour':'⏱️ 4H', '1day':'📅 يومي'
};

const NO_FILTER_SYMBOLS = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','SPX','NDX','DJI','US500','XAUUSD'
]);

// ── Upstash Redis ──
async function kvGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch(e) { return null; }
}
async function kvSet(key, value, exSeconds = 86400) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${exSeconds}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch(e) {}
}
async function isSent(key) { return (await kvGet(`sent:${key}`)) !== null; }
async function markSent(key, ttl = 4*3600) { await kvSet(`sent:${key}`, 1, ttl); }
async function getActiveSignals() { return (await kvGet('active_signals')) || {}; }
async function saveActiveSignals(s) { await kvSet('active_signals', s, 7*86400); }
async function getPerformance() {
  return (await kvGet('performance')) || { total:0,wins:0,losses:0,t1Hits:0,t2Hits:0,t3Hits:0,slHits:0,totalR:0 };
}
async function savePerformance(p) { await kvSet('performance', p, 365*86400); }

// ── Massive API fetch ──
function fetchMassive(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(MASSIVE_BASE + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Authorization': `Bearer ${MASSIVE_KEY}`, 'User-Agent': 'TIH/1.0' }
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── Yahoo Finance fallback ──
const YAHOO_MAP = {
  'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','VIX':'^VIX',
  'BTC':'BTC-USD','ETH':'ETH-USD','XAUUSD':'GC=F','US500':'ES=F'
};
function fetchYahoo(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

// ── جلب البيانات التاريخية من Massive ──
async function fetchBars(symbol, intervalKey) {
  const cfg = MASSIVE_INTERVAL[intervalKey];
  if (!cfg) return null;

  const to   = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - parseDays(cfg.range) * 86400000).toISOString().split('T')[0];
  const mSym = MASSIVE_MAP[symbol];

  try {
    let path;
    if (mSym && mSym.market === 'futures') {
      path = `/v2/aggs/ticker/${mSym.ticker}/range/${cfg.multiplier}/${cfg.timespan}/${from}/${to}?limit=500&adjusted=true`;
    } else if (mSym && mSym.market === 'indices') {
      path = `/v2/aggs/ticker/I:${mSym.ticker}/range/${cfg.multiplier}/${cfg.timespan}/${from}/${to}?limit=500`;
    } else {
      // أسهم عادية
      path = `/v2/aggs/ticker/${symbol}/range/${cfg.multiplier}/${cfg.timespan}/${from}/${to}?limit=500&adjusted=true`;
    }

    const json = await fetchMassive(path);
    if (json.results && json.results.length >= 20) {
      return {
        closes: json.results.map(b => b.c),
        highs:  json.results.map(b => b.h),
        lows:   json.results.map(b => b.l),
        vols:   json.results.map(b => b.v),
        price:  json.results[json.results.length - 1].c,
        source: 'massive'
      };
    }
  } catch(e) {}

  // Fallback → Yahoo Finance
  try {
    const yfSym = YAHOO_MAP[symbol] || symbol;
    const yfInterval = {'5min':'5m','15min':'15m','1hour':'1h','4hour':'1h','1day':'1d'}[intervalKey]||'1d';
    const yfRange = {'5min':'5d','15min':'14d','1hour':'60d','4hour':'60d','1day':'1y'}[intervalKey]||'1y';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${yfInterval}&range=${yfRange}`;
    const json = await fetchYahoo(url);
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const vi = q.close.map((v,i)=>v!==null?i:-1).filter(i=>i>=0);
    if (vi.length < 20) return null;
    return {
      closes: vi.map(i=>q.close[i]),
      highs:  vi.map(i=>q.high[i]),
      lows:   vi.map(i=>q.low[i]),
      vols:   vi.map(i=>q.volume?.[i]||0),
      price:  result.meta.regularMarketPrice || q.close[vi[vi.length-1]],
      source: 'yahoo'
    };
  } catch(e) { return null; }
}

function parseDays(range) {
  const n = parseInt(range);
  if (range.endsWith('d')) return n;
  if (range.endsWith('m')) return n * 30;
  if (range.endsWith('y')) return n * 365;
  return 60;
}

// ── جلب السعر الحالي ──
async function getCurrentPrice(symbol) {
  try {
    const mSym = MASSIVE_MAP[symbol];
    let path;
    if (mSym && mSym.market === 'futures') {
      path = `/v2/snapshot/locale/us/markets/futures/tickers/${mSym.ticker}`;
    } else if (mSym && mSym.market === 'indices') {
      path = `/v2/snapshot/locale/us/markets/indices/tickers/I:${mSym.ticker}`;
    } else {
      path = `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`;
    }
    const json = await fetchMassive(path);
    const price = json?.ticker?.day?.c || json?.ticker?.lastTrade?.p || json?.value;
    if (price) return parseFloat(price);
  } catch(e) {}

  // Yahoo fallback
  try {
    const yfSym = YAHOO_MAP[symbol] || symbol;
    const json = await fetchYahoo(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1m&range=1d`);
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch(e) { return null; }
}

// ── Market Open ──
function isMarketOpen(symbol) {
  if (NO_FILTER_SYMBOLS.has(symbol)) return { open: true, session: '24/7' };
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const totalMin = riyadh.getHours()*60 + riyadh.getMinutes();
  const day = riyadh.getDay();
  if (day===0||day===6) return { open:false, session:'weekend' };
  const open=16*60+30, close=22*60;
  if (totalMin>=open && totalMin<close) {
    let session='midday';
    if (totalMin<open+90) session='🔥 Open Killzone';
    else if (totalMin>=20*60+30) session='🔥 Power Hour';
    return { open:true, session };
  }
  return { open:false, session:'closed' };
}

async function checkMarketOpenClose() {
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Riyadh' }));
  const totalMin = riyadh.getHours()*60+riyadh.getMinutes();
  const day = riyadh.getDay();
  if (day===0||day===6) return;
  const todayKey = riyadh.toISOString().slice(0,10);
  if (totalMin>=16*60+30&&totalMin<16*60+35&&!await isSent(`market_open_${todayKey}`)) {
    await markSent(`market_open_${todayKey}`);
    await sendTelegram(`🔔 <b>السوق فتح الآن!</b>\n━━━━━━━━━━━━━━━\n⏰ 4:30 م — بدأت جلسة نيويورك\n🔥 Open Killzone نشطة\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`);
  }
  if (totalMin>=22*60&&totalMin<22*60+5&&!await isSent(`market_close_${todayKey}`)) {
    await markSent(`market_close_${todayKey}`);
    await sendTelegram(`🔕 <b>السوق أغلق</b>\n━━━━━━━━━━━━━━━\n⏰ 10:00 م — انتهت جلسة نيويورك\n⏭️ الفتح القادم: غداً 4:30 م\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`);
  }
}

// ── Telegram ──
function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id:CHAT_ID, text:message, parse_mode:'HTML' });
    const req = https.request({
      hostname:'api.telegram.org',
      path:`/bot${BOT_TOKEN}/sendMessage`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, (res) => {
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>resolve(JSON.parse(data)));
    });
    req.on('error',reject);
    req.write(body); req.end();
  });
}

// ── Technical Indicators ──
function calcSMA(p,n){if(p.length<n)return null;return p.slice(-n).reduce((a,b)=>a+b,0)/n;}
function calcEMA(p,n){
  if(p.length<n)return null;
  let k=2/(n+1),e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<p.length;i++)e=p[i]*k+e*(1-k);
  return e;
}
function calcRSI(p,n=14){
  if(p.length<n+1)return null;
  let g=0,l=0;
  for(let i=1;i<=n;i++){const d=p[i]-p[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/n,al=l/n;
  for(let i=n+1;i<p.length;i++){const d=p[i]-p[i-1];if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}}
  if(al===0)return 100;
  return 100-(100/(1+ag/al));
}
function calcATR(h,l,c,n=14){
  if(c.length<n+1)return null;
  const trs=[];
  for(let i=1;i<c.length;i++)trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
  return trs.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function calcMACD(p){
  const ema12=calcEMA(p,12),ema26=calcEMA(p,26);
  if(!ema12||!ema26)return null;
  return {macd:ema12-ema26,signal:ema12-ema26};
}
function calcBB(p,n=20,mult=2){
  if(p.length<n)return null;
  const slice=p.slice(-n);
  const mean=slice.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(slice.reduce((a,b)=>a+(b-mean)**2,0)/n);
  return {upper:mean+mult*std,middle:mean,lower:mean-mult*std,std};
}
function calcStochRSI(p,n=14,sk=3){
  const rsiArr=[];
  for(let i=n;i<=p.length;i++){
    const r=calcRSI(p.slice(0,i),n);
    if(r!==null)rsiArr.push(r);
  }
  if(rsiArr.length<n)return null;
  const recent=rsiArr.slice(-n);
  const min=Math.min(...recent),max=Math.max(...recent);
  if(max===min)return 50;
  return((rsiArr[rsiArr.length-1]-min)/(max-min))*100;
}
function calcVolProfile(closes,vols){
  if(!vols||vols.length<10)return null;
  const avg=vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,vols.length);
  const last=vols[vols.length-1];
  return{aboveAvg:last>avg*1.5,ratio:(last/avg).toFixed(2)};
}
function calcPowerZones(highs,lows,atr){
  const n=Math.min(130,highs.length);
  const za=atr*0.5;
  const hi=Math.max(...highs.slice(-n)),lo=Math.min(...lows.slice(-n));
  return{resTop:hi+za,resBot:hi-za,supTop:lo+za,supBot:lo-za};
}
function detectFalseBreakout(closes,highs,lows,supTop,supBot,resTop,resBot){
  if(closes.length<3)return null;
  const prev=closes[closes.length-2],curr=closes[closes.length-1];
  const prevL=lows[lows.length-2],prevH=highs[highs.length-2];
  if(prevL<supBot&&prev<supTop&&curr>supTop)return'CALL_FALSE_BREAK';
  if(prevH>resTop&&prev>resBot&&curr<resBot)return'PUT_FALSE_BREAK';
  return null;
}
function detectRoleReversal(closes,highs,lows,supTop,supBot,resTop,resBot,atr){
  if(closes.length<10)return null;
  const curr=closes[closes.length-1],tol=atr*0.5;
  if(curr>=resBot-tol&&curr<=resTop+tol&&closes.slice(-10,-3).some(c=>c>resTop))return'CALL_ROLE_REVERSAL';
  if(curr>=supBot-tol&&curr<=supTop+tol&&closes.slice(-10,-3).some(c=>c<supBot))return'PUT_ROLE_REVERSAL';
  return null;
}
function calcRiskReward(signal,price,closes,highs,lows,atr,zones,htfBull,htfBear){
  const{resTop,resBot,supTop,supBot}=zones;
  const isCT=signal==='CALL'?htfBear:htfBull;
  const ema9=calcEMA(closes,9)||price,ema21=calcEMA(closes,21)||price;
  if(isCT&&Math.abs(ema9-ema21)/atr>2.0)return null;
  let entry,stop,risk,t1,t2,t3,sigType;
  if(signal==='CALL'){
    entry=price;
    stop=isCT?entry-atr*1.5:Math.min(supBot-atr*0.2,entry-atr*1.0);
    stop=Math.max(stop,entry*0.97);
    risk=entry-stop;if(risk<=0)return null;
    t1=entry+2*risk;t2=entry+3*risk;
    t3=resBot>entry?Math.max(resBot,t2+risk):t2+risk;
    sigType=isCT?'⚠️ CALL (عكسي)':'📈 CALL';
  }else{
    entry=price;
    stop=isCT?entry+atr*1.5:Math.max(resTop+atr*0.2,entry+atr*1.0);
    stop=Math.min(stop,entry*1.03);
    risk=stop-entry;if(risk<=0)return null;
    t1=entry-2*risk;t2=entry-3*risk;
    t3=supTop<entry?Math.min(supTop,t2-risk):t2-risk;
    sigType=isCT?'⚠️ PUT (عكسي)':'📉 PUT';
  }
  const rr1=Math.abs(t1-entry)/risk;
  if(rr1<1.5)return null;
  return{
    entry:+entry.toFixed(2),stop:+stop.toFixed(2),
    t1:+t1.toFixed(2),t2:+t2.toFixed(2),t3:+t3.toFixed(2),
    risk:+risk.toFixed(2),rr1:rr1.toFixed(2),
    rr2:(Math.abs(t2-entry)/risk).toFixed(2),
    slPct:((stop-entry)/entry*100).toFixed(2),
    t1Pct:((t1-entry)/entry*100).toFixed(2),
    t2Pct:((t2-entry)/entry*100).toFixed(2),
    sigType,isCT,signal
  };
}

// ── التحليل على فريم واحد ──
async function analyzeOnInterval(symbol, intervalKey) {
  const bars = await fetchBars(symbol, intervalKey);
  if (!bars || bars.closes.length < 30) return null;

  const { closes, highs, lows, vols, price } = bars;
  const prevClose = closes[closes.length-2] || price;
  const changePct = ((price-prevClose)/prevClose*100).toFixed(2);

  const rsi      = calcRSI(closes);
  const atr      = calcATR(highs,lows,closes,14) || price*0.01;
  const ema9     = calcEMA(closes,9)  || price;
  const ema21    = calcEMA(closes,21) || price;
  const ema50    = calcEMA(closes,50);
  const sma200   = calcSMA(closes,200);
  const macd     = calcMACD(closes);
  const bb       = calcBB(closes);
  const stochRsi = calcStochRSI(closes);
  const vol      = calcVolProfile(closes, vols);
  const htfBull  = ema9>ema21, htfBear = ema9<ema21;
  const zones    = calcPowerZones(highs,lows,atr);
  const falseBreak = detectFalseBreakout(closes,highs,lows,zones.supTop,zones.supBot,zones.resTop,zones.resBot);
  const roleRev    = detectRoleReversal(closes,highs,lows,zones.supTop,zones.supBot,zones.resTop,zones.resBot,atr);

  // ── نظام النقاط المحسّن ──
  let score = 0;
  const reasons = [];

  // EMA Trend (أهم مؤشر)
  if (price>ema9&&ema9>ema21) { score+=2; reasons.push('EMA صاعد'); }
  else if (price<ema9&&ema9<ema21) { score-=2; reasons.push('EMA هابط'); }

  // EMA50 فلتر اتجاه أكبر
  if (ema50) {
    if (price>ema50) { score+=1; reasons.push('فوق EMA50'); }
    else { score-=1; reasons.push('تحت EMA50'); }
  }

  // SMA200 HTF
  if (sma200) {
    if (price>sma200) { score+=1; reasons.push('فوق SMA200'); }
    else { score-=1; reasons.push('تحت SMA200'); }
  }

  // RSI
  if (rsi) {
    if (rsi>55&&rsi<70) { score+=1; reasons.push(`RSI ${rsi.toFixed(0)} صاعد`); }
    else if (rsi<45&&rsi>30) { score-=1; reasons.push(`RSI ${rsi.toFixed(0)} هابط`); }
    else if (rsi>=70) { score-=1; reasons.push(`RSI ${rsi.toFixed(0)} تشبع شراء`); }
    else if (rsi<=30) { score+=1; reasons.push(`RSI ${rsi.toFixed(0)} تشبع بيع`); }
  }

  // Stochastic RSI
  if (stochRsi !== null) {
    if (stochRsi>80) score-=1;
    else if (stochRsi<20) score+=1;
  }

  // MACD
  if (macd) {
    if (macd.macd>0) { score+=1; reasons.push('MACD إيجابي'); }
    else { score-=1; reasons.push('MACD سلبي'); }
  }

  // Bollinger Bands
  if (bb) {
    if (price<=bb.lower) { score+=2; reasons.push('عند الباند السفلي'); }
    else if (price>=bb.upper) { score-=2; reasons.push('عند الباند العلوي'); }
    else if (price>bb.middle) score+=1;
    else score-=1;
  }

  // Volume Confirmation
  if (vol && vol.aboveAvg) {
    if (parseFloat(changePct)>0) { score+=1; reasons.push(`حجم عالٍ x${vol.ratio}`); }
    else { score-=1; reasons.push(`حجم عالٍ x${vol.ratio} هبوط`); }
  }

  // Price Change
  if (parseFloat(changePct)>1) score+=1;
  else if (parseFloat(changePct)<-1) score-=1;

  // False Breakout & Role Reversal
  let rawSignal = score>=5?'CALL':score<=-5?'PUT':null;

  if (!rawSignal&&falseBreak==='CALL_FALSE_BREAK') { rawSignal='CALL'; reasons.push('كسر وهمي↑'); }
  if (!rawSignal&&falseBreak==='PUT_FALSE_BREAK')  { rawSignal='PUT';  reasons.push('كسر وهمي↓'); }

  if (!rawSignal) return null;
  if (!isMarketOpen(symbol).open) return null;

  const rr = calcRiskReward(rawSignal,price,closes,highs,lows,atr,zones,htfBull,htfBear);
  if (!rr) return null;

  const tags = [];
  if (falseBreak&&falseBreak.startsWith(rawSignal)) tags.push('كسر وهمي');
  if (roleRev&&roleRev.startsWith(rawSignal)) tags.push('تبادل أدوار');
  const tagStr = tags.length>0?' | '+tags.join(' | '):'';

  const confidence = Math.min(95, Math.round(50 + Math.abs(score)*6));

  return {
    symbol, price:price.toFixed(2), changePct,
    rsi:rsi?rsi.toFixed(1):'—',
    stochRsi:stochRsi?stochRsi.toFixed(0):'—',
    macdVal:macd?(macd.macd>0?'↑':'↓'):'—',
    bbPos:bb?(price<=bb.lower?'دعم BB':price>=bb.upper?'مقاومة BB':'داخل BB'):'—',
    volInfo:vol?`x${vol.ratio}`:'—',
    signal:rawSignal, sigType:rr.sigType,
    score, confidence, rr, zones,
    atr:atr.toFixed(2), tagStr, tags,
    interval:intervalKey, tfLabel:TF_LABEL[intervalKey]||intervalKey,
    source:bars.source, reasons
  };
}

// ── تحليل متعدد الأطر مع MTF Confluence ──
async function analyzeSymbol(symbol) {
  const intervals = SYMBOL_INTERVALS[symbol] || SYMBOL_INTERVALS['default'];
  const results = await Promise.all(intervals.map(iv => analyzeOnInterval(symbol,iv).catch(()=>null)));
  const valid = results.filter(r=>r!==null);
  if (!valid.length) return null;

  // MTF Confluence: هل الفريمات الأكبر تتفق مع الإشارة؟
  // نعطي وزن أعلى للإشارات المتوافقة مع الاتجاه الكبير
  for (const r of valid) {
    let confluenceBonus = 0;
    const biggerFrames = valid.filter(x => x.interval !== r.interval && intervalWeight(x.interval) > intervalWeight(r.interval));
    const agreeing = biggerFrames.filter(x => x.signal === r.signal);
    confluenceBonus = agreeing.length * 10; // 10% لكل فريم أكبر يتفق
    r.confidence = Math.min(95, r.confidence + confluenceBonus);
    r.mtfAgreement = `${agreeing.length}/${biggerFrames.length}`;
  }

  // اختر الإشارة الأقوى (أعلى confidence)
  valid.sort((a,b) => b.confidence - a.confidence);
  const best = valid[0];

  // إذا كان هناك تعارض مع الاتجاه الكبير → خفّض الثقة
  const daily = valid.find(x=>x.interval==='1day');
  if (daily && best.signal !== daily.signal && best.interval !== '1day') {
    best.confidence = Math.max(50, best.confidence - 20);
    best.contrarianWarning = true;
  }

  return best;
}

function intervalWeight(iv) {
  return {'5min':1,'15min':2,'1hour':3,'4hour':4,'1day':5}[iv]||3;
}

// ── فحص الإشارات النشطة ──
async function checkActiveSignals() {
  const activeSignals = await getActiveSignals();
  const perf = await getPerformance();
  let notifications=0, changed=false;
  for (const [key,sig] of Object.entries(activeSignals)) {
    try {
      const price = await getCurrentPrice(sig.symbol);
      if (!price) continue;
      const isCall = sig.signal==='CALL';
      if (!sig.slHit&&((isCall&&price<=sig.stop)||(!isCall&&price>=sig.stop))) {
        sig.slHit=true; delete activeSignals[key];
        perf.losses++;perf.slHits++;perf.totalR-=1;changed=true;
        await sendTelegram(`🛑 <b>Stop Loss ضُرب!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.symbol}</b> — ${sig.sigType}\n💰 السعر: <b>$${price.toFixed(2)}</b>\n🛡️ SL: $${sig.stop}\n━━━━━━━━━━━━━━━\n📊 -1R خسارة\n📈 Win Rate: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`);
        notifications++;continue;
      }
      if (!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))) {
        sig.t1Hit=true;sig.stop=sig.entry;perf.t1Hits++;perf.wins++;perf.totalR+=2;changed=true;
        await sendTelegram(`🎯 <b>T1 تحقق! +2R</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.symbol}</b> — ${sig.sigType}\n💰 السعر: <b>$${price.toFixed(2)}</b>\n🏆 T1: $${sig.t1}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n━━━━━━━━━━━━━━━\n📊 +2R ✅ | SL → Break Even\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`);
        notifications++;
      }
      if (sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))) {
        sig.t2Hit=true;perf.t2Hits++;perf.totalR+=1;changed=true;
        await sendTelegram(`🎯🎯 <b>T2 تحقق! +3R</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.symbol}</b> — ${sig.sigType}\n💰 السعر: <b>$${price.toFixed(2)}</b>\n🏆 T2: $${sig.t2}\n⏭️ T3: $${sig.t3}\n━━━━━━━━━━━━━━━\n📊 +3R 🔥\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`);
        notifications++;
      }
      if (sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))) {
        sig.t3Hit=true;delete activeSignals[key];perf.t3Hits++;perf.totalR+=1;changed=true;
        await sendTelegram(`🏆🏆🏆 <b>T3 تحقق! الهدف الكامل!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.symbol}</b> — ${sig.sigType}\n💰 السعر: <b>$${price.toFixed(2)}</b>\n🏆 T3: $${sig.t3}\n━━━━━━━━━━━━━━━\n📊 +4R+ 💎\nWin Rate: ${((perf.wins/perf.total)*100).toFixed(0)}% | R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`);
        notifications++;
      }
      activeSignals[key]=sig;
    } catch(e) {}
  }
  if (changed){await saveActiveSignals(activeSignals);await savePerformance(perf);}
  return notifications;
}

// ── Macro Events ──
const MACRO_RULES={
  'Non-Farm':(a,f)=>{const b=a-f;if(b>100)return{label:'🟢🟢 صعود قوي',reason:'وظائف أقوى بكثير'};if(b>30)return{label:'🟢 صعود متوسط',reason:'وظائف أفضل'};if(b>-30)return{label:'⚪ تأثير لحظي',reason:'قريب من التوقعات'};if(b>-100)return{label:'🔴 هبوط متوسط',reason:'وظائف أقل'};return{label:'🔴🔴 هبوط قوي',reason:'وظائف ضعيفة جداً'};},
  'CPI':(a,f)=>{const b=a-f;if(b>0.3)return{label:'🔴🔴 هبوط قوي',reason:'تضخم أعلى بكثير'};if(b>0.1)return{label:'🔴 هبوط متوسط',reason:'تضخم أعلى'};if(b>-0.1)return{label:'⚪ تأثير لحظي',reason:'في التوقعات'};if(b>-0.3)return{label:'🟢 صعود متوسط',reason:'تضخم أقل'};return{label:'🟢🟢 صعود قوي',reason:'تضخم منخفض جداً'};},
  'default':(a,f)=>{const pct=f?((a-f)/Math.abs(f))*100:0;if(pct>10)return{label:'🟢🟢 صعود قوي',reason:'أفضل بكثير'};if(pct>3)return{label:'🟢 صعود متوسط',reason:'أفضل من التوقعات'};if(pct>-3)return{label:'⚪ تأثير لحظي',reason:'في التوقعات'};if(pct>-10)return{label:'🔴 هبوط متوسط',reason:'أضعف من التوقعات'};return{label:'🔴🔴 هبوط قوي',reason:'أضعف بكثير'};}
};
async function checkMacroEvents(){
  try{
    const events=await new Promise((resolve,reject)=>{
      https.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{'User-Agent':'Mozilla/5.0'}},(res)=>{
        let data='';res.on('data',c=>data+=c);res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
      }).on('error',reject);
    });
    if(!Array.isArray(events))return 0;
    const now=new Date();let sent=0;
    for(const e of events){
      if(!e.title||!e.actual)continue;
      if(e.impact!=='High'&&e.impact!=='Medium')continue;
      const eventTime=new Date(e.date);
      const diffMin=(now-eventTime)/60000;
      if(diffMin<0||diffMin>15)continue;
      const key=`macro_${e.title}_${e.date}`;
      if(await isSent(key))continue;
      await markSent(key);
      let fn=MACRO_RULES['default'];
      for(const k of Object.keys(MACRO_RULES)){if(k!=='default'&&e.title.includes(k)){fn=MACRO_RULES[k];break;}}
      const impact=fn(parseFloat(e.actual),parseFloat(e.forecast));
      const timeStr=eventTime.toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Riyadh'});
      await sendTelegram(`🌍 <b>بيانة اقتصادية صدرت!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${e.title}</b>\n${e.impact==='High'?'🔴 عالٍ':'🟡 متوسط'} | ⏰ ${timeStr}\n━━━━━━━━━━━━━━━\n📊 الفعلي: <b>${e.actual}</b>\n🎯 التوقعات: ${e.forecast||'—'}\n📅 السابق: ${e.previous||'—'}\n━━━━━━━━━━━━━━━\n${impact.label}\n💡 ${impact.reason}\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`);
      sent++;
    }
    return sent;
  }catch(e){return 0;}
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS')return res.status(200).end();
  const action=req.query.action||'check';

  if(action==='test'){
    try{
      await sendTelegram(
        '🤖 <b>TIH Trading Hub v8.0</b>\n━━━━━━━━━━━━━━━\n'+
        '✅ نظام التنبيهات يعمل!\n\n'+
        '📋 القائمة:\n'+DEFAULT_WATCHLIST.map(s=>`• ${s}`).join('\n')+'\n\n'+
        '🗄️ التخزين: Upstash Redis ✅\n'+
        '📊 البيانات: Massive API ✅\n'+
        '📈 المؤشرات: EMA+RSI+MACD+BB+StochRSI+Volume\n'+
        '🔀 MTF Confluence: مفعّل\n'+
        '⏱️ US500: 5M+15M+1H+4H+يومي\n'+
        '⏱️ فحص كل 5 دقائق'
      );
      return res.status(200).json({ok:true});
    }catch(e){return res.status(500).json({ok:false,error:e.message});}
  }

  if(action==='stats'){
    const perf=await getPerformance();
    const active=await getActiveSignals();
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    await sendTelegram(
      `📊 <b>تقرير الأداء</b>\n━━━━━━━━━━━━━━━\n`+
      `📈 إجمالي الإشارات: <b>${perf.total}</b>\n`+
      `✅ ناجحة: <b>${perf.wins}</b> | ❌ فاشلة: <b>${perf.losses}</b>\n`+
      `🎯 Win Rate: <b>${wr}%</b>\n━━━━━━━━━━━━━━━\n`+
      `🏆 T1: ${perf.t1Hits} | T2: ${perf.t2Hits} | T3: ${perf.t3Hits} | SL: ${perf.slHits}\n`+
      `━━━━━━━━━━━━━━━\n`+
      `💰 إجمالي R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n`+
      `📌 إشارات نشطة: ${Object.keys(active).length}\n`+
      `━━━━━━━━━━━━━━━\n🤖 <i>TIH Performance Tracker</i>`
    );
    return res.status(200).json({ok:true,perf,activeCount:Object.keys(active).length});
  }

  // ── Check ──
  const symbols=req.query.symbols
    ?req.query.symbols.split(',').map(s=>s.trim().toUpperCase())
    :DEFAULT_WATCHLIST;

  const alerts=[],errors=[];
  await checkMarketOpenClose();
  const perfAlerts=await checkActiveSignals();

  await Promise.all(symbols.map(async(sym)=>{
    try{
      const data=await analyzeSymbol(sym);
      if(!data)return;

      // منع التكرار — مع الفريم في المفتاح
      const sigKey=`sig_${sym}_${data.signal}_${data.interval}_${new Date().toISOString().slice(0,13)}`;
      if(await isSent(sigKey))return;
      await markSent(sigKey);

      alerts.push(data);
      const perf=await getPerformance();
      perf.total++;
      await savePerformance(perf);

      const rr=data.rr;
      const ctWarn=rr.isCT?'\n⚠️ <i>إشارة عكسية — حجم أصغر</i>':'';
      const confirmTag=data.tagStr?'\n✅ تأكيد: '+data.tags.join(' | '):'';
      const mStatus=isMarketOpen(sym);
      const sessionTag=mStatus.session!=='24/7'?`\n⏰ الجلسة: ${mStatus.session}`:'';
      const mtfTag=data.mtfAgreement?`\n🔀 MTF توافق: ${data.mtfAgreement}`:'';
      const contraWarn=data.contrarianWarning?'\n⚠️ <i>عكس الاتجاه اليومي — احذر</i>':'';
      const sourceTag=data.source==='massive'?'\n📡 Massive API':'';

      // حفظ الإشارة
      const activeSignals=await getActiveSignals();
      const sigId=`${sym}_${Date.now()}`;
      activeSignals[sigId]={
        symbol:sym,signal:data.signal,sigType:rr.sigType,
        entry:rr.entry,stop:rr.stop,
        t1:rr.t1,t2:rr.t2,t3:rr.t3,
        t1Pct:rr.t1Pct,t2Pct:rr.t2Pct,
        risk:rr.risk,t1Hit:false,t2Hit:false,t3Hit:false,slHit:false,
        openedAt:Date.now()
      };
      await saveActiveSignals(activeSignals);

      await sendTelegram(
        `${data.signal==='CALL'?'🟢':'🔴'} <b>${rr.sigType}${data.tagStr}</b>\n`+
        `━━━━━━━━━━━━━━━\n`+
        `📌 <b>${data.symbol}</b>\n`+
        `💰 السعر: <b>$${data.price}</b>\n`+
        `📊 التغير: ${parseFloat(data.changePct)>=0?'+':''}${data.changePct}%\n`+
        `📈 RSI: ${data.rsi} | StochRSI: ${data.stochRsi}\n`+
        `📉 MACD: ${data.macdVal} | BB: ${data.bbPos}\n`+
        `📦 الحجم: ${data.volInfo} | 🔥 الثقة: ${data.confidence}%\n`+
        `${data.tfLabel}\n`+
        `━━━━━━━━━━━━━━━\n`+
        `🎯 Entry:     $${rr.entry}\n`+
        `🛡️ Stop Loss: $${rr.stop} (${rr.slPct}%)\n`+
        `🏆 T1:        $${rr.t1} (${rr.t1Pct}%) | 1:${rr.rr1}\n`+
        `🏆 T2:        $${rr.t2} (${rr.t2Pct}%) | 1:${rr.rr2}\n`+
        `🏆 T3:        $${rr.t3}\n`+
        `━━━━━━━━━━━━━━━\n`+
        `🏛️ دعم: $${data.zones.supBot.toFixed(0)}–${data.zones.supTop.toFixed(0)}\n`+
        `🏛️ مقاومة: $${data.zones.resBot.toFixed(0)}–${data.zones.resTop.toFixed(0)}\n`+
        `📐 ATR: ${data.atr}`+ctWarn+
        (sessionTag?'\n'+sessionTag:'')+
        (confirmTag?'\n'+confirmTag:'')+
        (mtfTag?'\n'+mtfTag:'')+
        (contraWarn?'\n'+contraWarn:'')+
        (sourceTag?'\n'+sourceTag:'')+
        `\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub v8.0</i>`
      );
    }catch(e){errors.push(`${sym}: ${e.message}`);}
  }));

  const macroAlerts=await checkMacroEvents();
  const activeSignals=await getActiveSignals();

  return res.status(200).json({
    ok:true,checked:symbols.length,
    newAlerts:alerts.length,perfAlerts,macroAlerts,
    activeSignals:Object.keys(activeSignals).length,
    signals:alerts.map(a=>({symbol:a.symbol,signal:a.signal,score:a.score,interval:a.interval,confidence:a.confidence,source:a.source,rr1:a.rr?.rr1})),
    errors
  });
};
