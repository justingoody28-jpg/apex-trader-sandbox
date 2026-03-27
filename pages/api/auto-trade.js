// pages/api/auto-trade.js — Vercel Cron auto-trader
// Cron: 13:29 UTC Mon-Fri (= 9:29 AM EDT)
// Required env vars: ALPACA_ID, ALPACA_SECRET
// Config source: public/auto-trade-config.json (synced from browser via /api/save-auto-config)
// Price source: Alpaca snapshot API — orders sent as notional (supports fractional shares)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ALPACA_ID     = process.env.ALPACA_ID;
  const ALPACA_SECRET = process.env.ALPACA_SECRET;

  if (!ALPACA_ID || !ALPACA_SECRET) {
    return res.status(500).json({
      error: 'Missing env vars. Set ALPACA_ID and ALPACA_SECRET in Vercel dashboard.'
    });
  }

  const ALPACA_HEADERS = {
    'APCA-API-KEY-ID':     ALPACA_ID,
    'APCA-API-SECRET-KEY': ALPACA_SECRET,
    'Content-Type':        'application/json',
  };

  // Fetch config from GitHub raw URL — always current, no redeploy needed
  let config;
  try {
    const configRes = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!configRes.ok) throw new Error('Config not found — sync from the SCENARIOS tab first');
    config = await configRes.json();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const schedules = config.schedules || [];
  if (schedules.length === 0) {
    return res.status(200).json({ message: 'No schedules configured', trades: [] });
  }

  const results = [];

  for (const sched of schedules) {
    const { symbol, side, bet, scenario } = sched;
    const sym = (symbol || '').toUpperCase();

    if (!sym || !side || !(bet > 0)) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Invalid schedule entry' });
      continue;
    }

    try {
      // Send as notional — Alpaca handles fractional shares automatically
      const orderBody = {
        symbol:        sym,
        side:          side,
        type:          'market',
        time_in_force: 'day',
        notional:      String(bet),
      };

      const orderRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method:  'POST',
        headers: ALPACA_HEADERS,
        body:    JSON.stringify(orderBody),
      });
      const order = await orderRes.json();

      if (!orderRes.ok) {
        results.push({ symbol: sym, status: 'error', reason: order.message || `Alpaca error ${orderRes.status}` });
      } else {
        results.push({
          symbol: sym, status: 'traded', scenario, side,
          notional: bet, orderId: order.id, orderStatus: order.status
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