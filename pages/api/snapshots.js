import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('apex_backtest_snapshots')
      .select('*')
      .order('date_from', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data);
  }

  if (req.method === 'POST') {
    const { label, date_from, date_to, rows } = req.body;
    // Determine which grp values are in new rows
    const newGrps = new Set((rows||[]).map(r => r.grp).filter(Boolean));
    // Fetch existing snapshot for this label
    const { data: existing } = await supabase.from('apex_backtest_snapshots').select('*').eq('label', label).limit(1);
    let mergedRows = rows || [];
    if (existing && existing[0] && existing[0].rows) {
      // Keep existing rows that don't match the new grp values
      const kept = existing[0].rows.filter(r => !newGrps.has(r.grp));
      mergedRows = [...kept, ...(rows||[])];
    }
    // Delete existing and insert merged
    await supabase.from('apex_backtest_snapshots').delete().eq('label', label);
    const { data, error } = await supabase
      .from('apex_backtest_snapshots')
      .insert([{ label, date_from, date_to, rows: mergedRows, saved_at: new Date().toISOString() }])
      .select();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json(data[0]);
  }

  if (req.method === 'DELETE') {
    const { label } = req.query;
    const { error } = await supabase
      .from('apex_backtest_snapshots')
      .delete()
      .eq('label', label);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}