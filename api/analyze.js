const https = require('https');

const YAHOO_MAP = {
  'SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','RUT':'^RUT','VIX':'^VIX','DXY':'DX-Y.NYB',
  'EURUSD':'EURUSD=X','GBPUSD':'GBPUSD=X','USDJPY':'JPY=X','AUDUSD':'AUDUSD=X','USDCAD':'CAD=X','XAUUSD':'GC=F',
  'BTC':'BTC-USD','ETH':'ETH-USD','SOL':'SOL-USD','BNB':'BNB-USD','XRP':'XRP-USD','ADA':'ADA-USD'
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}


// ── Fallback: Finnhub ──
async function fetchFinnhub(symbol) {
  // Finnhub free endpoint — no key needed for basic quote
  const url = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=demo`;
  const json = await fetchJSON(url);
  if (!json || !json.c || json.c === 0) throw new Error('Finnhub no data');
  // Finnhub returns: c=current, h=high, l=low, o=open, pc=prev close
  return {
    price:      json.c,
    open:       json.o,
    high:       json.h,
    low:        json.l,
    prevClose:  json.pc,
    change:     json.c - json.pc,
    changePct:  ((json.c - json.pc) / json.pc) * 100,
    source:     'Finnhub'
  };
}

// ── Fallback: Alpha Vantage demo ──
async function fetchAlphaVantage(symbol) {
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=demo`;
  const json = await fetchJSON(url);
  const q = json?.['Global Quote'];
  if (!q || !q['05. price']) throw new Error('AlphaVantage no data');
  const price    = parseFloat(q['05. price']);
  const prevClose = parseFloat(q['08. previous close']);
  return {
    price,
    open:      parseFloat(q['02. open']),
    high:      parseFloat(q['03. high']),
    low:       parseFloat(q['04. low']),
    prevClose,
    change:    parseFloat(q['09. change']),
    changePct: parseFloat(q['10. change percent']),
    source:    'AlphaVantage'
  };
}

// ── Smart fetch with fallback ──
async function fetchWithFallback(yahooSym, originalSymbol) {
  const errors = [];

  // 1. Try Yahoo Finance
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=1d&range=1y`;
    const json = await fetchJSON(url);
    const result = json?.chart?.result?.[0];
    if (!result) throw new Error('Yahoo no data');
    const meta = result.meta;
    const q = result.indicators.quote[0];
    const validIdx = q.close.map((v,i) => v!==null?i:-1).filter(i=>i>=0);
    const closes  = validIdx.map(i => q.close[i]);
    const opens   = validIdx.map(i => q.open[i]);
    const highs   = validIdx.map(i => q.high[i]);
    const lows    = validIdx.map(i => q.low[i]);
    const volumes = validIdx.map(i => q.volume[i]||0);
    const price   = meta.regularMarketPrice || closes[closes.length-1];
    const prev    = closes.length >= 2 ? closes[closes.length-2] : (meta.previousClose || price);
    return {
      source: 'Yahoo Finance',
      symbol: meta.symbol || originalSymbol,
      fullName: meta.longName || meta.shortName || originalSymbol,
      exchange: meta.exchangeName || '—',
      currency: meta.currency || 'USD',
      price, prevClose: prev,
      open: opens[opens.length-1],
      high: highs[highs.length-1],
      low:  lows[lows.length-1],
      volume: volumes[volumes.length-1] || 0,
      closes, opens, highs, lows, volumes,
      change:    price - prev,
      changePct: ((price - prev) / prev) * 100,
    };
  } catch(e) { errors.push('Yahoo: ' + e.message); }

  // 2. Try Finnhub
  try {
    const fb = await fetchFinnhub(originalSymbol);
    // For analysis we need historical data — build minimal arrays
    const closes  = [fb.prevClose, fb.price];
    const highs   = [fb.high, fb.high];
    const lows    = [fb.low, fb.low];
    const opens   = [fb.open, fb.open];
    const volumes = [0, 0];
    return {
      source: 'Finnhub',
      symbol: originalSymbol,
      fullName: originalSymbol,
      exchange: '—',
      currency: 'USD',
      price: fb.price, prevClose: fb.prevClose,
      open: fb.open, high: fb.high, low: fb.low, volume: 0,
      closes, opens, highs, lows, volumes,
      change: fb.change, changePct: fb.changePct,
      limitedHistory: true,
    };
  } catch(e) { errors.push('Finnhub: ' + e.message); }

  // 3. Try Alpha Vantage
  try {
    const av = await fetchAlphaVantage(originalSymbol);
    const closes  = [av.prevClose, av.price];
    const highs   = [av.high, av.high];
    const lows    = [av.low, av.low];
    const opens   = [av.open, av.open];
    const volumes = [0, 0];
    return {
      source: 'AlphaVantage',
      symbol: originalSymbol,
      fullName: originalSymbol,
      exchange: '—',
      currency: 'USD',
      price: av.price, prevClose: av.prevClose,
      open: av.open, high: av.high, low: av.low, volume: 0,
      closes, opens, highs, lows, volumes,
      change: av.change, changePct: av.changePct,
      limitedHistory: true,
    };
  } catch(e) { errors.push('AlphaVantage: ' + e.message); }

  throw new Error('جميع المصادر فشلت: ' + errors.join(' | '));
}


// ── Multi-Timeframe ──
async function fetchMTF(yahooSym) {
  const ranges = [
    { tf:'D', interval:'1d',  range:'1y'  },
    { tf:'W', interval:'1wk', range:'3y'  },
    { tf:'M', interval:'1mo', range:'5y'  },
  ];
  const results = {};
  await Promise.all(ranges.map(async (r) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${r.interval}&range=${r.range}`;
      const json = await fetchJSON(url);
      const res = json?.chart?.result?.[0];
      if (!res) return;
      const q = res.indicators.quote[0];
      const vi = q.close.map((v,i)=>v!==null?i:-1).filter(i=>i>=0);
      results[r.tf] = {
        closes:  vi.map(i=>q.close[i]),
        highs:   vi.map(i=>q.high[i]),
        lows:    vi.map(i=>q.low[i]),
        volumes: vi.map(i=>q.volume[i]||0),
      };
    } catch(e) {}
  }));
  return results;
}

