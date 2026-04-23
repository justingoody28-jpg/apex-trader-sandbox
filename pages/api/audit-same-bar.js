// pages/api/audit-same-bar.js
//
// Batch endpoint: for a list of historical trades, pulls minute bars
// and checks whether the exit bar had both target and stop levels within
// its range (indicating same-bar ambiguity).
//
// Usage: POST with JSON body { trades: [{ticker, date, entry, min, wp, sp}, ...] }
//   wp = win target % (default 2), sp = stop % (default 2)
// Returns: { audited, clean, ambiguous, results: [...] }
//
// Scenario F is LONG with wp=2, sp=2 (defaults).

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY env not set' });

  let trades = null;
  if (req.method === 'GET') {
    // Compact format: ?t=TICKER|YYYY-MM-DD|entry|min;TICKER|...
    const tParam = req.query.t;
    if (!tParam) return res.status(400).json({ error: 'query param t required, format TICKER|YYYY-MM-DD|entry|min;...' });
    const wp = parseFloat(req.query.wp || '2');
    const sp = parseFloat(req.query.sp || '2');
    trades = tParam.split(';').filter(Boolean).map(s => {
      const [ticker, date, entry, min] = s.split('|');
      return { ticker, date, entry: parseFloat(entry), min: parseInt(min, 10), wp, sp };
    });
  } else if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    trades = body?.trades;
  } else {
    return res.status(405).json({ error: 'GET or POST only' });
  }

  if (!Array.isArray(trades) || !trades.length) {
    return res.status(400).json({ error: 'trades required (array in body or t query param)' });
  }

  const results = [];
  // Process sequentially but with small concurrency (4 in flight)
  const CONC = 4;
  let idx = 0;

  async function auditOne(t) {
    const { ticker, date, entry, min } = t;
    const wp = t.wp ?? 2;
    const sp = t.sp ?? 2;
    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker.toUpperCase())}` +
                  `/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
      const r = await fetch(url);
      if (!r.ok) return { ...t, status: `HTTP_${r.status}` };
      const data = await r.json();
      const bars = data.results || [];
      if (!bars.length) return { ...t, status: 'NO_BARS' };

      // Filter to market hours (9:30 ET onward).
      // EDT (Mar-Nov): 13:30 UTC | EST (Nov-Mar): 14:30 UTC
      // Build a generic filter: first bar at or after 13:30 UTC on the date.
      // For simplicity, find first bar >= 13:30 UTC on that date.
      const openBars = bars.filter(b => {
        const d = new Date(b.t);
        const hm = d.getUTCHours() * 60 + d.getUTCMinutes();
        return hm >= 13 * 60 + 30 && hm < 20 * 60;
      });
      if (!openBars.length) return { ...t, status: 'NO_MARKET_BARS' };

      // Exit bar is at index (min - 1) in 1-indexed min
      const exitIdx = min - 1;
      if (exitIdx >= openBars.length) return { ...t, status: 'EXIT_BAR_OOB', avail: openBars.length };

      const exitBar = openBars[exitIdx];
      const target = entry * (1 + wp / 100);
      const stop = entry * (1 - sp / 100);
      const hitTarget = exitBar.h >= target;
      const hitStop = exitBar.l <= stop;
      const ambiguous = hitTarget && hitStop;
      const breachPct = ambiguous ? +(((stop - exitBar.l) / entry) * 100).toFixed(3) : null;

      return {
        ticker, date, entry, min,
        target: +target.toFixed(4),
        stop: +stop.toFixed(4),
        bar_o: exitBar.o,
        bar_h: exitBar.h,
        bar_l: exitBar.l,
        bar_c: exitBar.c,
        hit_target: hitTarget,
        hit_stop: hitStop,
        ambiguous,
        breach_pct: breachPct,
        status: 'OK'
      };
    } catch (e) {
      return { ...t, status: `ERR_${e.message}` };
    }
  }

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= trades.length) return;
      const r = await auditOne(trades[i]);
      results[i] = r;
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONC, trades.length) }, () => worker()));

  const ok = results.filter(r => r.status === 'OK');
  const amb = ok.filter(r => r.ambiguous);
  const cleanWin = ok.filter(r => r.hit_target && !r.hit_stop);
  const noHit = ok.filter(r => !r.hit_target && !r.hit_stop);
  const breaches = amb.filter(r => r.breach_pct != null).map(r => r.breach_pct);
  const avgBreach = breaches.length ? breaches.reduce((a, b) => a + b, 0) / breaches.length : null;
  const maxBreach = breaches.length ? Math.max(...breaches) : null;

  return res.status(200).json({
    audited: results.length,
    ok: ok.length,
    ambiguous: amb.length,
    clean_wins: cleanWin.length,
    no_hit: noHit.length,
    errors: results.length - ok.length,
    ambiguity_rate: ok.length ? +(amb.length / ok.length * 100).toFixed(2) : null,
    avg_breach_pct: avgBreach != null ? +avgBreach.toFixed(3) : null,
    max_breach_pct: maxBreach,
    results
  });
}
