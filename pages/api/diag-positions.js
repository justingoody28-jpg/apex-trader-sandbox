// pages/api/diag-positions.js — show live open positions
export default async function handler(req, res) {
  const token   = process.env.TRADIER_TOKEN;
  const account = process.env.TRADIER_ACCOUNT_ID;
  const base    = 'https://api.tradier.com/v1';
  const [pR, oR] = await Promise.all([
    fetch(`${base}/accounts/${account}/positions`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }),
    fetch(`${base}/accounts/${account}/orders?includeTags=true`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } }),
  ]);
  const pd = await pR.json();
  const od = await oR.json();
  const positions = pd?.positions?.position;
  const posArr = Array.isArray(positions) ? positions : (positions ? [positions] : []);
  const orders = od?.orders?.order;
  const ordArr = Array.isArray(orders) ? orders : (orders ? [orders] : []);
  const todayStr = new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'})).toISOString().slice(0,10);
  const todayOrders = ordArr.filter(o => o.create_date?.startsWith(todayStr));
  return res.status(200).json({
    positions: posArr,
    todayOrdersFull: todayOrders,  // full objects including class, num_legs, leg arrays
  });
}
