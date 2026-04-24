// pages/api/tick-batch.js
//
// Runs tick analysis on the committed sample file (data/tick_sample.json)
// in paginated batches. Store progress in module-level cache between calls.
//
// GET /api/tick-batch?start=0&count=100  -> processes 100 signals starting at index 0
//                                            returns full per-signal data + summary
// GET /api/tick-batch?meta=1             -> returns sample size + last processed info

import fs from 'fs';
import path from 'path';

export const config = {
  maxDuration: 300
};

// Helper: fetch ticks for one query (copied from polygon-open-ticks for self-contained behavior)
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
    if (error) return { ticker, date, status: error };
    if (!trades.length) {
      ({ trades, openMs, error } = await fetchTicks(14));
      if (error) return { ticker, date, status: error };
    }
    if (!trades.length) return { ticker, date, status: 'NO_TRADES' };

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
      ticker: ticker.toUpperCase(),
      date,
      status: 'OK',
      total_trades: trades.length,
      first_trade_price: firstPrice,
      first_trade_size: first.size,
      first_delay_ms: +firstDelayMs.toFixed(1),
      fill_price: avgFill ? +avgFill.toFixed(4) : null,
      fill_slippage_pct: avgFill ? +(((avgFill - firstPrice) / firstPrice) * 100).toFixed(4) : null,
      shares_filled: filled,
      vol_1s: volumeUntil(1000),
      vol_5s: volumeUntil(5000),
      vol_15s: volumeUntil(15000)
    };
  } catch (e) {
    return { ticker, date, status: `ERR_${e.message}` };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  // Load sample
  const samplePath = path.join(process.cwd(), 'data', 'tick_sample.json');
  if (!fs.existsSync(samplePath)) {
    return res.status(500).json({ error: 'sample file not found at ' + samplePath });
  }
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

  if (req.query.meta) {
    return res.status(200).json({ total: sample.length });
  }

  const start = parseInt(req.query.start || '0', 10);
  const count = Math.min(parseInt(req.query.count || '100', 10), 250);
  const slice = sample.slice(start, start + count);
  if (!slice.length) return res.status(200).json({ start, count: 0, results: [] });

  const queries = slice.map(r => ({ ticker: r.t, date: r.d }));
  const results = new Array(queries.length);
  let idx = 0;
  const CONC = 16;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= queries.length) return;
      const r = await analyzeOne(queries[i], key);
      // Attach cap and spread from the sample for joining later
      results[i] = { ...r, cap: slice[i].c, spread_pct: slice[i].s };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, queries.length) }, () => worker()));

  return res.status(200).json({
    start,
    count: queries.length,
    next_start: start + queries.length,
    total: sample.length,
    results
  });
}
