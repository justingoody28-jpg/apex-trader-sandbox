// pages/api/diag-tradier-history.js
//
// Read-only diagnostic: returns filled trade history from Tradier for a date range.
// Used by fill-slippage-audit.html to audit live fills vs Polygon 9:30 open prices.
//
// No writes. No trading impact. Safe to call anytime.
//
// Usage:
//   GET /api/diag-tradier-history?start=2026-03-01&end=2026-04-22
//   GET /api/diag-tradier-history?start=2026-04-01&end=2026-04-22&side=buy
//
// Returns: { count, trades: [{date, symbol, side, qty, price, tradeType, description}] }

export default async function handler(req, res) {
  // CORS: allow browser-origin requests (including file:// which sends Origin: null)
  // Read-only endpoint — safe to expose.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
  const ACCOUNT_ID    = process.env.TRADIER_ACCOUNT_ID;
  if (!TRADIER_TOKEN || !ACCOUNT_ID) {
    return res.status(500).json({ error: 'TRADIER_TOKEN or TRADIER_ACCOUNT_ID env not set' });
  }

  const { start, end, side } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  // Basic validation: YYYY-MM-DD
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(start) || !ymd.test(end)) {
    return res.status(400).json({ error: 'start/end must be YYYY-MM-DD format' });
  }

  try {
    // Tradier account history endpoint
    // Docs: type=trade filters to executions only (excludes dividends, transfers, etc.)
    const url = `https://api.tradier.com/v1/accounts/${ACCOUNT_ID}/history` +
                `?start=${start}&end=${end}&type=trade&limit=1000`;

    const r = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${TRADIER_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    if (!r.ok) {
      const errTxt = await r.text();
      return res.status(r.status).json({
        error: `Tradier history ${r.status}`,
        detail: errTxt.slice(0, 500)
      });
    }

    const data = await r.json();

    // Tradier returns { history: { event: [...] } } or { history: { event: {...} } } for single
    // When no results: { history: null }
    const events = data?.history?.event;
    const arr = !events ? [] : (Array.isArray(events) ? events : [events]);

    // Each event has shape: { amount, date, type:'trade', trade: { commission, description, price, quantity, symbol, tradeType } }
    // quantity is positive for buys, negative for sells (in most cases)
    const trades = [];
    for (const ev of arr) {
      if (ev.type !== 'trade' || !ev.trade) continue;
      const t = ev.trade;
      const qty = Number(t.quantity) || 0;
      // Infer side: positive qty = buy, negative = sell. Some accounts may encode differently.
      const inferredSide = qty > 0 ? 'buy' : (qty < 0 ? 'sell' : 'unknown');
      trades.push({
        date: ev.date,          // timestamp of fill (ISO or YYYY-MM-DDTHH:MM:SS)
        symbol: t.symbol,
        side: inferredSide,
        qty: Math.abs(qty),
        price: Number(t.price) || 0,
        commission: Number(t.commission) || 0,
        tradeType: t.trade_type || t.tradeType || '', // Tradier returns snake_case 'trade_type'
        description: t.description || ''
      });
    }

    // Optional side filter (buy / sell)
    const filtered = side
      ? trades.filter(t => t.side === String(side).toLowerCase())
      : trades;

    // Sort ascending by date for easier auditing
    filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    return res.status(200).json({
      count: filtered.length,
      start,
      end,
      sideFilter: side || null,
      trades: filtered
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
