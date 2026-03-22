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

    if (req.method === 'POST' && action === 'trade') {
      const { ticker, side, quantity, price, pnl, reason, auto, newCash, position } = req.body;
      const metricsStr = req.body.metrics ? ' | '+JSON.stringify(req.body.metrics) : '';
      await supabase.from('trades').insert({ ticker, side, quantity, price, pnl: pnl || 0, reason: (reason||'Manual') + metricsStr, auto: auto || false });
      await supabase.from('portfolio').update({ cash: newCash, updated_at: new Date() }).eq('id', 'main');
      if (side === 'BUY') {
        await supabase.from('positions').insert({ ticker, shares: quantity, avg_price: price, entry_price: price, sl: position.sl, tp: position.tp });
      } else {
        await supabase.from('positions').delete().eq('ticker', ticker);
      }
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'ai_analysis') {
      const { results } = req.body;
      if (results && results.length) {
        // Delete existing rows for these tickers then insert fresh
        // This ensures recovery_probability and all fields always get updated
        const tickers = results.map(r => r.ticker).filter(Boolean);
        if (tickers.length) {
          await supabase.from('ai_analysis').delete().in('ticker', tickers);
        }
        await supabase.from('ai_analysis').insert(
          results.map(r => ({
            ticker: r.ticker,
            verdict: r.verdict,
            catalyst: r.catalyst,
            bull_case: r.bull_case || r.bull || null,
            bear_case: r.bear_case || r.bear || null,
            analyst_target: String(r.analyst_target || r.analystTarget || ''),
            upside: String(r.upside || ''),
            upside_num: parseFloat(r.upside_num || r.upsideNum) || null,
            recommendation: r.recommendation || null,
            drop_pct: parseFloat(r.drop_pct || r.dropNum) || null,
            price_str: String(r.price_str || r.price || ''),
            market_cap: String(r.market_cap || r.marketCap || ''),
            recovery_probability: r.recovery_probability || r.recoveryProbability || null,
            recovery_timeline: r.recovery_timeline || r.recoveryTimeline || null,
            multi_tf_analysis: r.multi_tf_analysis || r.multiTfAnalysis || null,
            selected_tf_change: r.selected_tf_change || r.selectedTfChange || null,
          }))
        );
      }
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && action === 'validation') {
      const { ticker, ai_verdict, confidence, score, checks_passed, checks_total, checks_detail } = req.body;
      await supabase.from('validation_scores').insert({ ticker, ai_verdict, confidence, score, checks_passed, checks_total, checks_detail });
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && action === 'history') {
      const { ticker } = req.query;
      const q = supabase.from('ai_analysis').select('*').order('analyzed_at', { ascending: false }).limit(500);
      if (ticker) q.eq('ticker', ticker);
      const { data } = await q;
      return res.json(data ?? []);
    }

    if (req.method === 'POST' && action === 'reset') {
      await Promise.all([
        supabase.from('portfolio').update({ cash: 100000, updated_at: new Date() }).eq('id', 'main'),
        supabase.from('positions').delete().neq('id', 0),
      ]);
      return res.json({ ok: true });
    }

    if (req.method === 'GET' && action === 'watchlist') {
      const { data } = await supabase.from('watchlist').select('*').order('added_at', { ascending: false });
      return res.json(data ?? []);
    }

    if (req.method === 'POST' && action === 'watchlist_add') {
      const { ticker, name, added_from } = req.body;
      const { data, error } = await supabase.from('watchlist').upsert({ ticker, name, added_from }, { onConflict: 'ticker' }).select().single();
      return res.json({ ok: !error, data });
    }

    if (req.method === 'POST' && action === 'watchlist_remove') {
      const { ticker } = req.body;
      await supabase.from('watchlist').delete().eq('ticker', ticker);
      return res.json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}