function analyzeTF(data) {
  if (!data || data.closes.length < 20) return null;
  const c=data.closes, h=data.highs, l=data.lows;
  const price=c[c.length-1], prev=c[c.length-2]||price;
  const chg=((price-prev)/prev)*100;
  const sma20=calcSMA(c,20), sma50=calcSMA(c,50), sma200=calcSMA(c,200);
  const rsi=calcRSI(c,14);
  const pivot=(h[h.length-1]+l[l.length-1]+prev)/3;
  let score=0, reasons=[];
  if(sma20&&sma50&&price>sma20&&sma20>sma50){score+=2;reasons.push('فوق MA20 وMA50');}
  else if(sma20&&price<sma20){score-=2;reasons.push('تحت MA20');}
  if(sma200&&price>sma200){score+=1;reasons.push('فوق MA200');}
  else if(sma200&&price<sma200){score-=1;reasons.push('تحت MA200');}
  if(rsi){
    if(rsi>70){score-=1;reasons.push('RSI '+rsi.toFixed(0)+' تشبع شرائي');}
    else if(rsi<30){score+=1;reasons.push('RSI '+rsi.toFixed(0)+' تشبع بيعي');}
    else if(rsi>55){score+=1;reasons.push('RSI '+rsi.toFixed(0)+' إيجابي');}
    else if(rsi<45){score-=1;reasons.push('RSI '+rsi.toFixed(0)+' سلبي');}
  }
  if(price>pivot){score+=1;reasons.push('فوق Pivot');}else{score-=1;reasons.push('تحت Pivot');}
  if(chg>1){score+=1;reasons.push('زخم +'+chg.toFixed(2)+'%');}
  else if(chg<-1){score-=1;reasons.push('زخم '+chg.toFixed(2)+'%');}
  const signal=score>=3?'CALL':score<=-3?'PUT':'انتظار';
  return {score,signal,signalClass:score>=3?'bull':score<=-3?'bear':'neutral',
    rsi:rsi?parseFloat(rsi.toFixed(1)):null,
    ma20:sma20?parseFloat(sma20.toFixed(2)):null,
    pivot:parseFloat(pivot.toFixed(2)),
    price:parseFloat(price.toFixed(2)),
    changePercent:parseFloat(chg.toFixed(2)),reasons};
}

