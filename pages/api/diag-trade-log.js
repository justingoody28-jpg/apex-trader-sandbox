// pages/api/diag-trade-log.js — query today's apex_trade_log rows
export default async function handler(req, res) {
  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const H = { apikey: sbKey, Authorization: 'Bearer ' + sbKey };
  const r = await fetch(
    `${sbUrl}/rest/v1/apex_trade_log?run_at=gte.2026-04-17T00:00:00&order=id.desc&limit=100`,
    { headers: H }
  );
  const data = await r.json();
  return res.status(200).json(data);
}
