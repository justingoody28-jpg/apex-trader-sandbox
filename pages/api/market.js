export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { source, endpoint, ...rest } = req.query;

  // Build extra query string from all params besides source and endpoint
  const extraParams = Object.entries(rest)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const sep = extraParams ? '?' : '';

  try {
    let url;
    if (source === 'td') {
      url = `https://api.twelvedata.com/${endpoint}${sep}${extraParams}&apikey=${process.env.TWELVE_DATA_KEY}`;
    } else if (source === 'fh') {
      url = `https://finnhub.io/api/v1/${endpoint}${sep}${extraParams}&token=${process.env.FINNHUB_KEY}`;
    } else if (source === 'fmp') {
      url = `https://financialmodelingprep.com/stable/${endpoint}${sep}${extraParams}&apikey=${process.env.FMP_KEY}`;
    } else {
      return res.status(400).json({ error: 'Unknown source' });
    }
    const r = await fetch(url);
    const data = await r.json();
    // 60s cache for quotes (fresh prices), 10min for historical/fundamental data
    const isQuote = endpoint && endpoint.includes('quote');
    res.setHeader('Cache-Control', isQuote
      ? 's-maxage=60, stale-while-revalidate=30'
      : 's-maxage=600, stale-while-revalidate=1200');
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