function combineMTFSignal(mtfData) {
  const weights = {D:1,W:2,M:3};
  const labels  = {D:'يومي',W:'أسبوعي',M:'شهري'};
  let totalScore=0, totalWeight=0;
  const timeframes=[];
  Object.entries(mtfData).forEach(([tf,data])=>{
    const a=analyzeTF(data);
    if(!a)return;
    const w=weights[tf]||1;
    totalScore+=a.score*w; totalWeight+=w;
    timeframes.push({...a, tf:labels[tf], tfKey:tf, weight:w});
  });
  if(!totalWeight)return null;
  const avg=totalScore/totalWeight;
  const calls=timeframes.filter(a=>a.signal==='CALL').length;
  const puts =timeframes.filter(a=>a.signal==='PUT').length;
  const n=timeframes.length;
  let confluence='تعارض ⚠️', confluenceClass='neutral';
  if(calls===n){confluence='إجماع كامل 🟢';confluenceClass='bull';}
  else if(puts===n){confluence='إجماع كامل 🔴';confluenceClass='bear';}
  else if(calls>=2){confluence='أغلبية CALL 🟢';confluenceClass='bull';}
  else if(puts>=2){confluence='أغلبية PUT 🔴';confluenceClass='bear';}
  const finalSignal=avg>=2?'CALL':avg<=-2?'PUT':'انتظار';
  return {
    finalSignal,
    finalClass:finalSignal==='CALL'?'bull':finalSignal==='PUT'?'bear':'neutral',
    avgScore:parseFloat(avg.toFixed(2)),
    confidence:Math.min(92,Math.round(40+Math.abs(avg)*10)),
    confluence, confluenceClass, timeframes
  };
}


function calcSMA(p, n) { if(p.length<n)return null; return p.slice(-n).reduce((a,b)=>a+b,0)/n; }
function calcEMA(p, n) { if(p.length<n)return null; const k=2/(n+1); let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n; for(let i=n;i<p.length;i++) e=p[i]*k+e*(1-k); return e; }
function calcRSI(p, n=14) { if(p.length<n+1)return null; let g=0,l=0; for(let i=1;i<=n;i++){const d=p[i]-p[i-1]; if(d>0)g+=d; else l-=d;} let ag=g/n,al=l/n; for(let i=n+1;i<p.length;i++){const d=p[i]-p[i-1]; if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}} if(al===0)return 100; return 100-(100/(1+ag/al)); }
function calcATR(h,l,c,n=14) { if(c.length<n+1)return null; const trs=[]; for(let i=1;i<c.length;i++) trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1]))); return trs.slice(-n).reduce((a,b)=>a+b,0)/n; }

function analyzeMurphy(d) {
  const c=d.closes,sma20=calcSMA(c,20),sma50=calcSMA(c,50),sma200=calcSMA(c,200),price=c[c.length-1];
  let score=0,trend='محايد',obs='';
  if(sma20&&sma50&&sma200){
    if(sma20>sma50&&sma50>sma200&&price>sma20){score=80;trend='صعود قوي';obs='كل المتوسطات مرتّبة صعودياً (20 > 50 > 200) والسعر فوقها';}
    else if(sma20>sma50&&price>sma20){score=60;trend='صعود متوسط';obs='MA 20 > MA 50 — اتجاه قصير المدى صاعد';}
    else if(sma20<sma50&&sma50<sma200&&price<sma20){score=-80;trend='هبوط قوي';obs='كل المتوسطات مرتّبة هبوطياً والسعر تحتها';}
    else if(sma20<sma50&&price<sma20){score=-60;trend='هبوط متوسط';obs='MA 20 < MA 50 — اتجاه قصير المدى هابط';}
    else{obs='المتوسطات متشابكة — السوق في حالة عدم وضوح';}
  }
  return {name:'Murphy التقليدي',source:'Technical Analysis of Financial Markets',icon:'JM',score,observation:obs,details:{'الاتجاه':trend,'MA 20':sma20?sma20.toFixed(2):'—','MA 50':sma50?sma50.toFixed(2):'—','MA 200':sma200?sma200.toFixed(2):'—'}};
}

