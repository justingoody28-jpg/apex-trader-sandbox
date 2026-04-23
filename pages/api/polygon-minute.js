// pages/api/polygon-minute.js
//
// Read-only proxy to Polygon's minute aggregates endpoint.
// Used by browser-based audit tools and backtest helpers so the
// POLYGON_KEY never leaves Vercel env.
//
// Usage:
//   GET /api/polygon-minute?ticker=HUBS&from=2026-04-23&to=2026-04-23
//   GET /api/polygon-minute?ticker=HUBS&from=2026-04-23&to=2026-04-23&premarketOnly=1
//
// Returns: { ticker, count, summary, bars: [{t, iso, o, h, l, c, v}, ...] }
// When premarketOnly=1, only bars before 13:30 UTC (9:30 ET EDT) are returned.

export default async function handler(req, res) {
  // CORS for browser origin (read-only)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  const { ticker, from, to, premarketOnly } = req.query;
  if (!ticker || !from || !to) {
    return res.status(400).json({ error: 'ticker, from, to query params required' });
  }

  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to)) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD format' });
  }

  if (!/^[A-Za-z.\-]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: 'ticker must be 1-10 alphanumeric chars' });
  }

  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker.toUpperCase())}` +
                `/range/1/minute/${from}/${to}` +
                `?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
    const r = await fetch(url);
    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(r.status).json({
        error: `Polygon ${r.status}`,
        detail: errTxt.slice(0, 300)
      });
    }
    const data = await r.json();
    const results = data.results || [];

    let bars = results.map(b => ({
      t: b.t,
      iso: new Date(b.t).toISOString(),
      o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
    }));

    // Premarket filter: 13:30 UTC is 9:30 ET during EDT (March-Nov)
    // For EST (Nov-March) it's 14:30 UTC. We use a conservative 13:30 cutoff for EDT dates.
    if (premarketOnly === '1') {
      bars = bars.filter(b => {
        const d = new Date(b.t);
        const hour = d.getUTCHours();
        const min = d.getUTCMinutes();
        return hour < 13 || (hour === 13 && min < 30);
      });
    }

    let summary = null;
    if (bars.length) {
      const lows = bars.map(b => b.l);
      const highs = bars.map(b => b.h);
      const vols = bars.map(b => b.v);
      const minLow = Math.min(...lows);
      const maxHigh = Math.max(...highs);
      const minLowBar = bars.find(b => b.l === minLow);
      const maxHighBar = bars.find(b => b.h === maxHigh);
      summary = {
        first_bar: bars[0].iso,
        last_bar: bars[bars.length - 1].iso,
        count: bars.length,
        min_low: minLow,
        min_low_time: minLowBar.iso,
        max_high: maxHigh,
        max_high_time: maxHighBar.iso,
        total_volume: vols.reduce((a, b) => a + b, 0)
      };
    }

    // Minute bars for historical dates don't change — safe to cache
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({
      ticker: ticker.toUpperCase(),
      count: bars.length,
      summary,
      bars
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
