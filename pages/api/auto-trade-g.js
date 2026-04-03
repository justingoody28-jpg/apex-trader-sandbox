// pages/api/auto-trade-g.js — Scenario G: HONED FADE LONG
// Cron: 9:31 AM EDT weekdays (needs open candles)
// Conditions: gap <= -8%, RVOL >= 3x, first green 1-min candle by 9:42 AM
// Exit: TP +1.5% / SL -2.0% | Breakeven: 57.1%
// VIX floor: only fires when VIX > 20 (volatility regime required)
// Required env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  const DRY_RUN = req.query.dryrun === '1' || req.query.dryrun === 'true';

  // ── Dedup guard: prevent double-execution on same trading day ────────────
  const _todayEDT = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'})).toISOString().slice(0,10);
  try {
    const _pt = process.env.TRADIER_PAPER_TOKEN || process.env.TRADIER_TOKEN;
    const _pa = process.env.TRADIER_PAPER_ACCOUNT_ID || 'VA49290911';
    const _or = await fetch(`https://sandbox.tradier.com/v1/accounts/${_pa}/orders`, {headers:{'Authorization':`Bearer ${_pt}`,'Accept':'application/json'}});
    const _od = await _or.json();
    const _ol = _od?.orders?.order;
    const _oArr = Array.isArray(_ol)?_ol:(_ol?[_ol]:[]);
    const _tod = _oArr.filter(o=>o.create_date?.startsWith(_todayEDT));
    if(_tod.length > 0){
      return res.status(200).json({timestamp:new Date().toISOString(),status:'already_ran',
        message:`Dedup guard: ${_tod.length} orders already placed today (${_todayEDT}). Skipping.`,
        symbols:_tod.map(o=>o.symbol)});
    }
  } catch(_e){ /* dedup check failed — proceed normally */ }
  // ── End dedup guard ──────────────────────────────────────────────────────

  const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
  const TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
  const POLYGON_KEY = process.env.POLYGON_KEY;
  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });

  const H = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://sandbox.tradier.com/v1';

  let config;
  try {
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!r.ok) throw new Error('Config fetch failed');
    config = await r.json();
  } catch (e) { return res.status(500).json({ error: e.message }); }

  if (!config.scenarios || !config.scenarios.G)
    return res.status(200).json({ message: 'Scenario G disabled', trades: [] });

  // ── Market hours guard: block on holidays and non-trading days ──────────
  try {
    const _mk = await fetch('https://api.tradier.com/v1/markets/clock', {
      headers: { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' }
    });
    const _mj = await _mk.json();
    if (_mj?.clock?.state === 'closed') {
      return res.status(200).json({
        timestamp: new Date().toISOString(),
        status: 'market_closed',
        message: 'Market is closed today (holiday or non-trading day). No trades placed.',
        trades: []
      });
    }
  } catch(_me) { /* non-fatal — proceed if clock check fails */ }
  // ── End market hours guard ───────────────────────────────────────────────

  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers', trades: [] });

  const gapThreshold = (config.thresholds && config.thresholds.gGap)  || 8;
  const rvolMin      = (config.thresholds && config.thresholds.gRvol) || 3;

  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];
  let quoteMap = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    if (r.ok) {
      const data = await r.json();
      const raw = data.quotes && data.quotes.quote;
      if (raw) { (Array.isArray(raw) ? raw : [raw]).forEach(q => { quoteMap[q.symbol] = q; }); }
    }
  } catch(_) {}

  // VIX floor: G only fires in elevated volatility (VIX > 20)
  let vix = null;
  try {
    if (POLYGON_KEY) {
      const ds = new Date().toISOString().split('T')[0];
      const vr = await fetch('https://api.polygon.io/v2/aggs/ticker/I:VIX/range/1/day/' + ds + '/' + ds + '?adjusted=false&limit=1&apiKey=' + POLYGON_KEY);
      if (vr.ok) {
        const vd = await vr.json();
        if (vd.results && vd.results[0]) vix = vd.results[0].c;
      }
    }
  } catch(e) { /* non-fatal */ }

  if (vix !== null && vix <= 20) {
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'suppressed',
      message: `G suppressed: VIX ${vix.toFixed(2)} <= 20 (calm market, no fade-long setup)`,
      vix,
      trades: []
    });
  }

  if (DRY_RUN) {
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'dry_run',
      message: 'Dry run — no orders placed. Scan complete.',
      vix,
      variant: 'G-Tradier-9:31'
    });
  }

  const today  = new Date().toISOString().split('T')[0];
  const startET = `${today} 09:30:00`;
  const endET   = `${today} 09:42:00`;
  const results = [];

  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase(), bet = ticker.bet, q = quoteMap[sym];
    if (!q) { results.push({ symbol: sym, status: 'skipped', reason: 'No quote' }); continue; }

    const price = q.last, prevClose = q.prevclose;
    if (!price || !prevClose || price <= 0 || prevClose <= 0) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Missing price/prevclose' });
      continue;
    }

    const gap  = (price - prevClose) / prevClose * 100;
    const rvol = q.average_volume > 0 ? +(q.volume / q.average_volume).toFixed(2) : null;

    if (gap > -gapThreshold) {
      results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% not <= -${gapThreshold}%`, gap: +gap.toFixed(2), rvol });
      continue;
    }
    if (!rvol || rvol < rvolMin) {
      results.push({ symbol: sym, status: 'skipped', reason: `RVOL ${rvol} below ${rvolMin}x`, gap: +gap.toFixed(2), rvol });
      continue;
    }

    let entryPrice = null;
    try {
      const ts = await fetch(`${BASE}/markets/timesales?symbol=${sym}&interval=1min&start=${encodeURIComponent(startET)}&end=${encodeURIComponent(endET)}&session_filter=all`, { headers: H });
      if (ts.ok) {
        const d = await ts.json();
        const series = d.series && d.series.data;
        if (series) {
          const candles = Array.isArray(series) ? series : [series];
          const fg = candles.find(c => parseFloat(c.close) > parseFloat(c.open));
          if (fg) entryPrice = +parseFloat(fg.close).toFixed(2);
        }
      }
    } catch(_) {}

    if (!entryPrice) {
      results.push({ symbol: sym, status: 'skipped', reason: 'No green candle by 9:42 AM', gap: +gap.toFixed(2), rvol });
      continue;
    }

    const qty = Math.floor(bet / entryPrice);
    if (qty < 1) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Bet too small', gap: +gap.toFixed(2), rvol });
      continue;
    }

    const tp = +(entryPrice * 1.015).toFixed(2);
    const sl = +(entryPrice * 0.980).toFixed(2);

    try {
      const params = new URLSearchParams({
        'class': 'otoco', 'duration': 'day',
        'symbol[0]': sym, 'side[0]': 'buy',  'quantity[0]': String(qty), 'type[0]': 'market',
        'symbol[1]': sym, 'side[1]': 'sell', 'quantity[1]': String(qty), 'type[1]': 'limit', 'price[1]': String(tp),
        'symbol[2]': sym, 'side[2]': 'sell', 'quantity[2]': String(qty), 'type[2]': 'stop',  'stop[2]':  String(sl),
      });
      const or = await fetch(`${BASE}/accounts/${TRADIER_ACCOUNT_ID}/orders`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
      });
      const od = await or.json();
      if (!or.ok || (od.order && od.order.status === 'error'))
        results.push({ symbol: sym, status: 'error',
          reason: od.order?.partner_error_description || od.fault?.faultstring || `Tradier ${or.status}`,
          gap: +gap.toFixed(2), rvol });
      else
        results.push({ symbol: sym, status: 'traded', scenario: 'G', side: 'buy',
          qty, entryPrice, takeProfitPrice: tp, stopLossPrice: sl,
          gap: +gap.toFixed(2), rvol, vix, orderId: od.order?.id, orderStatus: od.order?.status });
    } catch(e) { results.push({ symbol: sym, status: 'error', reason: e.message }); }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    variant: 'G-Tradier-9:31',
    vix,
    summary: {
      traded:  results.filter(r => r.status === 'traded').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors:  results.filter(r => r.status === 'error').length,
    },
    trades: results
  });
}
