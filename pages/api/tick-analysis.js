// pages/api/tick-analysis.js
//
// Runs tick analysis on all 1094 sampled signals and computes derived statistics
// including fill-quality distribution by vol_1s buckets to derive a real
// liquidity threshold from data (not guesses).

import fs from 'fs';
import path from 'path';

export const config = {
  maxDuration: 300
};

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
    if (error) return null;
    if (!trades.length) {
      ({ trades, openMs, error } = await fetchTicks(14));
      if (error) return null;
    }
    if (!trades.length) return null;
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
    const slipPct = avgFill ? ((avgFill - firstPrice) / firstPrice) * 100 : null;

    const volUntil = (ms) => {
      const cut = openNs + ms * 1e6;
      let s = 0;
      for (const t of trades) {
        const ts = t.sip_timestamp || t.participant_timestamp || 0;
        if (ts > cut) break;
        s += (t.size || 0);
      }
      return s;
    };
    return {
      delay_ms: firstDelayMs,
      slip_pct: slipPct,
      shares_filled: filled,
      vol_1s: volUntil(1000),
      vol_5s: volUntil(5000),
      vol_15s: volUntil(15000)
    };
  } catch (e) {
    return null;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  const samplePath = path.join(process.cwd(), 'data', 'tick_sample.json');
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

  // Process all signals concurrently
  const CONC = 20;
  const results = new Array(sample.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= sample.length) return;
      const r = await analyzeOne({ ticker: sample[i].t, date: sample[i].d }, key);
      if (r) {
        results[i] = { ...r, cap: sample[i].c, spread: sample[i].s };
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  const valid = results.filter(r => r && r.shares_filled !== undefined);

  // ----- Analysis -----
  // 1. Partial fill rate (filled < 200)
  const partials = valid.filter(r => r.shares_filled < 200);
  const fills = valid.filter(r => r.shares_filled >= 200);

  // 2. vol_1s distribution for partial vs full
  const vol1Partial = partials.map(r => r.vol_1s).sort((a, b) => a - b);
  const vol1Full = fills.map(r => r.vol_1s).sort((a, b) => a - b);

  // 3. vol_5s distribution
  const vol5Partial = partials.map(r => r.vol_5s).sort((a, b) => a - b);
  const vol5Full = fills.map(r => r.vol_5s).sort((a, b) => a - b);

  // 4. Derive threshold: find vol_1s and vol_5s values that best separate
  // partial from full fills
  const candidateThresholds = [100, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000];
  const thresholdAnalysis = {};
  for (const vol1T of candidateThresholds) {
    const blocked = valid.filter(r => r.vol_1s < vol1T);
    const allowed = valid.filter(r => r.vol_1s >= vol1T);
    thresholdAnalysis[`vol_1s_lt_${vol1T}`] = {
      blocked_signals: blocked.length,
      blocked_pct: ((blocked.length / valid.length) * 100).toFixed(1),
      blocked_partial_rate: blocked.length > 0 ?
        ((blocked.filter(r => r.shares_filled < 200).length / blocked.length) * 100).toFixed(1) : null,
      allowed_signals: allowed.length,
      allowed_partial_rate: allowed.length > 0 ?
        ((allowed.filter(r => r.shares_filled < 200).length / allowed.length) * 100).toFixed(1) : null
    };
  }

  // Same for vol_5s
  const thresholdAnalysis5s = {};
  for (const vol5T of candidateThresholds) {
    const blocked = valid.filter(r => r.vol_5s < vol5T);
    const allowed = valid.filter(r => r.vol_5s >= vol5T);
    thresholdAnalysis5s[`vol_5s_lt_${vol5T}`] = {
      blocked_signals: blocked.length,
      blocked_pct: ((blocked.length / valid.length) * 100).toFixed(1),
      blocked_partial_rate: blocked.length > 0 ?
        ((blocked.filter(r => r.shares_filled < 200).length / blocked.length) * 100).toFixed(1) : null,
      allowed_signals: allowed.length,
      allowed_partial_rate: allowed.length > 0 ?
        ((allowed.filter(r => r.shares_filled < 200).length / allowed.length) * 100).toFixed(1) : null
    };
  }

  // By cap subset
  const byCap = {};
  for (const cap of ['Large', 'Mid']) {
    const capResults = valid.filter(r => r.cap === cap);
    const capPartials = capResults.filter(r => r.shares_filled < 200);
    const capFills = capResults.filter(r => r.shares_filled >= 200);
    const slips = capFills.map(r => Math.abs(r.slip_pct || 0)).sort((a, b) => a - b);
    byCap[cap] = {
      n: capResults.length,
      partial_rate_pct: ((capPartials.length / capResults.length) * 100).toFixed(1),
      slip_median: percentile(slips, 0.5)?.toFixed(3),
      slip_p75: percentile(slips, 0.75)?.toFixed(3),
      slip_p90: percentile(slips, 0.9)?.toFixed(3),
      slip_p95: percentile(slips, 0.95)?.toFixed(3),
      slip_max: slips[slips.length - 1]?.toFixed(3)
    };
  }

  // Overall slippage distribution (full fills only)
  const allSlips = fills.map(r => Math.abs(r.slip_pct || 0)).sort((a, b) => a - b);

  return res.status(200).json({
    total_sample: sample.length,
    valid_results: valid.length,
    full_fills: fills.length,
    partial_fills: partials.length,
    partial_rate_pct: ((partials.length / valid.length) * 100).toFixed(1),
    slippage_overall: {
      p50: percentile(allSlips, 0.5)?.toFixed(3),
      p75: percentile(allSlips, 0.75)?.toFixed(3),
      p90: percentile(allSlips, 0.9)?.toFixed(3),
      p95: percentile(allSlips, 0.95)?.toFixed(3),
      max: allSlips[allSlips.length - 1]?.toFixed(3)
    },
    by_cap: byCap,
    vol_1s_distribution: {
      partial_fills: {
        n: vol1Partial.length,
        p10: percentile(vol1Partial, 0.1),
        p25: percentile(vol1Partial, 0.25),
        p50: percentile(vol1Partial, 0.5),
        p75: percentile(vol1Partial, 0.75),
        p90: percentile(vol1Partial, 0.9),
        max: vol1Partial[vol1Partial.length - 1]
      },
      full_fills: {
        n: vol1Full.length,
        p10: percentile(vol1Full, 0.1),
        p25: percentile(vol1Full, 0.25),
        p50: percentile(vol1Full, 0.5),
        p75: percentile(vol1Full, 0.75),
        p90: percentile(vol1Full, 0.9)
      }
    },
    vol_5s_distribution: {
      partial_fills: {
        n: vol5Partial.length,
        p10: percentile(vol5Partial, 0.1),
        p25: percentile(vol5Partial, 0.25),
        p50: percentile(vol5Partial, 0.5),
        p75: percentile(vol5Partial, 0.75),
        p90: percentile(vol5Partial, 0.9),
        max: vol5Partial[vol5Partial.length - 1]
      },
      full_fills: {
        n: vol5Full.length,
        p10: percentile(vol5Full, 0.1),
        p25: percentile(vol5Full, 0.25),
        p50: percentile(vol5Full, 0.5),
        p75: percentile(vol5Full, 0.75),
        p90: percentile(vol5Full, 0.9)
      }
    },
    threshold_analysis_vol_1s: thresholdAnalysis,
    threshold_analysis_vol_5s: thresholdAnalysis5s
  });
}
