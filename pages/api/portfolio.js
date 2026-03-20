import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // GET portfolio (cash + positions + trades)
    if (req.method === 'GET' && action === 'load') {
      const [port, positions, trades] = await Promise.all([
        supabase.from('portfolio').select('*').eq('id', 'main').single(),
        supabase.from('positions').select('*').order('opened_at', { ascending: false }),
        supabase.from('trades').select('*').order('executed_at', { ascending: false }).limit(500),
      ]);
      return res.json({
        cash: port.data?.cash ?? 100000,
        startCash: port.data?.start_cash ?? 100000,
        positions: positions.data ?? [],
        trades: trades.data ?? [],
      });
    }

    // POST a trade (buy or sell)
    if (req.method === 'POST' && action === 'trade') {
      const { ticker, side, quantity, price, pnl, reason, auto, newCash, position } = req.body;

      // Record the trade
      await supabase.from('trades').insert({
        ticker, side, quantity, price, pnl: pnl || 0, reason, auto: auto || false
      });

      // Update cash
      await supabase.from('portfolio').update({ cash: newCash, updated_at: new Date() }).eq('id', 'main');

      // Update positions
      if (side === 'BUY') {
        await supabase.from('positions').insert({
          ticker,
          shares: quantity,
          avg_price: price,
          entry_price: price,
          sl: position.sl,
          tp: position.tp,
        });
      } else {
        // Remove position on sell
        await supabase.from('positions').delete().eq('ticker', ticker);
      }

      return res.json({ ok: true });
    }

    // POST AI analysis results
    if (req.method === 'POST' && action === 'ai_analysis') {
      const { results } = req.body;
      if (results && results.length) {
        await supabase.from('ai_analysis').insert(
          results.map(r => ({
            ticker: r.ticker,
            verdict: r.verdict,
            catalyst: r.catalyst,
            bull_case: r.bull,
            bear_case: r.bear,
            analyst_target: r.analystTarget,
            upside: r.upside,
            upside_num: r.upsideNum,
            recommendation: r.recommendation,
            drop_pct: r.dropNum,
            price_str: r.price,
            market_cap: r.marketCap,
          }))
        );
      }
      return res.json({ ok: true });
    }

    // POST validation scores
    if (req.method === 'POST' && action === 'validation') {
      const { ticker, ai_verdict, confidence, score, checks_passed, checks_total, checks_detail } = req.body;
      await supabase.from('validation_scores').insert({
        ticker, ai_verdict, confidence, score, checks_passed, checks_total, checks_detail
      });
      return res.json({ ok: true });
    }

    // GET trade history for a ticker (accuracy tracking)
    if (req.method === 'GET' && action === 'history') {
      const { ticker } = req.query;
      const q = supabase.from('ai_analysis').select('*').order('analyzed_at', { ascending: false }).limit(100);
      if (ticker) q.eq('ticker', ticker);
      const { data } = await q;
      return res.json(data ?? []);
    }

    // POST reset portfolio
    if (req.method === 'POST' && action === 'reset') {
      await Promise.all([
        supabase.from('portfolio').update({ cash: 100000, updated_at: new Date() }).eq('id', 'main'),
        supabase.from('positions').delete().neq('id', 0),
      ]);
      return res.json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
