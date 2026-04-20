import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// Read-only schema probe. Returns whether the `tickers` column exists on
// apex_watchlist and (if so) its current value for the 'default' row.
// Safe: no writes, no side effects.
export default async function handler(req, res) {
  try {
    const { data, error } = await supabase
      .from('apex_watchlist')
      .select('id, tickers')
      .eq('id', 'default')
      .single();

    if (error) {
      const missing = /column.*tickers.*does not exist|does not exist.*tickers|PGRST204/i.test(
        error.message || error.code || ''
      );
      return res.status(200).json({
        columnExists: !missing,
        error: error.message,
        code: error.code,
      });
    }

    return res.status(200).json({
      columnExists: true,
      tickersCount: Array.isArray(data.tickers) ? data.tickers.length : null,
      sample: Array.isArray(data.tickers) ? data.tickers.slice(0, 3) : data.tickers,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
