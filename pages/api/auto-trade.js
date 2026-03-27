// pages/api/auto-trade.js — Vercel Cron auto-trader
// Cron: 13:29 UTC Mon-Fri (= 9:29 AM EDT)
// Required env vars: POLYGON_KEY, ALPACA_ID, ALPACA_SECRET
// Config source: public/auto-trade-config.json (synced from browser via /api/save-auto-config)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const POLYGON_KEY   = process.env.POLYGON_KEY;
  const ALPACA_ID     = process.env.ALPACA_ID;
  const ALPACA_SECRET = process.env.ALPACA_SECRET;

  if (!POLYGON_KEY || !ALPACA_ID || !ALPACA_SECRET) {
    return res.status(500).json({
      error: 'Missing env vars. Set POLYGON_KEY, ALPACA_ID, ALPACA_SECRET in Vercel dashboard.'
    });
  }

  // Fetch config JSON from the Vercel deployment's public folder
  let config;
  try {
    const configRes = await fetch('https://apex-trader-sandbox.vercel.app/auto-trade-config.json');
    if (!configRes.ok) throw new Error('Config not found — sync from the SCENARIOS tab first');
    config = await configRes.json();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const schedules = config.schedules || [];
  if (schedules.length === 0) {
    return res.status(200).json({ message: 'No schedules configured', trades: [] });
  }

  // Use today's date for Polygon open-close endpoint
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const ALPACA_HEADERS = {
    'APCA-API-KEY-ID':     ALPACA_ID,
    'APCA-API-SECRET-KEY': ALPACA_SECRET,
    'Content-Type':        'application/json',
  };

  const results = [];

  for (const sched of schedules) {
    const { symbol, side, bet, scenario } = sched;
    if (!symbol || !side || !(bet > 0)) {
      results.push({ symbol, status: 'skipped', reason: 'Invalid schedule entry' });
      continue;
    }

    try {
      // 1. Get open price from Polygon
      const polyRes = await fetch(
        `https://api.polygon.io/v1/open-close/${symbol.toUpperCase()}/${today}?adjusted=true&apiKey=${POLYGON_KEY}`
      );
      const polyData = await polyRes.json();
      const openPrice = polyData.open;

      if (!openPrice || openPrice <= 0) {
        results.push({ symbol, status: 'skipped', reason: `No open price from Polygon for ${today}` });
        continue;
      }

      // 2. Calculate shares = floor($ bet / open price)
      const shares = Math.floor(bet / openPrice);
      if (shares < 1) {
        results.push({
          symbol, status: 'skipped',
          reason: `Bet $${bet} too small for $${openPrice.toFixed(2)} open (< 1 share)`
        });
        continue;
      }

      // 3. Fire Alpaca market order
      const orderBody = {
        symbol:        symbol.toUpperCase(),
        side:          side,
        type:          'market',
        time_in_force: 'day',
        qty:           String(shares),
      };

      const orderRes = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method:  'POST',
        headers: ALPACA_HEADERS,
        body:    JSON.stringify(orderBody),
      });
      const order = await orderRes.json();

      if (!orderRes.ok) {
        results.push({ symbol, status: 'error', reason: order.message || `Alpaca error ${orderRes.status}` });
      } else {
        results.push({
          symbol, status: 'traded', scenario, side,
          shares, openPrice, orderId: order.id, orderStatus: order.status
        });
      }

    } catch (e) {
      results.push({ symbol, status: 'error', reason: e.message });
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