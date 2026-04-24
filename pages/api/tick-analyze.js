// pages/api/tick-analyze.js
//
// Processes the full sample and returns ONLY aggregated stats by spread bucket,
// pmv bucket, cap+scenario, and the list of "problem" signals (slip>1% OR partial).
// Response stays under ~100KB regardless of sample size.
//
// GET /api/tick-analyze?start=0&count=500  -> process this chunk, return aggregates
// Combine multiple chunks client-side by summing counts.

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
    const slipPct = avgFill ? ((avgFill - firstPrice) / firstPrice) * 100 : null;

    return { status: 'OK', filled, slip: slipPct };
  } catch (e) {
    return { status: 'ERR' };
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
  if (!slice.length) return res.status(200).json({ start, count: 0, empty: true });

  // Analyze
  const recs = new Array(slice.length);
  let idx = 0;
  const CONC = 24;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= slice.length) return;
      const r = await analyzeOne({ ticker: slice[i].t, date: slice[i].d }, key);
      recs[i] = { ...r, sample: slice[i] };
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, slice.length) }, () => worker()));

  // Aggregate
  function bucket(v, edges) {
    for (let i = 0; i < edges.length; i++) if (v < edges[i]) return i;
    return edges.length;
  }
  const spreadEdges = [1, 2, 3, 5, 10];      // buckets: <1, 1-2, 2-3, 3-5, 5-10, 10+
  const pmvEdges    = [500, 1000, 5000, 10000, 100000, 1000000];  // <500, 500-1k, 1k-5k, 5k-10k, 10k-100k, 100k-1M, 1M+

  // Aggregation: by (cap, scenario, spreadBucket)
  const agg = {};
  const problems = []; // only top problems

  let ok = 0, err = 0;

  for (const r of recs) {
    if (r.status !== 'OK') { err++; continue; }
    ok++;

    const s = r.sample;
    const cap = s.c || '?';
    const scen = s.sc || '?';
    const spread = +s.s;
    const pmv = +s.pmv || 0;
    const pnl = s.p;
    const gap = s.g;

    const sb = bucket(spread, spreadEdges);
    const pb = bucket(pmv, pmvEdges);
    const partial = r.filled < 200;
    const hiSlip = !partial && Math.abs(r.slip) > 1.0;
    const midSlip = !partial && Math.abs(r.slip) > 0.5;

    // Keyed aggregation
    const key1 = `${cap}|${scen}|s${sb}`;
    if (!agg[key1]) agg[key1] = { n: 0, partial: 0, hiSlip: 0, midSlip: 0, totalAbsSlip: 0, pnlSum: 0, pnlN: 0 };
    agg[key1].n++;
    if (partial) agg[key1].partial++;
    if (hiSlip) agg[key1].hiSlip++;
    if (midSlip) agg[key1].midSlip++;
    agg[key1].totalAbsSlip += Math.abs(r.slip || 0);
    if (pnl !== null && pnl !== undefined) { agg[key1].pnlSum += pnl; agg[key1].pnlN++; }

    // Pmv bucket too
    const key2 = `${cap}|${scen}|p${pb}`;
    if (!agg[key2]) agg[key2] = { n: 0, partial: 0, hiSlip: 0, midSlip: 0, totalAbsSlip: 0, pnlSum: 0, pnlN: 0 };
    agg[key2].n++;
    if (partial) agg[key2].partial++;
    if (hiSlip) agg[key2].hiSlip++;
    if (midSlip) agg[key2].midSlip++;
    agg[key2].totalAbsSlip += Math.abs(r.slip || 0);
    if (pnl !== null && pnl !== undefined) { agg[key2].pnlSum += pnl; agg[key2].pnlN++; }

    // Total
    const keyT = 'TOTAL';
    if (!agg[keyT]) agg[keyT] = { n: 0, partial: 0, hiSlip: 0, midSlip: 0, totalAbsSlip: 0, pnlSum: 0, pnlN: 0 };
    agg[keyT].n++;
    if (partial) agg[keyT].partial++;
    if (hiSlip) agg[keyT].hiSlip++;
    if (midSlip) agg[keyT].midSlip++;
    agg[keyT].totalAbsSlip += Math.abs(r.slip || 0);
    if (pnl !== null && pnl !== undefined) { agg[keyT].pnlSum += pnl; agg[keyT].pnlN++; }

    // Record problems only
    if (partial || hiSlip) {
      problems.push({
        t: s.t, d: s.d, c: cap, sc: scen, g: gap, p: pnl,
        sp: +spread.toFixed(2), pmv,
        fi: r.filled, sl: +r.slip.toFixed(3)
      });
    }
  }

  return res.status(200).json({
    start,
    count: recs.length,
    next_start: start + recs.length,
    total: sample.length,
    ok, err,
    agg,
    problems  // only 1-10% of records so this is small
  });
}
