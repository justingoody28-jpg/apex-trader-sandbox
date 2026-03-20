export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { source, endpoint } = req.query;

  try {
    let url;
    if (source === 'td') {
      url = `https://api.twelvedata.com/${endpoint}&apikey=${process.env.TWELVE_DATA_KEY}`;
    } else if (source === 'fh') {
      url = `https://finnhub.io/api/v1/${endpoint}&token=${process.env.FINNHUB_KEY}`;
    } else if (source === 'fmp') {
      url = `https://financialmodelingprep.com/api/v3/${endpoint}&apikey=${process.env.FMP_KEY}`;
    } else {
      return res.status(400).json({ error: 'Unknown source' });
    }

    const r = await fetch(url);
    const data = await r.json();
    // Cache for 5 minutes to avoid burning rate limits on repeat loads
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
