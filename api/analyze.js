// ════════════════════════════════════════════════════════
// TIH analyze.js — Professional Multi-Timeframe Analysis
// المؤشرات: 5m + 15m + 1h + 1d + 1w (Top-Down)
// الأسهم:   1h + 1d
// الكريبتو: 15m + 1h + 1d
// ════════════════════════════════════════════════════════

const YAHOO_MAP = {
  'US500':'ES=F','SPX':'^GSPC','NDX':'^NDX','DJI':'^DJI','RUT':'^RUT',
  'VIX':'^VIX','DXY':'DX-Y.NYB',
  'BTC':'BTC-USD','ETH':'ETH-USD','SOL':'SOL-USD','BNB':'BNB-USD',
  'XRP':'XRP-USD','ADA':'ADA-USD',
  'XAUUSD':'GC=F','EURUSD':'EURUSD=X','GBPUSD':'GBPUSD=X',
  'USDJPY':'USDJPY=X','AUDUSD':'AUDUSD=X','USDCAD':'USDCAD=X',
};

// ── تصنيف الرمز ──
function getSymbolType(symbol) {
  const indices = ['US500','SPX','NDX','DJI','RUT','VIX','DXY','XAUUSD'];
  const crypto  = ['BTC','ETH','SOL','BNB','XRP','ADA'];
  const forex   = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD'];
  if (indices.includes(symbol)) return 'index';
  if (crypto.includes(symbol))  return 'crypto';
  if (forex.includes(symbol))   return 'forex';
  return 'stock';
}

// ── إعدادات حسب نوع الرمز ──
function getConfig(type) {
  const configs = {
    index: {
      // المؤشرات: تذبذب عالٍ — Top-Down من أسبوعي إلى 5 دقائق
      timeframes: [
        { interval:'5m',  range:'5d',  label:'5 دقائق',  weight:1 },
        { interval:'15m', range:'5d',  label:'15 دقيقة', weight:2 },
        { interval:'1h',  range:'30d', label:'ساعة',     weight:3 },
        { interval:'1d',  range:'6mo', label:'يومي',     weight:4 },
        { interval:'1wk', range:'2y',  label:'أسبوعي',   weight:5 },
      ],
      primaryTF: '1d',
      atrMult: { sl:1.5, t1:1.5, t2:2.5, t3:4.0 },
      keyEMAs: [9, 20, 50, 200],
      rsiPeriod: 14,
      bbPeriod: 20,
      description: 'مؤشر — تذبذب عالٍ — تحليل Top-Down 5m→W',
    },
    stock: {
      // الأسهم: ساعة + يومي كافي
      timeframes: [
        { interval:'1h',  range:'30d', label:'ساعة',  weight:2 },
        { interval:'1d',  range:'6mo', label:'يومي',  weight:4 },
      ],
      primaryTF: '1d',
      atrMult: { sl:1.0, t1:2.0, t2:3.5, t3:5.0 },
      keyEMAs: [9, 20, 50, 200],
      rsiPeriod: 14,
      bbPeriod: 20,
      description: 'سهم — تحليل 1H + Daily',
    },
    crypto: {
      // الكريبتو: تذبذب أعلى — 15m + 1h + 1d
      timeframes: [
        { interval:'15m', range:'5d',  label:'15 دقيقة', weight:2 },
        { interval:'1h',  range:'30d', label:'ساعة',     weight:3 },
        { interval:'1d',  range:'6mo', label:'يومي',     weight:4 },
      ],
      primaryTF: '1d',
      atrMult: { sl:2.0, t1:2.0, t2:3.5, t3:5.5 },
      keyEMAs: [9, 20, 50, 200],
      rsiPeriod: 14,
      bbPeriod: 20,
      description: 'كريبتو — تذبذب عالٍ — 15m + 1H + Daily',
    },
    forex: {
      timeframes: [
        { interval:'1h',  range:'30d', label:'ساعة',  weight:2 },
        { interval:'1d',  range:'6mo', label:'يومي',  weight:4 },
      ],
      primaryTF: '1d',
      atrMult: { sl:1.2, t1:1.8, t2:3.0, t3:4.5 },
      keyEMAs: [20, 50, 200],
      rsiPeriod: 14,
      bbPeriod: 20,
      description: 'فوركس — 1H + Daily',
    },
  };
  return configs[type] || configs.stock;
}

// ════════════════════════════════════
// جلب البيانات
// ════════════════════════════════════
async function fetchBars(yahooSym, interval, range) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?interval=${interval}&range=${range}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
    const q = result.indicators.quote[0];
    const vi = q.close.map((v,i) => v != null ? i : -1).filter(i => i >= 0);
    if (vi.length < 10) return null;
    return {
      closes:  vi.map(i => q.close[i]),
      highs:   vi.map(i => q.high[i]),
      lows:    vi.map(i => q.low[i]),
      volumes: vi.map(i => q.volume?.[i] || 0),
      opens:   vi.map(i => q.open?.[i] || q.close[i]),
      meta:    result.meta,
    };
  } catch(e) { return null; }
}

// ════════════════════════════════════
// المؤشرات الفنية
// ════════════════════════════════════
function calcEMA(p, n) {
  if (p.length < n) return null;
  const k = 2/(n+1);
  let e = p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i = n; i < p.length; i++) e = p[i]*k + e*(1-k);
  return +e.toFixed(4);
}

function calcSMA(p, n) {
  if (p.length < n) return null;
  return +(p.slice(-n).reduce((a,b)=>a+b,0)/n).toFixed(4);
}

