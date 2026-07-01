// ════════════════════════════════════════════════════════
// TIH cot.js v2.0 — COT Report من CFTC CSV
// ════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ═══════════════════════════════════════════
// الأسواق — اسم السوق كما في CFTC
// ═══════════════════════════════════════════
const MARKET_NAMES = {
  'SP500':  { search: 'S&P 500', emoji: '📊', option: 'SPX/US500 Options' },
  'NASDAQ': { search: 'NASDAQ',  emoji: '💻', option: 'NDX/QQQ Options'   },
  'GOLD':   { search: 'GOLD',    emoji: '🥇', option: 'GLD Options'       },
  'DXY':    { search: 'U.S. DOLLAR INDEX', emoji: '💵', option: 'UUP Options' },
};

async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e){return null;}
}
async function kvSet(key,value,ex=21600) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
  } catch(e){}
}

function nowKSA() {
  return new Date().toLocaleString('ar-SA',{
    timeZone:'Asia/Riyadh',
    weekday:'short',month:'short',day:'numeric',
    hour:'2-digit',minute:'2-digit'
  });
}

async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:CHAT_ID,text:msg,parse_mode:'HTML'})
    });
  } catch(e){}
}

// ── جلب COT من CFTC TFF Report ──
async function fetchCOTData() {
  const year = new Date().getFullYear();
  
  // روابط CFTC الرسمية
  const urls = [
    `https://www.cftc.gov/files/dea/history/fut_fin_txt_${year}.zip`,
    `https://www.cftc.gov/files/dea/history/fut_fin_txt_${year-1}.zip`,
  ];

  for(const zipUrl of urls) {
    try {
      const r = await fetch(zipUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': '*/*',
          'Referer': 'https://www.cftc.gov/',
        }
      });
      if(!r.ok) continue;

      // قراءة ZIP
      const buffer = await r.arrayBuffer();
      const bytes  = new Uint8Array(buffer);
      
      // استخراج CSV من ZIP (بسيط)
      const text = new TextDecoder('utf-8', {fatal:false}).decode(bytes);
      
      // ابحث عن بداية CSV
      const csvStart = text.indexOf('Market and Exchange Names');
      if(csvStart < 0) continue;
      
      return text.slice(csvStart);
    } catch(e) {
      continue;
    }
  }
  
  // بديل: API JSON
  try {
    const apiUrl = 'https://publicreporting.cftc.gov/api/odata/v1/HistoricalViewTff?%24top=20&%24orderby=report_date_as_yyyy_mm_dd%20desc&%24format=json';
    const r = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
        'Accept': 'application/json',
        'Origin': 'https://publicreporting.cftc.gov',
      }
    });
    if(r.ok) {
      const data = await r.json();
      if(data.value && data.value.length) return {type:'json', records:data.value};
    }
  } catch(e) {}
  
  return null;
}

// ── Parse CSV وجلب بيانات السوق ──
function parseCSVForMarket(csvText, marketName) {
  const lines = csvText.split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
  
  // ابحث عن السطور التي تحتوي اسم السوق
  const marketLines = lines.filter(l => l.toLowerCase().includes(marketName.toLowerCase()));
  
  if(!marketLines.length) return null;
  
  const parseRow = (line) => {
    const cols = line.split(',').map(c => c.trim().replace(/"/g,''));
    const obj = {};
    headers.forEach((h,i) => { obj[h] = cols[i] || ''; });
    return obj;
  };

  const current  = parseRow(marketLines[0]);
  const previous = marketLines[1] ? parseRow(marketLines[1]) : null;
  
  return {current, previous};
}

// ── تحليل بيانات COT ──
function analyzeRecord(current, previous, marketKey) {
  if(!current) return null;
  
  // Leveraged Funds (TFF Report)
  const lf_long  = parseInt(current['Lev Money Positions Long All'] || current['lev_money_positions_long_all'] || 0);
  const lf_short = parseInt(current['Lev Money Positions Short All'] || current['lev_money_positions_short_all'] || 0);
  const lf_long_prev  = previous ? parseInt(previous['Lev Money Positions Long All'] || 0) : lf_long;
  const lf_short_prev = previous ? parseInt(previous['Lev Money Positions Short All'] || 0) : lf_short;
  
  const lf_net      = lf_long - lf_short;
  const lf_net_prev = lf_long_prev - lf_short_prev;
  const lf_change   = lf_net - lf_net_prev;
  
  // Asset Managers
  const am_long  = parseInt(current['Asset Mgr Positions Long All'] || current['asset_mgr_positions_long_all'] || 0);
  const am_short = parseInt(current['Asset Mgr Positions Short All'] || current['asset_mgr_positions_short_all'] || 0);
  
  // OI
  const oi      = parseInt(current['Open Interest (All)'] || current['open_interest_all'] || 0);
  const oi_prev = previous ? parseInt(previous['Open Interest (All)'] || 0) : oi;
  
  // تحديد الإشارة
  let signal, signalAr, confidence;
  if(lf_net > 0 && lf_change > 0)      { signal='CALL'; signalAr='🟢 صعودي قوي';    confidence='عالية'; }
  else if(lf_net > 0 && lf_change <= 0){ signal='CALL'; signalAr='🟡 صعودي يضعف';  confidence='متوسطة'; }
  else if(lf_net < 0 && lf_change < 0) { signal='PUT';  signalAr='🔴 هبوطي قوي';   confidence='عالية'; }
  else if(lf_net < 0 && lf_change >= 0){ signal='PUT';  signalAr='🟡 هبوطي يضعف'; confidence='متوسطة'; }
  else                                  { signal='NEUTRAL'; signalAr='⚪ محايد';     confidence='منخفضة'; }
  
  const durationAr = confidence==='عالية' ? 'أسبوعان إلى ثلاثة أسابيع'
                   : confidence==='متوسطة' ? 'أسبوع إلى أسبوعين'
                   : 'تجنب الدخول — إشارة ضعيفة';

  const reportDate = current['As of Date in Form YYYY-MM-DD'] || current['report_date_as_yyyy_mm_dd'] || '—';

  return {
    market: marketKey, reportDate,
    signal, signalAr, confidence, durationAr,
    lf: { long:lf_long, short:lf_short, net:lf_net, change:lf_change },
    am: { long:am_long, short:am_short, net:am_long-am_short },
    oi: { current:oi, change:oi-oi_prev },
  };
}

// ── بناء رسالة Telegram ──
function buildMsg(analyses) {
  let msg = `📋 <b>تقرير COT الأسبوعي — CFTC</b>\n`;
  msg += `⏰ <b>${nowKSA()}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  for(const a of analyses) {
    const m = MARKET_NAMES[a.market];
    if(!m) continue;
    const ch = a.lf.change>=0?'+'+a.lf.change.toLocaleString():a.lf.change.toLocaleString();
    
    msg += `${m.emoji} <b>${a.market==='SP500'?'S&P 500':a.market}</b>\n`;
    msg += `${a.signalAr} — ثقة: <b>${a.confidence}</b>\n`;
    msg += `🐋 LF Net: <b>${a.lf.net.toLocaleString()}</b> (${ch})\n`;
    if(a.signal!=='NEUTRAL') {
      msg += `🎯 <b>${a.signal}</b> — ${m.option}\n`;
      msg += `⏱️ المدة: <b>${a.durationAr}</b>\n`;
    } else {
      msg += `⚠️ ${a.durationAr}\n`;
    }
    msg += `\n`;
  }
  
  msg += `💡 <i>COT أسبوعي — للاتجاه العام مع التحليل الفني</i>\n`;
  msg += `🤖 <i>TIH COT v2.0</i>`;
  return msg;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'analyze';
  const force  = req.query.force === '1';

  try {
    const cacheKey = 'cot_v2_analysis';

    if(action === 'analyze' || action === 'report') {
      if(!force) {
        const cached = await kvGet(cacheKey);
        if(cached && (Date.now()-cached.ts) < 6*3600*1000)
          return res.status(200).json({ok:true,cached:true,data:cached.data});
      }

      const cotRaw = await fetchCOTData();
      if(!cotRaw) return res.status(200).json({ok:false,message:'لا توجد بيانات COT — تحقق لاحقاً'});

      const analyses = [];
      
      if(cotRaw.type === 'json') {
        // JSON format من API
        for(const [mKey, mInfo] of Object.entries(MARKET_NAMES)) {
          const records = cotRaw.records.filter(r => 
            (r.market_and_exchange_names||'').toLowerCase().includes(mInfo.search.toLowerCase())
          ).slice(0,2);
          
          if(records.length) {
            const a = analyzeRecord(records[0], records[1]||null, mKey);
            if(a && (a.lf.long>0||a.lf.short>0)) analyses.push(a);
          }
        }
      } else {
        // CSV format
        for(const [mKey, mInfo] of Object.entries(MARKET_NAMES)) {
          const parsed = parseCSVForMarket(cotRaw, mInfo.search);
          if(parsed) {
            const a = analyzeRecord(parsed.current, parsed.previous, mKey);
            if(a && (a.lf.long>0||a.lf.short>0)) analyses.push(a);
          }
        }
      }

      if(!analyses.length)
        return res.status(200).json({ok:false,message:'لا توجد بيانات — يُحدَّث كل جمعة 3:30 PM ET'});

      await kvSet(cacheKey, {data:analyses, ts:Date.now()}, 21600);

      if(action === 'report') await sendTelegram(buildMsg(analyses));

      return res.status(200).json({ok:true,cached:false,data:analyses});
    }

    if(action === 'send') {
      const cached = await kvGet(cacheKey);
      if(!cached) return res.status(200).json({ok:false,message:'شغّل action=report أولاً'});
      await sendTelegram(buildMsg(cached.data));
      return res.status(200).json({ok:true,message:'تم إرسال تقرير COT'});
    }

    return res.status(200).json({ok:false,message:'استخدم: analyze|report|send'});

  } catch(e) {
    return res.status(500).json({ok:false,error:e.message});
  }
};