function analyzeWyckoff(d) {
  const c=d.closes,v=d.volumes;
  if(c.length<50)return{name:'Wyckoff / Weis',source:'Modern Wyckoff',icon:'WY',score:0,observation:'بيانات غير كافية',details:{}};
  const r60=c.slice(-60),h60=Math.max(...r60),l60=Math.min(...r60),price=c[c.length-1],range=h60-l60;
  const pos=((price-l60)/range)*100,avgV=v.slice(-20).reduce((a,b)=>a+b,0)/20,lastV=v[v.length-1],vRatio=lastV/avgV;
  const r10V=v.slice(-10).reduce((a,b)=>a+b,0)/10,p10V=v.slice(-20,-10).reduce((a,b)=>a+b,0)/10,vTrend=r10V/p10V;
  let phase='',score=0,obs='';
  if(pos<25&&vRatio>1.5){phase='Selling Climax';score=60;obs='سعر منخفض + حجم متفجّر = ذروة بيع';}
  else if(pos<35&&vTrend<0.9){phase='Accumulation';score=40;obs='سعر بالقرب من القاع + حجم منخفض = تجميع';}
  else if(pos>35&&pos<75&&vTrend>1.1){phase='Markup';score=50;obs='صعود مع زيادة الحجم = مرحلة ارتفاع';}
  else if(pos>75&&vRatio>1.5){phase='Buying Climax';score=-60;obs='سعر مرتفع + حجم متفجّر = ذروة شراء';}
  else if(pos>65&&vTrend<0.9){phase='Distribution';score=-40;obs='سعر قرب القمة + حجم متناقص = توزيع';}
  else{phase='انتقالية';obs='لا توجد إشارة Wyckoff واضحة';}
  return{name:'Wyckoff / Weis',source:'David Weis · Modern Wyckoff',icon:'WY',score,observation:obs,details:{'المرحلة':phase,'الموقع':pos.toFixed(1)+'%','نسبة الحجم':vRatio.toFixed(2)+'x','اتجاه الحجم':vTrend>1.05?'↑ متزايد':vTrend<0.95?'↓ متناقص':'→ ثابت'}};
}

function analyzeSMC(d) {
  const c=d.closes,h=d.highs,l=d.lows;
  if(c.length<30)return{name:'SMC / ICT',source:'Smart Money Concepts',icon:'SM',score:0,observation:'بيانات غير كافية',details:{}};
  const sw={highs:[],lows:[]},lb=3;
  for(let i=lb;i<h.length-lb;i++){let iH=true,iL=true;for(let k=1;k<=lb;k++){if(h[i]<=h[i-k]||h[i]<=h[i+k])iH=false;if(l[i]>=l[i-k]||l[i]>=l[i+k])iL=false;}if(iH)sw.highs.push({idx:i,value:h[i]});if(iL)sw.lows.push({idx:i,value:l[i]});}
  const lH=sw.highs[sw.highs.length-1],pH=sw.highs[sw.highs.length-2],lL=sw.lows[sw.lows.length-1],pL=sw.lows[sw.lows.length-2];
  let score=0,struct='غير واضح',obs='';
  if(lH&&pH&&lL&&pL){if(lH.value>pH.value&&lL.value>pL.value){struct='هيكل صاعد (HH/HL)';score=60;obs='قمم وقيعان أعلى = هيكل صعودي سليم';}else if(lH.value<pH.value&&lL.value<pL.value){struct='هيكل هابط (LH/LL)';score=-60;obs='قمم وقيعان أدنى = هيكل هبوطي';}else{struct='BOS';score=30;obs='إشارات مختلطة في الهيكل';}}
  const price=c[c.length-1],r20H=Math.max(...h.slice(-20)),r20L=Math.min(...l.slice(-20));
  let liq='لا يوجد';if(price>r20H*0.998)liq='قرب سيولة علوية';else if(price<r20L*1.002)liq='قرب سيولة سفلية';
  return{name:'SMC / ICT',source:'Smart Money Concepts',icon:'SM',score,observation:obs,details:{'الهيكل':struct,'السيولة':liq,'آخر قمة':lH?lH.value.toFixed(2):'—','آخر قاع':lL?lL.value.toFixed(2):'—'}};
}

