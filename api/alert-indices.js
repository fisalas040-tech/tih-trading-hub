const https = require('https');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

const INDICES = {
  'US500': { yahoo: 'ES=F',    name: 'S&P 500',    tv: 'OANDA:SPX500USD' },
  'NDX':   { yahoo: '^NDX',    name: 'Nasdaq 100',  tv: 'NASDAQ:NDX'      },
  'DJI':   { yahoo: '^DJI',    name: 'Dow Jones',   tv: 'DJ:DJI'          },
  'BTC':   { yahoo: 'BTC-USD', name: 'Bitcoin',     tv: 'CRYPTO:BTCUSD'   },
  'ETH':   { yahoo: 'ETH-USD', name: 'Ethereum',    tv: 'CRYPTO:ETHUSD'   },
  'XAUUSD':{ yahoo: 'GC=F',    name: 'Gold',        tv: 'OANDA:XAUUSD'    },
};

const CRYPTO_SYMS = new Set(['BTC','ETH']);
const TV_INTERVAL = { '1H':'60', '15M':'15', '5M':'5', '4H':'240', '1D':'D' };

const INTERVALS = {
  weekly: { interval: '1wk', range: '1y'  },
  trend:  { interval: '1h',  range: '1mo' },
  entry:  { interval: '15m', range: '5d'  },
  fast:   { interval: '5m',  range: '2d'  },
};

const ATR_MULT = { sl: 1.5, t1: 2.0, t2: 3.5, t3: 5.0 };
const MIN_SCORE = 12;

let vixCache = { value: null, ts: 0 };

// Yahoo Finance getBars
async function getBars(sym, interval, range) {
  const yahooSym = sym === '^VIX' ? '^VIX' : (INDICES[sym]?.yahoo || sym);

  return new Promise((resolve) => {
    const path = `/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${interval}&range=${range}`;
    https.get({
      hostname: 'query1.finance.yahoo.com',
      path,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(d);
          const q = json?.chart?.result?.[0];
          if (!q || !q.indicators?.quote?.[0]) { resolve(null); return; }
          const quotes = q.indicators.quote[0];
          const timestamps = q.timestamp || [];
          if (timestamps.length < 5) { resolve(null); return; }
          const raw_c = quotes.close  || [];
          const raw_h = quotes.high   || [];
          const raw_l = quotes.low    || [];
          const raw_v = quotes.volume || [];
          // تنظيف القيم الفارغة
          const valid = raw_c.map((c,i) => c != null && c > 0 && raw_h[i] > 0 && raw_l[i] > 0);
          const closes = raw_c.filter((_,i) => valid[i]);
          const highs  = raw_h.filter((_,i) => valid[i]);
          const lows   = raw_l.filter((_,i) => valid[i]);
          const vols   = raw_v.filter((_,i) => valid[i]).map(v => v || 0);
          if (closes.length < 5) { resolve(null); return; }
          resolve({ closes, highs, lows, vols, price: closes[closes.length-1], ts: timestamps[timestamps.length-1] });
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function isKillZone() {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (mins >= 420 && mins <= 600) || (mins >= 810 && mins <= 960);
}

function isMarketOpen(sym) {
  if (CRYPTO_SYMS.has(sym)) return true;
  const now = new Date();
  const day = now.getUTCDay();
  return day !== 0 && day !== 6;
}

async function getVIX() {
  if (vixCache.value && (Date.now() - vixCache.ts) < 15 * 60 * 1000) return vixCache.value;
  try {
    const bars = await getBars('^VIX', '1d', '5d');
    if (bars && bars.price) { vixCache = { value: bars.price, ts: Date.now() }; return bars.price; }
  } catch(e) {}
  return null;
}

function hasVolumeConfirmation(bars) {
  if (!bars.vols || bars.vols.length < 20) return true;
  const vols = bars.vols.filter(v => v > 0);
  if (vols.length < 10) return true;
  const avgVol = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, vols.length);
  return vols[vols.length-1] >= avgVol * 1.0;
}

function hasLiquiditySweep(bars, signal) {
  if (!bars || bars.highs.length < 5) return true;
  const prevHigh = Math.max(...bars.highs.slice(-6,-1));
  const prevLow  = Math.min(...bars.lows.slice(-6,-1));
  if (signal === 'CALL') return Math.min(...bars.lows.slice(-3)) < prevLow * 0.999;
  else return Math.max(...bars.highs.slice(-3)) > prevHigh * 1.001;
}

function analyzeWeeklyTrend(weekBars) {
  if (!weekBars || weekBars.closes.length < 5) return 'neutral';
  const e8  = ema(weekBars.closes, 8);
  const e21 = ema(weekBars.closes, 21);
  if (!e8 || !e21) return 'neutral';
  if (weekBars.price > e8 && e8 > e21) return 'bull';
  if (weekBars.price < e8 && e8 < e21) return 'bear';
  return 'neutral';
}

async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}
async function kvSet(key, val, ex=86400) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}?ex=${ex}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  } catch(e) {}
}
async function kvDel(key) {
  try { await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }); } catch(e) {}
}

