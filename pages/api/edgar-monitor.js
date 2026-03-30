// pages/api/edgar-monitor.js — SEC EDGAR Dilution Risk Scanner
// Scans for S-3, 424B, and 8-K filings filed in the last 48 hours
// on your ticker list. Flags any that suggest shelf offerings or ATM programs.
// Run this each morning alongside the auto-traders to get a watchlist.
//
// Filing types that indicate dilution risk:
//   S-3     -- shelf registration (authorizes future stock sales)
//   S-3ASR  -- automatic shelf (large accelerated filers, same risk)
//   424B1-5 -- prospectus supplement (actual sale of shares happening NOW)
//   8-K     -- material event (could be ATM program, offering announcement)

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Load ticker list from config
  let tickers = [];
  try {
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json');
    if (!r.ok) throw new Error('Config fetch failed');
    const config = await r.json();
    tickers = (config.tickers || []).map(t => t.symbol.toUpperCase());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!tickers.length) return res.status(200).json({ message: 'No tickers', flags: [] });

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 2);
  const dateStr = cutoffDate.toISOString().slice(0, 10);

  const DILUTION_TYPES = ['S-3', 'S-3ASR', '424B1', '424B2', '424B3', '424B4', '424B5'];
  const flags = [];
  const errors = [];

  for (const sym of tickers) {
    try {
      const searchR = await fetch(
        `https://efts.sec.gov/LATEST/search-index?q=%22${sym}%22&dateRange=custom&startdt=${dateStr}&forms=${DILUTION_TYPES.join(',')}`,
        { headers: { 'User-Agent': 'APEX-Trader contact@apextrader.io', 'Accept': 'application/json' } }
      );

      if (!searchR.ok) continue;
      const searchData = await searchR.json();
      const hits = (searchData.hits && searchData.hits.hits) || [];

      for (const hit of hits) {
        const src = hit._source || {};
        const formType = src.form_type || '';
        const filedAt = src.file_date || '';
        const accession = src.accession_no || '';
        flags.push({
          symbol: sym,
          formType,
          filedAt,
          entityName: src.entity_name || '',
          description: src.file_description || '',
          accessionNo: accession,
          riskLevel: formType.startsWith('424B') ? 'HIGH' : 'MEDIUM',
          note: formType.startsWith('424B')
            ? 'Prospectus supplement -- shares being sold NOW. High dilution risk for next-day gap-down.'
            : 'Shelf registration -- future dilution authorized. Watch for follow-on ATM or offering.',
        });
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      errors.push({ symbol: sym, error: e.message });
    }
  }

  // Broader 8-K scan for ATM programs
  try {
    const atm8kR = await fetch(
      `https://efts.sec.gov/LATEST/search-index?q=%22at-the-market%22+%22offering%22&dateRange=custom&startdt=${dateStr}&forms=8-K`,
      { headers: { 'User-Agent': 'APEX-Trader contact@apextrader.io', 'Accept': 'application/json' } }
    );
    if (atm8kR.ok) {
      const atm8kData = await atm8kR.json();
      const hits8k = (atm8kData.hits && atm8kData.hits.hits) || [];
      for (const hit of hits8k) {
        const src = hit._source || {};
        const entity = (src.entity_name || '').toUpperCase();
        const matchedTicker = tickers.find(t => entity.includes(t) || (src.ticker || '').toUpperCase() === t);
        if (matchedTicker) {
          flags.push({
            symbol: matchedTicker,
            formType: '8-K (ATM)',
            filedAt: src.file_date || '',
            entityName: src.entity_name || '',
            description: 'At-the-market offering program mentioned in 8-K',
            riskLevel: 'HIGH',
            note: 'ATM program announced -- company can sell shares continuously. Strong dilution signal.',
          });
        }
      }
    }
  } catch (_) {}

  const highRisk = flags.filter(f => f.riskLevel === 'HIGH');
  const mediumRisk = flags.filter(f => f.riskLevel === 'MEDIUM');

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    scanPeriod: `${dateStr} to today`,
    summary: {
      tickersScanned: tickers.length,
      totalFlags: flags.length,
      highRisk: highRisk.length,
      mediumRisk: mediumRisk.length,
      errors: errors.length,
    },
    highRiskFlags: highRisk,
    mediumRiskFlags: mediumRisk,
    errors,
    usage: 'HIGH = shares being sold now (424B) or ATM announced (8-K). MEDIUM = shelf filed (S-3), watch for follow-on. Short the next-day gap-down if stock had 10%+ gap-up in prior 3 days.',
  });
}
