// pages/api/auto-trade-c.js
// Variant C: Tradier for BOTH price data AND execution
// Sandbox: sandbox.tradier.com (swap to api.tradier.com for live)
// Cron: 9:29 AM EDT weekdays via cron-job.org "APEX Auto-Trade C"
// Strategy: Scenario E GAP FADE SHORT — gap>=+10%, OTOCO bracket 2% TP / 2% SL
// Config: public/auto-trade-config.json — reads config.tickers + config.scenarios.E
// Required env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const TRADIER_TOKEN = process.env.TRADIER_TOKEN, TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID' });
  const H = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://sandbox.tradier.com/v1';

  let config;
  try {
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!r.ok) throw new Error('Config fetch failed');
    config = await r.json();
  } catch (e) { return res.status(500).json({ error: e.message }); }

  // Config uses config.tickers array + config.scenarios.E flag
  if (!config.scenarios || !config.scenarios.E) {
    return res.status(200).json({ message: 'Scenario E disabled in config', trades: [] });
  }

  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers configured', trades: [] });

  const gapThreshold = (config.thresholds && config.thresholds.eGap) || 10;

  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];
  let quoteMap = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    if (r.ok) {
      const data = await r.json();
      const raw = data.quotes && data.quotes.quote;
      if (raw) { const arr = Array.isArray(raw) ? raw : [raw]; arr.forEach(q => { quoteMap[q.symbol] = q; }); }
    }
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
    if (gap < gapThreshold) { results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% below +${gapThreshold}% threshold`, gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }
    const qty = Math.floor(bet / price);
    if (qty < 1) { results.push({ symbol: sym, status: 'skipped', reason: 'Bet too small', gap: +gap.toFixed(2), rvol_logged: rvol }); continue; }
    const tp = +(price * 0.98).toFixed(2), sl = +(price * 1.02).toFixed(2);
    try {
      const params = new URLSearchParams({
        'class': 'otoco', 'duration': 'day',
        'symbol[0]': sym, 'side[0]': 'sell_short', 'quantity[0]': String(qty), 'type[0]': 'market',
        'symbol[1]': sym, 'side[1]': 'buy_to_cover', 'quantity[1]': String(qty), 'type[1]': 'limit', 'price[1]': String(tp),
        'symbol[2]': sym, 'side[2]': 'buy_to_cover', 'quantity[2]': String(qty), 'type[2]': 'stop', 'stop[2]': String(sl),
      });
      const or = await fetch(`${BASE}/accounts/${TRADIER_ACCOUNT_ID}/orders`, {
        method: 'POST', headers: { ...H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
      });
      const od = await or.json();
      if (!or.ok || (od.order && od.order.status === 'error')) {
        results.push({ symbol: sym, status: 'error', reason: od.order?.partner_error_description || od.fault?.faultstring || `Tradier ${or.status}`, gap: +gap.toFixed(2), rvol_logged: rvol });
      } else {
        results.push({ symbol: sym, status: 'traded', scenario: 'E', variant: 'C-Tradier-sandbox', side: 'sell_short', qty, entryPrice: +price.toFixed(2), takeProfitPrice: tp, stopLossPrice: sl, gap: +gap.toFixed(2), rvol_logged: rvol, orderId: od.order?.id, orderStatus: od.order?.status });
      }
    } catch(e) { results.push({ symbol: sym, status: 'error', reason: e.message }); }
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(), variant: 'C-Tradier-sandbox',
    summary: { traded: results.filter(r=>r.status==='traded').length, skipped: results.filter(r=>r.status==='skipped').length, errors: results.filter(r=>r.status==='error').length },
    trades: results
  });
}