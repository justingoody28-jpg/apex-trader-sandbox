export default async function handler(req, res) {
  const live = req.query.account === 'live' || true; // always check live
  const token   = live ? process.env.TRADIER_TOKEN       : process.env.TRADIER_PAPER_TOKEN;
  const account = live ? process.env.TRADIER_ACCOUNT_ID  : process.env.TRADIER_PAPER_ACCOUNT_ID;
  const base    = live ? 'https://api.tradier.com/v1'    : 'https://sandbox.tradier.com/v1';

  const r = await fetch(`${base}/accounts/${account}/orders`, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  const d = await r.json();
  const orders = d?.orders?.order || [];
  const arr = Array.isArray(orders) ? orders : (orders ? [orders] : []);
  const todayStr = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'})).toISOString().slice(0,10);
  const todayOrders = arr.filter(o => o.create_date?.startsWith(todayStr));
  return res.status(200).json({
    account: live ? 'LIVE' : 'PAPER',
    total: arr.length,
    todayCount: todayOrders.length,
    todayOrders: todayOrders.map(o => ({
      id: o.id, symbol: o.symbol, status: o.status,
      create_date: o.create_date, type: o.type, side: o.side, qty: o.quantity
    })),
    allStatuses: [...new Set(arr.map(o=>o.status))]
  });
}