function calcRSI(p, n=14) {
  if (p.length < n+1) return null;
  let g=0, l=0;
  for (let i=1; i<=n; i++) { const d=p[i]-p[i-1]; if(d>0)g+=d; else l-=d; }
  let ag=g/n, al=l/n;
  for (let i=n+1; i<p.length; i++) {
    const d=p[i]-p[i-1];
    if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}
    else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}
  }
  return al===0?100:+(100-(100/(1+ag/al))).toFixed(2);
}

function calcMACD(p) {
  if (p.length < 26) return null;
  const macdValues = [];
  for (let i = 26; i <= p.length; i++) {
    const e12 = calcEMA(p.slice(0,i), 12);
    const e26 = calcEMA(p.slice(0,i), 26);
    if (e12 && e26) macdValues.push(e12-e26);
  }
  const macdLine = macdValues[macdValues.length-1] || 0;
  const signal   = macdValues.length >= 9 ? calcEMA(macdValues, 9) || macdLine : macdLine;
  const histogram = +(macdLine - signal).toFixed(4);
  return { macd:+macdLine.toFixed(4), signal:+signal.toFixed(4), histogram, bullish: macdLine > signal };
}

function calcATR(h, l, c, n=14) {
  if (c.length < n+1) return null;
  const trs = [];
  for (let i=1; i<c.length; i++)
    trs.push(Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1])));
  return +(trs.slice(-n).reduce((a,b)=>a+b,0)/n).toFixed(4);
}

function calcBB(p, n=20) {
  if (p.length < n) return null;
  const s = p.slice(-n);
  const mean = s.reduce((a,b)=>a+b,0)/n;
  const std  = Math.sqrt(s.reduce((a,b)=>a+(b-mean)**2,0)/n);
  const price = p[p.length-1];
  return {
    upper:  +(mean+2*std).toFixed(2),
    middle: +mean.toFixed(2),
    lower:  +(mean-2*std).toFixed(2),
    width:  +((4*std/mean)*100).toFixed(2),
    pct:    std>0?+((price-(mean-2*std))/(4*std)*100).toFixed(1):50,
  };
}

function calcStoch(h, l, c, k=14, d=3) {
  if (c.length < k) return null;
  const kVals = [];
  for (let i=k; i<=c.length; i++) {
    const hh = Math.max(...h.slice(i-k,i));
    const ll = Math.min(...l.slice(i-k,i));
    kVals.push(hh===ll?50:(c[i-1]-ll)/(hh-ll)*100);
  }
  const kVal = kVals[kVals.length-1];
  const dVal = kVals.length>=d ? kVals.slice(-d).reduce((a,b)=>a+b,0)/d : kVal;
  return { k:+kVal.toFixed(2), d:+dVal.toFixed(2), overbought:kVal>80, oversold:kVal<20 };
}

function calcWilliamsR(h, l, c, n=14) {
  if (c.length < n) return null;
  const hh = Math.max(...h.slice(-n));
  const ll = Math.min(...l.slice(-n));
  return hh===ll?-50:+((hh-c[c.length-1])/(hh-ll)*-100).toFixed(2);
}

function calcCCI(h, l, c, n=20) {
  if (c.length < n) return null;
  const tp = c.map((ci,i) => (h[i]+l[i]+ci)/3);
  const sl = tp.slice(-n);
  const mean = sl.reduce((a,b)=>a+b,0)/n;
  const dev  = sl.reduce((a,b)=>a+Math.abs(b-mean),0)/n;
  return dev===0?0:+((tp[tp.length-1]-mean)/(0.015*dev)).toFixed(2);
}

function calcOBV(c, v) {
  let obv = 0;
  const vals = [0];
  for (let i=1; i<c.length; i++) {
    if (c[i]>c[i-1]) obv+=v[i];
    else if (c[i]<c[i-1]) obv-=v[i];
    vals.push(obv);
  }
  const trend = vals[vals.length-1] > vals[Math.max(0,vals.length-10)] ? 'rising' : 'falling';
  return { value:obv, trend };
}

function calcVWAP(h, l, c, v) {
  let pv=0, tv=0;
  for (let i=0; i<c.length; i++) { const tp=(h[i]+l[i]+c[i])/3; pv+=tp*v[i]; tv+=v[i]; }
  return tv>0?+(pv/tv).toFixed(2):c[c.length-1];
}

function calcADX(h, l, c, n=14) {
  if (c.length < n*2) return null;
  const trs=[], pDMs=[], mDMs=[];
  for (let i=1; i<c.length; i++) {
    trs.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
    pDMs.push(h[i]-h[i-1]>l[i-1]-l[i]?Math.max(h[i]-h[i-1],0):0);
    mDMs.push(l[i-1]-l[i]>h[i]-h[i-1]?Math.max(l[i-1]-l[i],0):0);
  }
  const atr  = trs.slice(-n).reduce((a,b)=>a+b,0)/n;
  const pDI  = atr>0?+(pDMs.slice(-n).reduce((a,b)=>a+b,0)/n/atr*100).toFixed(2):0;
  const mDI  = atr>0?+(mDMs.slice(-n).reduce((a,b)=>a+b,0)/n/atr*100).toFixed(2):0;
  const dx   = pDI+mDI>0?Math.abs(pDI-mDI)/(pDI+mDI)*100:0;
  return { adx:+dx.toFixed(2), plusDI:pDI, minusDI:mDI,
           trending:dx>20, strong:dx>35,
           direction: pDI>mDI?'bullish':'bearish' };
}

