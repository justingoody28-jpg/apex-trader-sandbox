// pages/api/auto-trade-gh.js â Scenarios G (Honed Fade Long) + H (Panic Reversal)
// Cron: 9:29 AM EDT weekdays
// Data + Execution: Tradier consolidated feed + OTOCO bracket orders
// G: Gap <= -8%, RVOL >= 3x â buy long, TP +1.5%, SL -2.0%
// H: Gap <= -10%, RVOL >= 4x â buy long, TP +1.5%, SL -2.5% (H takes priority)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const TRADIER_TOKEN = process.env.TRADIER_TOKEN, TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars' });
  const H = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://api.tradier.com/v1';

  let config;
  try { const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json'); if (!r.ok) throw new Error('Config fetch failed'); config = await r.json(); }
  catch (e) { return res.status(500).json({ error: e.message }); }

  const runG = config.scenarios && config.scenarios.G;
  const runH = config.scenarios && config.scenarios.H;
  if (!runG && !runH) return res.status(200).json({ message: 'Scenarios G and H both disabled', trades: [] });

  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers', trades: [] });

  const gGap = (config.thresholds && config.thresholds.gGap) || 8;
  const hGap = (config.thresholds && config.thresholds.hGap) || 10;
  const gRvol = (config.thresholds && config.thresholds.gRvol) || 3;
  const hRvol = (config.thresholds && config.thresholds.hRvol) || 4;

  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];
  let quoteMap = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    if (r.ok) { const data = await r.json(); const raw = data.quotes && data.quotes.quote; if (raw) { const arr = Array.isArray(raw) ? raw : [raw]; arr.forEach(q => { quoteMap[q.symbol] = q; }); } }
  } catch(_) {}

  const results = [];
  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase(), bet = ticker.bet, q = quoteMap[sym];
    if (!q) { results.push({ symbol: sym, status: 'skipped', reason: 'No quote from Tradier' }); continue; }
    const price = q.last, prevClose = q.prevclose;
    if (!price || !prevClose || price <= 0 || prevClose <= 0) { results.push({ symbol: sym, status: 'skipped', reason: 'Missing price/prevclose' }); continue; }
    const gap = (price - prevClose) / prevClose * 100;
    const avgVol = q.average_volume || 0, todayVol = q.volume || 0;
    const rvol = avgVol > 0 ? +(todayVol / avgVol).toFixed(2) : null;

    let scenario = null;
    if (runH && gap <= -hGap && rvol !== null && rvol >= hRvol) {
      scenario = { name: 'H', tpPct: 1.5, slPct: 2.5 };
    } else if (runG && gap <= -gGap && rvol !== null && rvol >= gRvol) {
      scenario = { name: 'G', tpPct: 1.5, slPct: 2.0 };
    }

    if (!scenario) { results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% RVOL ${rvol||'?'}x â no G/H signal`, gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }

    const qty = Math.floor(bet / price);
    if (qty < 1) { results.push({ symbol: sym, status: 'skipped', reason: 'Bet too small', gap: +gap.toFixed(2), scenario: scenario.name, rvol_logged: rvol }); continue; }

    const tp = +(price * (1 + scenario.tpPct / 100)).toFixed(2);
    const sl = +(price * (1 - scenario.slPct / 100)).toFixed(2);

    try {
      const params = new URLSearchParams({
        'class':'otoco','duration':'day',
        'symbol[0]':sym,'side[0]':'buy',  'quantity[0]':String(qty),'type[0]':'market',
        'symbol[1]':sym,'side[1]':'sell', 'quantity[1]':String(qty),'type[1]':'limit','price[1]':String(tp),
        'symbol[2]':sym,'side[2]':'sell', 'quantity[2]':String(qty),'type[2]':'stop', 'stop[2]': String(sl),
      });
      const or = await fetch(`${BASE}/accounts/${TRADIER_ACCOUNT_ID}/orders`, { method:'POST', headers:{...H,'Content-Type':'application/x-www-form-urlencoded'}, body:params.toString() });
      const od = await or.json();
      if (!or.ok || (od.order && od.order.status === 'error')) {
        results.push({ symbol:sym, status:'error', scenario:scenario.name, reason:od.order?.partner_error_description||od.fault?.faultstring||`Tradier ${or.status}`, gap:+gap.toFixed(2), rvol_logged:rvol });
      } else {
        results.push({ symbol:sym, status:'traded', scenario:scenario.name, side:'buy', qty, entryPrice:+price.toFixed(2), tpPct:scenario.tpPct, slPct:scenario.slPct, takeProfitPrice:tp, stopLossPrice:sl, gap:+gap.toFixed(2), rvol_logged:rvol, orderId:od.order?.id, orderStatus:od.order?.status });
      }
    } catch(e) { results.push({ symbol:sym, status:'error', scenario:scenario.name, reason:e.message }); }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(), variant: 'GH-Tradier-9:29',
    summary: { traded:results.filter(r=>r.status==='traded').length, skipped:results.filter(r=>r.status==='skipped').length, errors:results.filter(r=>r.status==='error').length, scenarioG:results.filter(r=>r.scenario==='G'&&r.status==='traded').length, scenarioH:results.filter(r=>r.scenario==='H'&&r.status==='traded').length },
    trades: results
  });
}