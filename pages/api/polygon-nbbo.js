// pages/api/polygon-nbbo.js
//
// Historical NBBO (bid/ask) lookup endpoint.
// For a given ticker, date, and target time, returns the nearest NBBO quote.
// Used for spread analysis on historical signals.
//
// GET usage:
//   /api/polygon-nbbo?ticker=HUBS&date=2026-04-23&time=13:30:04
// Returns: { ticker, date, target_time, nbbo: {bid, ask, bid_size, ask_size, spread_pct, ts_delta_ms}, status }
//
// Polygon v3/quotes endpoint gives NBBO tick data. We fetch a small window
// around the target time and return the closest tick.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  // Support both GET (single lookup) and POST (batch)
  if (req.method === 'GET') {
    const { ticker, date, time } = req.query;
    if (!ticker || !date || !time) {
      return res.status(400).json({ error: 'ticker, date (YYYY-MM-DD), time (HH:MM:SS in UTC) required' });
    }
    const result = await fetchNbbo(ticker, date, time, key);
    return res.status(result.status === 'OK' ? 200 : 502).json(result);
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const queries = body?.queries;
    if (!Array.isArray(queries) || !queries.length) {
      return res.status(400).json({ error: 'queries array required: [{ticker, date, time}, ...]' });
    }
    if (queries.length > 100) {
      return res.status(400).json({ error: 'max 100 queries per batch' });
    }

    const results = [];
    let idx = 0;
    const CONC = 6;
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= queries.length) return;
        const q = queries[i];
        results[i] = await fetchNbbo(q.ticker, q.date, q.time, key);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, queries.length) }, () => worker()));
    return res.status(200).json({ count: results.length, results });
  }

  return res.status(405).json({ error: 'GET or POST only' });
}

async function fetchNbbo(ticker, date, time, key) {
  try {
    // Build UTC timestamp in nanoseconds for Polygon v3/quotes
    // Polygon accepts RFC3339 timestamps: YYYY-MM-DDTHH:MM:SS.sssZ
    const targetIso = `${date}T${time}.000Z`;
    const targetMs = new Date(targetIso).getTime();
    if (isNaN(targetMs)) return { ticker, date, time, status: 'INVALID_TIME' };

    // Fetch quotes in a small window around target time (±2 sec)
    const startNs = (targetMs - 2000) * 1e6;
    const endNs   = (targetMs + 2000) * 1e6;

    const url = `https://api.polygon.io/v3/quotes/${encodeURIComponent(ticker.toUpperCase())}` +
                `?timestamp.gte=${startNs}&timestamp.lte=${endNs}` +
                `&order=asc&limit=50&apiKey=${key}`;
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.text();
      return { ticker, date, time, status: `HTTP_${r.status}`, detail: err.slice(0, 200) };
    }
    const data = await r.json();
    const quotes = data.results || [];
    if (!quotes.length) return { ticker, date, time, status: 'NO_QUOTES' };

    // Find closest quote to target time
    const targetNs = targetMs * 1e6;
    let best = quotes[0];
    let bestDelta = Math.abs((best.sip_timestamp || best.participant_timestamp || 0) - targetNs);
    for (const q of quotes) {
      const ts = q.sip_timestamp || q.participant_timestamp || 0;
      const d = Math.abs(ts - targetNs);
      if (d < bestDelta) { best = q; bestDelta = d; }
    }

    const bid = best.bid_price;
    const ask = best.ask_price;
    const mid = (bid && ask) ? (bid + ask) / 2 : null;
    const spreadPct = (mid && bid && ask) ? +(((ask - bid) / mid) * 100).toFixed(4) : null;

    return {
      ticker: ticker.toUpperCase(),
      date,
      target_time: time,
      nbbo: {
        bid, ask,
        bid_size: best.bid_size,
        ask_size: best.ask_size,
        mid: mid ? +mid.toFixed(4) : null,
        spread: (bid && ask) ? +(ask - bid).toFixed(4) : null,
        spread_pct: spreadPct,
        ts_delta_ms: +(bestDelta / 1e6).toFixed(2)
      },
      total_quotes_in_window: quotes.length,
      status: 'OK'
    };
  } catch (e) {
    return { ticker, date, time, status: `ERR_${e.message}` };
  }
}