function calcPivots(h, l, c) {
  const p = (h+l+c)/3;
  return {
    pivot:+p.toFixed(2),
    r1:+(2*p-l).toFixed(2), r2:+(p+(h-l)).toFixed(2), r3:+(h+2*(p-l)).toFixed(2),
    s1:+(2*p-h).toFixed(2), s2:+(p-(h-l)).toFixed(2), s3:+(l-2*(h-p)).toFixed(2),
    cr4:+(c+(h-l)*1.1/2).toFixed(2), cr3:+(c+(h-l)*1.1/4).toFixed(2),
    cs3:+(c-(h-l)*1.1/4).toFixed(2), cs4:+(c-(h-l)*1.1/2).toFixed(2),
  };
}

function calcFib(high, low) {
  const d = high-low;
  return {
    '0':   +high.toFixed(2),
    '236': +(high-d*0.236).toFixed(2),
    '382': +(high-d*0.382).toFixed(2),
    '500': +(high-d*0.5).toFixed(2),
    '618': +(high-d*0.618).toFixed(2),
    '786': +(high-d*0.786).toFixed(2),
    '1000':+low.toFixed(2),
    '1272':+(low-d*0.272).toFixed(2),
    '1618':+(low-d*0.618).toFixed(2),
  };
}

function calcMarketStructure(c, h, l) {
  if (c.length < 20) return { structure:'unknown', structureAr:'غير محدد' };
  const n = Math.min(c.length, 60);
  const rc=c.slice(-n), rh=h.slice(-n), rl=l.slice(-n);
  const pivH=[], pivL=[];
  for (let i=2; i<rc.length-2; i++) {
    if (rh[i]>rh[i-1]&&rh[i]>rh[i-2]&&rh[i]>rh[i+1]&&rh[i]>rh[i+2]) pivH.push(rh[i]);
    if (rl[i]<rl[i-1]&&rl[i]<rl[i-2]&&rl[i]<rl[i+1]&&rl[i]<rl[i+2]) pivL.push(rl[i]);
  }
  let structure = 'ranging';
  if (pivH.length>=2 && pivL.length>=2) {
    const hh = pivH[pivH.length-1]>pivH[pivH.length-2];
    const hl = pivL[pivL.length-1]>pivL[pivL.length-2];
    const lh = pivH[pivH.length-1]<pivH[pivH.length-2];
    const ll = pivL[pivL.length-1]<pivL[pivL.length-2];
    if (hh&&hl) structure='uptrend';
    else if (lh&&ll) structure='downtrend';
    else if (lh&&hl) structure='consolidation';
  }
  return {
    structure,
    structureAr: structure==='uptrend'?'↑ اتجاه صاعد (HH+HL)':
                 structure==='downtrend'?'↓ اتجاه هابط (LL+LH)':
                 structure==='consolidation'?'◆ تضييق':
                 '↔ تذبذب',
    isUptrend:   structure==='uptrend',
    isDowntrend: structure==='downtrend',
    pivotHighs:  pivH.slice(-3).map(p=>+p.toFixed(2)),
    pivotLows:   pivL.slice(-3).map(p=>+p.toFixed(2)),
  };
}

function detectWyckoff(c, v, h, l) {
  const n = Math.min(c.length, 60);
  const rc=c.slice(-n), rv=v.slice(-n), rh=h.slice(-n), rl=l.slice(-n);
  const avgV = rv.reduce((a,b)=>a+b,0)/n;
  const recentV = rv.slice(-5).reduce((a,b)=>a+b,0)/5;
  const vr = recentV/avgV;
  const price = rc[rc.length-1];
  const rngH = Math.max(...rh), rngL = Math.min(...rl);
  const pos = (price-rngL)/(rngH-rngL);
  const chg = (rc[rc.length-1]-rc[0])/rc[0]*100;
  let phase, phaseAr, bias;
  if (pos<0.25&&vr>1.2)      {phase='Accumulation';phaseAr='تراكم 🟢';bias='bull';}
  else if (pos>0.75&&vr>1.2) {phase='Distribution';phaseAr='توزيع 🔴';bias='bear';}
  else if (chg>5&&pos>0.6)   {phase='Markup';phaseAr='صعود (Markup)';bias='bull';}
  else if (chg<-5&&pos<0.4)  {phase='Markdown';phaseAr='هبوط (Markdown)';bias='bear';}
  else                        {phase='Ranging';phaseAr='تذبذب';bias='neutral';}
  return {phase,phaseAr,bias,volRatio:+vr.toFixed(2),posInRange:+pos.toFixed(2)};
}