async function saveLog(entry) {
  try {
    const log = (await kvGet('idx_log')) || [];
    log.unshift({ ...entry, closedAt: Date.now() });
    if (log.length > 200) log.splice(200);
    await kvSet('idx_log', log, 90*86400);
  } catch(e) {}
}

function tg(msg) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode: 'HTML' });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function ema(p, n) {
  if (p.length < n) return null;
  const k = 2/(n+1);
  let e = p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i=n; i<p.length; i++) e = p[i]*k + e*(1-k);
  return e;
}
function rsi(p, n=14) {
  if (p.length < n+1) return null;
  let g=0, l=0;
  for (let i=1; i<=n; i++) { const d=p[i]-p[i-1]; d>0?g+=d:l-=d; }
  let ag=g/n, al=l/n;
  for (let i=n+1; i<p.length; i++) {
    const d=p[i]-p[i-1];
    d>0?(ag=(ag*(n-1)+d)/n,al=al*(n-1)/n):(ag=ag*(n-1)/n,al=(al*(n-1)-d)/n);
  }
  return al===0?100:100-(100/(1+ag/al));
}
function atr(h, l, c, n=14) {
  if (c.length < n+1) return null;
  const tr = [];
  for (let i=1; i<c.length; i++) tr.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return tr.slice(-n).reduce((a,b)=>a+b,0)/n;
}
function macd(p) {
  const e12=ema(p,12), e26=ema(p,26);
  if (!e12||!e26) return null;
  return { val: e12-e26, bull: e12>e26 };
}
function bb(p, n=20) {
  if (p.length<n) return null;
  const s=p.slice(-n), m=s.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/n);
  return { upper:m+2*sd, mid:m, lower:m-2*sd };
}

