// pages/api/diag-order-events.js
// Hits Tradier's single-order GET endpoint (richer error payload than bulk list).
// Read-only — safe to deploy during market hours.
//
// Usage:
//   GET /api/diag-order-events                        -> defaults to 5 canceled brackets from 2026-04-20
//   GET /api/diag-order-events?id=122441181           -> single order
//   GET /api/diag-order-events?ids=1,2,3              -> multiple orders
//   GET /api/diag-order-events?account=paper          -> query sandbox instead of live

export default async function handler(req, res) {
  const usePaper = req.query.account === 'paper';
  const token   = usePaper ? process.env.TRADIER_PAPER_TOKEN     : process.env.TRADIER_TOKEN;
  const account = usePaper ? process.env.TRADIER_PAPER_ACCOUNT_ID : process.env.TRADIER_ACCOUNT_ID;
  const base    = usePaper ? 'https://sandbox.tradier.com/v1'     : 'https://api.tradier.com/v1';

  let ids;
  if (req.query.ids) {
    ids = String(req.query.ids).split(',').map(s => s.trim()).filter(Boolean);
  } else if (req.query.id) {
    ids = [String(req.query.id)];
  } else {
    // Default: the 5 canceled brackets from 2026-04-20 morning that we need to diagnose
    ids = ['122441181','122441188','122441200','122441205','122441250'];
  }

  const results = await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(`${base}/accounts/${account}/orders/${id}?includeTags=true`, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
      });
      const body = await r.json();
      return { id, http_status: r.status, body };
    } catch (e) {
      return { id, error: String(e) };
    }
  }));

  return res.status(200).json({
    account: usePaper ? 'PAPER' : 'LIVE',
    endpoint: 'GET /accounts/{id}/orders/{order_id}',
    ids_queried: ids,
    results,
  });
}
