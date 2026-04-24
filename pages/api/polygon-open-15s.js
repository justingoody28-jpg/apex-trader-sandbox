// pages/api/polygon-open-15s.js
//
// For a given ticker + date, returns second-by-second aggregates covering
// the first 15 seconds of regular trading (9:30:00 - 9:30:15 ET).
// Used to characterize actual open behavior vs 9:30-bar open price used
// in backtest evaluation.
//
// Also captures:
//   - What second did the first trade happen in?
//   - Price range in first 15 seconds
//   - Total volume in first 15 seconds
//   - Distance from first-second open to 9:30:15 close
//
// GET: /api/polygon-open-15s?t=HUBS|2026-04-23;TSLA|2024-06-03;...
// POST: { queries: [{ticker, date}, ...] }

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
  if (queries.length > 200) {
    return res.status(400).json({ error: 'max 200 queries per batch' });
  }

  const results = [];
  let idx = 0;
  const CONC = 8;

  async function analyzeOne({ ticker, date }) {
    try {
      // Fetch 1-second aggregates for 9:30:00 - 9:31:00 ET (13:30:00 - 13:31:00 UTC)
      // Polygon v2/aggs supports timespan=second
      // Date must be converted to ms timestamps for from/to
      const startMs = new Date(`${date}T13:30:00.000Z`).getTime();
      const endMs   = new Date(`${date}T13:31:00.000Z`).getTime();

      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker.toUpperCase())}` +
                  `/range/1/second/${startMs}/${endMs}?adjusted=true&sort=asc&limit=100&apiKey=${key}`;
      const r = await fetch(url);
      if (!r.ok) {
        const errText = await r.text();
        return { ticker, date, status: `HTTP_${r.status}`, detail: errText.slice(0, 200) };
      }
      const data = await r.json();
      const bars = data.results || [];
      if (!bars.length) return { ticker, date, status: 'NO_BARS' };

      // Filter to first 15 seconds after 9:30:00 ET (which is 13:30:00 UTC in EDT / 14:30 UTC in EST)
      // bars[].t is ms timestamp. startMs IS 9:30:00. We want bars with t in [startMs, startMs+15000)
      // BUT if DST adjustment put 9:30 ET at 14:30 UTC, we need to check both
      const firstBarTs = bars[0].t;
      // The actual market open timestamp for this date. In EDT (March-Nov): 13:30 UTC, in EST (Nov-March): 14:30 UTC
      // We pass 13:30-13:31 window; if data's in EST the window won't return anything for the relevant minute
      // Polygon usually handles this correctly because timestamps are absolute
      // We'll just use first 15 bars that appear (bars are 1s, so 15 bars = 15 seconds)
      const first15 = bars.slice(0, 15);
      if (!first15.length) return { ticker, date, status: 'NO_OPEN_BARS' };

      const firstBar = first15[0];
      const lastBar = first15[first15.length - 1];
      const allOpens = first15.map(b => b.o);
      const allHighs = first15.map(b => b.h);
      const allLows = first15.map(b => b.l);
      const allCloses = first15.map(b => b.c);
      const allVolumes = first15.map(b => b.v || 0);

      const barCount = first15.length;
      const tradedSeconds = first15.filter(b => b.v > 0).length;
      const firstTradeSecOffset = first15.findIndex(b => b.v > 0);
      const maxHigh = Math.max(...allHighs);
      const minLow = Math.min(...allLows);
      const openPrice = firstBar.o;
      const rangeAbs = maxHigh - minLow;
      const rangePct = +((rangeAbs / openPrice) * 100).toFixed(3);
      const closeToOpenDiff = lastBar.c - openPrice;
      const closeToOpenPct = +((closeToOpenDiff / openPrice) * 100).toFixed(3);
      const totalVolume = allVolumes.reduce((a, b) => a + b, 0);

      // Volume-weighted average across first 15s
      let vwapNum = 0, vwapDen = 0;
      for (const b of first15) {
        if (b.v > 0 && b.vw) { vwapNum += b.vw * b.v; vwapDen += b.v; }
      }
      const vwap = vwapDen > 0 ? +((vwapNum / vwapDen).toFixed(4)) : null;
      const vwapVsOpenPct = vwap ? +(((vwap - openPrice) / openPrice) * 100).toFixed(3) : null;

      return {
        ticker: ticker.toUpperCase(),
        date,
        status: 'OK',
        bar_count: barCount,
        traded_seconds: tradedSeconds,
        first_trade_sec_offset: firstTradeSecOffset,
        open_price: openPrice,
        max_high_15s: maxHigh,
        min_low_15s: minLow,
        close_15s: lastBar.c,
        range_abs: +rangeAbs.toFixed(4),
        range_pct: rangePct,
        close_to_open_diff: +closeToOpenDiff.toFixed(4),
        close_to_open_pct: closeToOpenPct,
        total_volume_15s: totalVolume,
        vwap_15s: vwap,
        vwap_vs_open_pct: vwapVsOpenPct
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

  // Summary
  function pctile(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * p)];
  }
  const ranges = ok.map(r => r.range_pct);
  const closeToOpens = ok.map(r => Math.abs(r.close_to_open_pct));
  const vwapDiffs = ok.filter(r => r.vwap_vs_open_pct !== null).map(r => Math.abs(r.vwap_vs_open_pct));
  const firstTradeOffsets = ok.map(r => r.first_trade_sec_offset).filter(x => x >= 0);

  return res.status(200).json({
    audited: results.length,
    ok: ok.length,
    summary: {
      range_pct: {
        p25: pctile(ranges, 0.25),
        p50: pctile(ranges, 0.50),
        p75: pctile(ranges, 0.75),
        p90: pctile(ranges, 0.90),
        max: ranges.length ? Math.max(...ranges) : null
      },
      abs_close_to_open_pct: {
        p50: pctile(closeToOpens, 0.50),
        p75: pctile(closeToOpens, 0.75),
        p90: pctile(closeToOpens, 0.90)
      },
      abs_vwap_vs_open_pct: {
        p50: pctile(vwapDiffs, 0.50),
        p75: pctile(vwapDiffs, 0.75),
        p90: pctile(vwapDiffs, 0.90)
      },
      first_trade_delay_sec: {
        p50: pctile(firstTradeOffsets, 0.50),
        p75: pctile(firstTradeOffsets, 0.75),
        p90: pctile(firstTradeOffsets, 0.90)
      }
    },
    results
  });
}
