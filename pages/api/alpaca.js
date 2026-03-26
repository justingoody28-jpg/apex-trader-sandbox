// pages/api/alpaca.js — Alpaca Paper Trading proxy
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, alpacaId, alpacaSecret, ticker, side, qty, notional, scenario } = req.body || {};

  if (!alpacaId || !alpacaSecret) return res.status(400).json({ error: 'Missing Alpaca credentials' });

  const BASE = 'https://paper-api.alpaca.markets';
  const headers = {
    'APCA-API-KEY-ID': alpacaId,
    'APCA-API-SECRET-KEY': alpacaSecret,
    'Content-Type': 'application/json',
  };

  try {
    // CHECK: just verify account
    if (action === 'check') {
      const r = await fetch(BASE + '/v2/account', { headers });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return res.status(200).json({ ok: false, error: err.message || 'Auth failed (' + r.status + ')' });
      }
      const acct = await r.json();
      return res.status(200).json({ ok: true, equity: acct.equity, buying_power: acct.buying_power, status: acct.status });
    }

    // TRADE: submit market order
    if (!ticker || !side) return res.status(400).json({ error: 'Missing ticker or side' });

    const orderBody = {
      symbol: ticker.toUpperCase(),
      side: side, // 'buy' or 'sell'
      type: 'market',
      time_in_force: 'day',
    };

    if (qty && qty > 0) {
      orderBody.qty = String(qty);
    } else if (notional && notional > 0) {
      orderBody.notional = String(notional);
    } else {
      return res.status(400).json({ error: 'Must provide qty or notional' });
    }

    const r = await fetch(BASE + '/v2/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify(orderBody),
    });

    const order = await r.json();
    if (!r.ok) return res.status(200).json({ success: false, error: order.message || 'Order failed (' + r.status + ')' });

    return res.status(200).json({
      success: true,
      order: {
        id: order.id,
        status: order.status,
        symbol: order.symbol,
        side: order.side,
        qty: order.qty,
        type: order.type,
        submitted_at: order.submitted_at,
      },
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
