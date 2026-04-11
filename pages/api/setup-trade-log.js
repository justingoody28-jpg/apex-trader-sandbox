// pages/api/setup-trade-log.js — ONE TIME setup, creates apex_trade_log table
export default async function handler(req, res) {
  if (req.query.key !== 'APEX_SETUP_2026') return res.status(403).json({ error: 'Forbidden' });

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const H = { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' };

  // Use Supabase's pg/sql endpoint (available on all projects)
  const sql = `
    CREATE TABLE IF NOT EXISTS apex_trade_log (
      id            bigserial PRIMARY KEY,
      run_at        timestamptz NOT NULL DEFAULT now(),
      trigger_type  text NOT NULL,
      live          boolean NOT NULL,
      symbol        text NOT NULL,
      scenario      text,
      status        text NOT NULL,
      gap           numeric,
      price         numeric,
      qty           integer,
      tp            numeric,
      sl            numeric,
      bet           numeric,
      order_id      text,
      reason        text
    );
    CREATE INDEX IF NOT EXISTS apex_trade_log_run_at_idx ON apex_trade_log (run_at DESC);
    CREATE INDEX IF NOT EXISTS apex_trade_log_symbol_idx ON apex_trade_log (symbol);
  `;

  // Try inserting into the table — if it doesn't exist, create it first
  // Test if table exists by selecting
  const testR = await fetch(`${sbUrl}/rest/v1/apex_trade_log?limit=1`, { headers: H });

  if (testR.status === 404 || testR.status === 400) {
    // Table doesn't exist — use Supabase management API
    const projectRef = sbUrl.replace('https://', '').replace('.supabase.co', '');
    const mgmtR = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql })
    });
    const mgmtD = await mgmtR.json();
    return res.status(200).json({ method: 'management_api', status: mgmtR.status, result: mgmtD });
  }

  return res.status(200).json({ method: 'none_needed', tableExists: true, testStatus: testR.status });
}
