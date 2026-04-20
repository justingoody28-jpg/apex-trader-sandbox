import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('apex_watchlist')
      .select('*')
      .eq('id', 'default')
      .single();
    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ error: error.message });
    }
    // Always return a tickers field even if the column doesn't exist yet.
    return res.status(200).json(
      data
        ? { ...data, tickers: Array.isArray(data.tickers) ? data.tickers : [] }
        : { id: 'default', active: [], excluded: [], tickers: [] }
    );
  }

  if (req.method === 'POST') {
    const { active, excluded, tickers } = req.body;
    // v4 fix (2026-04-20): persist `tickers` [{t,g},...] so cap-tier labels
    // set via batch upload survive page refresh. Backward-compatible:
    // if `tickers` column doesn't exist, retry without it.
    const payload = {
      id: 'default',
      active: active || [],
      excluded: excluded || [],
      updated_at: new Date().toISOString(),
    };
    if (Array.isArray(tickers)) payload.tickers = tickers;

    let { data, error } = await supabase
      .from('apex_watchlist')
      .upsert(payload)
      .select()
      .single();

    if (error && /column.*tickers.*does not exist|PGRST204/i.test(error.message || error.code || '')) {
      delete payload.tickers;
      const retry = await supabase
        .from('apex_watchlist')
        .upsert(payload)
        .select()
        .single();
      data = retry.data;
      error = retry.error;
    }

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, saved: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
