const https = require('https');

const BOT_TOKEN = '8353933401:AAHXbYHxTUBEiiNPGC3wBsTA2cL6VZ7jZm0';
const CHAT_ID   = '1721100632';

const DEFAULT_WATCHLIST = (process.env.WATCHLIST || 
  'AAPL,MSFT,NVDA,TSLA,AMZN,GOOGL,META,AMD,AVGO,MRVL,SPX,NDX,DJI,VIX,BTC,ETH,XAUUSD'
).split(',').map(s => s.trim()).filter(Boolean);

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

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({chat_id:CHAT_ID, text:message, parse_mode:'HTML'});
    const options = {
      hostname:'api.telegram.org',
      path:`/bot${BOT_TOKEN}/sendMessage`,
      method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    };
    const req = https.request(options, (res) => {
      let data='';
      res.on('data',c=>data+=c);
      res.on('end',()=>resolve(JSON.parse(data)));
    });
    req.on('error',reject);
    req.write(body); req.end();
  });
}

function calcSMA(p,n){if(p.length<n)return null;return p.slice(-n).reduce((a,b)=>a+b,0)/n;}
function calcRSI(p,n=14){
  if(p.length<n+1)return null;
  let g=0,l=0;
  for(let i=1;i<=n;i++){const d=p[i]-p[i-1];if(d>0)g+=d;else l-=d;}
  let ag=g/n,al=l/n;
  for(let i=n+1;i<p.length;i++){const d=p[i]-p[i-1];if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n;}else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n;}}
  if(al===0)return 100; return 100-(100/(1+ag/al));
}

// ── Macro: تأثير البيانات على السوق ──
const MACRO_RULES = {
  'Non-Farm': (a,f) => {
    const b = a-f;
    if(b>100) return {label:'🟢🟢 صعود قوي',     reason:'وظائف أقوى بكثير → اقتصاد قوي → أسهم ترتفع'};
    if(b>30)  return {label:'🟢 صعود متوسط',      reason:'وظائف أفضل من التوقعات'};
    if(b>-30) return {label:'⚪ تأثير لحظي فقط', reason:'قريب من التوقعات'};
    if(b>-100)return {label:'🔴 هبوط متوسط',      reason:'وظائف أقل من التوقعات'};
    return      {label:'🔴🔴 هبوط قوي',          reason:'وظائف ضعيفة جداً → مخاوف ركود'};
  },
  'CPI': (a,f) => {
    const b = a-f;
    if(b>0.3)  return {label:'🔴🔴 هبوط قوي',     reason:'تضخم أعلى بكثير → الفيد يرفع الفائدة → أسهم تهبط'};
    if(b>0.1)  return {label:'🔴 هبوط متوسط',      reason:'تضخم أعلى من التوقعات'};
    if(b>-0.1) return {label:'⚪ تأثير لحظي فقط', reason:'في خط التوقعات'};
    if(b>-0.3) return {label:'🟢 صعود متوسط',      reason:'تضخم أقل → الفيد قد يخفف'};
    return      {label:'🟢🟢 صعود قوي',            reason:'تضخم منخفض جداً → توقعات تخفيض الفائدة'};
  },
  'GDP': (a,f) => {
    const b = a-f;
    if(b>0.5)  return {label:'🟢🟢 صعود قوي',     reason:'نمو اقتصادي قوي جداً'};
    if(b>0.1)  return {label:'🟢 صعود متوسط',      reason:'نمو أفضل من المتوقع'};
    if(b>-0.1) return {label:'⚪ تأثير لحظي فقط', reason:'في خط التوقعات'};
    if(b>-0.5) return {label:'🔴 هبوط متوسط',      reason:'نمو أضعف من المتوقع'};
    return      {label:'🔴🔴 هبوط قوي',            reason:'نمو ضعيف جداً → مخاوف الركود'};
  },
  'PCE': (a,f) => {
    const b = a-f;
    if(b>0.2)  return {label:'🔴🔴 هبوط قوي',     reason:'PCE مرتفع → الفيد صارم'};
    if(b>0.05) return {label:'🔴 هبوط متوسط',      reason:'PCE أعلى من التوقعات'};
    if(b>-0.05)return {label:'⚪ تأثير لحظي فقط', reason:'في خط التوقعات'};
    return      {label:'🟢 صعود متوسط',             reason:'PCE منخفض → ضغط أقل على الفيد'};
  },
  'default': (a,f) => {
    const pct = f ? ((a-f)/Math.abs(f))*100 : 0;
    if(pct>10)  return {label:'🟢🟢 صعود قوي',     reason:'أفضل بكثير من التوقعات'};
    if(pct>3)   return {label:'🟢 صعود متوسط',      reason:'أفضل من التوقعات'};
    if(pct>-3)  return {label:'⚪ تأثير لحظي فقط', reason:'قريب من التوقعات'};
    if(pct>-10) return {label:'🔴 هبوط متوسط',      reason:'أضعف من التوقعات'};
    return       {label:'🔴🔴 هبوط قوي',            reason:'أضعف بكثير من التوقعات'};
  }
};

