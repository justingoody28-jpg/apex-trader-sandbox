export default async function handler(req, res) {
  const _pt = process.env.TRADIER_PAPER_TOKEN || process.env.TRADIER_TOKEN;
  const _pa = process.env.TRADIER_PAPER_ACCOUNT_ID || process.env.TRADIER_ACCOUNT_ID;
  const r = await fetch('https://sandbox.tradier.com/v1/accounts/' + _pa + '/orders', {
    headers: { Authorization: 'Bearer ' + _pt, Accept: 'application/json' }
  });
  const d = await r.json();
  const orders = d?.orders?.order || [];
  const arr = Array.isArray(orders) ? orders : (orders ? [orders] : []);
  const todayStr = '2026-04-06';
  const todayOrders = arr.filter(o => o.create_date?.startsWith(todayStr));
  return res.status(200).json({
    total: arr.length,
    todayCount: todayOrders.length,
    todayOrders: todayOrders.map(o => ({
      id: o.id, symbol: o.symbol, status: o.status,
      create_date: o.create_date, type: o.type, side: o.side, qty: o.quantity
    })),
    allStatuses: [...new Set(arr.map(o=>o.status))]
  });
}