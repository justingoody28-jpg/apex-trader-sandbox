import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
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
    return res.status(200).json(data || { id: 'default', active: [], excluded: [] });
  }

  if (req.method === 'POST') {
    const { active, excluded } = req.body;
    const { data, error } = await supabase
      .from('apex_watchlist')
      .upsert({ id: 'default', active: active || [], excluded: excluded || [], updated_at: new Date().toISOString() })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, saved: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}