export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { ticker, from, to } = req.query;
  if (!ticker || !from || !to)
    return res.status(400).json({ error: 'ticker, from, to required' });

  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY not set' });

  try {
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=500&apiKey=${key}`;
    const r = await fetch(url);
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.json(data.results || []);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
