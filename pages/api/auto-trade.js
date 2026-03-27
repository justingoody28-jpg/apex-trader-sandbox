// pages/api/auto-trade.js — Vercel Cron auto-trader
// Cron: 13:29 UTC Mon-Fri (= 9:29 AM EDT)
// Strategy: Scenario E — GAP FADE SHORT (gap >= +10%, rvol >= 2x, short at open)
// Required env vars: ALPACA_ID, ALPACA_SECRET

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ALPACA_ID     = process.env.ALPACA_ID;
  const ALPACA_SECRET = process.env.ALPACA_SECRET;

  if (!ALPACA_ID || !ALPACA_SECRET) {
    return res.status(500).json({ error: 'Missing env vars: ALPACA_ID, ALPACA_SECRET' });
  }

  const ALPACA_HEADERS = {
    'APCA-API-KEY-ID':     ALPACA_ID,
    'APCA-API-SECRET-KEY': ALPACA_SECRET,
    'Content-Type':        'application/json',
  };

  // 1. Load schedule from GitHub raw URL (always current, no redeploy needed)
  let config;
  try {
    const r = await fetch(
      'https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json'
    );
    if (!r.ok) throw new Error('Config not found — sync from the SCENARIOS tab first');
    config = await r.json();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const schedules = (config.schedules || []).filter(s => s.symbol && s.bet > 0);
  if (schedules.length === 0) {
    return res.status(200).json({ message: 'No schedules configured', trades: [] });
  }

  // 2. Batch-fetch snapshots for all symbols in one call
  const symbols = [...new Set(schedules.map(s => s.symbol.toUpperCase()))];
  let snapshots = {};
  try {
    const r = await fetch(
      `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=iex`,
      { headers: ALPACA_HEADERS }
    );
    if (r.ok) snapshots = await r.json();
  } catch (_) {}

  // 3. Evaluate each scheduled symbol against Scenario E criteria
  const results = [];

  for (const sched of schedules) {
    const sym  = sched.symbol.toUpperCase();
    const bet  = sched.bet;
    const snap = snapshots[sym];

    if (!snap) {
      results.push({ symbol: sym, status: 'skipped', reason: 'No snapshot data from Alpaca' });
      continue;
    }

    // Pre-market price = best estimate of the open
    const price     = snap.latestTrade && snap.latestTrade.p;
    const prevClose = snap.prevDailyBar && snap.prevDailyBar.c;

    if (!price || !prevClose || price <= 0 || prevClose <= 0) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Missing price or prev close' });
      continue;
    }

    // Gap % = (pre-market price - prev close) / prev close * 100
    const gap = (price - prevClose) / prevClose * 100;

    // RVOL = today pre-market volume / 20-day avg daily volume
    let rvol = 0;
    try {
      const end   = new Date().toISOString().split('T')[0];
      const start = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const br    = await fetch(
        `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=1Day&start=${start}&end=${end}&limit=25&feed=iex`,
        { headers: ALPACA_HEADERS }
      );
      if (br.ok) {
        const bd   = await br.json();
        const bars = bd.bars || [];
        if (bars.length > 0) {
          const avgVol   = bars.reduce((s, b) => s + b.v, 0) / bars.length;
          const todayVol = (snap.dailyBar && snap.dailyBar.v) || 0;
          rvol = avgVol > 0 ? todayVol / avgVol : 0;
        }
      }
    } catch (_) {}

    // Scenario E: gap >= +10% AND rvol >= 2x
    if (gap < 10) {
      results.push({
        symbol: sym, status: 'skipped',
        reason: `Gap ${gap.toFixed(2)}% below +10% threshold`,
        gap: +gap.toFixed(2), rvol: +rvol.toFixed(2)
      });
      continue;
    }
    if (rvol < 2) {
      results.push({
        symbol: sym, status: 'skipped',
        reason: `RVOL ${rvol.toFixed(2)}x below 2x threshold (gap was +${gap.toFixed(2)}%)`,
        gap: +gap.toFixed(2), rvol: +rvol.toFixed(2)
      });
      continue;
    }

    // Qualifies — short sell whole shares (Alpaca does not support fractional shorts)
    const qty = Math.floor(bet / price);
    if (qty < 1) {
      results.push({
        symbol: sym, status: 'skipped',
        reason: `Bet $${bet} too small for $${price.toFixed(2)} price (rounds to 0 shares)`,
        gap: +gap.toFixed(2), rvol: +rvol.toFixed(2)
      });
      continue;
    }

    try {
      const orderRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method:  'POST',
        headers: ALPACA_HEADERS,
        body:    JSON.stringify({
          symbol:        sym,
          side:          'sell',
          type:          'market',
          time_in_force: 'day',
          qty:           String(qty),
        }),
      });
      const order = await orderRes.json();

      if (!orderRes.ok) {
        results.push({
          symbol: sym, status: 'error',
          reason: order.message || `Alpaca error ${orderRes.status}`,
          gap: +gap.toFixed(2), rvol: +rvol.toFixed(2)
        });
      } else {
        results.push({
          symbol: sym, status: 'traded', scenario: 'E', side: 'sell',
          qty, price: +price.toFixed(2),
          gap: +gap.toFixed(2), rvol: +rvol.toFixed(2),
          orderId: order.id, orderStatus: order.status
        });
      }
    } catch (e) {
      results.push({ symbol: sym, status: 'error', reason: e.message });
    }
  }

  const traded  = results.filter(r => r.status === 'traded').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    summary:   { traded, skipped, errors },
    trades:    results,
  });
}