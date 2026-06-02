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

const MASSIVE_MAP = {
  'SPX':   { ticker: 'SPX',   market: 'indices' },
  'NDX':   { ticker: 'NDX',   market: 'indices' },
  'DJI':   { ticker: 'DJI',   market: 'indices' },
  'VIX':   { ticker: 'VIX',   market: 'indices' },
  // US500: Massive لا يدعم Futures — يستخدم Yahoo فقط
  'XAUUSD':{ ticker: 'GC',    market: 'futures' },
  'BTC':   { ticker: 'BTC',   market: 'crypto'  },
  'ETH':   { ticker: 'ETH',   market: 'crypto'  },
};

const YAHOO_MAP = {
  'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','VIX':'^VIX',
  'BTC':'BTC-USD','ETH':'ETH-USD','XAUUSD':'GC=F','US500':'ES=F'
};

// ── MTF Config: الفريم الأكبر يحدد الاتجاه، الأصغر يحدد الدخول ──
// trend_frames: الاتجاه العام — يجب أن يتوافق
// entry_frames: نقطة الدخول — أي منها يكفي
// المؤشرات السريعة — تحتاج منطق مستقل بدون شرط توافق الفريمات الكبيرة
const FAST_INDICES = new Set(['US500','SPX','NDX','DJI','VIX']);

