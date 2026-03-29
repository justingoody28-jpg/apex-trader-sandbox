// pages/api/auto-trade.js — Variant B: Tradier data + Alpaca execution
// Cron: 9:30 AM EDT weekdays (cron-job.org "APEX Auto-Trade B")
// Data: Tradier consolidated feed — real pre-market quotes, FREE
// Execution: Alpaca bracket order (2% take profit / 2% stop loss)
// Strategy: Scenario E GAP FADE SHORT — gap >= +10%
// Required env vars: TRADIER_TOKEN, ALPACA_ID, ALPACA_SECRET

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const TRADIER_TOKEN = process.env.TRADIER_TOKEN, ALPACA_ID = process.env.ALPACA_ID, ALPACA_SECRET = process.env.ALPACA_SECRET;
  if (!TRADIER_TOKEN || !ALPACA_ID || !ALPACA_SECRET) return res.status(500).json({ error: 'Missing env vars: TRADIER_TOKEN, ALPACA_ID, ALPACA_SECRET' });
  const TH = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const AH = { 'APCA-API-KEY-ID': ALPACA_ID, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' };

  let config;
  try { const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json'); if (!r.ok) throw new Error('Config fetch failed'); config = await r.json(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  if (!config.scenarios || !config.scenarios.E) return res.status(200).json({ message: 'Scenario E disabled', trades: [] });
  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers configured', trades: [] });

  const gapThreshold = (config.thresholds && config.thresholds.eGap) || 10;
  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];

  let quoteMap = {};
  try {
    const r = await fetch(`https://sandbox.tradier.com/v1/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: TH });
    if (r.ok) { const data = await r.json(); const raw = data.quotes && data.quotes.quote; if (raw) { const arr = Array.isArray(raw) ? raw : [raw]; arr.forEach(q => { quoteMap[q.symbol] = q; }); } }
  } catch(_) {}

  const results = [];
  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase(), bet = ticker.bet, q = quoteMap[sym];
    if (!q) { results.push({ symbol: sym, status: 'skipped', reason: 'No quote from Tradier' }); continue; }
    const price = q.last, prevClose = q.prevclose;
    if (!price || !prevClose || price <= 0 || prevClose <= 0) { results.push({ symbol: sym, status: 'skipped', reason: 'Missing price/prevclose' }); continue; }
    const gap = (price - prevClose) / prevClose * 100;
    const rvol = q.average_volume > 0 ? +(q.volume / q.average_volume).toFixed(2) : null;
    if (gap < gapThreshold) { results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% below +${gapThreshold}%`, gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }
    const qty = Math.floor(bet / price);
    if (qty < 1) { results.push({ symbol: sym, status: 'skipped', reason: 'Bet too small', gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }
    const tp = +(price*0.98).toFixed(2), sl = +(price*1.02).toFixed(2);
    try {
      const or = await fetch('https://paper-api.alpaca.markets/v2/orders', { method:'POST', headers:AH, body:JSON.stringify({ symbol:sym, side:'sell', type:'market', time_in_force:'day', qty:String(qty), order_class:'bracket', take_profit:{ limit_price:String(tp) }, stop_loss:{ stop_price:String(sl) } }) });
      const o = await or.json();
      if (!or.ok) results.push({ symbol:sym, status:'error', reason:o.message||'Alpaca error', gap:+gap.toFixed(2), rvol_logged:rvol });
      else results.push({ symbol:sym, status:'traded', scenario:'E', variant:'B-Tradier-data-Alpaca-exec', side:'sell', qty, entryPrice:+price.toFixed(2), takeProfitPrice:tp, stopLossPrice:sl, gap:+gap.toFixed(2), rvol_logged:rvol, orderId:o.id, orderStatus:o.status });
    } catch(e) { results.push({ symbol:sym, status:'error', reason:e.message }); }
  }
  return res.status(200).json({ timestamp:new Date().toISOString(), variant:'B-Tradier-data-Alpaca-exec', summary:{ traded:results.filter(r=>r.status==='traded').length, skipped:results.filter(r=>r.status==='skipped').length, errors:results.filter(r=>r.status==='error').length }, trades:results });
}