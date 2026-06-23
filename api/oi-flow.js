// ════════════════════════════════════════════════════════
// TIH oi-flow.js v1.0
// OI Flow — تتبع تغييرات Open Interest لكل Strike
// تنبيه عند دخول كميات كبيرة مفاجئة
// ════════════════════════════════════════════════════════

const MASSIVE_KEY  = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE = 'api.polygon.io';
const BOT_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID      = process.env.TELEGRAM_CHAT_ID;
const UPSTASH_URL  = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN= process.env.UPSTASH_REDIS_REST_TOKEN;

// الرموز المراقبة
const WATCH_SYMBOLS = ['SPY','QQQ','SPX','NVDA','AAPL','TSLA','AMD'];

// حد التنبيه — نسبة زيادة OI
const OI_SURGE_PCT   = 25;   // 25% زيادة مفاجئة
const OI_SURGE_MIN   = 3000; // minimum OI للتنبيه (تجاهل العقود الصغيرة)

// ── Upstash ──
async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e){return null;}
}
async function kvSet(key,value,ex=7200) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}?ex=${ex}`,
      {headers:{Authorization:`Bearer ${UPSTASH_TOKEN}`}});
  } catch(e){}
}

// ── Massive API ──
async function fetchMassive(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `https://${MASSIVE_BASE}${path}${sep}apiKey=${MASSIVE_KEY}`;
  const r = await fetch(url,{headers:{'User-Agent':'TIH/2.0'}});
  if(!r.ok) throw new Error(`Massive ${r.status}`);
  return r.json();
}