function detectCandles(o, c, h, l) {
  const patterns = [];
  const n=c.length;
  if (n<3) return patterns;
  const last=n-1, prev=n-2, prev2=n-3;
  const body=i=>Math.abs(c[i]-o[i]);
  const rng=i=>h[i]-l[i];
  const upS=i=>h[i]-Math.max(c[i],o[i]);
  const loS=i=>Math.min(c[i],o[i])-l[i];
  const isBull=i=>c[i]>o[i];
  const isBear=i=>c[i]<o[i];
  const isDoji=i=>body(i)<rng(i)*0.1;
  const isHmr=i=>loS(i)>body(i)*2&&upS(i)<body(i)*0.5;
  const isSS=i=>upS(i)>body(i)*2&&loS(i)<body(i)*0.5;

  if(isDoji(last)) patterns.push({name:'Doji',ar:'دوجي ⚪',type:'neutral',strength:2});
  if(body(last)>rng(last)*0.9&&isBull(last)) patterns.push({name:'Bullish Marubozu',ar:'ماروبوزو صاعد',type:'bull',strength:3});
  if(body(last)>rng(last)*0.9&&isBear(last)) patterns.push({name:'Bearish Marubozu',ar:'ماروبوزو هابط',type:'bear',strength:3});
  if(isHmr(last)) patterns.push(isBear(prev)||isBear(prev2)?{name:'Hammer',ar:'المطرقة 🔨',type:'bull',strength:3}:{name:'Hanging Man',ar:'الرجل المشنوق',type:'bear',strength:2});
  if(isSS(last)) patterns.push(isBull(prev)?{name:'Shooting Star',ar:'النجمة الساقطة ⭐',type:'bear',strength:3}:{name:'Inverted Hammer',ar:'المطرقة المعكوسة',type:'bull',strength:2});
  if(isBull(last)&&isBear(prev)&&o[last]<=c[prev]&&c[last]>=o[prev]&&body(last)>body(prev))
    patterns.push({name:'Bullish Engulfing',ar:'الابتلاع الصاعد 🟢',type:'bull',strength:4});
  if(isBear(last)&&isBull(prev)&&o[last]>=c[prev]&&c[last]<=o[prev]&&body(last)>body(prev))
    patterns.push({name:'Bearish Engulfing',ar:'الابتلاع الهابط 🔴',type:'bear',strength:4});
  if(n>=3&&isBull(last)&&isBull(prev)&&isBull(prev2)&&c[last]>c[prev]&&c[prev]>c[prev2])
    patterns.push({name:'Three White Soldiers',ar:'ثلاثة جنود بيض 🟢🟢🟢',type:'bull',strength:5});
  if(n>=3&&isBear(last)&&isBear(prev)&&isBear(prev2)&&c[last]<c[prev]&&c[prev]<c[prev2])
    patterns.push({name:'Three Black Crows',ar:'ثلاثة غربان سود 🔴🔴🔴',type:'bear',strength:5});
  if(n>=3&&isBear(prev2)&&isDoji(prev)&&isBull(last)&&c[last]>(o[prev2]+c[prev2])/2)
    patterns.push({name:'Morning Star',ar:'نجمة الصباح ⭐',type:'bull',strength:4});
  if(n>=3&&isBull(prev2)&&isDoji(prev)&&isBear(last)&&c[last]<(o[prev2]+c[prev2])/2)
    patterns.push({name:'Evening Star',ar:'نجمة المساء ⭐',type:'bear',strength:4});
  if(isBear(prev)&&isBull(last)&&o[last]<l[prev]&&c[last]>(o[prev]+c[prev])/2)
    patterns.push({name:'Piercing Line',ar:'خط الاختراق',type:'bull',strength:3});
  if(isBull(prev)&&isBear(last)&&o[last]>h[prev]&&c[last]<(o[prev]+c[prev])/2)
    patterns.push({name:'Dark Cloud Cover',ar:'غطاء السحابة الداكنة',type:'bear',strength:3});
  return patterns;
}

function calcVolume(c, v) {
  const n=Math.min(c.length,20);
  const rc=c.slice(-n), rv=v.slice(-n);
  const avg=rv.reduce((a,b)=>a+b,0)/n;
  const last=rv[rv.length-1];
  const vr=last/avg;
  let upV=0,dnV=0,upD=0,dnD=0;
  for(let i=1;i<rc.length;i++){
    if(rc[i]>rc[i-1]){upV+=rv[i];upD++;}
    else{dnV+=rv[i];dnD++;}
  }
  const avgUp=upD>0?upV/upD:0, avgDn=dnD>0?dnV/dnD:0;
  let sig='neutral';
  if(avgUp>avgDn*1.3&&rc[rc.length-1]>rc[0])sig='accumulation';
  else if(avgDn>avgUp*1.3&&rc[rc.length-1]<rc[0])sig='distribution';
  else if(vr<0.5)sig='drying_up';
  else if(vr>2.0)sig='climax';
  return {
    avgVol:+avg.toFixed(0), lastVol:last, volRatio:+vr.toFixed(2), signal:sig,
    signalAr:sig==='accumulation'?'🟢 تراكم':sig==='distribution'?'🔴 توزيع':sig==='drying_up'?'⚪ جفاف':sig==='climax'?'⚡ ذروة':'— طبيعي',
    bullish:sig==='accumulation', bearish:sig==='distribution',
  };
}

function calcSR(h, l, c, price) {
  const n=Math.min(c.length,100), tol=price*0.003;
  const all=[...h.slice(-n),...l.slice(-n)];
  const clusters=[];
  all.forEach(lv=>{
    const ex=clusters.find(cl=>Math.abs(cl.price-lv)<tol);
    if(ex){ex.count++;ex.price=(ex.price+lv)/2;}
    else clusters.push({price:lv,count:1});
  });
  const strong=clusters.filter(c=>c.count>=3).sort((a,b)=>b.count-a.count).slice(0,10);
  return {
    resistances: strong.filter(l=>l.price>price*1.001).sort((a,b)=>a.price-b.price).slice(0,3),
    supports:    strong.filter(l=>l.price<price*0.999).sort((a,b)=>b.price-a.price).slice(0,3),
  };
}

