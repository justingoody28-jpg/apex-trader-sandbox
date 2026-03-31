// pages/api/backtest-daily.js
// Returns daily OHLCV bars + pmPrice (close of last 5-min pre-market bar before 9:30 AM)
// pmPrice is used as both the gap entry reference and the trade entry price

export default async function handler(req, res) {
  const { ticker, from, to } = req.query;
  if (!ticker || !from || !to) return res.status(400).json({ error: 'ticker, from, to required' });

  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY not set' });

  try {
    // Parallel: daily bars for regular-session OHLCV + 5-min extended for pre-market price
    const [dailyRes, pmRes] = await Promise.all([
      fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}` +
        `?adjusted=true&sort=asc&limit=500&apiKey=${key}`
      ),
      fetch(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/5/minute/${from}/${to}` +
        `?adjusted=true&sort=asc&limit=50000&extended_hours=true&apiKey=${key}`
      ),
    ]);

    if (!dailyRes.ok) return res.status(dailyRes.status).json({ error: 'polygon daily error' });
    if (!pmRes.ok)    return res.status(pmRes.status).json({ error: 'polygon 5min error' });

    const [dailyData, pmData] = await Promise.all([dailyRes.json(), pmRes.json()]);

    const dailyBars = dailyData.results || [];
    const pmBars    = pmData.results    || [];

    // Build pre-market price map: date string -> close of 9:25-9:30 AM bar
    // The 9:25 AM bar starts at:
    //   EDT (Mar-Nov approx): 13:25 UTC
    //   EST (Nov-Mar approx): 14:25 UTC
    // Check both to avoid DST edge-case errors around transition weeks
    const pmMap = {};
    for (const bar of pmBars) {
      const dt = new Date(bar.t);
      const utcH = dt.getUTCHours();
      const utcM = dt.getUTCMinutes();
      if (utcM === 25 && (utcH === 13 || utcH === 14)) {
        const dateStr = dt.toISOString().slice(0, 10);
        pmMap[dateStr] = bar.c; // close of 9:25-9:30 bar = last pre-market print
      }
    }

    // Attach pmPrice to each daily bar
    const result = dailyBars.map(bar => {
      const dateStr = new Date(bar.t).toISOString().slice(0, 10);
      return { ...bar, pmPrice: pmMap[dateStr] ?? null };
    });

    res.setHeader('Cache-Control', 's-maxage=3600');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
