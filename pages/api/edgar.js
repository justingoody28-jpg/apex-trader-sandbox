export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  try {
    const tickersRes = await fetch('https://www.sec.gov/files/company_tickers_exchange.json', {
      headers: { 'User-Agent': 'ApexTrader/1.0 contact@apextrader.app' }
    });
    const tickersData = await tickersRes.json();
    const match = (tickersData.data || []).find(row => row[2] && row[2].toUpperCase() === ticker.toUpperCase());
    if (!match) return res.status(404).json({ error: 'CIK not found', ticker });
    const cik = String(match[0]).padStart(10, '0');
    const factsRes = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: { 'User-Agent': 'ApexTrader/1.0 contact@apextrader.app' }
    });
    const facts = await factsRes.json();
    const gaap = facts.facts?.['us-gaap'] || {};
    const revenueKey = ['Revenues','RevenueFromContractWithCustomerExcludingAssessedTax','SalesRevenueNet','RevenueFromContractWithCustomerIncludingAssessedTax'].find(k => gaap[k]);
    const netIncomeKey = ['NetIncomeLoss','ProfitLoss','NetIncome'].find(k => gaap[k]);
    let revenues = [], netIncome = [];
    if (revenueKey && gaap[revenueKey]) {
      revenues = (gaap[revenueKey].units.USD || []).filter(f => f.form === '10-K' && f.fp === 'FY').sort((a,b) => a.end > b.end ? 1 : -1).slice(-3).map(r => ({ year: r.end?.slice(0,4), val: r.val }));
    }
    if (netIncomeKey && gaap[netIncomeKey]) {
      netIncome = (gaap[netIncomeKey].units.USD || []).filter(f => f.form === '10-K' && f.fp === 'FY').sort((a,b) => a.end > b.end ? 1 : -1).slice(-2).map(r => ({ year: r.end?.slice(0,4), val: r.val }));
    }
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.json({ ticker, cik, revenues, netIncome });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}