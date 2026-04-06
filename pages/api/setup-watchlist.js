import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  try {
    const { error } = await supabase.rpc('exec_sql', {
      sql: `
        create table if not exists apex_watchlist (
          id text primary key,
          active jsonb not null default '[]',
          excluded jsonb not null default '[]',
          updated_at timestamptz not null default now()
        );
        insert into apex_watchlist (id, active, excluded)
        values ('default', '[]', '[]')
        on conflict (id) do nothing;
      `
    });
    if (error) {
      // Try direct table creation via REST
      const r2 = await fetch(process.env.SUPABASE_URL + '/rest/v1/apex_watchlist?id=eq.default', {
        headers: {
          'apikey': process.env.SUPABASE_SERVICE_KEY,
          'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
        }
      });
      const existing = await r2.json();
      return res.status(200).json({ status: 'checked', existing, rpcError: error.message });
    }
    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}