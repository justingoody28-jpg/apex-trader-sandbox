// pages/api/spread-proxy-audit.js
//
// Since NBBO quote data requires paid Polygon tier, this endpoint uses
// minute-bar OHLC data as a proxy for spread/liquidity characteristics:
//
// 1. premkt_bars        — # of premarket minute bars with trades (0 = bad sign)
// 2. premkt_volume      — total premarket shares traded
// 3. first_bar_range_pct — (h-l)/o on the 9:30-9:31 bar (wide = wide spread)
// 4. first_bar_volume   — shares in 9:30-9:31
// 5. first_5_range_pct  — max range across first 5 minutes
//
// GET usage: /api/spread-proxy-audit?t=TICKER|YYYY-MM-DD;TICKER|YYYY-MM-DD;...
// POST usage: { queries: [{ticker, date}, ...] }
// Returns per-query analysis + overall summary stats.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  let queries = null;
  if (req.method === 'GET') {
    const t = req.query.t;
    if (!t) return res.status(400).json({ error: 'query param t required, format TICKER|YYYY-MM-DD;...' });
    queries = t.split(';').filter(Boolean).map(s => {
      const [ticker, date] = s.split('|');
      return { ticker, date };
    });
  } else if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    queries = body?.queries;
  } else {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  if (!Array.isArray(queries) || !queries.length) {
    return res.status(400).json({ error: 'queries required' });
  }

  const results = [];
  let idx = 0;
  const CONC = 5;

  async function analyzeOne({ ticker, date }) {
    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker.toUpperCase())}` +
                  `/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
      const r = await fetch(url);
      if (!r.ok) return { ticker, date, status: `HTTP_${r.status}` };
      const data = await r.json();
      const bars = data.results || [];
      if (!bars.length) return { ticker, date, status: 'NO_BARS' };

      // Classify bars as premarket or regular session (market open at 13:30 UTC EDT, 14:30 EST)
      // Filter: premarket = hour*60+min < 13:30 UTC, regular = 13:30 to 20:00
      const premkt = [];
      const regular = [];
      for (const b of bars) {
        const d = new Date(b.t);
        const hm = d.getUTCHours() * 60 + d.getUTCMinutes();
        if (hm < 13 * 60 + 30) premkt.push(b);
        else if (hm < 20 * 60) regular.push(b);
      }

      if (!regular.length) return { ticker, date, status: 'NO_REGULAR_BARS' };

      const premkt_bars = premkt.length;
      const premkt_volume = premkt.reduce((a, b) => a + (b.v || 0), 0);
      const bar0 = regular[0];
      const first_bar_range_pct = +(((bar0.h - bar0.l) / bar0.o) * 100).toFixed(3);
      const first_bar_volume = bar0.v;

      const first5 = regular.slice(0, 5);
      const first_5_max_range = Math.max(...first5.map(b => b.h - b.l));
      const first_5_range_pct = +((first_5_max_range / bar0.o) * 100).toFixed(3);
      const first_5_volume = first5.reduce((a, b) => a + (b.v || 0), 0);

      return {
        ticker: ticker.toUpperCase(),
        date,
        premkt_bars,
        premkt_volume: Math.round(premkt_volume),
        bar0_o: bar0.o,
        bar0_h: bar0.h,
        bar0_l: bar0.l,
        bar0_c: bar0.c,
        first_bar_range_pct,
        first_bar_volume: Math.round(first_bar_volume),
        first_5_range_pct,
        first_5_volume: Math.round(first_5_volume),
        status: 'OK'
      };
    } catch (e) {
      return { ticker, date, status: `ERR_${e.message}` };
    }
  }

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= queries.length) return;
      results[i] = await analyzeOne(queries[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, queries.length) }, () => worker()));

  const ok = results.filter(r => r.status === 'OK');
  const noPremkt = ok.filter(r => r.premkt_bars === 0);
  const thinPremkt = ok.filter(r => r.premkt_bars > 0 && r.premkt_bars < 5);

  // Summary percentiles
  function pct(arr, p) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((sorted.length - 1) * p);
    return sorted[idx];
  }
  const firstBarRanges = ok.map(r => r.first_bar_range_pct);
  const firstBarVols = ok.map(r => r.first_bar_volume);

  return res.status(200).json({
    audited: results.length,
    ok: ok.length,
    no_premkt_bars: noPremkt.length,
    thin_premkt_under_5: thinPremkt.length,
    first_bar_range_pct: {
      min: Math.min(...firstBarRanges),
      p10: pct(firstBarRanges, 0.1),
      p25: pct(firstBarRanges, 0.25),
      p50: pct(firstBarRanges, 0.5),
      p75: pct(firstBarRanges, 0.75),
      p90: pct(firstBarRanges, 0.9),
      max: Math.max(...firstBarRanges)
    },
    first_bar_volume: {
      min: Math.min(...firstBarVols),
      p10: pct(firstBarVols, 0.1),
      p50: pct(firstBarVols, 0.5),
      p90: pct(firstBarVols, 0.9),
      max: Math.max(...firstBarVols)
    },
    results
  });
}
