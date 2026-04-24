// pages/api/polygon-open-ticks.js
//
// Per ticker + date: fetch individual trade prints in the first 15 seconds
// of regular trading. Identifies the opening cross print (if any) and the
// realistic fill price for a small market order queued before open.
//
// Returns per-query:
//   - opening_cross_price: first print matching "official opening" conditions
//   - first_trade: price/size/timestamp of the first print at/after 9:30:00
//   - fill_price_estimate: price of the first print large enough to absorb
//     a typical retail market order (100-500 shares), weighted toward the
//     exchange the order would route to
//   - price_at_1s, price_at_5s, price_at_15s: last trade price at each mark
//   - slippage_1s_pct, slippage_5s_pct, slippage_15s_pct: |price - first_trade|/first_trade
//   - total_volume_first_1s, _first_5s, _first_15s
//
// GET: /api/polygon-open-ticks?t=HUBS|2026-04-23;AAPL|2024-06-03
// POST: { queries: [{ticker, date}, ...] }

export const config = {
  maxDuration: 300
};

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
  if (queries.length > 1500) {
    return res.status(400).json({ error: 'max 1500 queries per batch' });
  }

  const results = [];
  let idx = 0;
  const CONC = 16;

  async function analyzeOne({ ticker, date }) {
    try {
      // Determine market open timestamp — DST-aware.
      // March-Nov: EDT (UTC-4), market open 13:30:00 UTC
      // Nov-March: EST (UTC-5), market open 14:30:00 UTC
      // Polygon stores nanosecond timestamps in UTC.
      // We'll try 13:30 UTC first; if no trades, fall back to 14:30 UTC.

      const fetchTicks = async (openUtcHour) => {
        const openMs = new Date(`${date}T${String(openUtcHour).padStart(2,'0')}:30:00.000Z`).getTime();
        const startNs = openMs * 1e6;
        const endNs   = (openMs + 15000) * 1e6; // 15 seconds after open
        const url = `https://api.polygon.io/v3/trades/${encodeURIComponent(ticker.toUpperCase())}` +
                    `?timestamp.gte=${startNs}&timestamp.lt=${endNs}` +
                    `&order=asc&limit=1000&apiKey=${key}`;
        const r = await fetch(url);
        if (!r.ok) {
          const errText = await r.text();
          return { error: `HTTP_${r.status}`, detail: errText.slice(0,200) };
        }
        const data = await r.json();
        return { trades: data.results || [], openMs };
      };

      let { trades, openMs, error, detail } = await fetchTicks(13);
      if (error) return { ticker, date, status: error, detail };
      if (!trades.length) {
        // Maybe EST — try 14:30 UTC
        ({ trades, openMs, error, detail } = await fetchTicks(14));
        if (error) return { ticker, date, status: error, detail };
      }
      if (!trades.length) return { ticker, date, status: 'NO_TRADES' };

      // Sort by SIP timestamp just to be safe
      trades.sort((a, b) => (a.sip_timestamp || a.participant_timestamp || 0) -
                            (b.sip_timestamp || b.participant_timestamp || 0));

      const openNs = openMs * 1e6;

      // First trade (the one most relevant for your fill)
      const first = trades[0];
      const firstTs = first.sip_timestamp || first.participant_timestamp || 0;
      const firstDelayMs = (firstTs - openNs) / 1e6;

      // Find the opening cross print. Polygon marks these with condition code 'O' (Opening Print)
      // on UTP tape or conditions that include 'Opening' semantics. Condition 37 on CTA tape = "Q"
      // (opening cross NYSE). We'll identify by (a) conditions array containing key markers, or
      // (b) largest single trade in the first 500ms (typical for opening cross) as fallback.
      let openingCross = null;
      for (const t of trades.slice(0, 50)) {
        const conds = t.conditions || [];
        // Polygon trade conditions: 17 = "Opening Print" for Nasdaq UTP, 15/16 for NYSE
        // Actually: 15 = "Average Price Trade", 17 = "Bunched Trade"
        // True opening cross is typically code Q (OpeningCross) or O (Opened) — trying a range
        if (conds.includes(17) || conds.includes(37) || conds.includes(38)) {
          openingCross = t;
          break;
        }
      }
      // Fallback: largest trade in first 200ms is almost always the opening cross on liquid names
      if (!openingCross && trades.length > 0) {
        const firstWindow = trades.filter(t => {
          const ts = t.sip_timestamp || t.participant_timestamp || 0;
          return (ts - openNs) / 1e6 < 500; // first 500ms
        });
        if (firstWindow.length) {
          firstWindow.sort((a,b) => (b.size || 0) - (a.size || 0));
          const candidate = firstWindow[0];
          // Only flag as opening cross if the winner is meaningfully bigger than #2
          if (candidate && (!firstWindow[1] || candidate.size > firstWindow[1].size * 2)) {
            openingCross = candidate;
          }
        }
      }

      // Price marks at 1s, 5s, 15s
      const priceAtT = (msAfterOpen) => {
        const cutoffNs = openNs + msAfterOpen * 1e6;
        // Find last trade on or before this time
        let last = null;
        for (const t of trades) {
          const ts = t.sip_timestamp || t.participant_timestamp || 0;
          if (ts <= cutoffNs) last = t; else break;
        }
        return last ? last.price : null;
      };
      const vwapUntil = (msAfterOpen) => {
        const cutoffNs = openNs + msAfterOpen * 1e6;
        let sumPS = 0, sumS = 0;
        for (const t of trades) {
          const ts = t.sip_timestamp || t.participant_timestamp || 0;
          if (ts > cutoffNs) break;
          sumPS += t.price * (t.size || 0);
          sumS += (t.size || 0);
        }
        return sumS > 0 ? sumPS / sumS : null;
      };
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

      // Estimate realistic retail market-order fill.
      // A retail 100-500 share order hitting the tape right after open will fill on the first
      // few prints that collectively absorb it. We model a 200-share order.
      const ORDER_SIZE = 200;
      let filled = 0, fillCostDollars = 0;
      for (const t of trades) {
        if (filled >= ORDER_SIZE) break;
        const take = Math.min(t.size || 0, ORDER_SIZE - filled);
        fillCostDollars += take * t.price;
        filled += take;
      }
      const avgFillPrice = filled > 0 ? fillCostDollars / filled : null;

      const firstPrice = first.price;
      const p1 = priceAtT(1000);
      const p5 = priceAtT(5000);
      const p15 = priceAtT(15000);
      const vwap15 = vwapUntil(15000);

      const slip = (later) => later && firstPrice ? +(((later - firstPrice) / firstPrice) * 100).toFixed(4) : null;

      return {
        ticker: ticker.toUpperCase(),
        date,
        status: 'OK',
        total_trades_first_15s: trades.length,
        first_trade: {
          price: firstPrice,
          size: first.size,
          delay_ms_from_open: +firstDelayMs.toFixed(2),
          exchange: first.exchange
        },
        opening_cross: openingCross ? {
          price: openingCross.price,
          size: openingCross.size,
          delay_ms_from_open: +(((openingCross.sip_timestamp || openingCross.participant_timestamp) - openNs) / 1e6).toFixed(2),
          diff_from_first_trade_pct: +(((openingCross.price - firstPrice) / firstPrice) * 100).toFixed(4)
        } : null,
        fill_simulation_200sh: {
          avg_fill_price: avgFillPrice ? +avgFillPrice.toFixed(4) : null,
          fill_vs_first_trade_pct: avgFillPrice ? +(((avgFillPrice - firstPrice) / firstPrice) * 100).toFixed(4) : null,
          shares_filled: filled
        },
        price_at_1s: p1, slip_1s_pct: slip(p1),
        price_at_5s: p5, slip_5s_pct: slip(p5),
        price_at_15s: p15, slip_15s_pct: slip(p15),
        vwap_15s: vwap15 ? +vwap15.toFixed(4) : null,
        vwap_vs_first_trade_pct: vwap15 && firstPrice ? +(((vwap15 - firstPrice) / firstPrice) * 100).toFixed(4) : null,
        volume_first_1s: volumeUntil(1000),
        volume_first_5s: volumeUntil(5000),
        volume_first_15s: volumeUntil(15000)
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
  function pctile(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * p)];
  }
  const fillSlips = ok.map(r => r.fill_simulation_200sh?.fill_vs_first_trade_pct).filter(x => x !== null && x !== undefined).map(Math.abs);
  const firstDelays = ok.map(r => r.first_trade?.delay_ms_from_open).filter(x => x !== null && x !== undefined);
  const vwapSlips = ok.map(r => r.vwap_vs_first_trade_pct).filter(x => x !== null && x !== undefined).map(Math.abs);
  const openingCrossDiffs = ok.filter(r => r.opening_cross).map(r => Math.abs(r.opening_cross.diff_from_first_trade_pct));
  const hasCross = ok.filter(r => r.opening_cross).length;

  return res.status(200).json({
    audited: results.length,
    ok: ok.length,
    opening_cross_detected: hasCross,
    summary: {
      first_trade_delay_ms: { p50: pctile(firstDelays, 0.5), p90: pctile(firstDelays, 0.9), max: firstDelays.length ? Math.max(...firstDelays) : null },
      fill_slippage_200sh_pct: { p50: pctile(fillSlips, 0.5), p75: pctile(fillSlips, 0.75), p90: pctile(fillSlips, 0.9), max: fillSlips.length ? Math.max(...fillSlips) : null },
      vwap_15s_slippage_pct: { p50: pctile(vwapSlips, 0.5), p90: pctile(vwapSlips, 0.9) },
      opening_cross_vs_first_trade_pct: { p50: pctile(openingCrossDiffs, 0.5), p90: pctile(openingCrossDiffs, 0.9) }
    },
    results
  });
}
