// pages/api/auto-trade-bc.js — Scenarios B + C: PreMarketEdge Gap-Up Longs
// Cron: 9:29 AM EDT weekdays
// Data + Execution: Tradier production API + OTOCO bracket orders
//
// B: Gap-up 3.0–3.99% | TP +3% / SL -1% (BE 25%) | SPY gap >0.5% + recovering, VIX <= 25
// C: Gap-up >= 4.0%   | TP +4% / SL -1% (BE 20%) | SPY gap >0.5% + recovering, VIX <= 25
// C takes priority when gap >= 4%.
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
        symbols:_tod.map(o=>o.symbol||(Array.isArray(o.leg)?o.leg[0]?.symbol:o.leg?.symbol)||'?')});
    }
  } catch(_e){ /* dedup check failed — proceed normally */ }
  // ── End dedup guard ──────────────────────────────────────────────────────

  // ── Market hours guard: block on holidays and non-trading days ──────────
  try {
    const _mk = await fetch('https://api.tradier.com/v1/markets/clock', {
      headers: { 'Authorization': `Bearer ${process.env.TRADIER_TOKEN}`, 'Accept': 'application/json' }
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

  // ── Market hours guard ───────────────────────────────────────────────────
  try {
    const _mktR = await fetch('https://api.tradier.com/v1/markets/clock', {
      headers: { 'Authorization': `Bearer ${process.env.TRADIER_TOKEN}`, 'Accept': 'application/json' }
    });
    if (_mktR.ok) {
      const _mktJ = await _mktR.json();
      if (_mktJ?.clock?.state === 'closed') {
        return res.status(200).json({
          timestamp: new Date().toISOString(),
          status: 'market_closed',
          message: 'Market closed (holiday or weekend). No trades placed.',
          trades: []
        });
      }
    }
  } catch(_me) { /* non-fatal — proceed if market clock check fails */ }
  // ── End market hours guard ─────────────────────────────────────────────────

  const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
  const TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
  const TRADIER_PAPER_TOKEN = process.env.TRADIER_PAPER_TOKEN;
  const TRADIER_PAPER_ACCOUNT_ID = process.env.TRADIER_PAPER_ACCOUNT_ID;
  const POLYGON_KEY = process.env.POLYGON_KEY;

  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) {
    return res.status(500).json({ error: 'Missing env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID' });
  }

  const H = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const PAPER_H = {
    'Authorization': `Bearer ${TRADIER_PAPER_TOKEN}`,
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded'
  };
  const BASE       = 'https://api.tradier.com/v1';
  const PAPER_BASE = 'https://sandbox.tradier.com/v1';

  let config;
  try {
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!r.ok) throw new Error('Config fetch failed');
    config = await r.json();
  } catch (e) { return res.status(500).json({ error: e.message }); }

  const runB = config.scenarios && config.scenarios.B;
  const runC = config.scenarios && config.scenarios.C;
  if (!runB && !runC) {
    return res.status(200).json({ message: 'Scenarios B and C both disabled', trades: [] });
  }

  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers configured', trades: [] });

  // Include SPY in quote fetch for market context filter
  const symbols = [...new Set([...tickers.map(t => t.symbol.toUpperCase()), 'SPY'])];
  let quoteMap = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    if (r.ok) {
      const data = await r.json();
      const raw = data.quotes && data.quotes.quote;
      if (raw) { (Array.isArray(raw) ? raw : [raw]).forEach(q => { quoteMap[q.symbol] = q; }); }
    }
  } catch (_) {}

  // SPY gap filter: B/C are gap-up longs — only fire when SPY is constructive
  const spyQ   = quoteMap['SPY'];
  const spyGap = spyQ && spyQ.prevclose > 0
    ? ((spyQ.bid || spyQ.last) - spyQ.prevclose) / spyQ.prevclose * 100
    : 0;

  // SPY pre-market momentum: 9:29 AM vs 9:00 AM close (recovering = bullish)
  let spyRecovering = false;
  try {
    if (POLYGON_KEY && spyQ) {
      const ds = new Date().toISOString().split('T')[0];
      const pr = await fetch(
        'https://api.polygon.io/v2/aggs/ticker/SPY/range/1/minute/' + ds + 'T09:00:00/' + ds + 'T09:01:00?adjusted=false&limit=1&apiKey=' + POLYGON_KEY
      );
      if (pr.ok) {
        const pd = await pr.json();
        const spy900 = pd.results && pd.results[0] ? pd.results[0].c : null;
        const spy929 = spyQ.bid || spyQ.last;
        if (spy900 && spy929) spyRecovering = spy929 > spy900;
      }
    }
  } catch(e) { /* non-fatal */ }

  // VIX filter: suppress B/C if VIX > 25 (fear regime — gap-up longs unreliable)
  let vix = null;
  try {
    if (POLYGON_KEY) {
      const ds = new Date().toISOString().split('T')[0];
      const vr = await fetch(
        'https://api.polygon.io/v2/aggs/ticker/I:VIX/range/1/day/' + ds + '/' + ds + '?adjusted=false&limit=1&apiKey=' + POLYGON_KEY
      );
      if (vr.ok) {
        const vd = await vr.json();
        if (vd.results && vd.results[0]) vix = vd.results[0].c;
      }
    }
  } catch(e) { /* non-fatal */ }

  // Suppress if SPY not constructive
  if (spyGap <= 0.5 || !spyRecovering) {
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'suppressed',
      message: `B/C suppressed: SPY gap ${spyGap.toFixed(2)}% (need >0.5%), recovering: ${spyRecovering}`,
      spyGap: +spyGap.toFixed(2), spyRecovering, vix, trades: []
    });
  }

  // Suppress if VIX too elevated
  if (vix !== null && vix > 25) {
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'suppressed',
      message: `B/C suppressed: VIX ${vix.toFixed(2)} > 25 (fear regime, gap-up longs unreliable)`,
      vix, trades: []
    });
  }

  if (DRY_RUN) {
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      status: 'dry_run',
      message: 'Dry run — no orders placed. Scan complete.',
      spyGap: +spyGap.toFixed(2), spyRecovering, vix,
      variant: 'BC-Tradier-9:29'
    });
  }

  const results = [];

  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase();
    const bet = ticker.bet;
    const q   = quoteMap[sym];

    if (!q) { results.push({ symbol: sym, status: 'skipped', reason: 'No quote from Tradier' }); continue; }

    const bidPrice = (q.bid && q.bid > 0) ? q.bid : null;
    const lastPrice = (q.last && q.last > 0) ? q.last : null;
    const price    = bidPrice || lastPrice;
    const prevClose = q.prevclose;

    if (!price || !prevClose || price <= 0 || prevClose <= 0) {
      results.push({ symbol: sym, status: 'skipped', reason: 'Missing price or prevclose' });
      continue;
    }

    const gap  = (price - prevClose) / prevClose * 100;
    const rvol = (q.average_volume > 0) ? +(q.volume / q.average_volume).toFixed(2) : null;

    // C takes priority (higher gap threshold)
    let scenario = null;
    if (runC && gap >= 4) {
      scenario = { name: 'C', tpPct: 4.0, slPct: 1.0 };
    } else if (runB && gap >= 3 && gap < 4) {
      scenario = { name: 'B', tpPct: 3.0, slPct: 1.0 };
    }

    if (!scenario) {
      results.push({ symbol: sym, status: 'skipped',
        reason: `Gap ${gap.toFixed(2)}% not in B/C range (need >=3%)`,
        gap: +gap.toFixed(2), rvol_logged: rvol, priceSource: bidPrice ? 'bid' : 'last' });
      continue;
    }

    const qty = Math.max(1, Math.floor(bet / price));
    const tp  = +(price * (1 + scenario.tpPct / 100)).toFixed(2);
    const sl  = +(price * (1 - scenario.slPct / 100)).toFixed(2);

    try {
      const params = new URLSearchParams({
        'class': 'otoco', 'duration': 'day',
        'symbol[0]': sym, 'side[0]': 'buy',  'quantity[0]': String(qty), 'type[0]': 'market',
        'symbol[1]': sym, 'side[1]': 'sell', 'quantity[1]': String(qty), 'type[1]': 'limit', 'price[1]': String(tp),
        'symbol[2]': sym, 'side[2]': 'sell', 'quantity[2]': String(qty), 'type[2]': 'stop',  'stop[2]':  String(sl),
      });
      const or = await fetch(`${PAPER_BASE}/accounts/${TRADIER_PAPER_ACCOUNT_ID}/orders`, {
        method: 'POST', headers: PAPER_H, body: params.toString(),
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
          gap: +gap.toFixed(2), rvol_logged: rvol, spyGap: +spyGap.toFixed(2), vix,
          orderId: od.order?.id, orderStatus: od.order?.status });
      }
    } catch (e) { results.push({ symbol: sym, status: 'error', scenario: scenario.name, reason: e.message }); }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    variant: 'BC-Tradier-9:29',
    spyGap: +spyGap.toFixed(2), spyRecovering, vix,
    summary: {
      traded:    results.filter(r => r.status === 'traded').length,
      skipped:   results.filter(r => r.status === 'skipped').length,
      errors:    results.filter(r => r.status === 'error').length,
      scenarioB: results.filter(r => r.scenario === 'B' && r.status === 'traded').length,
      scenarioC: results.filter(r => r.scenario === 'C' && r.status === 'traded').length,
    },
    trades: results,
  });
}