function detectFVG_idx(highs, lows, price, signal) {
  const len=highs.length; if(len<3)return false;
  const lb=Math.min(len-1,8);
  for(let i=len-1;i>=len-lb;i--){
    if(i<2)break;
    const sz=signal==='CALL'?lows[i]-highs[i-2]:lows[i-2]-highs[i];
    if(sz<=0||sz/price*100<0.05)continue;
    if(signal==='CALL'&&price<=lows[i]*1.002&&price>=highs[i-2]*0.998)return true;
    if(signal==='PUT' &&price>=highs[i]*0.998&&price<=lows[i-2]*1.002)return true;
  }
  return false;
}
function detectIFVG_idx(highs, lows, closes, price, signal) {
  const len=highs.length; if(len<5)return false;
  const lb=Math.min(len-1,15);
  for(let i=len-3;i>=len-lb;i--){
    if(i<2)break;
    const bFvg=lows[i]-highs[i-2], rFvg=lows[i-2]-highs[i];
    let top,bot,wasBull;
    if(bFvg>0&&bFvg/price*100>=0.05){top=lows[i];bot=highs[i-2];wasBull=true;}
    else if(rFvg>0&&rFvg/price*100>=0.05){top=lows[i-2];bot=highs[i];wasBull=false;}
    else continue;
    let mit=false;
    for(let j=i+1;j<len-1;j++){if(closes[j]>bot&&closes[j]<top){mit=true;break;}}
    if(!mit)continue;
    if(signal==='CALL'&&!wasBull&&price>=bot*0.998&&price<=top*1.002)return true;
    if(signal==='PUT' &&wasBull &&price>=bot*0.998&&price<=top*1.002)return true;
  }
  return false;
}
function detectOB_idx(highs, lows, closes, price, signal) {
  const len=closes.length; if(len<4)return false;
  const lb=Math.min(len-2,8);
  for(let i=len-2;i>=len-lb;i--){
    if(i<1)break;
    const h1=highs[i-1],l1=lows[i-1],c1=closes[i-1];
    const h2=highs[i],l2=lows[i],c2=closes[i];
    const prev=closes[i-2]||c1;
    if(signal==='CALL'){if(c1<prev*1.001&&c2>h1&&l2<l1&&price>=l1*0.999&&price<=h1*1.001)return true;}
    else{if(c1>prev*0.999&&c2<l1&&h2>h1&&price>=l1*0.999&&price<=h1*1.001)return true;}
  }
  return false;
}
function detectBOS_idx(highs, lows, closes, signal) {
  const len=closes.length; if(len<12)return false;
  const rH=highs.slice(-11,-1), rL=lows.slice(-11,-1);
  const last=closes[len-1];
  return signal==='CALL'?last>Math.max(...rH):last<Math.min(...rL);
}
function detectRej_idx(highs, lows, closes, signal) {
  const len=closes.length;
  for(let i=len-1;i>=Math.max(0,len-2);i--){
    const o=closes[i-1]||closes[i],c=closes[i],h=highs[i],l=lows[i];
    const range=h-l; if(range===0)continue;
    const body=Math.abs(c-o)/range;
    const upper=(h-Math.max(o,c))/range;
    const lower=(Math.min(o,c)-l)/range;
    if(signal==='CALL'&&lower>=0.55&&body<=0.40)return true;
    if(signal==='PUT' &&upper>=0.55&&body<=0.40)return true;
  }
  return false;
}
function calcICT_idx(trendBars, entryBars, fastBars, price, signal) {
  let score=0; const details=[];
  if(entryBars&&detectFVG_idx(entryBars.highs,entryBars.lows,price,signal)){score+=3;details.push('FVG✅');}
  if(trendBars&&detectIFVG_idx(trendBars.highs,trendBars.lows,trendBars.closes,price,signal)){score+=3;details.push('IFVG✅');}
  if(trendBars&&detectOB_idx(trendBars.highs,trendBars.lows,trendBars.closes,price,signal)){score+=3;details.push('OB✅');}
  if(entryBars&&detectBOS_idx(entryBars.highs,entryBars.lows,entryBars.closes,signal)){score+=2;details.push('BOS✅');}
  if(fastBars&&detectRej_idx(fastBars.highs,fastBars.lows,fastBars.closes,signal)){score+=2;details.push('REJ✅');}
  return {score,details};
}

function analyzeFrame(bars, minScore=MIN_SCORE) {
  const { closes, highs, lows, price } = bars;
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50);
  const r=rsi(closes), m=macd(closes), b=bb(closes);
  const a=atr(highs,lows,closes,14);
  if (!e9||!e21||!r||!a) return null;
  let bull=0, bear=0; const reasons=[];
  if(price>e9&&e9>e21){bull+=3;reasons.push('EMA↑');}
  else if(price<e9&&e9<e21){bear+=3;reasons.push('EMA↓');}
  if(e50){if(price>e50){bull+=2;reasons.push('فوق EMA50');}else{bear+=2;reasons.push('تحت EMA50');}}
  if(r>58&&r<72){bull+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<42&&r>28){bear+=2;reasons.push(`RSI ${r.toFixed(0)}`);}
  else if(r<=28){bull+=3;reasons.push(`RSI تشبع بيع ${r.toFixed(0)}`);}
  else if(r>=72){bear+=2;reasons.push(`RSI تشبع شراء ${r.toFixed(0)}`);}
  if(m?.bull){bull+=2;reasons.push('MACD↑');}else if(m){bear+=2;reasons.push('MACD↓');}
  if(b){
    if(price<=b.lower){bull+=3;reasons.push('BB دعم');}
    else if(price>=b.upper){bear+=3;reasons.push('BB مقاومة');}
    else if(price>b.mid)bull+=1; else bear+=1;
  }
  const prev=closes[closes.length-2]||price, chg=((price-prev)/prev)*100;
  if(chg>0.5){bull+=2;reasons.push(`زخم +${chg.toFixed(1)}%`);}
  else if(chg>0.2)bull+=1;
  else if(chg<-0.5){bear+=2;reasons.push(`زخم ${chg.toFixed(1)}%`);}
  else if(chg<-0.2)bear+=1;
  const signal=bull>=minScore?'CALL':bear>=minScore?'PUT':null;
  const trend=bull>bear?'bull':bear>bull?'bear':'neutral';
  return { signal, trend, bull, bear, rsi:r, atr:a, reasons, price, chg };
}

