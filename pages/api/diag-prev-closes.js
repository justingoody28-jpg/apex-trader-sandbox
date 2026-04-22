// pages/api/diag-prev-closes.js
//
// Read-only diagnostic for apex_prev_closes. No writes, no trading impact.
//
// Usage:
//   GET /api/diag-prev-closes                    -> summary: counts by as_of_date (last 30 dates)
//   GET /api/diag-prev-closes?symbol=MHO         -> last 10 rows for one symbol
//   GET /api/diag-prev-closes?date=2026-04-21    -> all rows on one date
//   GET /api/diag-prev-closes?freshness=1        -> is the latest fetch recent enough to trade on?
//
// The ?freshness=1 check is meant for pre-market verification. Call it at 7 AM ET before
// the morning cron fires to confirm data is ready.

export default async function handler(req, res) {
  // CORS: allow browser-origin requests (read-only diag endpoint).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase env vars not set' });

  const H = { apikey: sbKey, Authorization: 'Bearer ' + sbKey };
  const { symbol, date, freshness } = req.query;

  try {
    // ── Mode: freshness check ───────────────────────────────────────────────
    if (freshness) {
      const r = await fetch(
        `${sbUrl}/rest/v1/apex_prev_closes?select=as_of_date,fetched_at&order=as_of_date.desc&limit=1`,
        { headers: H }
      );
      const data = await r.json();
      if (!data.length) {
        return res.status(200).json({ status: 'empty', message: 'apex_prev_closes has no rows' });
      }
      const latest = data[0];
      const latestDate = new Date(latest.as_of_date);
      const now = new Date();
      const daysOld = Math.floor((now - latestDate) / (1000 * 60 * 60 * 24));
      return res.status(200).json({
        status: daysOld <= 4 ? 'fresh' : 'stale',
        latestAsOfDate: latest.as_of_date,
        fetchedAt: latest.fetched_at,
        daysOld,
        acceptableIfUnderDays: 4,
        recommendation: daysOld <= 4
          ? 'OK to use for today\'s cron'
          : 'Stale — evening fetch may have failed; investigate before trading',
      });
    }

    // ── Mode: single symbol history ─────────────────────────────────────────
    if (symbol) {
      const sym = String(symbol).toUpperCase();
      const r = await fetch(
        `${sbUrl}/rest/v1/apex_prev_closes?symbol=eq.${encodeURIComponent(sym)}&order=as_of_date.desc&limit=10`,
        { headers: H }
      );
      const data = await r.json();
      return res.status(200).json({ symbol: sym, rows: data });
    }

    // ── Mode: single date snapshot ──────────────────────────────────────────
    if (date) {
      const r = await fetch(
        `${sbUrl}/rest/v1/apex_prev_closes?as_of_date=eq.${encodeURIComponent(date)}&order=symbol.asc`,
        { headers: H }
      );
      const data = await r.json();
      return res.status(200).json({
        as_of_date: date,
        count: data.length,
        rows: data,
      });
    }

    // ── Mode: default summary (counts by date) ──────────────────────────────
    const r = await fetch(
      `${sbUrl}/rest/v1/apex_prev_closes?select=as_of_date&order=as_of_date.desc&limit=10000`,
      { headers: H }
    );
    const data = await r.json();
    const byDate = {};
    for (const row of data) {
      byDate[row.as_of_date] = (byDate[row.as_of_date] || 0) + 1;
    }
    const sorted = Object.entries(byDate)
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 30)
      .map(([d, c]) => ({ as_of_date: d, symbol_count: c }));

    return res.status(200).json({
      totalRows: data.length,
      uniqueDates: Object.keys(byDate).length,
      latestDate: sorted[0]?.as_of_date || null,
      latestCount: sorted[0]?.symbol_count || 0,
      summary_last_30_dates: sorted,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
