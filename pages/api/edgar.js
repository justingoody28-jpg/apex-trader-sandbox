export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { ticker } = req.query;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });

  try {
    // Step 1: Look up CIK from ticker using EDGAR company search
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&forms=10-K&dateRange=custom&startdt=2020-01-01`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': 'ApexTrader/1.0 contact@apextrader.app' }
    });
    const searchData = await searchRes.json();
    
    // Find the exact ticker match
    const hit = (searchData.hits?.hits || []).find(h => 
      h._source?.period_of_report && h._source?.entity_name
    );
    
    if (!hit) {
      // Fallback: try direct CIK lookup via company_tickers_exchange
      const tickerUrl = `https://data.sec.gov/submissions/CIK${ticker}.json`;
      return res.status(404).json({ error: 'CIK not found', ticker });
    }

    const cik = hit._source.file_num?.replace('0-', '') || '';
    const entityCik = hit._id?.split(':')[0] || '';
    
    // Step 2: Use the padded CIK to fetch company facts
    const paddedCik = entityCik.padStart(10, '0');
    const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${paddedCik}.json`;
    const factsRes = await fetch(factsUrl, {
      headers: { 'User-Agent': 'ApexTrader/1.0 contact@apextrader.app' }
    });
    const facts = await factsRes.json();

    // Extract revenue - try multiple GAAP keys
    const gaap = facts.facts?.['us-gaap'] || {};
    const revenueKey = ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 
      'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'].find(k => gaap[k]);
    
    const netIncomeKey = ['NetIncomeLoss', 'ProfitLoss', 'NetIncome'].find(k => gaap[k]);
    
    let revenues = [], netIncome = [];
    
    if (revenueKey && gaap[revenueKey]) {
      revenues = gaap[revenueKey].units.USD
        .filter(f => f.form === '10-K' && f.fp === 'FY')
        .slice(-3)
        .map(r => ({ year: r.end?.slice(0,4), val: r.val }));
    }
    
    if (netIncomeKey && gaap[netIncomeKey]) {
      netIncome = gaap[netIncomeKey].units.USD
        .filter(f => f.form === '10-K' && f.fp === 'FY')
        .slice(-2)
        .map(r => ({ year: r.end?.slice(0,4), val: r.val }));
    }

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.json({ ticker, cik: paddedCik, revenues, netIncome });
    
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
