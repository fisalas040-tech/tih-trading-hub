export default function handler(req, res) {
  const { symbol = 'OANDA:SPX500USD', interval = 'D' } = req.query;
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>*{margin:0;padding:0;}body{background:#0F1424;overflow:hidden;}</style>
</head><body>
<div id="tv"></div>
<script src="https://s3.tradingview.com/tv.js"></script>
<script>
new TradingView.widget({
autosize:true,symbol:"${symbol}",interval:"${interval}",
timezone:"Asia/Riyadh",theme:"dark",style:"1",locale:"ar",
toolbar_bg:"#0F1424",enable_publishing:false,withdateranges:true,
allow_symbol_change:false,container_id:"tv",
studies:["MASimple@tv-basicstudies","RSI@tv-basicstudies"],
overrides:{"paneProperties.background":"#0F1424","paneProperties.backgroundType":"solid",
"paneProperties.vertGridProperties.color":"#1E2740","paneProperties.horzGridProperties.color":"#1E2740"}
});
</script></body></html>`);
}
