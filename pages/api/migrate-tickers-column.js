import { createClient } from '@supabase/supabase-js';

// One-shot migration: adds the `tickers` jsonb column to apex_watchlist if
// it doesn't already exist. Safe to run multiple times.
//
// Usage: POST to /api/migrate-tickers-column
//
// Requires SUPABASE_SERVICE_KEY with DDL privileges.
export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Use GET or POST' });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // Try via exec_sql RPC (may not exist in all projects)
    const { error } = await supabase.rpc('exec_sql', {
      sql: `ALTER TABLE apex_watchlist ADD COLUMN IF NOT EXISTS tickers JSONB NOT NULL DEFAULT '[]'::jsonb;`
    });

    if (error) {
      return res.status(500).json({
        ok: false,
        error: error.message,
        hint: "If exec_sql RPC doesn't exist, run this SQL manually in the Supabase dashboard SQL editor: ALTER TABLE apex_watchlist ADD COLUMN IF NOT EXISTS tickers JSONB NOT NULL DEFAULT '[]'::jsonb;"
      });
    }

    // Verify by selecting the column
    const { data, error: selErr } = await supabase
      .from('apex_watchlist')
      .select('id, tickers')
      .eq('id', 'default')
      .single();

    return res.status(200).json({
      ok: true,
      migrated: true,
      verify: { data, error: selErr?.message || null }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
