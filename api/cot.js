// ════════════════════════════════════════════════════════
// TIH cot.js v1.0 — COT Report Analysis
// Commitment of Traders — CFTC Weekly Report
// يصدر كل جمعة 3:30 PM ET — يُحلل مراكز Leveraged Funds
// ════════════════════════════════════════════════════════

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8902487184:AAEI-5Qxi9vzUdUBEqAHqDZ3k3QWupv6T1I';
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || '8974941641';
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL   || 'https://desired-buffalo-141165.upstash.io';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'gQAAAAAAAidtAAIgcDIwMTY3NDg0YjFiOTc0M2U2YjkwMGE5MDhkYTg0MTc0ZQ';

// ═══════════════════════════════════════════
// الأسواق المراقبة — TFF Report (Financial Futures)
// CFTC Contract Codes
// ═══════════════════════════════════════════
const MARKETS = {
  'SP500': {
    name: 'S&P 500 (E-Mini)',
    code: '13874+',
    optionType: 'US500/SPX Options',
    emoji: '📊',
  },
  'NASDAQ': {
    name: 'Nasdaq 100 (E-Mini)',
    code: '20974+',
    optionType: 'NDX/QQQ Options',
    emoji: '💻',
  },
  'DOW': {
    name: 'Dow Jones (E-Mini)',
    code: '12460+',
    optionType: 'DJI Options',
    emoji: '🏭',
  },
  'GOLD': {
    name: 'Gold Futures',
    code: '088691',
    optionType: 'GLD Options',
    emoji: '🥇',
  },
  'DXY': {
    name: 'US Dollar Index',
    code: '098662',
    optionType: 'UUP Options',
    emoji: '💵',
  },
  'VIX': {
    name: 'VIX Futures',
    code: '1170E1',
    optionType: 'VIX Options',
    emoji: '⚡',
  },
};

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e){return null;}
}
async function kvSet(key,value,ex=604800) { // 7 أيام
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
  } catch(e){}
}

// ── الوقت بتوقيت السعودية ──
function nowKSA() {
  return new Date().toLocaleString('ar-SA',{
    timeZone:'Asia/Riyadh',
    weekday:'short',month:'short',day:'numeric',
    hour:'2-digit',minute:'2-digit'
  });
}

// ── Telegram ──
async function sendTelegram(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({chat_id:CHAT_ID,text:msg,parse_mode:'HTML'})
    });
  } catch(e){}
}

// ── جلب COT من CFTC API ──
async function fetchCOT(marketCode) {
  try {
    // CFTC Disaggregated + TFF Reports API
    const url = `https://publicreporting.cftc.gov/api/odata/v1/HistoricalViewOiit?%24filter=cftc_contract_market_code%20eq%20'${marketCode}'&%24orderby=report_date_as_yyyy_mm_dd%20desc&%24top=2&%24format=json`;
    
    const r = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TIH/1.0',
      }
    });
    if(!r.ok) throw new Error(`CFTC ${r.status}`);
    const data = await r.json();
    return data.value || [];
  } catch(e) {
    // جرب TFF endpoint
    try {
      const url2 = `https://publicreporting.cftc.gov/api/odata/v1/HistoricalViewTff?%24filter=cftc_contract_market_code%20eq%20'${marketCode}'&%24orderby=report_date_as_yyyy_mm_dd%20desc&%24top=2&%24format=json`;
      const r2 = await fetch(url2, {
        headers: {'Accept':'application/json','User-Agent':'TIH/1.0'}
      });
      if(!r2.ok) return [];
      const d2 = await r2.json();
      return d2.value || [];
    } catch(e2) { return []; }
  }
}

// ── تحليل بيانات COT ──
function analyzeCOT(current, previous, market) {
  if(!current) return null;

  // Leveraged Funds (صناديق التحوط) — أهم الفئات
  const lf_long_curr  = current.lev_money_positions_long_all  || current.lev_money_long  || 0;
  const lf_short_curr = current.lev_money_positions_short_all || current.lev_money_short || 0;
  const lf_long_prev  = previous ? (previous.lev_money_positions_long_all  || previous.lev_money_long  || 0) : lf_long_curr;
  const lf_short_prev = previous ? (previous.lev_money_positions_short_all || previous.lev_money_short || 0) : lf_short_curr;

  // Asset Managers
  const am_long_curr  = current.asset_mgr_positions_long_all  || current.asset_mgr_long  || 0;
  const am_short_curr = current.asset_mgr_positions_short_all || current.asset_mgr_short || 0;

  // حساب Net Position
  const lf_net_curr = lf_long_curr - lf_short_curr;
  const lf_net_prev = lf_long_prev - lf_short_prev;
  const lf_change   = lf_net_curr - lf_net_prev;

  const am_net_curr = am_long_curr - am_short_curr;

  // Open Interest
  const oi_curr = current.open_interest_all || current.oi_all || 0;
  const oi_prev = previous ? (previous.open_interest_all || previous.oi_all || 0) : oi_curr;
  const oi_change = oi_curr - oi_prev;

  // تحديد الاتجاه
  let signal, signalAr, confidence;

  if(lf_net_curr > 0 && lf_change > 0) {
    signal = 'CALL'; signalAr = '🟢 صعودي قوي'; confidence = 'عالية';
  } else if(lf_net_curr > 0 && lf_change < 0) {
    signal = 'CALL'; signalAr = '🟡 صعودي يضعف'; confidence = 'متوسطة';
  } else if(lf_net_curr < 0 && lf_change < 0) {
    signal = 'PUT'; signalAr = '🔴 هبوطي قوي'; confidence = 'عالية';
  } else if(lf_net_curr < 0 && lf_change > 0) {
    signal = 'PUT'; signalAr = '🟡 هبوطي يضعف'; confidence = 'متوسطة';
  } else {
    signal = 'NEUTRAL'; signalAr = '⚪ محايد'; confidence = 'منخفضة';
  }

  // مدة الأوبشن المقترحة بناءً على COT
  // COT أسبوعي = مدة أسبوع إلى 3 أسابيع مناسبة
  let duration, durationAr;
  if(confidence === 'عالية') {
    duration = '2-3 weeks';
    durationAr = 'أسبوعان إلى ثلاثة أسابيع';
  } else if(confidence === 'متوسطة') {
    duration = '1-2 weeks';
    durationAr = 'أسبوع إلى أسبوعين';
  } else {
    duration = 'avoid';
    durationAr = 'تجنب الدخول — إشارة ضعيفة';
  }

  return {
    market,
    reportDate: current.report_date_as_yyyy_mm_dd || '—',
    signal, signalAr, confidence,
    duration, durationAr,
    lf: {
      long: lf_long_curr,
      short: lf_short_curr,
      net: lf_net_curr,
      change: lf_change,
    },
    am: {
      long: am_long_curr,
      short: am_short_curr,
      net: am_net_curr,
    },
    oi: { current: oi_curr, change: oi_change },
  };
}