const MTF_CONFIG = {
  'US500': { trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'SPX':   { trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'NDX':   { trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'DJI':   { trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'BTC':   { trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'ETH':   { trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'XAUUSD':{ trend_frames: ['1day','4hour'], entry_frames: ['1hour','15min'] },
  'default':{ trend_frames: ['1day'],        entry_frames: ['1day'] },
};

const MASSIVE_INTERVAL = {
  '5min':  { multiplier:5,  timespan:'minute', range:'7d'   },
  '15min': { multiplier:15, timespan:'minute', range:'14d'  },
  '1hour': { multiplier:1,  timespan:'hour',   range:'60d'  },
  '4hour': { multiplier:4,  timespan:'hour',   range:'60d'  },
  '1day':  { multiplier:1,  timespan:'day',    range:'365d' },
};

const TF_LABEL = {
  '5min':'⚡ 5M','15min':'⏱️ 15M',
  '1hour':'⏱️ 1H','4hour':'⏱️ 4H','1day':'📅 يومي'
};

// ── معاملات SL/TP لكل فئة رموز ──
const RR_CONFIG = {
  // كريبتو — تقلب عالٍ
  'BTC':    { sl: 2.0, t1: 3.0, t2: 5.0, t3: 8.0 },
  'ETH':    { sl: 2.0, t1: 3.0, t2: 5.0, t3: 8.0 },
  'SOL':    { sl: 2.0, t1: 3.0, t2: 5.0, t3: 8.0 },
  // مؤشرات — تقلب متوسط-عالٍ
  'US500':  { sl: 1.5, t1: 2.5, t2: 4.0, t3: 6.0 },
  'SPX':    { sl: 1.5, t1: 2.5, t2: 4.0, t3: 6.0 },
  'NDX':    { sl: 1.5, t1: 2.5, t2: 4.0, t3: 6.0 },
  'DJI':    { sl: 1.5, t1: 2.5, t2: 4.0, t3: 6.0 },
  // ذهب — تقلب متوسط
  'XAUUSD': { sl: 1.5, t1: 2.5, t2: 4.0, t3: 6.0 },
  // default — أسهم
  'default':{ sl: 1.2, t1: 2.0, t2: 3.5, t3: 5.0 },
};

function getRRConfig(symbol) {
  return RR_CONFIG[symbol] || RR_CONFIG['default'];
}

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
async function markSent(key, ttl=4*3600) { await kvSet(`sent:${key}`, 1, ttl); }
async function getActiveSignals() { return (await kvGet('active_signals')) || {}; }
async function saveActiveSignals(s) { await kvSet('active_signals', s, 7*86400); }
async function getPerformance() {
  return (await kvGet('performance')) || {total:0,wins:0,losses:0,t1Hits:0,t2Hits:0,t3Hits:0,slHits:0,totalR:0};
}
async function savePerformance(p) { await kvSet('performance', p, 365*86400); }

// ── Massive API ──
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
function fetchYahoo(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function parseDays(range) {
  const n = parseInt(range);
  if (range.endsWith('d')) return n;
  if (range.endsWith('m')) return n * 30;
  if (range.endsWith('y')) return n * 365;
  return 60;
}

// ── جلب بيانات فريم واحد ──
async function fetchBars(symbol, intervalKey) {
  const cfg = MASSIVE_INTERVAL[intervalKey];
  if (!cfg) return null;
  const to   = new Date().toISOString().split('T')[0];
  const from = new Date(Date.now() - parseDays(cfg.range)*86400000).toISOString().split('T')[0];
  const mSym = MASSIVE_MAP[symbol];

  // Massive API
  try {
    let path;
    if (mSym?.market === 'futures') {
      path = `/v2/aggs/ticker/${mSym.ticker}/range/${cfg.multiplier}/${cfg.timespan}/${from}/${to}?limit=500&adjusted=true`;
    } else if (mSym?.market === 'indices') {
      path = `/v2/aggs/ticker/I:${mSym.ticker}/range/${cfg.multiplier}/${cfg.timespan}/${from}/${to}?limit=500`;
    } else {
      path = `/v2/aggs/ticker/${symbol}/range/${cfg.multiplier}/${cfg.timespan}/${from}/${to}?limit=500&adjusted=true`;
    }
    const json = await fetchMassive(path);
    if (json.results && json.results.length >= 20) {
      return {
        closes: json.results.map(b=>b.c), highs: json.results.map(b=>b.h),
        lows:   json.results.map(b=>b.l), vols:  json.results.map(b=>b.v),
        price:  json.results[json.results.length-1].c, source: 'massive'
      };
    }
  } catch(e) {}

  // Yahoo fallback
  try {
    const yfSym = YAHOO_MAP[symbol] || symbol;
    const yfInterval = {'5min':'5m','15min':'15m','1hour':'1h','4hour':'1h','1day':'1d'}[intervalKey]||'1d';
    const yfRange    = {'5min':'5d','15min':'14d','1hour':'60d','4hour':'60d','1day':'1y'}[intervalKey]||'1y';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=${yfInterval}&range=${yfRange}`;
    const json = await fetchYahoo(url);
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const vi = q.close.map((v,i)=>v!==null?i:-1).filter(i=>i>=0);
    if (vi.length < 20) return null;
    return {
      closes: vi.map(i=>q.close[i]), highs: vi.map(i=>q.high[i]),
      lows:   vi.map(i=>q.low[i]),   vols:  vi.map(i=>q.volume?.[i]||0),
      price:  result.meta.regularMarketPrice || q.close[vi[vi.length-1]], source: 'yahoo'
    };
  } catch(e) { return null; }
}

// ── السعر الحالي ──
async function getCurrentPrice(symbol) {
  try {
    const mSym = MASSIVE_MAP[symbol];
    let path;
    if (mSym?.market === 'futures')  path = `/v2/snapshot/locale/us/markets/futures/tickers/${mSym.ticker}`;
    else if (mSym?.market === 'indices') path = `/v2/snapshot/locale/us/markets/indices/tickers/I:${mSym.ticker}`;
    else path = `/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`;
    const json = await fetchMassive(path);
    const price = json?.ticker?.day?.c || json?.ticker?.lastTrade?.p || json?.value;
    if (price) return parseFloat(price);
  } catch(e) {}
  try {
    const yfSym = YAHOO_MAP[symbol] || symbol;
    const json = await fetchYahoo(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1m&range=1d`);
    return json?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch(e) { return null; }
}

// ── Market Open ──
function isMarketOpen(symbol) {
  if (NO_FILTER_SYMBOLS.has(symbol)) return { open:true, session:'24/7' };
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US', { timeZone:'Asia/Riyadh' }));
  const totalMin = riyadh.getHours()*60+riyadh.getMinutes();
  const day = riyadh.getDay();
  if (day===0||day===6) return { open:false, session:'weekend' };
  const open=16*60+30, close=22*60;
  if (totalMin>=open&&totalMin<close) {
    let session='midday';
    if (totalMin<open+90) session='🔥 Open Killzone';
    else if (totalMin>=20*60+30) session='🔥 Power Hour';
    return { open:true, session };
  }
  return { open:false, session:'closed' };
}

async function checkMarketOpenClose() {
  const now = new Date();
  const riyadh = new Date(now.toLocaleString('en-US',{timeZone:'Asia/Riyadh'}));
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
    const body = JSON.stringify({chat_id:CHAT_ID, text:message, parse_mode:'HTML'});
    const req = https.request({
      hostname:'api.telegram.org',
      path:`/bot${BOT_TOKEN}/sendMessage`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    }, (res) => {
      let data=''; res.on('data',c=>data+=c);
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
  return {macd:ema12-ema26,bullish:ema12>ema26};
}
function calcBB(p,n=20,mult=2){
  if(p.length<n)return null;
  const slice=p.slice(-n),mean=slice.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(slice.reduce((a,b)=>a+(b-mean)**2,0)/n);
  return {upper:mean+mult*std,middle:mean,lower:mean-mult*std};
}
function calcStochRSI(p,n=14){
  const rsiArr=[];
  for(let i=n;i<=p.length;i++){const r=calcRSI(p.slice(0,i),n);if(r!==null)rsiArr.push(r);}
  if(rsiArr.length<n)return null;
  const recent=rsiArr.slice(-n),min=Math.min(...recent),max=Math.max(...recent);
  if(max===min)return 50;
  return((rsiArr[rsiArr.length-1]-min)/(max-min))*100;
}
function calcVolProfile(vols){
  if(!vols||vols.length<10)return null;
  const avg=vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(20,vols.length);
  const last=vols[vols.length-1];
  return{aboveAvg:last>avg*1.5,ratio:(last/avg).toFixed(2)};
}
function calcPowerZones(highs,lows,atr){
  const n=Math.min(130,highs.length),za=atr*0.5;
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
function calcRiskReward(signal,price,closes,highs,lows,atr,zones,htfBull,htfBear,symbol){
  const{resTop,resBot,supTop,supBot}=zones;
  const isCT=signal==='CALL'?htfBear:htfBull;
  const ema9=calcEMA(closes,9)||price,ema21=calcEMA(closes,21)||price;
  if(isCT&&Math.abs(ema9-ema21)/atr>2.0)return null;

  // معاملات SL/TP حسب الرمز
  const cfg=getRRConfig(symbol||'default');
  const slMult  = isCT ? cfg.sl*1.5 : cfg.sl;
  const t1Mult  = cfg.t1;
  const t2Mult  = cfg.t2;
  const t3Mult  = cfg.t3;

  let entry,stop,risk,t1,t2,t3,sigType;
  if(signal==='CALL'){
    entry=price;
    stop=isCT?entry-atr*slMult:Math.min(supBot-atr*0.2,entry-atr*slMult);
    stop=Math.max(stop,entry-atr*(slMult*1.5)); // حد أقصى للـ SL
    risk=entry-stop;if(risk<=0)return null;
    // T1: مستوى المقاومة الأول أو ATR×t1Mult
    t1=resBot>entry?Math.min(resBot,entry+atr*t1Mult):entry+atr*t1Mult;
    t2=resTop>t1?Math.min(resTop,entry+atr*t2Mult):entry+atr*t2Mult;
    t3=entry+atr*t3Mult;
    sigType=isCT?'⚠️ CALL (عكسي)':'📈 CALL';
  }else{
    entry=price;
    stop=isCT?entry+atr*slMult:Math.max(resTop+atr*0.2,entry+atr*slMult);
    stop=Math.min(stop,entry+atr*(slMult*1.5));
    risk=stop-entry;if(risk<=0)return null;
    t1=supTop<entry?Math.max(supTop,entry-atr*t1Mult):entry-atr*t1Mult;
    t2=supBot<t1?Math.max(supBot,entry-atr*t2Mult):entry-atr*t2Mult;
    t3=entry-atr*t3Mult;
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

// ── تحليل فريم واحد — يُرجع الاتجاه والإشارة ──
async function analyzeFrame(symbol, intervalKey) {
  const bars = await fetchBars(symbol, intervalKey);
  if (!bars || bars.closes.length < 30) return null;

  const {closes, highs, lows, vols, price} = bars;
  const rsi      = calcRSI(closes);
  const atr      = calcATR(highs,lows,closes,14) || price*0.01;
  const ema9     = calcEMA(closes,9)  || price;
  const ema21    = calcEMA(closes,21) || price;
  const ema50    = calcEMA(closes,50);
  const sma200   = calcSMA(closes,200);
  const macd     = calcMACD(closes);
  const bb       = calcBB(closes);
  const stochRsi = calcStochRSI(closes);
  const vol      = calcVolProfile(vols);
  const htfBull  = ema9>ema21, htfBear=ema9<ema21;
  const zones    = calcPowerZones(highs,lows,atr);
  const falseBreak = detectFalseBreakout(closes,highs,lows,zones.supTop,zones.supBot,zones.resTop,zones.resBot);

  // حساب الاتجاه العام للفريم (trend direction)
  let trendScore = 0;
  if (price>ema9&&ema9>ema21) trendScore+=3;
  else if (price<ema9&&ema9<ema21) trendScore-=3;
  if (ema50&&price>ema50) trendScore+=2; else if (ema50) trendScore-=2;
  if (sma200&&price>sma200) trendScore+=1; else if (sma200) trendScore-=1;
  if (macd?.bullish) trendScore+=1; else if (macd) trendScore-=1;

  const trend = trendScore>=3?'bull':trendScore<=-3?'bear':'neutral';

  // إشارة الدخول (entry signal) — أدق
  let entryScore = 0;
  if (rsi&&rsi>55&&rsi<70) entryScore+=2;
  else if (rsi&&rsi<45&&rsi>30) entryScore-=2;
  else if (rsi&&rsi>=70) entryScore-=1;
  else if (rsi&&rsi<=30) entryScore+=2;
  if (stochRsi!==null&&stochRsi<20) entryScore+=2;
  else if (stochRsi!==null&&stochRsi>80) entryScore-=2;
  if (bb&&price<=bb.lower) entryScore+=2;
  else if (bb&&price>=bb.upper) entryScore-=2;
  if (vol?.aboveAvg) entryScore+=1;

  const changePct = ((price-(closes[closes.length-2]||price))/(closes[closes.length-2]||price)*100);
  if (changePct>0.5) entryScore+=1; else if (changePct<-0.5) entryScore-=1;

  const entrySignal = entryScore>=3?'CALL':entryScore<=-3?'PUT':null;

  return {
    symbol, intervalKey, price, trend, trendScore,
    entrySignal, entryScore, rsi, stochRsi, macd,
    bb, vol, atr, zones, highs, lows, closes,
    htfBull, htfBear, falseBreak,
    changePct: changePct.toFixed(2),
    source: bars.source
  };
}


function intervalWeight(iv) {
  return {'5min':1,'15min':2,'1hour':3,'4hour':4,'1day':5}[iv]||3;
}

// ── تحليل مستقل للمؤشرات السريعة ──
// كل فريم مستقل — أي إشارة قوية تكفي بدون شرط توافق الفريمات الكبيرة
async function analyzeIndependentFrames(symbol, cfg) {
  const allFrames = [...cfg.trend_frames, ...cfg.entry_frames];
  const results = await Promise.all(
    allFrames.map(iv => analyzeFrame(symbol, iv).catch(()=>null))
  );
  const valid = results.filter(r=>r!==null);
  if (!valid.length) return null;

  // نبحث عن أقوى إشارة على أي فريم — score مطلق أعلى
  // لكن نشترط score ≥ 4 (قوي) أو انعكاس واضح
  const signals = valid.filter(r => {
    const absScore = Math.abs(r.entryScore);
    const strongReversal =
      (r.entrySignal === 'PUT' && r.rsi && r.rsi < 42) ||
      (r.entrySignal === 'CALL' && r.rsi && r.rsi > 58);
    return absScore >= 4 || (absScore >= 3 && strongReversal);
  });

  if (!signals.length) return null;

  // رتّب: الأقوى score أولاً، ثم الفريم الأصغر (للدخول الأسرع)
  signals.sort((a,b) => {
    const scoreDiff = Math.abs(b.entryScore) - Math.abs(a.entryScore);
    if (Math.abs(scoreDiff) > 1) return scoreDiff;
    return intervalWeight(a.intervalKey) - intervalWeight(b.intervalKey);
  });

  const best = signals[0];
  if (!best.entrySignal) return null;

  // تحقق من أن الفريمات الأخرى لا تتعارض بشكل حاد
  const oppositeCount = valid.filter(r =>
    r.entrySignal && r.entrySignal !== best.entrySignal && Math.abs(r.entryScore) >= 4
  ).length;

  // إذا فريمان أو أكثر بقوة معاكسة → تجاهل
  if (oppositeCount >= 2) return null;

  const rr = calcRiskReward(
    best.entrySignal, best.price,
    best.closes, best.highs, best.lows,
    best.atr, best.zones,
    best.htfBull, best.htfBear, symbol
  );
  if (!rr) return null;

  // ملخص الأطر
  const frameSummary = valid.map(r =>
    `${TF_LABEL[r.intervalKey]||r.intervalKey}: ${r.entrySignal==='CALL'?'🟢':r.entrySignal==='PUT'?'🔴':'⚪'}`
  ).join(' | ');

  const confidence = Math.min(92, Math.round(50 + Math.abs(best.entryScore) * 7));
  const tags = [];
  if (best.falseBreak?.startsWith(best.entrySignal)) tags.push('كسر وهمي');
  if (oppositeCount === 0) tags.push('لا تعارض');
  const tagStr = tags.length>0?' | '+tags.join(' | '):'';

  return {
    symbol, signal: best.entrySignal, sigType: rr.sigType,
    price: best.price.toFixed(2),
    changePct: best.changePct,
    rsi: best.rsi?.toFixed(1)||'—',
    confidence, rr, zones: best.zones,
    atr: best.atr.toFixed(2),
    dominantTrend: best.entrySignal==='CALL'?'bull':'bear',
    avgTrendScore: best.entryScore.toFixed(1),
    trendAgreement: `${valid.filter(r=>r.entrySignal===best.entrySignal).length}/${valid.length}`,
    trendSummary: frameSummary,
    entryFrameLabel: TF_LABEL[best.intervalKey]||best.intervalKey,
    tagStr, tags, source: best.source,
    intervalKey: best.intervalKey,
    isIndependent: true
  };
}

// ── MTF Confluence الحقيقي ──
async function analyzeWithMTFConfluence(symbol) {
  const cfg = MTF_CONFIG[symbol] || MTF_CONFIG['default'];
  if (!isMarketOpen(symbol).open) return null;

  // ── المؤشرات السريعة: منطق مستقل ──
  if (FAST_INDICES.has(symbol)) {
    return analyzeIndependentFrames(symbol, cfg);
  }

  // ── الأسهم: MTF Confluence صارم ──

  // 1. حلل فريمات الاتجاه (trend frames)
  const trendResults = await Promise.all(
    cfg.trend_frames.map(iv => analyzeFrame(symbol, iv).catch(()=>null))
  );
  const validTrends = trendResults.filter(r=>r!==null);
  if (!validTrends.length) return null;

  // 2. تحديد الاتجاه السائد من الفريمات الأكبر
  // نعطي وزن أعلى للفريم الأكبر
  const frameWeight = {'1day':3,'4hour':2,'1hour':1,'15min':0.5,'5min':0.25};
  let weightedTrendScore = 0, totalWeight = 0;
  for (const r of validTrends) {
    const w = frameWeight[r.intervalKey]||1;
    weightedTrendScore += r.trendScore * w;
    totalWeight += w;
  }
  const avgTrendScore = weightedTrendScore / totalWeight;
  const dominantTrend = avgTrendScore >= 2 ? 'bull' : avgTrendScore <= -2 ? 'bear' : 'neutral';

  // 3. إذا الاتجاه محايد — لا إشارة
  if (dominantTrend === 'neutral') return null;

  // 4. تحقق: هل فريمات الاتجاه متوافقة؟ (على الأقل الأكبر يتفق)
  const biggestTrend = validTrends[0]; // أكبر فريم
  if (!biggestTrend || biggestTrend.trend === 'neutral') return null;

  // 5. حلل فريمات الدخول
  const entryResults = await Promise.all(
    cfg.entry_frames.map(iv => analyzeFrame(symbol, iv).catch(()=>null))
  );
  const validEntries = entryResults.filter(r=>r!==null);
  if (!validEntries.length) return null;

  // 6. ابحث عن إشارة دخول تتوافق مع الاتجاه السائد
  const requiredSignal = dominantTrend === 'bull' ? 'CALL' : 'PUT';
  let bestEntry = null;

  for (const entry of validEntries) {
    // الإشارة يجب أن تتوافق مع الاتجاه الكبير
    const signalMatch = entry.entrySignal === requiredSignal;
    // أو كسر وهمي في نفس الاتجاه
    const falseBreakMatch = entry.falseBreak && entry.falseBreak.startsWith(requiredSignal);

    if (signalMatch || falseBreakMatch) {
      if (!bestEntry || Math.abs(entry.entryScore) > Math.abs(bestEntry.entryScore)) {
        bestEntry = entry;
      }
    }
  }

  if (!bestEntry) return null;

  // 7. احسب RR من بيانات الدخول
  const rr = calcRiskReward(
    requiredSignal, bestEntry.price,
    bestEntry.closes, bestEntry.highs, bestEntry.lows,
    bestEntry.atr, bestEntry.zones,
    bestEntry.htfBull, bestEntry.htfBear, symbol
  );
  if (!rr) return null;

  // 8. حساب الثقة بناءً على قوة التوافق
  const trendAgreement = validTrends.filter(r=>r.trend===dominantTrend).length;
  const trendAgreementPct = trendAgreement / validTrends.length;
  const baseConfidence = Math.min(95, Math.round(50 + Math.abs(avgTrendScore)*8));
  const confidence = Math.round(baseConfidence * (0.7 + 0.3*trendAgreementPct));

  // تاغات
  const tags = [];
  if (bestEntry.falseBreak?.startsWith(requiredSignal)) tags.push('كسر وهمي');
  if (trendAgreement === validTrends.length) tags.push('إجماع الاتجاه');
  const tagStr = tags.length>0?' | '+tags.join(' | '):'';

  // ملخص الأطر
  const trendSummary = validTrends.map(r=>`${TF_LABEL[r.intervalKey]||r.intervalKey}: ${r.trend==='bull'?'🟢':r.trend==='bear'?'🔴':'⚪'}`).join(' | ');
  const entryFrameLabel = TF_LABEL[bestEntry.intervalKey] || bestEntry.intervalKey;

  return {
    symbol, signal: requiredSignal, sigType: rr.sigType,
    price: bestEntry.price.toFixed(2),
    changePct: bestEntry.changePct,
    rsi: bestEntry.rsi?.toFixed(1)||'—',
    confidence, rr, zones: bestEntry.zones,
    atr: bestEntry.atr.toFixed(2),
    dominantTrend, avgTrendScore: avgTrendScore.toFixed(1),
    trendAgreement: `${trendAgreement}/${validTrends.length}`,
    trendSummary, entryFrameLabel,
    tagStr, tags, source: bestEntry.source,
    intervalKey: bestEntry.intervalKey
  };
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
    const events = await new Promise((resolve,reject)=>{
      https.get('https://nfs.faireconomy.media/ff_calendar_thisweek.json',{headers:{'User-Agent':'Mozilla/5.0'}},(res)=>{
        let data='';res.on('data',c=>data+=c);
        res.on('end',()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
      }).on('error',reject);
    });
    if(!Array.isArray(events))return 0;
    const now=new Date();let sent=0;
    for(const e of events){
      if(!e.title||!e.actual)continue;
      if(e.impact!=='High'&&e.impact!=='Medium')continue;
      const eventTime=new Date(e.date),diffMin=(now-eventTime)/60000;
      if(diffMin<0||diffMin>15)continue;
      const key=`macro_${e.title}_${e.date}`;
      if(await isSent(key))continue;
      await markSent(key);
      let fn=MACRO_RULES['default'];
      for(const k of Object.keys(MACRO_RULES)){if(k!=='default'&&e.title.includes(k)){fn=MACRO_RULES[k];break;}}
      const impact=fn(parseFloat(e.actual),parseFloat(e.forecast));
      const timeStr=eventTime.toLocaleTimeString('ar-SA',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Riyadh'});
      await sendTelegram(`🌍 <b>بيانة اقتصادية!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${e.title}</b>\n${e.impact==='High'?'🔴 عالٍ':'🟡 متوسط'} | ⏰ ${timeStr}\n━━━━━━━━━━━━━━━\n📊 الفعلي: <b>${e.actual}</b>\n🎯 التوقعات: ${e.forecast||'—'}\n📅 السابق: ${e.previous||'—'}\n━━━━━━━━━━━━━━━\n${impact.label}\n💡 ${impact.reason}\n━━━━━━━━━━━━━━━\n🤖 <i>TIH Trading Hub</i>`);
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
        '🤖 <b>TIH Trading Hub v8.1</b>\n━━━━━━━━━━━━━━━\n'+
        '✅ نظام التنبيهات يعمل!\n\n'+
        '📋 القائمة:\n'+DEFAULT_WATCHLIST.map(s=>`• ${s}`).join('\n')+'\n\n'+
        '🗄️ Upstash Redis ✅\n'+
        '📊 Massive API ✅\n'+
        '📈 EMA+RSI+MACD+BB+StochRSI+Volume\n'+
        '🔀 MTF Confluence v2: الاتجاه أولاً → الدخول ثانياً\n'+
        '⏱️ US500: 5M+15M+1H إشارة | 4H+يومي اتجاه\n'+
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
      `📈 إجمالي: <b>${perf.total}</b> | ✅ ناجح: <b>${perf.wins}</b> | ❌ فاشل: <b>${perf.losses}</b>\n`+
      `🎯 Win Rate: <b>${wr}%</b>\n━━━━━━━━━━━━━━━\n`+
      `🏆 T1:${perf.t1Hits} T2:${perf.t2Hits} T3:${perf.t3Hits} SL:${perf.slHits}\n`+
      `💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b> | نشطة: ${Object.keys(active).length}\n`+
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
      const data=await analyzeWithMTFConfluence(sym);
      if(!data)return;

      // منع التكرار
      const sigKey=`sig_${sym}_${data.signal}_${data.intervalKey}_${new Date().toISOString().slice(0,13)}`;
      if(await isSent(sigKey))return;
      await markSent(sigKey);

      alerts.push(data);
      const perf=await getPerformance();
      perf.total++;
      await savePerformance(perf);

      const rr=data.rr;
      const ctWarn=rr.isCT?'\n⚠️ <i>إشارة عكسية — حجم أصغر</i>':'';
      const mStatus=isMarketOpen(sym);
      const sessionTag=mStatus.session!=='24/7'?`\n⏰ ${mStatus.session}`:'';
      const sourceTag=data.source==='massive'?'\n📡 Massive API':'';

      // حفظ في Redis
      const activeSignals=await getActiveSignals();
      activeSignals[`${sym}_${Date.now()}`]={
        symbol:sym,signal:data.signal,sigType:rr.sigType,
        entry:rr.entry,stop:rr.stop,t1:rr.t1,t2:rr.t2,t3:rr.t3,
        t1Pct:rr.t1Pct,t2Pct:rr.t2Pct,risk:rr.risk,
        t1Hit:false,t2Hit:false,t3Hit:false,slHit:false,openedAt:Date.now()
      };
      await saveActiveSignals(activeSignals);

      await sendTelegram(
        `${data.signal==='CALL'?'🟢':'🔴'} <b>${rr.sigType}${data.tagStr}</b>\n`+
        `━━━━━━━━━━━━━━━\n`+
        `📌 <b>${data.symbol}</b>\n`+
        `💰 السعر: <b>$${data.price}</b> (${parseFloat(data.changePct)>=0?'+':''}${data.changePct}%)\n`+
        `📈 RSI: ${data.rsi} | 🔥 الثقة: ${data.confidence}%\n`+
        `\n🔀 <b>MTF Confluence:</b>\n${data.trendSummary}\n`+
        `📊 الاتجاه: ${data.dominantTrend==='bull'?'🟢 صاعد':'🔴 هابط'} (${data.trendAgreement} متوافق)\n`+
        `⏱️ نقطة الدخول: ${data.entryFrameLabel}\n`+
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
        (sourceTag?'\n'+sourceTag:'')+
        `\n━━━━━━━━━━━━━━━\n🤖 <i>TIH v8.1 — MTF Confluence</i>`
      );
    }catch(e){errors.push(`${sym}: ${e.message}`);}
  }));

  const macroAlerts=await checkMacroEvents();
  const activeSignals=await getActiveSignals();

  return res.status(200).json({
    ok:true,checked:symbols.length,
    newAlerts:alerts.length,perfAlerts,macroAlerts,
    activeSignals:Object.keys(activeSignals).length,
    signals:alerts.map(a=>({symbol:a.symbol,signal:a.signal,confidence:a.confidence,trendAgreement:a.trendAgreement,entryFrame:a.intervalKey,rr1:a.rr?.rr1})),
    errors
  });
};