// ── سعر الأصل (بديل عند غياب underlying price في snapshot) ──
async function fetchUnderlyingSpot(symbol) {
  const ckey = `oi_spot_${symbol}`;
  const cached = await kvGet(ckey);
  if(cached) return cached;
  try {
    const d = await fetchMassive(`/v2/aggs/ticker/${symbol}/prev?adjusted=true`);
    const px = (d.results && d.results[0] && d.results[0].c) || 0;
    if(px) await kvSet(ckey, px, 900);
    return px;
  } catch(e){ return 0; }
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

// ── الوقت بتوقيت السعودية ──
function nowKSA() {
  return new Date().toLocaleString('ar-SA',{
    timeZone:'Asia/Riyadh',
    weekday:'short', month:'short', day:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
}

// ── جلب OI لكل Strike ──
async function fetchOISnapshot(symbol) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const in30d = new Date(Date.now()+30*86400000).toISOString().split('T')[0];

    const data = await fetchMassive(
      `/v3/snapshot/options/${symbol}?expiration_date.gte=${today}&expiration_date.lte=${in30d}&limit=250`
    );

    const results = data.results || [];
    if(!results.length) return null;

    let spot = results[0]?.underlying_asset?.price || 0;
    const strikeMap = {};

    for(const c of results) {
      const strike = c.details?.strike_price;
      const type   = c.details?.contract_type;
      const oi     = c.open_interest || 0;
      const exp    = c.details?.expiration_date || '';
      const iv     = c.implied_volatility ? (c.implied_volatility*100).toFixed(1) : null;

      if(!strike) continue;

      const key = `${strike}_${type}`;
      if(!strikeMap[key]) {
        strikeMap[key] = {strike, type, oi:0, exp, iv};
      }
      strikeMap[key].oi += oi;
    }

    // أعلى 20 Strike بـ OI
    const sorted = Object.values(strikeMap)
      .sort((a,b) => b.oi - a.oi)
      .slice(0,20);

    // بديل السعر إذا لم يُرجعه snapshot (خطة Polygon لا تتضمن underlying price)
    if(!spot) spot = await fetchUnderlyingSpot(symbol);

    return {symbol, spot, strikes:sorted, ts:Date.now()};
  } catch(e) {
    console.error(`OI fetch error ${symbol}:`, e.message);
    return null;
  }
}

// ── مقارنة OI وإصدار تنبيهات ──
async function checkOISurges(symbol, current, previous) {
  if(!current || !previous) return 0;
  let alerts = 0;
  const today = new Date().toISOString().split('T')[0];

  for(const curr of current.strikes) {
    if(curr.oi < OI_SURGE_MIN) continue;

    const prev = previous.strikes.find(
      p => p.strike === curr.strike && p.type === curr.type
    );

    if(!prev || prev.oi === 0) continue;

    const changePct = ((curr.oi - prev.oi) / prev.oi) * 100;
    if(changePct < OI_SURGE_PCT) continue;

    // تحقق من عدم إرسال تنبيه مسبق
    const alertKey = `oi_alert_${symbol}_${curr.strike}_${curr.type}_${today}`;
    const sent = await kvGet(alertKey);
    if(sent) continue;
    await kvSet(alertKey, 1, 12*3600);

    const isCall = curr.type === 'call';
    const emoji  = isCall ? '🟢' : '🔴';
    const dir    = isCall ? 'CALL — صعودي' : 'PUT — هبوطي';
    const spot   = current.spot ? `$${current.spot.toFixed(2)}` : '—';
    const aboveBelow = curr.strike > (current.spot||0) ? 'فوق السعر ⬆' : 'تحت السعر ⬇';

    const msg =
      `${emoji} <b>⚡ تدفق OI كبير!</b>\n` +
      `⏰ <b>${nowKSA()}</b>\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📌 <b>${symbol}</b> — Strike <b>$${curr.strike}</b>\n` +
      `${emoji} <b>${dir}</b>\n` +
      `📊 OI الحالي: <b>${curr.oi.toLocaleString()}</b> عقد\n` +
      `📈 التغيير: <b>+${changePct.toFixed(0)}%</b> (من ${prev.oi.toLocaleString()})\n` +
      `💰 السعر الحالي: ${spot} — ${aboveBelow}\n` +
      (curr.iv ? `📐 IV: ${curr.iv}%\n` : '') +
      `📅 انتهاء: ${curr.exp}\n` +
      `━━━━━━━━━━━━━━━\n` +
      `💡 <i>كمية كبيرة دخلت هذا الـ Strike — راقب السعر</i>\n` +
      `🤖 <i>TIH OI Flow v1.0</i>`;

    await sendTelegram(msg);
    alerts++;
    console.log(`OI Alert: ${symbol} ${curr.type} $${curr.strike} +${changePct.toFixed(0)}%`);
  }
  return alerts;
}

// ── Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS') return res.status(200).end();

  const action = req.query.action || 'snapshot';
  const sym    = (req.query.symbol || '').toUpperCase();
  const force  = req.query.force === '1';

  try {

    // ── جلب Snapshot لرمز محدد ──
    if(action === 'snapshot' && sym) {
      const cacheKey = `oi_snap_${sym}`;
      if(!force) {
        const cached = await kvGet(cacheKey);
        if(cached && (Date.now()-cached.ts) < 10*60*1000)
          return res.status(200).json({ok:true,cached:true,data:cached});
      }
      const data = await fetchOISnapshot(sym);
      if(!data) return res.status(200).json({ok:false,message:`لا بيانات لـ ${sym}`});
      await kvSet(cacheKey, data, 600);
      return res.status(200).json({ok:true,cached:false,data});
    }

    // ── فحص التغييرات وإرسال تنبيهات ──
    if(action === 'check') {
      let totalAlerts = 0;
      const symbols = sym ? [sym] : WATCH_SYMBOLS;

      for(const s of symbols) {
        const prevKey = `oi_prev_${s}`;
        const currKey = `oi_snap_${s}`;

        // جلب الـ snapshot الحالي
        const current = await fetchOISnapshot(s);
        if(!current) continue;

        // جلب الـ snapshot السابق للمقارنة
        const previous = await kvGet(prevKey);

        // فحص التغييرات
        if(previous) {
          const a = await checkOISurges(s, current, previous);
          totalAlerts += a;
        }

        // حفظ الحالي كـ "سابق" للمرة القادمة
        await kvSet(prevKey, current, 7200);
        await kvSet(currKey, current, 600);
      }

      return res.status(200).json({ok:true, totalAlerts, symbols:symbols.length, time:nowKSA()});
    }

    // ── جلب كل الرموز للعرض في المنصة ──
    if(action === 'all') {
      const results = [];
      for(const s of WATCH_SYMBOLS) {
        const cacheKey = `oi_snap_${s}`;
        let data = await kvGet(cacheKey);
        if(!data || (Date.now()-data.ts) > 15*60*1000) {
          data = await fetchOISnapshot(s);
          if(data) await kvSet(cacheKey, data, 600);
        }
        if(data) results.push(data);
      }
      return res.status(200).json({ok:true, data:results, time:nowKSA()});
    }

    return res.status(200).json({ok:false, message:'action غير معروف — استخدم: snapshot|check|all'});

  } catch(e) {
    return res.status(500).json({ok:false, error:e.message});
  }
};