// ════════════════════════════════════
// تحليل فريم واحد
// ════════════════════════════════════
function analyzeTF(bars, type, label) {
  const { closes:c, highs:h, lows:l, volumes:v, opens:o } = bars;
  const price = c[c.length-1];

  const rsi    = calcRSI(c, 14);
  const ema9   = calcEMA(c, 9);
  const ema20  = calcEMA(c, 20);
  const ema50  = calcEMA(c, 50);
  const ema200 = c.length>=200?calcEMA(c,200):null;
  const macd   = calcMACD(c);
  const atr    = calcATR(h,l,c,14);
  const bb     = calcBB(c,20);
  const stoch  = calcStoch(h,l,c,14,3);
  const adx    = calcADX(h,l,c,14);
  const obv    = calcOBV(c,v);
  const vwap   = calcVWAP(h,l,c,v);
  const willR  = calcWilliamsR(h,l,c,14);
  const cci    = calcCCI(h,l,c,20);
  const volume = calcVolume(c,v);
  const struct = calcMarketStructure(c,h,l);
  const candles= detectCandles(o,c,h,l);

  // Score لهذا الفريم
  let score = 0;

  // Market Structure
  if(struct.isUptrend)   score+=3;
  else if(struct.isDowntrend) score-=3;

  // EMA Alignment
  if(price>ema20&&ema20>ema50) score+=2;
  else if(price<ema20&&ema20<ema50) score-=2;
  if(ema200){if(price>ema200)score+=1;else score-=1;}

  // RSI
  if(rsi<30)score+=3;else if(rsi<45)score+=1;
  else if(rsi>70)score-=3;else if(rsi>55)score+=1;

  // MACD
  if(macd?.bullish&&macd.histogram>0)score+=2;
  else if(!macd?.bullish&&macd?.histogram<0)score-=2;
  else if(macd?.bullish)score+=1;else score-=1;

  // Bollinger
  if(bb){
    if(price<=bb.lower)score+=3;
    else if(price>=bb.upper)score-=3;
    else if(price>bb.middle)score+=1;else score-=1;
  }

  // Stochastic
  if(stoch?.oversold)score+=2;
  else if(stoch?.overbought)score-=2;

  // ADX
  if(adx?.trending){
    if(adx.direction==='bullish'&&adx.strong)score+=2;
    else if(adx.direction==='bearish'&&adx.strong)score-=2;
  }

  // VWAP
  if(price>vwap)score+=1;else score-=1;

  // OBV
  if(obv.trend==='rising')score+=1;else score-=1;

  // Volume
  if(volume.bullish)score+=2;else if(volume.bearish)score-=2;

  // Candles
  candles.forEach(p=>{
    if(p.type==='bull'&&p.strength>=3)score+=Math.min(p.strength,2);
    else if(p.type==='bear'&&p.strength>=3)score-=Math.min(p.strength,2);
  });

  const signal = score>=5?'CALL':score<=-5?'PUT':'WAIT';
  const signalClass = signal==='CALL'?'bull':signal==='PUT'?'bear':'neutral';

  // أسباب موجزة
  const reasons = [];
  if(struct.isUptrend)reasons.push('هيكل صاعد');
  else if(struct.isDowntrend)reasons.push('هيكل هابط');
  if(rsi<30)reasons.push(`RSI ${rsi} تشبع بيع`);
  else if(rsi>70)reasons.push(`RSI ${rsi} تشبع شراء`);
  else reasons.push(`RSI ${rsi}`);
  if(macd?.bullish)reasons.push('MACD ↑');else reasons.push('MACD ↓');
  if(bb&&price<=bb.lower)reasons.push('BB سفلي');
  else if(bb&&price>=bb.upper)reasons.push('BB علوي');
  if(candles.length>0)reasons.push(candles[0].ar);

  return {
    label, signal: score>=5?'CALL':score<=-5?'PUT':'WAIT',
    signalClass: score>=5?'bull':score<=-5?'bear':'neutral',
    score,
    price, rsi, ema9, ema20, ema50, ema200,
    macd, atr, bb, stoch, adx, obv, vwap,
    willR, cci, volume, struct, candles,
    reasons: reasons.slice(0,5),
  };
}

