export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { source, endpoint, ...rest } = req.query;

  const extraParams = Object.entries(rest)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const sep = extraParams ? '?' : '';

  function isRateLimited(data) {
    const str = JSON.stringify(data || '');
    return str.includes('API limit reached') || str.includes('Rate limit') ||
           str.includes('too many requests') || str.includes('"429"');
  }
  function isEmpty(data) {
    return !data || (Array.isArray(data) && data.length === 0) ||
      (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).filter(k=>k!=='_source').length === 0);
  }
  // Normalize FMP quote array into Finnhub-style object so callers don't need to change
  function normalizeFmpQuote(fmpArr) {
    const q = Array.isArray(fmpArr) ? fmpArr[0] : fmpArr;
    if (!q || !q.price) return null;
    return {
      c:  q.price,
      pc: q.previousClose || q.price,
      dp: q.changesPercentage || 0,
      h:  q.dayHigh || q.price,
      l:  q.dayLow  || q.price,
      v:  q.volume  || 0,
      // Also expose FMP-specific fields for 52W (Finnhub needs separate metric call)
      hi52: q.yearHigh  || 0,
      lo52: q.yearLow   || 0,
      avgVol: q.avgVolume || 0,
      mktCap: q.marketCap || 0,
      pe: q.pe || null,
      beta: q.beta || null,
      _source: 'fmp',
    };
  }

  const isQuote = endpoint && (endpoint.includes('quote') || endpoint === 'quote');
  const cacheHeader = isQuote
    ? 's-maxage=60, stale-while-revalidate=30'
    : 's-maxage=600, stale-while-revalidate=1200';

  try {
    let data;

    if (source === 'td') {
      const url = `https://api.twelvedata.com/${endpoint}${sep}${extraParams}&apikey=${process.env.TWELVE_DATA_KEY}`;
      data = await fetch(url).then(r => r.json());

    } else if (source === 'fh') {
      const url = `https://finnhub.io/api/v1/${endpoint}${sep}${extraParams}&token=${process.env.FINNHUB_KEY}`;
      data = await fetch(url).then(r => r.json());

    } else if (source === 'fmp') {
      const url = `https://financialmodelingprep.com/stable/${endpoint}${sep}${extraParams}&apikey=${process.env.FMP_KEY}`;
      data = await fetch(url).then(r => r.json());

    } else if (source === 'fmp_fh') {
      // Primary: FMP. Fallback: Finnhub. fh_endpoint = Finnhub equivalent path.
      const { fh_endpoint, ...sharedRest } = rest;
      const sharedExtra = Object.entries(sharedRest)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
      const sharedSep = sharedExtra ? '?' : '';

      const fmpUrl = `https://financialmodelingprep.com/stable/${endpoint}${sharedSep}${sharedExtra}&apikey=${process.env.FMP_KEY}`;
      const fmpRaw = await fetch(fmpUrl).then(r => r.json()).catch(() => null);

      if (!isRateLimited(fmpRaw) && !isEmpty(fmpRaw)) {
        // Normalize FMP quote to Finnhub format so callers work unchanged
        data = isQuote ? normalizeFmpQuote(fmpRaw) : fmpRaw;
        if (data) data._source = 'fmp';
      } else if (fh_endpoint) {
        // Fall back to Finnhub
        const fhUrl = `https://finnhub.io/api/v1/${fh_endpoint}${sharedSep}${sharedExtra}&token=${process.env.FINNHUB_KEY}`;
        data = await fetch(fhUrl).then(r => r.json()).catch(() => ({}));
        if (data) data._source = 'fh_fallback';
      } else {
        data = fmpRaw;
      }

    } else {
      return res.status(400).json({ error: 'Unknown source' });
    }

    res.setHeader('Cache-Control', cacheHeader);
    return res.json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
