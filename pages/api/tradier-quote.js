// pages/api/tradier-quote.js
// Proxy: batch real-time + pre-market quotes from Tradier consolidated feed
// FREE with any Tradier brokerage account — includes pre-market, SIP-equivalent

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
  if (!TRADIER_TOKEN) return res.status(500).json({ error: 'Missing TRADIER_TOKEN env var' });

  const symbols = (req.query.symbols || (req.body && req.body.symbols) || '').toUpperCase().trim();
  if (!symbols) return res.status(400).json({ error: 'symbols param required (comma-separated)' });

  try {
    const r = await fetch(
      `https://api.tradier.com/v1/markets/quotes?symbols=${symbols}&greeks=false`,
      { headers: { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' } }
    );
    if (!r.ok) { const err = await r.text(); return res.status(r.status).json({ error: `Tradier ${r.status}: ${err.slice(0,200)}` }); }
    const data = await r.json();
    const raw  = data.quotes && data.quotes.quote;
    if (!raw) return res.status(200).json({ quotes: [] });
    const arr = Array.isArray(raw) ? raw : [raw];
    const quotes = arr.map(q => ({
      symbol: q.symbol, last: q.last, prevclose: q.prevclose,
      open: q.open, volume: q.volume, average_volume: q.average_volume,
      bid: q.bid, ask: q.ask, trade_date: q.trade_date,
    }));
    return res.status(200).json({ quotes });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}