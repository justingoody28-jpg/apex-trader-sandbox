export default async function handler(req, res) {
  const TOKEN = process.env.TRADIER_TOKEN;
  const syms = (req.query.symbols || 'TSLA,MARA,RIOT,GFAI').toUpperCase();
  const r = await fetch(`https://api.tradier.com/v1/markets/quotes?symbols=${syms}&greeks=false`,
    { headers: { 'Authorization': `Bearer ${TOKEN}`, 'Accept': 'application/json' } });
  const data = await r.json();
  const raw = data.quotes && data.quotes.quote;
  const arr = Array.isArray(raw) ? raw : [raw];
  // Return ALL fields
  return res.status(200).json({ quotes: arr, status: r.status });
}