function analyzeCandles(d) {
  const o=d.opens,c=d.closes,h=d.highs,l=d.lows;
  if(c.length<3)return{name:'الشموع اليابانية',source:'Al-Qasim',icon:'蝋',score:0,observation:'بيانات غير كافية',details:{}};
  const i=c.length-1,body=Math.abs(c[i]-o[i]),range=h[i]-l[i],br=range>0?body/range:0;
  const uW=h[i]-Math.max(o[i],c[i]),lW=Math.min(o[i],c[i])-l[i];
  let pat='شمعة عادية',score=0,obs='';
  if(br<0.15&&uW>body*2&&lW>body*2){pat='دوجي';obs='عدم يقين — انتظر التأكيد';}
  else if(lW>body*2&&uW<body*0.5&&c[i]>o[i]){pat='مطرقة';score=50;obs='انعكاس صعودي محتمل';}
  else if(uW>body*2&&lW<body*0.5&&c[i]<o[i]){pat='نجم شهاب';score=-50;obs='انعكاس هبوطي محتمل';}
  else if(br>0.85&&c[i]>o[i]){pat='ماروبوزو صاعد';score=40;obs='قوة شرائية مهيمنة';}
  else if(br>0.85&&c[i]<o[i]){pat='ماروبوزو هابط';score=-40;obs='قوة بيعية مهيمنة';}
  else if(c[i]>o[i]&&c[i-1]<o[i-1]&&c[i]>o[i-1]&&o[i]<c[i-1]){pat='ابتلاع صاعد';score=60;obs='انعكاس صعودي قوي';}
  else if(c[i]<o[i]&&c[i-1]>o[i-1]&&c[i]<o[i-1]&&o[i]>c[i-1]){pat='ابتلاع هابط';score=-60;obs='انعكاس هبوطي قوي';}
  else{obs='لا توجد شمعة انعكاسية واضحة';}
  return{name:'الشموع اليابانية',source:'Al-Qasim',icon:'蝋',score,observation:obs,details:{'النمط':pat,'نسبة الجسم':(br*100).toFixed(0)+'%','الفتيل العلوي':uW.toFixed(2),'الفتيل السفلي':lW.toFixed(2)}};
}

function analyzePriceAction(d) {
  const c=d.closes,h=d.highs,l=d.lows,ma50=calcSMA(c,50),price=c[c.length-1],atr=calcATR(h,l,c,14);
  if(!ma50||!atr)return{name:'Price Action',source:'Rayner Teo · MAEE',icon:'PA',score:0,observation:'بيانات غير كافية',details:{}};
  const dist=((price-ma50)/ma50)*100,isPB=Math.abs(dist)<5&&Math.abs(price-ma50)<atr;
  const l10=c.slice(-10),r10=Math.max(...l10)-Math.min(...l10),tm=Math.abs(l10[9]-l10[0]),eff=r10>0?tm/r10:0;
  let score=0,phase='',obs='';
  if(price>ma50&&isPB){phase='Pullback صاعد';score=50;obs='فرصة دخول كلاسيكية (MAEE)';}
  else if(price<ma50&&isPB){phase='Pullback هابط';score=-50;obs='فرصة دخول شورت كلاسيكية';}
  else if(eff>0.7&&price>ma50){phase='Impulse صاعد';score=40;obs='اندفاع شرائي — انتظر pullback';}
  else if(eff>0.7&&price<ma50){phase='Impulse هابط';score=-40;obs='اندفاع بيعي — انتظر pullback';}
  else{phase='تذبذب جانبي';obs='لا توجد فرصة MAEE واضحة';}
  return{name:'Price Action',source:'Rayner Teo · MAEE',icon:'PA',score,observation:obs,details:{'المرحلة':phase,'البعد عن MA50':dist.toFixed(2)+'%','كفاءة الحركة':(eff*100).toFixed(0)+'%','ATR(14)':atr.toFixed(2)}};
}

function analyzeBehavioral(d) {
  const c=d.closes;
  if(c.length<60)return{name:'علم النفس السوقي',source:'Kahneman + Soros',icon:'ψ',score:0,observation:'بيانات غير كافية',details:{}};
  const rsi=calcRSI(c,14),price=c[c.length-1],h60=Math.max(...c.slice(-60)),l60=Math.min(...c.slice(-60));
  const r5=c.slice(-5),vel=((r5[4]-r5[0])/r5[0])*100;
  let sent='',score=0,obs='',fomo='منخفض';
  if(rsi>75&&((h60-price)/h60)*100<3&&vel>10){sent='FOMO شديد';fomo='عالٍ جداً';score=-70;obs='الجميع يشتري بهلع — علامة قمة';}
  else if(rsi>70&&vel>5){sent='حماس';fomo='متوسط';score=-30;obs='حذر — قد يكون السوق متطرفاً';}
  else if(rsi<25&&((price-l60)/l60)*100<3&&vel<-10){sent='ذعر بيعي';fomo='خوف';score=70;obs='الجميع يبيع — علامة قاع';}
  else if(rsi<30&&vel<-5){sent='تشاؤم';score=30;obs='مزاج سلبي — فرصة محتملة';}
  else{sent='متوازن';obs='مزاج السوق طبيعي';}
  return{name:'علم النفس السوقي',source:'Kahneman + Reflexivity',icon:'ψ',score,observation:obs,details:{'المزاج':sent,'FOMO':fomo,'RSI(14)':rsi?rsi.toFixed(1):'—','السرعة':vel.toFixed(2)+'%'}};
}

