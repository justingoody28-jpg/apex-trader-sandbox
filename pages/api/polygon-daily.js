// pages/api/polygon-daily.js
//
// Read-only proxy to Polygon's daily aggregates endpoint.
// Used by browser-based audit tools so the POLYGON_KEY never leaves Vercel env.
//
// Usage:
//   GET /api/polygon-daily?ticker=ACCO&from=2026-04-10&to=2026-04-22
//
// Returns: { ticker, bars: [{date:'YYYY-MM-DD', o, h, l, c, v}, ...] }

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

  const { ticker, from, to } = req.query;
  if (!ticker || !from || !to) {
    return res.status(400).json({ error: 'ticker, from, to query params required' });
  }

  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to)) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD format' });
  }

  // Basic ticker sanitize — letters, dots, hyphens only (no path chars)
  if (!/^[A-Za-z.\-]{1,10}$/.test(ticker)) {
    return res.status(400).json({ error: 'ticker must be 1-10 alphanumeric chars' });
  }

  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker.toUpperCase())}` +
                `/range/1/day/${from}/${to}` +
                `?adjusted=true&sort=asc&limit=500&apiKey=${key}`;
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
    const bars = results.map(b => ({
      date: new Date(b.t).toISOString().slice(0, 10),
      o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
    }));

    // Cache at edge for 1 hour — historical daily bars don't change
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ ticker: ticker.toUpperCase(), count: bars.length, bars });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