// ════════════════════════════════════
// القرار الموحد Top-Down
// ════════════════════════════════════
function makeTopDownDecision(tfResults, config, type) {
  // وزن كل فريم
  let totalScore = 0, totalWeight = 0;
  const weightedTFs = [];

  tfResults.forEach((tf, i) => {
    const w = config.timeframes[i]?.weight || 1;

    // للمؤشرات: الفريم الكبير له وزن أكبر (Top-Down)
    // الفريم الصغير (5m/15m) يُستخدم للتأكيد فقط
    const adjustedWeight = type === 'index'
      ? w  // يومي وزن 4، 5 دقائق وزن 1
      : w;

    totalScore  += tf.score * adjustedWeight;
    totalWeight += adjustedWeight;
    weightedTFs.push({ ...tf, weight: adjustedWeight });
  });

  const avgScore = totalWeight > 0 ? totalScore / totalWeight : 0;

  // تحقق من التوافق — الفريمات الكبيرة تحكم
  const bigTFs   = weightedTFs.filter(tf => tf.weight >= 4); // يومي + أسبوعي
  const smallTFs = weightedTFs.filter(tf => tf.weight <= 2); // 5m + 15m + ساعة

  const bigBull   = bigTFs.filter(tf => tf.signal === 'CALL').length;
  const bigBear   = bigTFs.filter(tf => tf.signal === 'PUT').length;
  const smallBull = smallTFs.filter(tf => tf.signal === 'CALL').length;
  const smallBear = smallTFs.filter(tf => tf.signal === 'PUT').length;

  // للمؤشرات: يجب أن الاتجاه الكبير يتوافق مع الصغير
  // للأسهم: اليومي يحكم
  let finalSignal, confidence, summary;

  if (type === 'index') {
    // المؤشرات: Top-Down صارم
    if (bigBull >= 1 && smallBull >= 1 && avgScore > 3) {
      finalSignal = 'CALL';
      confidence  = Math.min(95, Math.round(50 + avgScore * 4));
      summary = `📈 الاتجاه الكبير + الصغير صاعد — دخول قوي`;
    } else if (bigBear >= 1 && smallBear >= 1 && avgScore < -3) {
      finalSignal = 'PUT';
      confidence  = Math.min(95, Math.round(50 + Math.abs(avgScore) * 4));
      summary = `📉 الاتجاه الكبير + الصغير هابط — دخول قوي`;
    } else if (bigBull >= 1 && smallBear >= 1) {
      finalSignal = 'WAIT';
      confidence  = 40;
      summary = `⚠️ تعارض: الاتجاه الكبير صاعد لكن الصغير هابط — انتظر`;
    } else if (bigBear >= 1 && smallBull >= 1) {
      finalSignal = 'WAIT';
      confidence  = 40;
      summary = `⚠️ تعارض: الاتجاه الكبير هابط لكن الصغير صاعد — انتظر`;
    } else {
      finalSignal = avgScore > 2 ? 'CALL' : avgScore < -2 ? 'PUT' : 'WAIT';
      confidence  = Math.min(75, Math.round(50 + Math.abs(avgScore) * 3));
      summary = `إشارة متوسطة القوة — تأكيد مطلوب`;
    }
  } else {
    // الأسهم والكريبتو: اليومي يحكم
    finalSignal = avgScore >= 5 ? 'CALL' : avgScore <= -5 ? 'PUT' : avgScore >= 2 ? 'CALL' : avgScore <= -2 ? 'PUT' : 'WAIT';
    confidence  = Math.min(90, Math.round(50 + Math.abs(avgScore) * 4));
    summary     = finalSignal === 'CALL' ? `📈 إشارة شراء — ${confidence}% ثقة` :
                  finalSignal === 'PUT'  ? `📉 إشارة بيع — ${confidence}% ثقة` :
                  '⚪ انتظار — لا إشارة حاسمة';
  }

  // القرار النهائي مع الأسباب
  const primaryTF = weightedTFs.find(tf => tf.weight === Math.max(...weightedTFs.map(t=>t.weight)));
  const reasons = primaryTF ? primaryTF.reasons.map(r => ({ type: finalSignal==='CALL'?'bull':'bear', text: r })) : [];

  const verdict = finalSignal === 'CALL' ? '🟢 شراء' : finalSignal === 'PUT' ? '🔴 بيع' : '⚪ انتظار';
  const cls     = finalSignal === 'CALL' ? 'buy' : finalSignal === 'PUT' ? 'avoid' : 'wait';

  return {
    verdict, class: cls, confidence, summary,
    reasons, score: +avgScore.toFixed(2),
    finalSignal, avgScore: +avgScore.toFixed(2),
    alignment: { bigBull, bigBear, smallBull, smallBear },
  };
}