function getImpact(title, actual, forecast) {
  const a = parseFloat(actual), f = parseFloat(forecast);
  if(isNaN(a)||isNaN(f)) return {label:'⚪ غير محدد', reason:'بيانات غير كافية'};
  for(const key of Object.keys(MACRO_RULES)) {
    if(key !== 'default' && title.includes(key)) return MACRO_RULES[key](a,f);
  }
  return MACRO_RULES['default'](a,f);
}

// مخزن الأحداث المُرسلة (بمتغير في الذاكرة — يُصفَّر عند إعادة تشغيل السيرفر)
const sentMacroEvents = new Set();

async function checkMacroEvents() {
  try {
    const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
    const events = await fetchJSON(url);
    if(!Array.isArray(events)) return 0;

    const now = new Date();
    const sent = [];

    for(const e of events) {
      if(!e.title || !e.actual) continue;                    // لم يصدر بعد
      if(e.impact !== 'High' && e.impact !== 'Medium') continue; // تأثير منخفض تجاهل
      
      const eventTime = new Date(e.date);
      const diffMin = (now - eventTime) / 60000;
      if(diffMin < 0 || diffMin > 15) continue;             // صدر في آخر 15 دقيقة فقط

      const eventKey = e.title + '_' + e.date;
      if(sentMacroEvents.has(eventKey)) continue;            // أُرسل مسبقاً
      sentMacroEvents.add(eventKey);

      const impact = getImpact(e.title, e.actual, e.forecast);
      const impactEmoji = e.impact === 'High' ? '🔴' : '🟡';
      const timeStr = eventTime.toLocaleTimeString('ar-SA', {hour:'2-digit', minute:'2-digit', timeZone:'Asia/Riyadh'});

      const msg =
        `🌍 <b>بيانة اقتصادية صدرت للتو!</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${e.title}</b>\n` +
        `${impactEmoji} التأثير: <b>${e.impact === 'High' ? 'عالٍ' : 'متوسط'}</b>  |  ⏰ ${timeStr}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📊 الفعلي:    <b>${e.actual}</b>\n` +
        `🎯 التوقعات: ${e.forecast || '—'}\n` +
        `📅 السابق:   ${e.previous || '—'}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `${impact.label}\n` +
        `💡 ${impact.reason}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🤖 <i>TIH Trading Hub</i>`;

      await sendTelegram(msg);
      sent.push(e.title);
    }
    return sent.length;
  } catch(e) {
    return 0;
  }
}

async function analyzeSymbol(symbol) {
  const yfSym = YAHOO_MAP[symbol] || symbol;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?interval=1d&range=6mo`;
  const json = await fetchJSON(url);
  const result = json?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta;
  const q = result.indicators.quote[0];
  const vi = q.close.map((v,i)=>v!==null?i:-1).filter(i=>i>=0);
  const closes = vi.map(i=>q.close[i]);
  const highs  = vi.map(i=>q.high[i]);
  const lows   = vi.map(i=>q.low[i]);

  const price     = meta.regularMarketPrice || closes[closes.length-1];
  const prevClose = closes.length>=2 ? closes[closes.length-2] : price;
  const changePct = ((price-prevClose)/prevClose*100).toFixed(2);

  const rsi   = calcRSI(closes);
  const sma20 = calcSMA(closes,20);
  const sma50 = calcSMA(closes,50);
  const H=highs[highs.length-1], L=lows[lows.length-1];
  const pivot=(H+L+prevClose)/3;
  const res1=(2*pivot-L).toFixed(2);
  const res2=(pivot+(H-L)).toFixed(2);
  const sup1=(2*pivot-H).toFixed(2);
  const sup2=(pivot-(H-L)).toFixed(2);

  let score=0;
  if(price>pivot) score+=2; else score-=2;
  if(parseFloat(changePct)>1) score+=2;
  else if(parseFloat(changePct)>0) score+=1;
  else if(parseFloat(changePct)<-1) score-=2;
  else score-=1;
  if(sma20&&sma50&&price>sma20&&sma20>sma50) score+=2;
  else if(sma20&&price<sma20) score-=2;
  if(rsi&&rsi>70) score-=1;
  else if(rsi&&rsi<30) score+=1;
  else if(rsi&&rsi>55) score+=1;

  const signal = score>=4?'CALL':score<=-4?'PUT':null;
  const confidence = Math.min(90, Math.round(50+Math.abs(score)*7));

  let rr = null;
  if (signal) {
    let atrVal = price * 0.01;
    if (closes.length > 14) {
      let sum=0;
      for(let i=closes.length-14;i<closes.length;i++){
        const hl=highs[i]-lows[i];
        const hpc=i>0?Math.abs(highs[i]-closes[i-1]):0;
        const lpc=i>0?Math.abs(lows[i]-closes[i-1]):0;
        sum+=Math.max(hl,hpc,lpc);
      }
      atrVal = sum/14;
    }
    const r1f=parseFloat(res1), s1f=parseFloat(sup1);
    const recentLow  = Math.min(...lows.slice(-5));
    const recentHigh = Math.max(...highs.slice(-5));
    let entry, sl, t1;
    if(signal==='CALL'){
      entry=price;
      sl=Math.max(recentLow-(atrVal*0.3), price*0.97);
      t1=r1f>price?r1f:price*1.015;
    } else {
      entry=price;
      sl=Math.min(recentHigh+(atrVal*0.3), price*1.03);
      t1=s1f<price?s1f:price*0.985;
    }
    const risk=Math.abs(entry-sl), rew1=Math.abs(t1-entry);
    rr = {
      entry:entry.toFixed(2), sl:sl.toFixed(2), t1:t1.toFixed(2),
      slPct:((sl-entry)/entry*100).toFixed(2),
      t1Pct:((t1-entry)/entry*100).toFixed(2),
      rr1: risk>0?(rew1/risk).toFixed(2):'—'
    };
  }

  return {
    symbol, price:price.toFixed(2), changePct,
    rsi:rsi?rsi.toFixed(1):'—',
    pivot:pivot.toFixed(2), res1, res2, sup1, sup2,
    signal, score, confidence, rr,
    currency: meta.currency||'USD',
    fullName: meta.longName||meta.shortName||symbol
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'check';

  // Test
  if(action==='test') {
    try {
      await sendTelegram(
        '🤖 <b>TIH Trading Hub</b>\n' +
        '━━━━━━━━━━━━━━━\n' +
        '✅ نظام التنبيهات يعمل!\n\n' +
        '📋 القائمة الحالية:\n' +
        DEFAULT_WATCHLIST.map(s=>`• ${s}`).join('\n') + '\n\n' +
        '🌍 تنبيهات الاقتصاد الكلي: مفعّلة\n' +
        '⏱️ يتم الفحص كل 5 دقائق تلقائياً'
      );
      return res.status(200).json({ok:true, watchlist:DEFAULT_WATCHLIST});
    } catch(e) {
      return res.status(500).json({ok:false, error:e.message});
    }
  }

  // Check symbols + macro
  const symbols = req.query.symbols ? 
    req.query.symbols.split(',').map(s=>s.trim().toUpperCase()) : 
    DEFAULT_WATCHLIST;

  const alerts=[], errors=[];

  // 1. فحص الإشارات الفنية
  await Promise.all(symbols.map(async(sym)=>{
    try {
      const data = await analyzeSymbol(sym);
      if(!data||!data.signal) return;
      alerts.push(data);
      const emoji  = data.signal==='CALL'?'🟢':'🔴';
      const action = data.signal==='CALL'?'📈 CALL — شراء':'📉 PUT — بيع';
      const rr = data.rr;
      const msg =
        `${emoji} <b>${action}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📌 <b>${data.symbol}</b> — ${data.fullName}\n` +
        `💰 السعر: <b>$${data.price}</b>\n` +
        `📊 التغير: ${parseFloat(data.changePct)>=0?'+':''}${data.changePct}%\n` +
        `📈 RSI: ${data.rsi}  |  🔥 الثقة: ${data.confidence}%\n` +
        `━━━━━━━━━━━━━━━\n` +
        (rr ? 
        `🎯 Entry: $${rr.entry}\n` +
        `🛡️ Stop Loss: $${rr.sl} (${rr.slPct}%)\n` +
        `🏆 Target: $${rr.t1} (${rr.t1Pct}%)\n` +
        `📐 R:R = 1:${rr.rr1}\n` +
        `━━━━━━━━━━━━━━━\n` : '') +
        `⚡ Pivot: $${data.pivot}  |  R1: $${data.res1}  |  S1: $${data.sup1}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🤖 <i>TIH Trading Hub</i>`;
      await sendTelegram(msg);
    } catch(e){ errors.push(sym+': '+e.message); }
  }));

  // 2. فحص البيانات الاقتصادية الصادرة
  const macroAlerts = await checkMacroEvents();

  return res.status(200).json({
    ok:true,
    checked:symbols.length,
    alerts:alerts.length,
    macroAlerts,
    signals:alerts.map(a=>({symbol:a.symbol,signal:a.signal,score:a.score,confidence:a.confidence})),
    errors
  });
};