async function analyzeMTF(sym, vix) {
  if (!isMarketOpen(sym)) return null;
  if (!CRYPTO_SYMS.has(sym) && !isKillZone()) return null;
  const vixLevel = vix || 0;
  const cfg = INDICES[sym];
  const [weekBars, trendBars, entryBars, fastBars] = await Promise.all([
    CRYPTO_SYMS.has(sym) ? null : getBars(sym, INTERVALS.weekly.interval, INTERVALS.weekly.range),
    getBars(sym, INTERVALS.trend.interval, INTERVALS.trend.range),
    getBars(sym, INTERVALS.entry.interval, INTERVALS.entry.range),
    getBars(sym, INTERVALS.fast.interval,  INTERVALS.fast.range),
  ]);
  if (!trendBars) return null;
  if (!hasVolumeConfirmation(trendBars)) return null;
  const weeklyTrend = weekBars ? analyzeWeeklyTrend(weekBars) : 'neutral';
  const trendResult=analyzeFrame(trendBars);
  const entryResult=entryBars?analyzeFrame(entryBars):null;
  const fastResult=fastBars?analyzeFrame(fastBars):null;
  if (!trendResult) return null;
  const dominantTrend=trendResult.trend;
  if (dominantTrend==='neutral') return null;
  if (!CRYPTO_SYMS.has(sym) && weeklyTrend !== 'neutral' && weeklyTrend !== dominantTrend) return null;
  const requiredSignal=dominantTrend==='bull'?'CALL':'PUT';
  if (requiredSignal==='CALL' && trendResult.rsi > 75) return null;
  if (requiredSignal==='PUT'  && trendResult.rsi < 25) return null;
  let entryFrame=null, entryData=null;
  if(fastResult?.signal===requiredSignal){entryFrame='5M';entryData=fastResult;}
  else if(entryResult?.signal===requiredSignal){entryFrame='15M';entryData=entryResult;}
  else if(trendResult.signal===requiredSignal){entryFrame='1H';entryData=trendResult;}
  if (!entryFrame||!entryData) return null;
  const entryBarsCheck = entryBars || trendBars;
  if (!hasLiquiditySweep(entryBarsCheck, requiredSignal)) return null;
  const agreements=[
    trendResult.trend===dominantTrend,
    entryResult?.trend===dominantTrend,
    fastResult?.trend===dominantTrend,
    !CRYPTO_SYMS.has(sym) ? weeklyTrend===dominantTrend : true,
  ].filter(Boolean).length;
  const entryScore=entryData?(dominantTrend==='bull'?entryData.bull:entryData.bear):0;
  const trendScore2=dominantTrend==='bull'?trendResult.bull:trendResult.bear;
  const combinedScore=Math.round((entryScore+trendScore2)/2);
  const ict = calcICT_idx(trendBars, entryBars, fastBars, entryData.price||trendBars.price, requiredSignal);
  let grade,gradeLabel,successRate;
  const totalScore = combinedScore + (ict.score>=5?2:ict.score>=3?1:0);
  if(agreements>=3&&totalScore>=12){grade='S';gradeLabel='🔥 نسبة نجاح عالية جداً';successRate=85;}
  else if(agreements>=3||(agreements>=2&&totalScore>=10)){grade='A';gradeLabel='✅ نسبة نجاح عالية';successRate=72;}
  else return null;
  return {
    sym, signal:requiredSignal, dominantTrend, entryFrame,
    grade, gradeLabel, successRate,
    price:entryData.price||trendBars.price, atr:entryData.atr,
    trendRSI:trendResult.rsi?.toFixed(1), entryRSI:entryData.rsi?.toFixed(1),
    weeklyTrend, trendReasons:trendResult.reasons, entryReasons:entryData.reasons,
    agreements, totalFrames:4,
    trendScore:dominantTrend==='bull'?trendResult.bull:trendResult.bear,
    vix:vixLevel>0?vixLevel.toFixed(1):null,
    ictScore:ict.score, ictDetails:ict.details,
  };
}

