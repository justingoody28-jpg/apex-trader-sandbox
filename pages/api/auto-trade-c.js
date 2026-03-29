// pages/api/auto-trade-c.js — Variant C: Tradier data + Tradier OTOCO — TIERED
// Tier 1: gap 10-13% → TP 2% / SL 2%  (88.9% WR, PF 8.0)
// Tier 2: gap 13-15% → TP 3% / SL 3%  (100% WR, PF infinity)
// Tier 3: gap 15%+   → TP 5% / SL 5%  (87.5% WR, PF 7.0)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const TRADIER_TOKEN = process.env.TRADIER_TOKEN, TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID;
  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) return res.status(500).json({ error: 'Missing env vars: TRADIER_TOKEN, TRADIER_ACCOUNT_ID' });
  const TH = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  let config;
  try { const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json'); if (!r.ok) throw new Error('Config fetch failed'); config = await r.json(); } catch (e) { return res.status(500).json({ error: e.message }); }
  if (!config.scenarios || !config.scenarios.E) return res.status(200).json({ message: 'Scenario E disabled', trades: [] });
  const tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  if (!tickers.length) return res.status(200).json({ message: 'No tickers configured', trades: [] });
  const gapMin = (config.thresholds && config.thresholds.eGap) || 10;
  const symbols = [...new Set(tickers.map(t => t.symbol.toUpperCase()))];
  function getTier(gap) {
    if (gap >= 15) return { tier:3, tp:5, sl:5, label:'15%+ 5/5' };
    if (gap >= 13) return { tier:2, tp:3, sl:3, label:'13-15% 3/3' };
    return              { tier:1, tp:2, sl:2, label:'10-13% 2/2' };
  }
  let quoteMap = {};
  try { const r = await fetch(`https://sandbox.tradier.com/v1/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: TH }); if (r.ok) { const d = await r.json(); const raw = d.quotes&&d.quotes.quote; if (raw) { (Array.isArray(raw)?raw:[raw]).forEach(q=>{quoteMap[q.symbol]=q;}); } } } catch(_) {}
  const results = [];
  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase(), bet = ticker.bet, q = quoteMap[sym];
    if (!q) { results.push({symbol:sym,status:'skipped',reason:'No quote from Tradier'}); continue; }
    const price = q.last, prevClose = q.prevclose;
    if (!price||!prevClose||price<=0||prevClose<=0) { results.push({symbol:sym,status:'skipped',reason:'Missing price/prevclose'}); continue; }
    const gap = (price-prevClose)/prevClose*100;
    const rvol = q.average_volume>0 ? +(q.volume/q.average_volume).toFixed(2) : null;
    if (gap<gapMin) { results.push({symbol:sym,status:'skipped',reason:`Gap ${gap.toFixed(2)}% below +${gapMin}%`,gap:+gap.toFixed(2),rvol_logged:rvol}); continue; }
    const qty = Math.floor(bet/price);
    if (qty<1) { results.push({symbol:sym,status:'skipped',reason:'Bet too small',gap:+gap.toFixed(2),rvol_logged:rvol}); continue; }
    const {tier,tp,sl,label} = getTier(gap);
    const takeProfitPrice = +(price*(1-tp/100)).toFixed(2);
    const stopLossPrice   = +(price*(1+sl/100)).toFixed(2);
    try {
      const params = new URLSearchParams({'class':'otoco','duration':'day','symbol[0]':sym,'side[0]':'sell_short','quantity[0]':String(qty),'type[0]':'market','symbol[1]':sym,'side[1]':'buy_to_cover','quantity[1]':String(qty),'type[1]':'limit','price[1]':String(takeProfitPrice),'symbol[2]':sym,'side[2]':'buy_to_cover','quantity[2]':String(qty),'type[2]':'stop','stop[2]':String(stopLossPrice)});
      const or = await fetch(`https://sandbox.tradier.com/v1/accounts/${TRADIER_ACCOUNT_ID}/orders`,{method:'POST',headers:{...TH,'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
      const od = await or.json();
      if (!or.ok||(od.order&&od.order.status==='error')) results.push({symbol:sym,status:'error',reason:od.order?.partner_error_description||od.fault?.faultstring||`Tradier ${or.status}`,gap:+gap.toFixed(2),rvol_logged:rvol,tier});
      else results.push({symbol:sym,status:'traded',scenario:'E',variant:'C-Tradier-tiered',side:'sell_short',qty,entryPrice:+price.toFixed(2),takeProfitPrice,stopLossPrice,tier,tierLabel:label,tpPct:tp,slPct:sl,gap:+gap.toFixed(2),rvol_logged:rvol,orderId:od.order?.id});
    } catch(e) { results.push({symbol:sym,status:'error',reason:e.message}); }
  }
  return res.status(200).json({ timestamp:new Date().toISOString(), variant:'C-Tradier-tiered', summary:{traded:results.filter(r=>r.status==='traded').length,skipped:results.filter(r=>r.status==='skipped').length,errors:results.filter(r=>r.status==='error').length}, trades:results });
}