// ── بناء رسالة Telegram ──
function buildTelegramMsg(analyses) {
  let msg = `📋 <b>تقرير COT الأسبوعي — CFTC</b>\n`;
  msg += `⏰ <b>${nowKSA()}</b>\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  for(const a of analyses) {
    if(!a) continue;
    const m = MARKETS[a.market];
    const lfChange = a.lf.change >= 0 ? `+${a.lf.change.toLocaleString()}` : a.lf.change.toLocaleString();
    const oiChange = a.oi.change >= 0 ? `+${a.oi.change.toLocaleString()}` : a.oi.change.toLocaleString();

    msg += `${m.emoji} <b>${m.name}</b>\n`;
    msg += `${a.signalAr} — ثقة: <b>${a.confidence}</b>\n`;
    msg += `━━━━━━━━━━━━\n`;
    msg += `🐋 Leveraged Funds:\n`;
    msg += `  📈 Long: <b>${a.lf.long.toLocaleString()}</b>\n`;
    msg += `  📉 Short: <b>${a.lf.short.toLocaleString()}</b>\n`;
    msg += `  📊 Net: <b>${a.lf.net.toLocaleString()}</b> (${lfChange} هذا الأسبوع)\n`;
    msg += `📈 OI: ${a.oi.current.toLocaleString()} (${oiChange})\n`;
    msg += `━━━━━━━━━━━━\n`;

    if(a.signal !== 'NEUTRAL') {
      msg += `🎯 <b>التوصية:</b>\n`;
      msg += `  • النوع: <b>${a.signal} — ${m.optionType}</b>\n`;
      msg += `  • المدة: <b>${a.durationAr}</b>\n`;
    } else {
      msg += `⚠️ <b>${a.durationAr}</b>\n`;
    }
    msg += `\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━\n`;
  msg += `💡 <i>COT أسبوعي — للاتجاه العام فقط، دمجه مع التحليل الفني</i>\n`;
  msg += `📅 تاريخ التقرير: ${analyses[0]?.reportDate || '—'}\n`;
  msg += `🤖 <i>TIH COT Analyzer v1.0</i>`;

  return msg;
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'analyze';
  const force  = req.query.force === '1';

  try {

    // ── جلب وتحليل COT ──
    if(action === 'analyze' || action === 'report') {

      // Cache أسبوعي
      const cacheKey = 'cot_weekly_analysis';
      if(!force) {
        const cached = await kvGet(cacheKey);
        if(cached && (Date.now()-cached.ts) < 6*3600*1000) // cache 6 ساعات
          return res.status(200).json({ok:true,cached:true,data:cached.data});
      }

      const analyses = [];
      const targetMarkets = ['SP500','NASDAQ','DOW','GOLD','DXY'];

      for(const mKey of targetMarkets) {
        const m = MARKETS[mKey];
        try {
          const records = await fetchCOT(m.code);
          if(records.length >= 1) {
            const analysis = analyzeCOT(records[0], records[1] || null, mKey);
            if(analysis) analyses.push(analysis);
          }
        } catch(e) {
          console.error(`COT error ${mKey}:`, e.message);
        }
      }

      if(!analyses.length)
        return res.status(200).json({ok:false,message:'لا توجد بيانات COT — تحقق لاحقاً'});

      // حفظ في Cache
      await kvSet(cacheKey, {data:analyses, ts:Date.now()}, 21600);

      // إرسال Telegram إذا طُلب
      if(action === 'report') {
        const msg = buildTelegramMsg(analyses);
        await sendTelegram(msg);
      }

      return res.status(200).json({ok:true,cached:false,data:analyses});
    }

    // ── إرسال تقرير Telegram يدوياً ──
    if(action === 'send') {
      const cached = await kvGet('cot_weekly_analysis');
      if(!cached)
        return res.status(200).json({ok:false,message:'لا توجد بيانات — شغّل action=report أولاً'});
      const msg = buildTelegramMsg(cached.data);
      await sendTelegram(msg);
      return res.status(200).json({ok:true,message:'تم إرسال تقرير COT'});
    }

    return res.status(200).json({ok:false,message:'action غير معروف — استخدم: analyze|report|send'});

  } catch(e) {
    return res.status(500).json({ok:false,error:e.message});
  }
};
