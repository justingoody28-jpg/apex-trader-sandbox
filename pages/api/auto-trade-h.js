// pages/api/auto-trade-h.js — Scenario H: PANIC REVERSAL
// Cron: 9:31 AM EDT weekdays (needs open candles)
// Conditions: gap <= -10%, RVOL >= 4x, first green 1-min candle by 9:42 AM
// Exit: TP +1.5% / SL -2.5% | Breakeven: 62.5%
// Required env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const TRADIER_TOKEN = process.env.TRADIER_TOKEN, TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });
  const H = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://sandbox.tradier.com/v1';

  let config;
  try { const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json'); if (!r.ok) throw new Error('Config fetch failed'); config = await r.json(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  if (!config.scenarios || !config.scenarios.H) return res.status(200).json({ message: 'Scenario H disabled', trades: [] });
  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers', trades: [] });

  const gapThreshold = (config.thresholds && config.thresholds.hGap)  || 10;
  const rvolMin      = (config.thresholds && config.thresholds.hRvol) || 4;
  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];

  let quoteMap = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    if (r.ok) { const data = await r.json(); const raw = data.quotes && data.quotes.quote; if (raw) { const arr = Array.isArray(raw) ? raw : [raw]; arr.forEach(q => { quoteMap[q.symbol] = q; }); } }
  } catch(_) {}

  const today = new Date().toISOString().split('T')[0];
  const startET = `${today} 09:30:00`, endET = `${today} 09:42:00`;
  const results = [];

  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase(), bet = ticker.bet, q = quoteMap[sym];
    if (!q) { results.push({ symbol: sym, status: 'skipped', reason: 'No quote' }); continue; }
    const price = q.last, prevClose = q.prevclose;
    if (!price || !prevClose || price <= 0 || prevClose <= 0) { results.push({ symbol: sym, status: 'skipped', reason: 'Missing price/prevclose' }); continue; }
    const gap = (price - prevClose) / prevClose * 100;
    const rvol = q.average_volume > 0 ? +(q.volume / q.average_volume).toFixed(2) : null;
    if (gap > -gapThreshold) { results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% not <= -${gapThreshold}%`, gap: +gap.toFixed(2), rvol }); continue; }
    if (!rvol || rvol < rvolMin) { results.push({ symbol: sym, status: 'skipped', reason: `RVOL ${rvol} below ${rvolMin}x`, gap: +gap.toFixed(2), rvol }); continue; }

    let entryPrice = null;
    try {
      const ts = await fetch(`${BASE}/markets/timesales?symbol=${sym}&interval=1min&start=${encodeURIComponent(startET)}&end=${encodeURIComponent(endET)}&session_filter=all`, { headers: H });
      if (ts.ok) { const d = await ts.json(); const series = d.series && d.series.data; if (series) { const candles = Array.isArray(series) ? series : [series]; const fg = candles.find(c => parseFloat(c.close) > parseFloat(c.open)); if (fg) entryPrice = +parseFloat(fg.close).toFixed(2); } }
    } catch(_) {}

    if (!entryPrice) { results.push({ symbol: sym, status: 'skipped', reason: 'No green candle by 9:42 AM', gap: +gap.toFixed(2), rvol }); continue; }
    const qty = Math.floor(bet / entryPrice);
    if (qty < 1) { results.push({ symbol: sym, status: 'skipped', reason: 'Bet too small', gap: +gap.toFixed(2), rvol }); continue; }
    const tp = +(entryPrice * 1.015).toFixed(2), sl = +(entryPrice * 0.975).toFixed(2);
    try {
      const params = new URLSearchParams({ 'class':'otoco','duration':'day','symbol[0]':sym,'side[0]':'buy','quantity[0]':String(qty),'type[0]':'market','symbol[1]':sym,'side[1]':'sell','quantity[1]':String(qty),'type[1]':'limit','price[1]':String(tp),'symbol[2]':sym,'side[2]':'sell','quantity[2]':String(qty),'type[2]':'stop','stop[2]':String(sl) });
      const or = await fetch(`${BASE}/accounts/${TRADIER_ACCOUNT_ID}/orders`, { method:'POST', headers:{...H,'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
      const od = await or.json();
      if (!or.ok || (od.order && od.order.status === 'error')) results.push({ symbol:sym, status:'error', reason:od.order?.partner_error_description||od.fault?.faultstring||`Tradier ${or.status}`, gap:+gap.toFixed(2), rvol });
      else results.push({ symbol:sym, status:'traded', scenario:'H', side:'buy', qty, entryPrice, takeProfitPrice:tp, stopLossPrice:sl, gap:+gap.toFixed(2), rvol, orderId:od.order?.id, orderStatus:od.order?.status });
    } catch(e) { results.push({ symbol:sym, status:'error', reason:e.message }); }
  }
  return res.status(200).json({ timestamp:new Date().toISOString(), variant:'H-Tradier-9:31', summary:{traded:results.filter(r=>r.status==='traded').length,skipped:results.filter(r=>r.status==='skipped').length,errors:results.filter(r=>r.status==='error').length}, trades:results });
}