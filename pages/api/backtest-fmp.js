export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  const key = process.env.FMP_KEY;
  if (!key) return res.status(500).json({ error: 'FMP_KEY not set' });

  try {
    const [earnsRes, analRes] = await Promise.all([
      fetch(`https://financialmodelingprep.com/api/v3/earnings-surprises/${encodeURIComponent(ticker)}?apikey=${key}`),
      fetch(`https://financialmodelingprep.com/api/v4/upgrades-downgrades?symbol=${encodeURIComponent(ticker)}&apikey=${key}`)
    ]);
    const earns   = await earnsRes.json().catch(() => []);
    const analRaw = await analRes.json().catch(() => []);
    const analysts = analRaw?.upgradesDowngradesHistory || (Array.isArray(analRaw) ? analRaw : []);
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    return res.json({ earns: Array.isArray(earns) ? earns : [], analysts });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
