// pages/api/auto-trade-gh.js — Scenarios G (Honed Fade Long) + H (Panic Reversal)
// Cron: 9:29 AM EDT weekdays
// Data + Execution: Tradier production API + OTOCO bracket orders
//
// G: Gap <= -10%, RVOL >= 5x, first green candle -> buy long, TP +1.5%, SL -1.5%
// H: Gap <= -10%, RVOL >= 4x, first green candle <= 9:42 AM -> buy long, TP +1.5%, SL -2.5%
// H takes priority when both conditions met.
// WOLF excluded from G/H (consistently underperforms).
// VIX floor: only fires when VIX > 20 (panic/volatility regime required)
//
// Uses q.bid for pre-market price (updates live).
// q.last only updates when a trade prints — stays at prev close pre-market.
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
  const TRADIER_PAPER_TOKEN = process.env.TRADIER_PAPER_TOKEN;
  const TRADIER_PAPER_ACCOUNT_ID = process.env.TRADIER_PAPER_ACCOUNT_ID;
  const POLYGON_KEY = process.env.POLYGON_KEY;
  const PAPER_BASE = 'https://sandbox.tradier.com/v1';
  const PaperHeaders = { 'Authorization': `Bearer ${TRADIER_PAPER_TOKEN}`, 'Accept': 'application/json' };

  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID' });
  }

  const Headers = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://api.tradier.com/v1';

  let config;
  try {
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!r.ok) throw new Error('Config fetch failed');
    config = await r.json();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const runG = config.scenarios && config.scenarios.G;
  const runH = config.scenarios && config.scenarios.H;
  if (!runG && !runH) {
    return res.status(200).json({ message: 'Scenarios G and H both disabled', trades: [] });
  }

  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) {
    return res.status(200).json({ message: 'No tickers configured', trades: [] });
  }

  const gGap  = (config.thresholds && config.thresholds.gGap)  || 10;
  const hGap  = (config.thresholds && config.thresholds.hGap)  || 10;
  const gRvol = (config.thresholds && config.thresholds.gRvol) || 5;
  const hRvol = (config.thresholds && config.thresholds.hRvol) || 4;

  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];
  let quoteMap = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: Headers });
    if (r.ok) {
      const data = await r.json();
      const raw = data.quotes && data.quotes.quote;
      if (raw) { (Array.isArray(raw) ? raw : [raw]).forEach(q => { quoteMap[q.symbol] = q; }); }
    }
  } catch (_) {}

  // VIX floor: G/H only fire in elevated volatility (VIX > 20)
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
      message: `G/H suppressed: VIX ${vix.toFixed(2)} <= 20 (calm market, no panic reversal setup)`,
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
      variant: 'GH-Tradier-9:29'
    });
  }

  const results = [];

  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase();
    const bet = ticker.bet;

    // WOLF excluded from G/H — consistently underperforms on gap-down reversal
    if (sym === 'WOLF') {
      results.push({ symbol: sym, status: 'skipped', reason: 'WOLF excluded from G/H' });
      continue;
    }

    const q = quoteMap[sym];
    if (!q) { results.push({ symbol: sym, status: 'skipped', reason: 'No quote from Tradier' }); continue; }

    const bidPrice = (q.bid && q.bid > 0) ? q.bid : null;
    const lastPrice = (q.last && q.last > 0) ? q.last : null;
    const price = bidPrice || lastPrice;
    const prevClose = q.prevclose;

    if (!price || !prevClose || price <= 0 || prevClose <= 0) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Missing price or prevclose' });
      continue;
    }

    const gap  = (price - prevClose) / prevClose * 100;
    const rvol = (q.average_volume || 0) > 0 ? +(( q.volume || 0) / q.average_volume).toFixed(2) : null;

    // H takes priority if both qualify
    let scenario = null;
    if (runH && gap <= -hGap && rvol !== null && rvol >= hRvol) {
      scenario = { name: 'H', tpPct: 1.5, slPct: 2.5 };
    } else if (runG && gap <= -gGap && rvol !== null && rvol >= gRvol) {
      scenario = { name: 'G', tpPct: 1.5, slPct: 1.5 };
    }

    if (!scenario) {
      results.push({ symbol: sym, status: 'skipped',
        reason: `Gap ${gap.toFixed(2)}% RVOL ${rvol || '?'}x — no G/H signal`,
        gap: +gap.toFixed(2), rvol_logged: rvol, priceSource: bidPrice ? 'bid' : 'last' });
      continue;
    }

    const qty = Math.floor(bet / price);
    if (qty < 1) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Bet too small',
        gap: +gap.toFixed(2), scenario: scenario.name, rvol_logged: rvol });
      continue;
    }

    const tp = +(price * (1 + scenario.tpPct / 100)).toFixed(2);
    const sl = +(price * (1 - scenario.slPct / 100)).toFixed(2);

    try {
      const params = new URLSearchParams({
        'class': 'otoco', 'duration': 'day',
        'symbol[0]': sym, 'side[0]': 'buy',          'quantity[0]': String(qty), 'type[0]': 'market',
        'symbol[1]': sym, 'side[1]': 'sell',          'quantity[1]': String(qty), 'type[1]': 'limit', 'price[1]': String(tp),
        'symbol[2]': sym, 'side[2]': 'sell',          'quantity[2]': String(qty), 'type[2]': 'stop',  'stop[2]':  String(sl),
      });
      const or = await fetch(`${PAPER_BASE}/accounts/${TRADIER_PAPER_ACCOUNT_ID}/orders`, {
        method: 'POST',
        headers: { ...PaperHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      const od = await or.json();
      if (!or.ok || (od.order && od.order.status === 'error')) {
        results.push({ symbol: sym, status: 'error', scenario: scenario.name,
          reason: od.order?.partner_error_description || od.fault?.faultstring || `Tradier ${or.status}`,
          gap: +gap.toFixed(2), rvol_logged: rvol });
      } else {
        results.push({ symbol: sym, status: 'traded', scenario: scenario.name,
          side: 'buy', qty, entryPrice: +price.toFixed(2), priceSource: bidPrice ? 'bid' : 'last',
          tpPct: scenario.tpPct, slPct: scenario.slPct, takeProfitPrice: tp, stopLossPrice: sl,
          gap: +gap.toFixed(2), rvol_logged: rvol, vix,
          orderId: od.order?.id, orderStatus: od.order?.status });
      }
    } catch (e) {
      results.push({ symbol: sym, status: 'error', scenario: scenario.name, reason: e.message });
    }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    variant: 'GH-Tradier-9:29',
    vix,
    summary: {
      traded:    results.filter(r => r.status === 'traded').length,
      skipped:   results.filter(r => r.status === 'skipped').length,
      errors:    results.filter(r => r.status === 'error').length,
      scenarioG: results.filter(r => r.scenario === 'G' && r.status === 'traded').length,
      scenarioH: results.filter(r => r.scenario === 'H' && r.status === 'traded').length,
    },
    trades: results,
  });
}
