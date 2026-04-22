// pages/api/fetch-prev-closes.js
//
// Evening job — fetch today's regular-session close for watchlist tickers from
// Polygon's grouped endpoint and store in apex_prev_closes so the morning cron
// can read prev_close from Supabase instead of relying on Tradier's quote field.
//
// Trigger: Vercel cron at 23:00 UTC Mon-Fri (6 PM EST / 7 PM EDT).
//   vercel.json entry: { "path": "/api/fetch-prev-closes", "schedule": "0 23 * * 1-5" }
//
// Manual re-run / backfill:
//   GET /api/fetch-prev-closes              -> fetches today's close (US/Eastern)
//   GET /api/fetch-prev-closes?date=2026-04-21  -> backfill a specific date
//
// Safety: read-only from Polygon, upsert to Supabase. No trading actions.
// Idempotent: re-running for the same date is a no-op on the data.

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function fetchWithRetry(url, opts, attempts = MAX_RETRIES) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r;
      lastErr = new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      // Don't retry client errors (4xx) — only transient failures
      if (r.status >= 400 && r.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (i + 1)));
  }
  throw lastErr;
}

function todayInET() {
  const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = nowET.getFullYear();
  const m = String(nowET.getMonth() + 1).padStart(2, '0');
  const d = String(nowET.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default async function handler(req, res) {
  const POLYGON_KEY = process.env.POLYGON_KEY;
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;

  if (!POLYGON_KEY) return res.status(500).json({ error: 'POLYGON_KEY not set' });
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase env vars not set' });

  // Optional auth — if CRON_SECRET is set, require it to be provided.
  // Vercel cron includes an Authorization header automatically on scheduled runs.
  if (process.env.CRON_SECRET) {
    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.query.secret;
    if (provided !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const targetDate = req.query.date || todayInET();
  const runStarted = new Date().toISOString();

  // ── 1. Fetch Polygon grouped bars (all US stocks for the date, adjusted) ─
  // adjusted=true matches the backtest methodology. Critical for splits/dividends.
  let polygonData;
  try {
    const url = `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${targetDate}?adjusted=true&apiKey=${POLYGON_KEY}`;
    const r = await fetchWithRetry(url);
    polygonData = await r.json();
  } catch (e) {
    return res.status(502).json({
      status: 'error',
      stage: 'polygon_fetch',
      error: e.message,
      targetDate,
      runStarted,
    });
  }

  const results = polygonData.results || [];
  if (!results.length) {
    // Could be a weekend/holiday, or Polygon data not yet available
    return res.status(200).json({
      status: 'no_data',
      targetDate,
      message: 'Polygon returned 0 results. Likely a non-trading day, or data not yet published.',
      runStarted,
    });
  }

  // ── 2. Load watchlist to scope the upsert ────────────────────────────────
  let watchlistSymbols;
  try {
    const wlRes = await fetchWithRetry(
      `${sbUrl}/rest/v1/apex_watchlist?select=active&id=eq.default`,
      { headers: { apikey: sbKey, Authorization: 'Bearer ' + sbKey } }
    );
    const wlData = await wlRes.json();
    watchlistSymbols = new Set((wlData[0]?.active || []).map(s => String(s).toUpperCase()));
  } catch (e) {
    return res.status(502).json({
      status: 'error',
      stage: 'supabase_watchlist_fetch',
      error: e.message,
      targetDate,
    });
  }

  if (!watchlistSymbols.size) {
    return res.status(200).json({
      status: 'error',
      stage: 'watchlist_empty',
      message: 'apex_watchlist.active is empty — nothing to fetch prev_close for',
      targetDate,
    });
  }

  // Always include SPY — auto-trade-c.js uses it for the SPY-gap filter on Scenario D
  watchlistSymbols.add('SPY');

  // ── 3. Filter Polygon results to watchlist-only ──────────────────────────
  const rows = [];
  const seen = new Set();
  for (const r of results) {
    const sym = String(r.T || '').toUpperCase();
    if (!sym || !watchlistSymbols.has(sym)) continue;
    if (seen.has(sym)) continue; // dedupe (shouldn't happen, but safe)
    if (typeof r.c !== 'number' || r.c <= 0) continue;
    seen.add(sym);
    rows.push({
      symbol: sym,
      close: r.c,
      as_of_date: targetDate,
      source: 'polygon_grouped',
    });
  }

  const fetched = new Set(rows.map(r => r.symbol));
  const missing = [...watchlistSymbols].filter(s => !fetched.has(s));

  if (!rows.length) {
    return res.status(200).json({
      status: 'error',
      stage: 'no_watchlist_matches',
      message: 'Polygon returned data but none matched the watchlist',
      targetDate,
      polygonResultsTotal: results.length,
      watchlistSize: watchlistSymbols.size,
    });
  }

  // ── 4. Upsert to apex_prev_closes (on_conflict (symbol, as_of_date)) ────
  try {
    const upsertRes = await fetchWithRetry(
      `${sbUrl}/rest/v1/apex_prev_closes?on_conflict=symbol,as_of_date`,
      {
        method: 'POST',
        headers: {
          apikey: sbKey,
          Authorization: 'Bearer ' + sbKey,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(rows),
      }
    );
    // Supabase returns 201 with empty body on success when Prefer: return=minimal
    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      return res.status(502).json({
        status: 'error',
        stage: 'supabase_upsert',
        error: `${upsertRes.status}: ${errText.slice(0, 300)}`,
        targetDate,
        attempted: rows.length,
      });
    }
  } catch (e) {
    return res.status(502).json({
      status: 'error',
      stage: 'supabase_upsert',
      error: e.message,
      targetDate,
      attempted: rows.length,
    });
  }

  // ── 5. Success summary ───────────────────────────────────────────────────
  return res.status(200).json({
    status: 'success',
    targetDate,
    polygonResultsTotal: results.length,
    watchlistSize: watchlistSymbols.size,
    storedCount: rows.length,
    missingFromPolygon: missing,
    missingCount: missing.length,
    runStarted,
    runCompleted: new Date().toISOString(),
    // Sample first 3 rows for spot-check
    sample: rows.slice(0, 3),
  });
}