// ════════════════════════════════════
// الـ Handler
// ════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const symbol  = (req.query.symbol || 'NVDA').toUpperCase();
  const yahooSym = YAHOO_MAP[symbol] || symbol;
  const type     = getSymbolType(symbol);
  const config   = getConfig(type);

  try {
    // جلب كل الفريمات بالتوازي
    const barsPromises = config.timeframes.map(tf =>
      fetchBars(yahooSym, tf.interval, tf.range)
    );
    const allBars = await Promise.all(barsPromises);

    // تحليل كل فريم
    const tfResults = [];
    let primaryBars = null;

    for (let i = 0; i < config.timeframes.length; i++) {
      const bars = allBars[i];
      const tf   = config.timeframes[i];
      if (!bars) continue;
      if (tf.interval === config.primaryTF) primaryBars = bars;
      tfResults.push(analyzeTF(bars, type, tf.label));
    }

    // fallback
    if (!primaryBars) primaryBars = allBars.find(Boolean);
    if (!primaryBars) throw new Error('لا توجد بيانات للرمز: ' + symbol);

    const { closes:c, highs:h, lows:l, volumes:v, opens:o, meta } = primaryBars;
    const price     = meta.regularMarketPrice || c[c.length-1];
    const prevClose = meta.chartPreviousClose  || c[c.length-2] || price;
    const open      = meta.regularMarketOpen   || c[c.length-1];
    const high      = meta.regularMarketDayHigh || h[h.length-1];
    const low       = meta.regularMarketDayLow  || l[l.length-1];
    const volume    = meta.regularMarketVolume  || v[v.length-1];
    const fullName  = meta.longName || meta.shortName || symbol;
    const exchange  = meta.exchangeName || (type==='stock'?'NASDAQ':'—');

    const change        = +(price - prevClose).toFixed(2);
    const changePercent = +((change / prevClose) * 100).toFixed(2);

    // المؤشرات من الفريم الرئيسي (يومي)
    const primary = tfResults.find(tf => tf.label === (type==='index'?'يومي':type==='crypto'?'يومي':'يومي')) || tfResults[tfResults.length-1];

    // Divergence — مرة واحدة فقط على البيانات اليومية
    let divergence = { bull:false, bear:false, type:null, ar:null };
    try {
      const _dc = closes.slice(-25);
      const _rsiArr = [];
      for (let _i = 15; _i <= _dc.length; _i++) {
        const _r = calcRSI(_dc.slice(0,_i), 14);
        if (_r) _rsiArr.push(_r);
      }
      divergence = detectDivergence(_dc, _rsiArr, null);
    } catch(e) {}

    // القرار Top-Down
    const decision = makeTopDownDecision(tfResults, config, type);
    // أضف تأثير Divergence للقرار
    if (divergence.bull) { decision.score = +(decision.score + 1.5).toFixed(2); decision.reasons.push({ type:'bull', text: divergence.ar }); }
    if (divergence.bear) { decision.score = +(decision.score - 1.5).toFixed(2); decision.reasons.push({ type:'bear', text: divergence.ar }); }

    // Fibonacci & Pivots
    const high60d = +Math.max(...h.slice(-60)).toFixed(2);
    const low60d  = +Math.min(...l.slice(-60)).toFixed(2);
    const fib     = calcFib(high60d, low60d);
    const pivots  = calcPivots(h[h.length-2]||high, l[l.length-2]||low, c[c.length-2]||prevClose);
    const sr      = calcSR(h, l, c, price);
    const wyckoff = detectWyckoff(c, v, h, l);

    // MTF Signal للعرض
    const mtfSignal = {
      finalSignal: decision.finalSignal,
      finalClass:  decision.class === 'buy' ? 'bull' : decision.class === 'avoid' ? 'bear' : 'neutral',
      confluence:  decision.finalSignal==='CALL'?'صاعد':decision.finalSignal==='PUT'?'هابط':'محايد',
      confluenceClass: decision.class==='buy'?'bull':decision.class==='avoid'?'bear':'neutral',
      confidence:  decision.confidence,
      avgScore:    decision.avgScore,
      timeframes:  tfResults.map(tf => ({
        tf:          tf.label,
        signal:      tf.signal,
        signalClass: tf.signalClass,
        rsi:         tf.rsi,
        reasons:     tf.reasons,
        score:       tf.score,
      })),
      typeInfo: config.description,
      alignment: decision.alignment,
    };

    // Risk/Reward حسب نوع الرمز
    const atr = primary?.atr || calcATR(h,l,c,14) || price*0.01;
    const mult = config.atrMult;
    const isCall = decision.finalSignal === 'CALL';
    const riskReward = {
      entry:    +price.toFixed(2),
      stopLoss: +(price - atr*mult.sl*(isCall?1:-1)).toFixed(2),
      target1:  +(price + atr*mult.t1*(isCall?1:-1)).toFixed(2),
      target2:  +(price + atr*mult.t2*(isCall?1:-1)).toFixed(2),
      target3:  +(price + atr*mult.t3*(isCall?1:-1)).toFixed(2),
      slPct:    +((atr*mult.sl/price)*100).toFixed(2),
      t1Pct:    +((atr*mult.t1/price)*100).toFixed(2),
      rr1:      +(mult.t1/mult.sl).toFixed(1),
      rr2:      +(mult.t2/mult.sl).toFixed(1),
      quality:  atr/price<0.015?'ممتاز':atr/price<0.03?'جيد':'ضعيف',
      atr:      +atr.toFixed(2),
      symbolType: type,
    };

    // Methodologies
    const p = primary || {};
    const methodologies = [
      {
        name: `هيكل السوق & الاتجاه (Murphy) — ${config.description}`,
        icon:'M', source:'JOHN MURPHY',
        score: p.struct?.isUptrend?25:p.struct?.isDowntrend?-25:0,
        observation: `${p.struct?.structureAr} | Wyckoff: ${wyckoff.phaseAr} | نوع الرمز: ${type==='index'?'مؤشر':type==='crypto'?'كريبتو':'سهم'}`,
        details: {
          'نوع التحليل': config.description,
          'هيكل السوق':  p.struct?.structureAr||'—',
          'EMA 20':      `$${p.ema20}`,
          'EMA 50':      `$${p.ema50}`,
          ...(p.ema200?{'EMA 200':`$${p.ema200}`}:{}),
          'Wyckoff':     wyckoff.phaseAr,
        },
      },
      {
        name: 'RSI & Stochastic & Williams %R',
        icon:'O', source:'OSCILLATORS',
        score: p.rsi<30?25:p.rsi>70?-25:p.rsi>55?10:-10,
        observation: `RSI: ${p.rsi} | Stoch K/D: ${p.stoch?.k}/${p.stoch?.d} | W%R: ${p.willR} | CCI: ${p.cci}`,
        details: {
          'RSI(14)':     `${p.rsi} — ${p.rsi<30?'🟢 تشبع بيع':p.rsi>70?'🔴 تشبع شراء':'طبيعي'}`,
          'Stochastic':  `K:${p.stoch?.k} D:${p.stoch?.d} ${p.stoch?.oversold?'🟢':p.stoch?.overbought?'🔴':''}`,
          'Williams %R': `${p.willR} ${p.willR<-80?'🟢':p.willR>-20?'🔴':''}`,
          'CCI(20)':     `${p.cci}`,
        },
      },
      {
        name: 'MACD & ADX (Wyckoff/Weis)',
        icon:'Wd', source:'WYCKOFF / WEIS',
        score: (p.macd?.bullish?15:-15)+(p.adx?.direction==='bullish'?10:-10),
        observation: `MACD: ${p.macd?.macd} | Hist: ${p.macd?.histogram} | ADX: ${p.adx?.adx} | ${p.volume?.signalAr}`,
        details: {
          'MACD':        `${p.macd?.macd} ${p.macd?.bullish?'↑':'↓'}`,
          'Histogram':   `${p.macd?.histogram}`,
          'ADX':         `${p.adx?.adx} ${p.adx?.strong?'قوي':'ضعيف'} ${p.adx?.direction==='bullish'?'↑':'↓'}`,
          '+DI / -DI':   `${p.adx?.plusDI} / ${p.adx?.minusDI}`,
          'OBV':         `${p.obv?.trend==='rising'?'↑ صاعد':'↓ هابط'}`,
          'الحجم':       p.volume?.signalAr||'—',
          'ATR':         `$${p.atr}`,
        },
      },
      {
        name: 'Bollinger Bands & VWAP',
        icon:'BB', source:'BOLLINGER BANDS',
        score: p.bb?(price<=p.bb.lower?25:price>=p.bb.upper?-25:price>p.bb.middle?5:-5):0,
        observation: `BB Upper: $${p.bb?.upper} | Middle: $${p.bb?.middle} | Lower: $${p.bb?.lower} | VWAP: $${p.vwap}`,
        details: {
          'BB Upper':    `$${p.bb?.upper}`,
          'BB Middle':   `$${p.bb?.middle}`,
          'BB Lower':    `$${p.bb?.lower}`,
          'BB Width':    `${p.bb?.width}%`,
          '%B':          `${p.bb?.pct}%`,
          'VWAP':        `$${p.vwap}`,
          'السعر vs VWAP': price>p.vwap?'فوق VWAP ✅':'تحت VWAP ⚠️',
        },
      },
      {
        name: 'Fibonacci & Pivot & S/R (ICT/SMC)',
        icon:'F', source:'FIBONACCI / ICT / SMC',
        score: price>pivots.pivot?10:-10,
        observation: `Pivot: $${pivots.pivot} | R1: $${pivots.r1} | S1: $${pivots.s1} | Fib 0.618: $${fib['618']}`,
        details: {
          'Pivot':        `$${pivots.pivot}`,
          'R1/R2/R3':     `$${pivots.r1} / $${pivots.r2} / $${pivots.r3}`,
          'S1/S2/S3':     `$${pivots.s1} / $${pivots.s2} / $${pivots.s3}`,
          'Cam R4/S4':    `$${pivots.cr4} / $${pivots.cs4}`,
          'Fib 0.382':    `$${fib['382']}`,
          'Fib 0.618':    `$${fib['618']}`,
          'دعم قوي':      sr.supports[0]?`$${sr.supports[0].price.toFixed(2)} (${sr.supports[0].count}x)`:'—',
          'مقاومة قوية':  sr.resistances[0]?`$${sr.resistances[0].price.toFixed(2)} (${sr.resistances[0].count}x)`:'—',
        },
      },
      {
        name: 'التباعد (Divergence) — Murphy',
        icon:'DIV', source:'JOHN MURPHY',
        score: (divergence?.bull?30:divergence?.bear?-30:0),
        observation: divergence?.ar || 'لا يوجد تباعد واضح حالياً',
        details: {
          'التباعد': divergence?.ar || '— لا يوجد',
          'النوع': divergence?.type === 'bullish' ? '🟢 إيجابي (Bullish)' : divergence?.type === 'bearish' ? '🔴 سلبي (Bearish)' : '— لا يوجد',
          'الأهمية': 'تباعد RSI مع السعر = إشارة انعكاس قوية (Murphy)',
        },
      },
      {
        name: 'Price Action & Candlestick (Rayner/Al-Qasim)',
        icon:'PA', source:'PRICE ACTION',
        score: (p.candles||[]).reduce((s,c)=>s+(c.type==='bull'?c.strength:c.type==='bear'?-c.strength:0),0)*3,
        observation: (p.candles||[]).length>0?(p.candles||[]).map(c=>c.ar).join(' | '):'لا توجد أنماط واضحة',
        details: Object.fromEntries((p.candles||[]).map(c=>[c.ar,c.type==='bull'?'🟢 صاعد':c.type==='bear'?'🔴 هابط':'⚪'])),
      },
    ];

    const riskScore = (p.rsi||50)>75?80:(p.rsi||50)<25?20:p.adx?.strong?60:50;

    const volFmt = vol => vol>=1e9?(vol/1e9).toFixed(1)+'B':vol>=1e6?(vol/1e6).toFixed(1)+'M':vol>=1e3?(vol/1e3).toFixed(0)+'K':String(vol||0);

    return res.status(200).json({
      symbol, fullName, exchange, currency:'USD',
      price, open, high, low, change, changePercent,
      volume: volFmt(volume),
      high60d, low60d, fib,
      levels: { res2:pivots.r2, res1:pivots.r1, pivot:pivots.pivot, sup1:pivots.s1, sup2:pivots.s2 },
      pivots, sr,
      symbolType: type,
      analysisConfig: config.description,
      indicators: {
        rsi14: p.rsi, ema9: p.ema9, ema20: p.ema20,
        ema50: p.ema50, ema200: p.ema200,
        macd: p.macd, atr14: p.atr, bb: p.bb,
        stoch: p.stoch, willR: p.willR, cci: p.cci,
        obv: p.obv, vwap: p.vwap, adx: p.adx,
        trend_daily: p.struct?.isUptrend?'bullish':p.struct?.isDowntrend?'bearish':'neutral',
        trend_4h:    tfResults[1]?.struct?.isUptrend?'bullish':tfResults[1]?.struct?.isDowntrend?'bearish':'neutral',
        trend_1h:    tfResults[0]?.struct?.isUptrend?'bullish':tfResults[0]?.struct?.isDowntrend?'bearish':'neutral',
        momentum:    change>price*0.015?'strong_up':change>0?'up':change<-price*0.015?'strong_down':'down',
      },
      structure: p.struct,
      wyckoff,
      candlePatterns: p.candles||[],
      volumeAnalysis: p.volume,
      decision, methodologies,
      risk: { score:riskScore, label:riskScore>65?'مخاطرة عالية':riskScore<35?'مخاطرة منخفضة':'مخاطرة متوسطة' },
      mtfSignal, riskReward,
    });

  } catch(err) {
    return res.status(500).json({ error:true, message:err.message });
  }
};