function analyzeVolumeProfile(d) {
  const c=d.closes,v=d.volumes;
  if(c.length<30)return{name:'Volume Profile',source:'Steidlmayer',icon:'VP',score:0,observation:'بيانات غير كافية',details:{}};
  const n=Math.min(30,c.length),sl=c.slice(-n),vl=v.slice(-n),mn=Math.min(...sl),mx=Math.max(...sl),bs=(mx-mn)/10;
  const prof=new Array(10).fill(0);
  for(let i=0;i<sl.length;i++){const b=Math.min(Math.floor((sl[i]-mn)/bs),9);prof[b]+=vl[i]||1;}
  const mb=prof.indexOf(Math.max(...prof)),poc=mn+(mb+0.5)*bs,price=c[c.length-1];
  let score=0,obs='',zone='';
  if(price>poc*1.02){zone='فوق POC';score=-20;obs='السعر فوق POC — احتمال العودة';}
  else if(price<poc*0.98){zone='تحت POC';score=20;obs='السعر تحت POC — احتمال الصعود';}
  else{zone='عند POC';obs='السعر يتقلب حول POC';}
  return{name:'Volume Profile',source:'Steidlmayer',icon:'VP',score,observation:obs,details:{'المنطقة':zone,'POC':poc.toFixed(2),'البعد':(((price-poc)/poc)*100).toFixed(2)+'%'}};
}


// ── Risk/Reward Calculator ──
function calcRiskReward(price, signal, levels, indicators, closes, highs, lows) {
  if (!signal || signal === 'انتظار') return null;

  const atr = calcATR(highs, lows, closes, 14) || (price * 0.01);
  const L = levels || {};

  // المستويات الحقيقية
  const res1 = parseFloat(L.res1) || price * 1.015;
  const res2 = parseFloat(L.res2) || price * 1.030;
  const sup1 = parseFloat(L.sup1) || price * 0.985;
  const sup2 = parseFloat(L.sup2) || price * 0.970;

  // أدنى قاع وأعلى قمة للـ 5 شموع الأخيرة
  const recentLow  = Math.min(...lows.slice(-5));
  const recentHigh = Math.max(...highs.slice(-5));

  let entry, stopLoss, target1, target2;

  if (signal === 'CALL' || signal === 'شراء حذر') {
    entry = price;
    // SL: تحت أدنى قاع أخير بمقدار ATR*0.3 (لكن لا يتجاوز 3% من السعر)
    const slRaw = recentLow - (atr * 0.3);
    const slMax = price * 0.97; // الحد الأقصى للخسارة 3%
    stopLoss = Math.max(slRaw, slMax);
    // TP: أول مستوى مقاومة فوق السعر الحالي
    target1 = res1 > price ? res1 : price * 1.015;
    target2 = res2 > price ? res2 : price * 1.030;
  } else {
    // PUT
    entry = price;
    // SL: فوق أعلى قمة أخيرة بمقدار ATR*0.3 (لا يتجاوز 3%)
    const slRaw = recentHigh + (atr * 0.3);
    const slMax = price * 1.03;
    stopLoss = Math.min(slRaw, slMax);
    // TP: أول دعم تحت السعر الحالي
    target1 = sup1 < price ? sup1 : price * 0.985;
    target2 = sup2 < price ? sup2 : price * 0.970;
  }

  const risk    = Math.abs(entry - stopLoss);
  const reward1 = Math.abs(target1 - entry);
  const rr1     = risk > 0 ? (reward1 / risk).toFixed(2) : '—';

  const slPct = ((stopLoss - entry) / entry * 100).toFixed(2);
  const t1Pct = ((target1  - entry) / entry * 100).toFixed(2);
  const t2Pct = ((target2  - entry) / entry * 100).toFixed(2);

  const rrNum = parseFloat(rr1);
  const quality = rrNum >= 2 ? 'ممتاز' : rrNum >= 1.5 ? 'جيد' : rrNum >= 1 ? 'مقبول' : 'ضعيف';

  return {
    entry:    parseFloat(entry.toFixed(2)),
    stopLoss: parseFloat(stopLoss.toFixed(2)),
    target1:  parseFloat(target1.toFixed(2)),
    target2:  parseFloat(target2.toFixed(2)),
    slPct, t1Pct, t2Pct, rr1,
    atr: parseFloat(atr.toFixed(2)),
    quality
  };
}


