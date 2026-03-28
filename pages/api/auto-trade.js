// pages/api/auto-trade.js
// Fires at 9:29 AM EDT weekdays via Vercel cron + GitHub Actions
// Runs Scenarios E (gap short), G (honed fade long), H (panic reversal)
// against all configured tickers with live pre-market condition checks

export default async function handler(req, res) {
  const startTime = Date.now();
  const log = [];
  const lg = (msg) => { log.push(msg); console.log(msg); };

  // ── Auth guard ──────────────────────────────────────────────────────────────
  const secret = req.headers['x-cron-secret'] || req.query.secret || '';
  if (secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const POLY_KEY  = process.env.POLYGON_KEY;
  const ALPA_ID   = process.env.ALPACA_ID;
  const ALPA_SEC  = process.env.ALPACA_SECRET;
  const ALPA_BASE = 'https://paper-api.alpaca.markets';

  if (!POLY_KEY || !ALPA_ID || !ALPA_SEC) {
    return res.status(500).json({ error: 'Missing env vars', log });
  }

  // ── Load config from GitHub raw ────────────────────────────────────────────
  let config = {};
  try {
    const cfgUrl = 'https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json';
    const cfgRes = await fetch(cfgUrl + '?t=' + Date.now());
    config = await cfgRes.json();
  } catch (e) {
    lg('Config load failed: ' + e.message);
  }

  // Config shape:
  // { tickers: [{symbol, bet}], scenarios: {E,G,H}, thresholds: {eGap,gGap,hGap}, defaultBet }
  const tickers    = config.tickers || [];
  const scenarios  = config.scenarios  || { E: true, G: true, H: true };
  const thresholds = config.thresholds || { eGap: 10, gGap: 8, hGap: 10 };
  const defaultBet = config.defaultBet || 500;

  if (!tickers.length) {
    lg('No tickers configured');
    return res.status(200).json({ ok: true, message: 'No tickers', log });
  }

  lg('Auto-trader starting: ' + tickers.length + ' tickers | scenarios E:' +
    scenarios.E + ' G:' + scenarios.G + ' H:' + scenarios.H);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const etH = (ts) => {
    const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York' }));
    return d.getHours() + d.getMinutes() / 60;
  };

  const fetchPMbars = async (symbol) => {
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    // Use a wide window to get all pre-market bars (4am-9:30am ET)
    const fromMs = new Date(today + 'T04:00:00').getTime();
    const toMs   = Date.now();
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${fromMs}/${toMs}?adjusted=true&sort=asc&limit=500&apiKey=${POLY_KEY}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('Polygon ' + r.status);
    const d = await r.json();
    return (d.results || []).filter(b => { const h = etH(b.t); return h >= 4 && h < 9.5; });
  };

  const fetchAvgVol = async (symbol) => {
    const to = new Date(); to.setDate(to.getDate() - 1);
    const fr = new Date(); fr.setDate(fr.getDate() - 31);
    const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/day/${fr.toISOString().slice(0,10)}/${to.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=30&apiKey=${POLY_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    const bars = d.results || [];
    return bars.length ? bars.reduce((s, b) => s + b.v, 0) / bars.length : null;
  };

  const fetchPrevClose = async (symbol) => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    // walk back to find last trading day
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
    const date = d.toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v1/open-close/${symbol}/${date}?adjusted=true&apiKey=${POLY_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    return data.close || null;
  };

  const placeOrder = async (symbol, side, qty) => {
    const body = { symbol, qty: String(qty), side, type: 'market', time_in_force: 'day' };
    const r = await fetch(ALPA_BASE + '/v2/orders', {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID': ALPA_ID,
        'APCA-API-SECRET-KEY': ALPA_SEC,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.message || JSON.stringify(data));
    return data;
  };

  const getSnapshot = async (symbol) => {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}?apiKey=${POLY_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    return d.ticker ? (d.ticker.day?.o || d.ticker.prevDay?.c || null) : null;
  };

  // ── Process each ticker ────────────────────────────────────────────────────
  const results = [];

  for (const tickerCfg of tickers) {
    const symbol = (tickerCfg.symbol || tickerCfg).toUpperCase();
    const bet    = tickerCfg.bet || defaultBet;
    const tickerLog = [];
    const tl = (msg) => { tickerLog.push(msg); lg('[' + symbol + '] ' + msg); };

    try {
      // Fetch data in parallel
      const [pmBars, avgVol, prevClose] = await Promise.all([
        fetchPMbars(symbol),
        fetchAvgVol(symbol),
        fetchPrevClose(symbol)
      ]);

      if (!pmBars.length || !prevClose) {
        tl('No PM data or prev close — skip');
        results.push({ symbol, skipped: true, reason: 'no data' });
        continue;
      }

      // Compute metrics
      const lastPM   = pmBars[pmBars.length - 1].c;
      const minPM    = pmBars.reduce((mn, b) => Math.min(mn, b.l), Infinity);
      const pmVol    = pmBars.reduce((s, b) => s + b.v, 0);
      const gap      = ((lastPM - prevClose) / prevClose) * 100;      // last PM close vs prev close
      const gapDown  = ((minPM  - prevClose) / prevClose) * 100;      // lowest PM print vs prev close
      const rvol     = avgVol ? pmVol / (avgVol * 0.05) : null;       // PM vol vs 5% of avg daily

      tl(`gap=${gap.toFixed(1)}% gapDown=${gapDown.toFixed(1)}% rvol=${rvol ? rvol.toFixed(1)+'x' : 'N/A'}`);

      // Get live price for share calc
      const livePrice = await getSnapshot(symbol) || lastPM;
      const tickerResult = { symbol, gap: +gap.toFixed(2), gapDown: +gapDown.toFixed(2), rvol: rvol ? +rvol.toFixed(2) : null, orders: [] };

      // ── Scenario E: Gap Fade Short ─────────────────────────────────────────
      if (scenarios.E && gap >= thresholds.eGap) {
        tl(`E TRIGGERED: gap ${gap.toFixed(1)}% >= ${thresholds.eGap}% → SHORT`);
        const qty = Math.floor(bet / livePrice);
        if (qty >= 1) {
          try {
            const order = await placeOrder(symbol, 'sell', qty);
            tl(`E ORDER: short ${qty} shares @ ~$${livePrice.toFixed(2)} | id=${order.id.slice(0,8)}`);
            tickerResult.orders.push({ scenario: 'E', side: 'sell', qty, price: livePrice, orderId: order.id, status: order.status });
          } catch (e) { tl('E order failed: ' + e.message); }
        } else { tl(`E: qty=0 at $${livePrice.toFixed(2)} with $${bet} bet — skip`); }
      } else if (scenarios.E) {
        tl(`E: gap ${gap.toFixed(1)}% < ${thresholds.eGap}% — no signal`);
      }

      // ── Scenario G: Honed Fade Long ────────────────────────────────────────
      if (scenarios.G && gapDown <= -thresholds.gGap && rvol !== null && rvol >= 3) {
        tl(`G TRIGGERED: gapDown ${gapDown.toFixed(1)}% <= -${thresholds.gGap}%, RVOL=${rvol.toFixed(1)}x → BUY`);
        const qty = Math.floor(bet / livePrice);
        if (qty >= 1) {
          try {
            const order = await placeOrder(symbol, 'buy', qty);
            tl(`G ORDER: buy ${qty} shares @ ~$${livePrice.toFixed(2)} | id=${order.id.slice(0,8)}`);
            tickerResult.orders.push({ scenario: 'G', side: 'buy', qty, price: livePrice, orderId: order.id, status: order.status });
          } catch (e) { tl('G order failed: ' + e.message); }
        } else { tl(`G: qty=0 — skip`); }
      } else if (scenarios.G) {
        const why = gapDown > -thresholds.gGap ? `gapDown ${gapDown.toFixed(1)}% > -${thresholds.gGap}%` : `RVOL ${rvol ? rvol.toFixed(1)+'x' : 'N/A'} < 3x`;
        tl('G: no signal — ' + why);
      }

      // ── Scenario H: Panic Reversal ─────────────────────────────────────────
      if (scenarios.H && gapDown <= -thresholds.hGap && rvol !== null && rvol >= 4) {
        tl(`H TRIGGERED: gapDown ${gapDown.toFixed(1)}% <= -${thresholds.hGap}%, RVOL=${rvol.toFixed(1)}x → BUY`);
        const qty = Math.floor(bet / livePrice);
        if (qty >= 1) {
          try {
            const order = await placeOrder(symbol, 'buy', qty);
            tl(`H ORDER: buy ${qty} shares @ ~$${livePrice.toFixed(2)} | id=${order.id.slice(0,8)}`);
            tickerResult.orders.push({ scenario: 'H', side: 'buy', qty, price: livePrice, orderId: order.id, status: order.status });
          } catch (e) { tl('H order failed: ' + e.message); }
        } else { tl(`H: qty=0 — skip`); }
      } else if (scenarios.H) {
        const why = gapDown > -thresholds.hGap ? `gapDown ${gapDown.toFixed(1)}% > -${thresholds.hGap}%` : `RVOL ${rvol ? rvol.toFixed(1)+'x' : 'N/A'} < 4x`;
        tl('H: no signal — ' + why);
      }

      results.push(tickerResult);

    } catch (e) {
      tl('ERROR: ' + e.message);
      results.push({ symbol, error: e.message });
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalOrders = results.reduce((s, r) => s + (r.orders ? r.orders.length : 0), 0);
  lg(`Done in ${elapsed}s | ${results.length} tickers | ${totalOrders} orders placed`);

  return res.status(200).json({ ok: true, elapsed, totalOrders, results, log });
}
