// ════════════════════════════════════════════════════════
// TIH news.js v1.0 — تحليل أخبار Finviz + Financial News
// ════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch(e) { return null; }
}

async function kvSet(key, val, ex = 1800) {
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(val))}?ex=${ex}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  } catch(e) {}
}

// ════════ تحليل المشاعر من العنوان ════════
function analyzeSentiment(title) {
  const bullWords = [
    'surge','surges','jump','jumps','rise','rises','gain','gains','beat','beats',
    'strong','bullish','rally','rallies','high','growth','profit','profits',
    'positive','up','upgrade','upgraded','buy','outperform','record','boost',
    'soar','soars','climb','climbs','breakout','opportunity','recover','recovery',
    'ارتفع','صعد','ارتفاع','صعود','نمو','ربح','أرباح','قوي','إيجابي'
  ];
  const bearWords = [
    'drop','drops','fall','falls','crash','crashes','lose','loss','losses','miss',
    'weak','bearish','decline','declines','low','negative','down','downgrade',
    'downgraded','sell','underperform','warning','cut','cuts','fear','fears',
    'concern','concerns','risk','risks','plunge','plunges','slide','slides',
    'انخفض','هبط','انخفاض','هبوط','خسارة','ضعيف','سلبي','تراجع'
  ];
  const t = title.toLowerCase();
  let score = 0;
  bullWords.forEach(w => { if(t.includes(w)) score++; });
  bearWords.forEach(w => { if(t.includes(w)) score--; });
  return { sentiment: score > 0 ? 'bull' : score < 0 ? 'bear' : 'neutral', score };
}

// ════════ جلب أخبار Finviz ════════
async function fetchFinvizNews(symbol) {
  try {
    const url = `https://finviz.com/quote.ashx?t=${encodeURIComponent(symbol)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finviz.com/',
      },
      timeout: 8000,
    });
    if (!r.ok) return [];
    const html = await r.text();

    const items = [];
    // استخراج جدول الأخبار من Finviz
    const tableMatch = html.match(/id="news-table"[\s\S]*?<\/table>/);
    if (!tableMatch) return [];

    const rowRegex = /<tr[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*class="news-link-left"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/tr>/g;
    const timeRegex = /<td[^>]*align="right"[^>]*>([\s\S]*?)<\/td>/;
    let match;

    while ((match = rowRegex.exec(tableMatch[0])) !== null && items.length < 10) {
      const url   = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (!title || title.length < 5) continue;
      const { sentiment, score } = analyzeSentiment(title);
      items.push({ title, url, sentiment, score });
    }

    // fallback: regex بسيط
    if (items.length === 0) {
      const simpleRegex = /href="(https?:\/\/[^"]+)"[^>]*class="[^"]*news-link[^"]*"[^>]*>(.*?)<\/a>/g;
      while ((match = simpleRegex.exec(html)) !== null && items.length < 10) {
        const title = match[2].replace(/<[^>]+>/g, '').trim();
        if (!title || title.length < 5) continue;
        const { sentiment, score } = analyzeSentiment(title);
        items.push({ title, url: match[1], sentiment, score });
      }
    }

    return items;
  } catch(e) {
    console.error('Finviz fetch error:', e.message);
    return [];
  }
}

// ════════ جلب أخبار Google News (احتياطي) ════════
async function fetchGoogleNews(symbol) {
  try {
    const query = encodeURIComponent(`${symbol} stock`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml' },
      timeout: 8000,
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
      const titleMatch = match[1].match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch  = match[1].match(/<link>([\s\S]*?)<\/link>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const url   = linkMatch ? linkMatch[1].trim() : '#';
      const { sentiment, score } = analyzeSentiment(title);
      items.push({ title, url, sentiment, score });
    }
    return items;
  } catch(e) {
    console.error('Google News fetch error:', e.message);
    return [];
  }
}

// ════════ Handler الرئيسي ════════
module.exports = async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase().trim();
  if (!symbol) {
    return res.json({ news: [], sentiment: 'neutral', score: 0, ar: '—' });
  }

  // Cache 30 دقيقة
  const ckey = `news_v2_${symbol}`;
  const cached = await kvGet(ckey);
  if (cached) return res.json(cached);

  // جلب الأخبار — Finviz أولاً ثم Google News
  let newsItems = await fetchFinvizNews(symbol);
  let source = 'finviz';

  if (newsItems.length < 3) {
    newsItems = await fetchGoogleNews(symbol);
    source = 'google';
  }

  // حساب المشاعر الكلية
  const bullItems = newsItems.filter(n => n.sentiment === 'bull');
  const bearItems = newsItems.filter(n => n.sentiment === 'bear');
  const bullCount = bullItems.length;
  const bearCount = bearItems.length;
  const totalScore = newsItems.reduce((s, n) => s + n.score, 0);
  const netScore   = bullCount - bearCount;

  let sentiment, ar;
  if (netScore >= 3)       { sentiment = 'bull'; ar = `📰 الأخبار إيجابية بقوة (${bullCount} صاعد / ${bearCount} هابط)`; }
  else if (netScore >= 1)  { sentiment = 'bull'; ar = `📰 الأخبار إيجابية (${bullCount} صاعد / ${bearCount} هابط)`; }
  else if (netScore <= -3) { sentiment = 'bear'; ar = `📰 الأخبار سلبية بقوة (${bearCount} هابط / ${bullCount} صاعد)`; }
  else if (netScore <= -1) { sentiment = 'bear'; ar = `📰 الأخبار سلبية (${bearCount} هابط / ${bullCount} صاعد)`; }
  else                     { sentiment = 'neutral'; ar = `📰 الأخبار محايدة (${bullCount} صاعد / ${bearCount} هابط)`; }

  const result = {
    symbol,
    news: newsItems.slice(0, 8),
    sentiment,
    score: netScore,
    totalScore,
    bullCount,
    bearCount,
    source,
    ar,
    topBull: bullItems[0]?.title || null,
    topBear: bearItems[0]?.title || null,
    timestamp: new Date().toISOString(),
  };

  await kvSet(ckey, result, 1800);
  return res.json(result);
};