function calcTargets(signal, price, atrVal) {
  const d=signal==='CALL'?1:-1;
  const sl=price-d*atrVal*ATR_MULT.sl;
  const t1=price+d*atrVal*ATR_MULT.t1;
  const t2=price+d*atrVal*ATR_MULT.t2;
  const t3=price+d*atrVal*ATR_MULT.t3;
  const risk=Math.abs(price-sl);
  return {
    sl:+sl.toFixed(2),t1:+t1.toFixed(2),t2:+t2.toFixed(2),t3:+t3.toFixed(2),
    slPct:((sl-price)/price*100).toFixed(2),
    t1Pct:((t1-price)/price*100).toFixed(2),
    rr1:(Math.abs(t1-price)/risk).toFixed(2),
    rr2:(Math.abs(t2-price)/risk).toFixed(2),
    rr3:(Math.abs(t3-price)/risk).toFixed(2),
  };
}

async function checkActiveSignals() {
  const active=(await kvGet('idx_active'))||{};
  const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0.0};
  let changed=false, notifs=0;
  for (const [id,sig] of Object.entries(active)) {
    try {
      const cfg=INDICES[sig.sym];
      if(!cfg){delete active[id];changed=true;continue;}
      const bars=await getBars(sig.sym,'5m','2d');
      const price=bars?.price;
      if(!price)continue;
      const isCall=sig.signal==='CALL';
      if((isCall&&price<=sig.sl)||(!isCall&&price>=sig.sl)){
        delete active[id]; perf.losses++; perf.totalR-=1; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'SL',r:-1,type:'index'});
        await tg(`🛑 <b>Stop Loss!</b>\n━━━━━━━━━━━━━━━\n📌 <b>${sig.sym}</b> — ${sig.signal==='CALL'?'📈 CALL':'📉 PUT'}\n💰 $${price.toFixed(2)}\n🛡️ SL: $${sig.sl}\n📊 -1R | WR: ${perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0}%\n🤖 <i>TIH Indices v5.2</i>`);
        notifs++; continue;
      }
      if(!sig.t1Hit&&((isCall&&price>=sig.t1)||(!isCall&&price<=sig.t1))){
        sig.t1Hit=true; sig.sl=sig.entry; perf.wins++; perf.totalR+=2; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T1',r:2,type:'index'});
        await tg(`🎯 <b>T1 تحقق! +2R</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T2: $${sig.t2} | T3: $${sig.t3}\n🔒 SL → BE\n🤖 <i>TIH Indices v5.2</i>`);
        notifs++;
      }
      if(sig.t1Hit&&!sig.t2Hit&&((isCall&&price>=sig.t2)||(!isCall&&price<=sig.t2))){
        sig.t2Hit=true; perf.totalR+=1.5; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T2',r:3.5,type:'index'});
        await tg(`🎯🎯 <b>T2 تحقق! +3.5R 🔥</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n⏭️ T3: $${sig.t3}\n🤖 <i>TIH Indices v5.2</i>`);
        notifs++;
      }
      if(sig.t2Hit&&!sig.t3Hit&&((isCall&&price>=sig.t3)||(!isCall&&price<=sig.t3))){
        delete active[id]; perf.totalR+=1.5; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'T3',r:5,type:'index'});
        await tg(`🏆🏆🏆 <b>T3 تحقق! +5R 💎</b>\n📌 <b>${sig.sym}</b>\n💰 $${price.toFixed(2)}\n🤖 <i>TIH Indices v5.2</i>`);
        notifs++; continue;
      }
      const age=Date.now()-(sig.openedAt||0);
      if(age>36*60*60*1000&&!sig.t1Hit){
        delete active[id]; changed=true;
        await saveLog({sym:sig.sym,signal:sig.signal,grade:sig.grade,entry:sig.entry,exit:price,result:'EXP',r:0,type:'index'});
        await tg(`⏰ <b>انتهت الإشارة</b>\n📌 <b>${sig.sym}</b> — 36س بدون T1\n🤖 <i>TIH Indices v5.2</i>`);
        notifs++; continue;
      }
      active[id]=sig;
    } catch(e) {}
  }
  if(changed){ await kvSet('idx_active',active,7*86400); await kvSet('idx_perf',perf,365*86400); }
  return notifs;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method==='OPTIONS') return res.status(200).end();
  const action = req.query.action || 'check';

  if (action==='test') {
    const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('idx_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    const kz=isKillZone();
    await tg(
      `🤖 <b>TIH Indices v5.2</b>\n━━━━━━━━━━━━━━━\n✅ النظام يعمل!\n\n` +
      `📊 ${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n` +
      `🎯 Win Rate: ${wr}%\n💰 R: ${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R\n` +
      `📌 نشطة: ${Object.keys(active).length}\n━━━━━━━━━━━━━━━\n` +
      `✅ Kill Zones: ${kz?'🟢 نشط':'🔴 خارج النافذة'}\n` +
      `✅ شرط الإشارة: ${MIN_SCORE} نقطة\n` +
      `✅ Weekly Trend: مفعّل\n✅ Liquidity Sweep: مفعّل\n` +
      `✅ Grade S+A فقط\n` +
      `📊 VIX: ${vix?vix.toFixed(1):'—'}\n` +
      `📡 مصدر البيانات: Yahoo Finance\n🤖 <i>TIH Indices v5.2</i>`
    );
    return res.status(200).json({ ok:true, vix, killZone:kz });
  }

  if (action==='reset') { await kvDel('idx_active'); await tg('🔄 تم مسح الإشارات النشطة\n🤖 TIH Indices v5.2'); return res.status(200).json({ ok:true }); }

  if (action==='cleanup') {
    const active=(await kvGet('idx_active'))||{};
    const latest={};
    for(const [id,sig] of Object.entries(active)){ if(!latest[sig.sym]||sig.openedAt>latest[sig.sym].openedAt) latest[sig.sym]={id,...sig}; }
    const newActive={};
    for(const [sym,sig] of Object.entries(latest)){const{id,...data}=sig;newActive[id]=data;}
    await kvSet('idx_active',newActive,7*86400);
    return res.status(200).json({ok:true,removed:Object.keys(active).length-Object.keys(newActive).length,remaining:Object.keys(newActive).length});
  }

  if (action==='active') {
    const active=(await kvGet('idx_active'))||{};
    const sigs=Object.values(active).map(s=>({sym:s.sym,signal:s.signal,grade:s.grade,entry:s.entry,sl:s.sl,t1:s.t1,t2:s.t2,t3:s.t3,t1Hit:s.t1Hit,t2Hit:s.t2Hit,openedAt:s.openedAt}));
    return res.status(200).json({ok:true,signals:sigs,count:sigs.length});
  }

  if (action==='log') { const log=(await kvGet('idx_log'))||[]; return res.status(200).json({ok:true,log,count:log.length}); }

  if (action==='stats') {
    const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
    const active=(await kvGet('idx_active'))||{};
    const wr=perf.total>0?((perf.wins/perf.total)*100).toFixed(0):0;
    const vix=await getVIX();
    await tg(`📊 <b>أداء المؤشرات v5.2</b>\n━━━━━━━━━━━━━━━\n${perf.total} | ✅ ${perf.wins} | ❌ ${perf.losses}\n🎯 Win Rate: <b>${wr}%</b>\n💰 R: <b>${perf.totalR>0?'+':''}${perf.totalR.toFixed(1)}R</b>\n📌 نشطة: ${Object.keys(active).length}\n📊 VIX: ${vix?vix.toFixed(1):'—'}\n🤖 TIH Indices v5.2`);
    return res.status(200).json({ok:true,perf,active:Object.keys(active).length,vix});
  }

  const symbols=req.query.symbols?req.query.symbols.split(',').map(s=>s.trim().toUpperCase()).filter(s=>INDICES[s]):Object.keys(INDICES);
  const perfNotifs=await checkActiveSignals();
  const newAlerts=[],errors=[],skipped=[];
  const vix=await getVIX();

  if(vix&&vix>25){
    const lastVixAlert=await kvGet('idx_vix_alert');
    const today=new Date().toISOString().split('T')[0];
    if(lastVixAlert!==today){
      await kvSet('idx_vix_alert',today,86400);
      await tg(vix>35
        ?`⚠️ <b>VIX شديد!</b> ${vix.toFixed(1)} — تداول بحذر شديد\n🤖 TIH Indices v5.2`
        :`⚠️ <b>VIX مرتفع</b> ${vix.toFixed(1)} — راقب الإشارات بحذر\n🤖 TIH Indices v5.2`);
    }
  }

  await Promise.all(symbols.map(async (sym) => {
    try {
      if(!isMarketOpen(sym)){skipped.push(sym);return;}
      const result=await analyzeMTF(sym,vix);
      if(!result)return;
      const active=(await kvGet('idx_active'))||{};
      if(Object.values(active).some(s=>s.sym===sym))return;
      const targets=calcTargets(result.signal,result.price,result.atr);
      const sigId=`${sym}_${Date.now()}`;
      active[sigId]={sym,signal:result.signal,entry:result.price,sl:targets.sl,t1:targets.t1,t2:targets.t2,t3:targets.t3,t1Hit:false,t2Hit:false,t3Hit:false,grade:result.grade,openedAt:Date.now()};
      const perf=(await kvGet('idx_perf'))||{total:0,wins:0,losses:0,totalR:0};
      perf.total++;
      await kvSet('idx_active',active,7*86400);
      await kvSet('idx_perf',perf,365*86400);
      newAlerts.push({sym,signal:result.signal,grade:result.grade});
      const emoji=result.signal==='CALL'?'🟢':'🔴';
      const sigType=result.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const now=new Date().toLocaleTimeString('ar-SA',{timeZone:'Asia/Riyadh',hour:'2-digit',minute:'2-digit'});
      const weekLine=result.weeklyTrend!=='neutral'?`📅 Trend الأسبوعي: ${result.weeklyTrend==='bull'?'🟢 صاعد':'🔴 هابط'}\n`:'';
      const ictLine=result.ictDetails?.length?`🔬 ICT: ${result.ictDetails.join(' ')} (${result.ictScore}/13)\n`:'';
      await tg(
        `${emoji} <b>${sigType}</b>\n${result.gradeLabel} — <b>${result.successRate}%</b>\n━━━━━━━━━━━━━━━\n` +
        `📌 <b>${sym}</b> — ${INDICES[sym].name}\n💰 $${result.price.toFixed(2)}\n` +
        `${weekLine}${ictLine}` +
        `📊 RSI(1H): ${result.trendRSI} | RSI(${result.entryFrame}): ${result.entryRSI}\n` +
        `🔀 التوافق: ${result.agreements}/${result.totalFrames} فريم\n━━━━━━━━━━━━━━━\n` +
        `🎯 Entry: $${result.price.toFixed(2)}\n🛡️ SL: $${targets.sl} (${targets.slPct}%)\n` +
        `🏆 T1: $${targets.t1} (+${targets.t1Pct}%) | 1:${targets.rr1}\n` +
        `🏆 T2: $${targets.t2} | 1:${targets.rr2}\n` +
        `🏆 T3: $${targets.t3} | 1:${targets.rr3}\n━━━━━━━━━━━━━━━\n` +
        `📐 ATR: ${result.atr.toFixed(3)} | VIX: ${result.vix||'—'}\n` +
        `⏰ ${now} | Kill Zone ✅\n` +
        `📊 <a href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(INDICES[sym].tv)}&interval=${TV_INTERVAL[result.entryFrame]||'60'}">الشارت ↗</a>\n` +
        `🤖 <i>TIH Indices v5.2</i>`
      );
    } catch(e){ errors.push(`${sym}: ${e.message}`); }
  }));

  const active=(await kvGet('idx_active'))||{};
  return res.status(200).json({
    ok:true, checked:symbols.length,
    newAlerts:newAlerts.length, perfNotifs,
    active:Object.keys(active).length,
    signals:newAlerts, skipped, errors,
    vix:vix?+vix.toFixed(1):null,
    killZone:isKillZone()
  });
};