function calcRisk(d) {
  const c=d.closes,h=d.highs,l=d.lows;
  let r=0;
  const price=c[c.length-1];

  // 1. البعد عن القمة 60 يوم
  const h60=Math.max(...c.slice(-60)),dH=((h60-price)/h60)*100;
  if(dH<2)r+=25;else if(dH<5)r+=15;else if(dH<10)r+=5;

  // 2. RSI — الأهم (وزن أعلى)
  const rsi=calcRSI(c,14);
  if(rsi){
    if(rsi>78)r+=30;        // تشبع شرائي شديد جداً
    else if(rsi>70)r+=20;   // تشبع شرائي
    else if(rsi>65)r+=10;   // اقتراب من التشبع
    else if(rsi<22)r+=25;   // تشبع بيعي شديد
    else if(rsi<30)r+=15;   // تشبع بيعي
  }

  // 3. سرعة الحركة 5 شموع
  const r5=c.slice(-5),vel=Math.abs((r5[4]-r5[0])/r5[0])*100;
  if(vel>8)r+=20;else if(vel>4)r+=10;

  // 4. ATR نسبي
  const atr=calcATR(h,l,c,14);
  if(atr&&price){const ap=(atr/price)*100;if(ap>4)r+=15;else if(ap>2.5)r+=8;}

  // 5. البعد عن MA50 — ممتد = خطر
  const s50=calcSMA(c,50);
  if(s50){
    const ds=((price-s50)/s50)*100;
    if(ds>15)r+=20;      // ممتد جداً فوق MA50
    else if(ds>10)r+=12;
    else if(ds>5)r+=5;
    else if(ds<-15)r+=15; // ممتد جداً تحت MA50
  }

  const score=Math.min(r,100);
  return{
    score,
    label: score<30?'مخاطرة منخفضة — وضع مريح':
           score<50?'مخاطرة متوسطة — حذر مطلوب':
           score<70?'مخاطرة مرتفعة — قلّل الحجم':
                    'مخاطرة عالية جداً — تجنّب الدخول'
  };
}

function genDecision(methods) {
  const w={'Murphy التقليدي':1.0,'Wyckoff / Weis':1.4,'SMC / ICT':1.3,'الشموع اليابانية':0.8,'Price Action':1.0,'علم النفس السوقي':1.2,'Volume Profile':1.0};
  let ts=0,tw=0;
  methods.forEach(m=>{const wt=w[m.name]||1;ts+=m.score*wt;tw+=wt;});
  const fs=ts/tw,conf=Math.min(100,Math.abs(fs)*1.5);
  const reasons=methods.filter(m=>Math.abs(m.score)>=30).map(m=>({type:m.score>0?'bull':'bear',text:`${m.name}: ${m.observation}`}));
  if(!reasons.length)reasons.push({type:'neutral',text:'إشارات مختلطة من جميع المناهج'});
  let verdict,summary,cls;
  if(fs>30){verdict='شراء';cls='buy';summary='الإجماع بين المناهج يميل للصعود.';}
  else if(fs>15){verdict='شراء حذر';cls='buy';summary='إشارات صعودية معتدلة. احتمالية النجاح أعلى من الفشل، لكن ليست قوية جداً.';}
  else if(fs<-30){verdict='تجنّب';cls='avoid';summary='الإشارات السلبية تتفوق. لا تشتري الآن.';}
  else if(fs<-15){verdict='حذر';cls='avoid';summary='مخاطر متزايدة — انتظر إشارة أوضح.';}
  else{verdict='انتظار';cls='wait';summary='السوق غير حاسم. انتظر إشارة واضحة.';}
  return{verdict,summary,class:cls,confidence:conf,reasons};
}

