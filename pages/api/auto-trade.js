// pages/api/auto-trade.js — Vercel Cron auto-trader
// Entry: gap >= +10% only. RVOL fetched and logged but NOT used as filter.
// Exit: bracket order 2% take profit / 2% stop loss via Alpaca in real time.

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const ALPACA_ID = process.env.ALPACA_ID, ALPACA_SECRET = process.env.ALPACA_SECRET;
  if (!ALPACA_ID || !ALPACA_SECRET) return res.status(500).json({ error: 'Missing env vars: ALPACA_ID, ALPACA_SECRET' });
  const H = { 'APCA-API-KEY-ID': ALPACA_ID, 'APCA-API-SECRET-KEY': ALPACA_SECRET, 'Content-Type': 'application/json' };

  let config;
  try {
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!r.ok) throw new Error('Config not found');
    config = await r.json();
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const schedules = (config.schedules || []).filter(s => s.symbol && s.bet > 0);
  if (!schedules.length) return res.status(200).json({ message: 'No schedules', trades: [] });

  const symbols = [...new Set(schedules.map(s => s.symbol.toUpperCase()))];
  let snaps = {};
  try { const r = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=iex`, { headers: H }); if (r.ok) snaps = await r.json(); } catch (_) {}

  const results = [];
  for (const sched of schedules) {
    const sym = sched.symbol.toUpperCase(), bet = sched.bet, snap = snaps[sym];
    if (!snap) { results.push({ symbol: sym, status: 'skipped', reason: 'No snapshot data' }); continue; }
    const price = snap.latestTrade && snap.latestTrade.p, prevClose = snap.prevDailyBar && snap.prevDailyBar.c;
    if (!price || !prevClose || price <= 0 || prevClose <= 0) { results.push({ symbol: sym, status: 'skipped', reason: 'Missing price/prevClose' }); continue; }
    const gap = (price - prevClose) / prevClose * 100;

    // RVOL — logged only, not used as filter
    let rvol = null;
    try {
      const end = new Date().toISOString().split('T')[0];
      const start = new Date(Date.now() - 35*24*60*60*1000).toISOString().split('T')[0];
      const br = await fetch(`https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=25&feed=iex`, { headers: H });
      if (br.ok) { const bd = await br.json(); const bars = bd.bars||[]; if (bars.length) { const avg = bars.reduce((s,b)=>s+b.v,0)/bars.length; rvol = avg>0 ? +((((snap.dailyBar&&snap.dailyBar.v)||0)/avg)).toFixed(2) : 0; } }
    } catch (_) {}

    if (gap < 10) { results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% below +10%`, gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }
    const qty = Math.floor(bet / price);
    if (qty < 1) { results.push({ symbol: sym, status: 'skipped', reason: `Bet too small for $${price.toFixed(2)}`, gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }

    const tp = +(price*0.98).toFixed(2), sl = +(price*1.02).toFixed(2);
    try {
      const or = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method:'POST', headers: H,
        body: JSON.stringify({ symbol: sym, side:'sell', type:'market', time_in_force:'day', qty: String(qty), order_class:'bracket', take_profit:{ limit_price: String(tp) }, stop_loss:{ stop_price: String(sl) } })
      });
      const o = await or.json();
      if (!or.ok) { results.push({ symbol:sym, status:'error', reason: o.message||`Alpaca ${or.status}`, gap:+gap.toFixed(2), rvol_logged:rvol }); }
      else { results.push({ symbol:sym, status:'traded', scenario:'E', side:'sell', qty, entryPrice:+price.toFixed(2), takeProfitPrice:tp, stopLossPrice:sl, gap:+gap.toFixed(2), rvol_logged:rvol, orderId:o.id, orderStatus:o.status }); }
    } catch(e) { results.push({ symbol:sym, status:'error', reason:e.message }); }
  }

  return res.status(200).json({ timestamp: new Date().toISOString(), summary: { traded: results.filter(r=>r.status==='traded').length, skipped: results.filter(r=>r.status==='skipped').length, errors: results.filter(r=>r.status==='error').length }, trades: results });
}