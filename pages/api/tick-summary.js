// pages/api/tick-summary.js
//
// Runs tick analysis on the committed sample file in batches, BUT returns ONLY
// aggregated summary stats + the per-signal record in minimal form.
// Each signal: [ticker, date, cap, scenario, gap, pnl, pmv, spread, status,
//               shares_filled, fill_slip_pct, first_delay_ms, vol_1s, vol_5s, vol_15s]
// This keeps response size small enough to process 500+ signals per call.
//
// GET /api/tick-summary?start=0&count=500
// GET /api/tick-summary?meta=1

import fs from 'fs';
import path from 'path';

export const config = { maxDuration: 300 };

async function analyzeOne({ ticker, date }, key) {
  try {
    const fetchTicks = async (openUtcHour) => {
      const openMs = new Date(`${date}T${String(openUtcHour).padStart(2,'0')}:30:00.000Z`).getTime();
      const startNs = openMs * 1e6;
      const endNs   = (openMs + 15000) * 1e6;
      const url = `https://api.polygon.io/v3/trades/${encodeURIComponent(ticker.toUpperCase())}` +
                  `?timestamp.gte=${startNs}&timestamp.lt=${endNs}` +
                  `&order=asc&limit=1000&apiKey=${key}`;
      const r = await fetch(url);
      if (!r.ok) return { error: `HTTP_${r.status}` };
      const data = await r.json();
      return { trades: data.results || [], openMs };
    };
    let { trades, openMs, error } = await fetchTicks(13);
    if (error) return { status: error };
    if (!trades.length) {
      ({ trades, openMs, error } = await fetchTicks(14));
      if (error) return { status: error };
    }
    if (!trades.length) return { status: 'NO_TRADES' };

    trades.sort((a, b) => (a.sip_timestamp || a.participant_timestamp || 0) -
                          (b.sip_timestamp || b.participant_timestamp || 0));
    const openNs = openMs * 1e6;
    const first = trades[0];
    const firstTs = first.sip_timestamp || first.participant_timestamp || 0;
    const firstDelayMs = (firstTs - openNs) / 1e6;
    const firstPrice = first.price;

    const ORDER_SIZE = 200;
    let filled = 0, fillCost = 0;
    for (const t of trades) {
      if (filled >= ORDER_SIZE) break;
      const take = Math.min(t.size || 0, ORDER_SIZE - filled);
      fillCost += take * t.price;
      filled += take;
    }
    const avgFill = filled > 0 ? fillCost / filled : null;
    const slipPct = avgFill ? +(((avgFill - firstPrice) / firstPrice) * 100).toFixed(4) : null;

    const volumeUntil = (msAfterOpen) => {
      const cutoffNs = openNs + msAfterOpen * 1e6;
      let s = 0;
      for (const t of trades) {
        const ts = t.sip_timestamp || t.participant_timestamp || 0;
        if (ts > cutoffNs) break;
        s += (t.size || 0);
      }
      return s;
    };

    return {
      status: 'OK',
      filled,
      slip: slipPct,
      delay: +firstDelayMs.toFixed(0),
      v1: volumeUntil(1000),
      v5: volumeUntil(5000),
      v15: volumeUntil(15000)
    };
  } catch (e) {
    return { status: `ERR` };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  const samplePath = path.join(process.cwd(), 'data', 'tick_sample.json');
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

  if (req.query.meta) return res.status(200).json({ total: sample.length });

  const start = parseInt(req.query.start || '0', 10);
  const count = Math.min(parseInt(req.query.count || '500', 10), 700);
  const slice = sample.slice(start, start + count);
  if (!slice.length) return res.status(200).json({ start, count: 0, results: [] });

  const results = new Array(slice.length);
  let idx = 0;
  const CONC = 24;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= slice.length) return;
      const s = slice[i];
      const r = await analyzeOne({ ticker: s.t, date: s.d }, key);
      // Compact tuple: [ticker, date, cap, scenario, gap, pnl, pmv, spread, status, filled, slip, delay, v1, v5, v15]
      results[i] = [
        s.t, s.d, s.c, s.sc, s.g, s.p, s.pmv, s.s,
        r.status || 'ERR',
        r.filled ?? null,
        r.slip ?? null,
        r.delay ?? null,
        r.v1 ?? null,
        r.v5 ?? null,
        r.v15 ?? null
      ];
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, slice.length) }, () => worker()));

  return res.status(200).json({
    start,
    count: slice.length,
    next_start: start + slice.length,
    total: sample.length,
    results
  });
}