function calcIndicators(d) {
  const c=d.closes,h=d.highs,l=d.lows,price=c[c.length-1];
  const rsi14=calcRSI(c,14),sma20=calcSMA(c,20),sma50=calcSMA(c,50),sma200=calcSMA(c,200);
  let trend_daily='neutral';
  if(sma20&&sma50){if(price>sma20&&sma20>sma50)trend_daily='bullish';else if(price<sma20&&sma20<sma50)trend_daily='bearish';}
  const r5=c.slice(-5),sma20s=calcSMA(c.slice(-20),20);
  let trend_4h=trend_daily;
  if(r5.length===5&&sma20s){if(r5[4]>sma20s&&r5[4]>r5[0])trend_4h='bullish';else if(r5[4]<sma20s&&r5[4]<r5[0])trend_4h='bearish';else trend_4h='neutral';}
  let momentum='neutral';
  if(sma20){const dist=((price-sma20)/sma20)*100;if(dist>5)momentum='strong_up';else if(dist>1)momentum='up';else if(dist<-5)momentum='strong_down';else if(dist<-1)momentum='down';}
  return{rsi14,trend_daily,trend_4h,trend_1h:trend_daily,momentum};
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  if(req.method==='OPTIONS')return res.status(200).end();

  const symbol=(req.query.symbol||'AAPL').toUpperCase().replace(/[^A-Z0-9.\-\/^]/g,'');
  const yahooSym=YAHOO_MAP[symbol]||symbol;

  try {
    // Smart fetch with automatic fallback
    const fetched = await fetchWithFallback(yahooSym, symbol);

    const closes  = fetched.closes;
    const opens   = fetched.opens;
    const highs   = fetched.highs;
    const lows    = fetched.lows;
    const volumes = fetched.volumes;
    const price   = fetched.price;
    const prevClose = fetched.prevClose;
    const dataSource = fetched.source;
    const limitedHistory = fetched.limitedHistory || false;
    const change = fetched.change || (price - prevClose);
    const changePercent = fetched.changePct || ((price - prevClose) / prevClose * 100);

    const raw={opens,closes,highs,lows,volumes};
    const indicators=calcIndicators(raw);
    const h60=Math.max(...highs.slice(-60)),l60=Math.min(...lows.slice(-60)),swing=h60-l60;
    const fib={'236':(h60-swing*0.236).toFixed(2),'382':(h60-swing*0.382).toFixed(2),'500':(h60-swing*0.500).toFixed(2),'618':(h60-swing*0.618).toFixed(2)};

    // Pivot Points
    const last=closes.length-1;
    const H=highs[last],L=lows[last],C=prevClose;
    const pivot=(H+L+C)/3;
    const levels={
      res2:(pivot+(H-L)).toFixed(2),
      res1:(2*pivot-L).toFixed(2),
      pivot:pivot.toFixed(2),
      sup1:(2*pivot-H).toFixed(2),
      sup2:(pivot-(H-L)).toFixed(2)
    };

    const methods=[analyzeMurphy(raw),analyzeWyckoff(raw),analyzeSMC(raw),analyzeCandles(raw),analyzePriceAction(raw),analyzeVolumeProfile(raw),analyzeBehavioral(raw)];
    const decision=genDecision(methods);
    const risk=calcRisk(raw);

    const vol=volumes[last];
    const volStr=vol>=1e9?(vol/1e9).toFixed(2)+'B':vol>=1e6?(vol/1e6).toFixed(2)+'M':vol>=1e3?(vol/1e3).toFixed(2)+'K':vol?vol.toFixed(0):'—';

    // Fetch MTF data in parallel
    // Calculate Risk/Reward
    const rrData = calcRiskReward(price, decision.signal, levels, indicators, closes, highs, lows);

    const mtfData = await fetchMTF(yahooSym);
    const mtfSignal = combineMTFSignal(mtfData);

    res.setHeader('Cache-Control','s-maxage=60,stale-while-revalidate=120');
    res.status(200).json({
      symbol:fetched.symbol||symbol,fullName:fetched.fullName||symbol,
      exchange:fetched.exchange||'—',currency:fetched.currency||'USD',
      dataSource, limitedHistory,
      price,change:parseFloat(change.toFixed(2)),changePercent:parseFloat(changePercent.toFixed(2)),
      open:opens[last],high:highs[last],low:lows[last],volume:volStr,
      high60d:h60,low60d:l60,fib,levels,indicators,methodologies:methods,decision,risk,riskReward:rrData,
      mtfSignal
    });
  } catch(e) {
    res.status(500).json({error:true,message:e.message});
  }
};
