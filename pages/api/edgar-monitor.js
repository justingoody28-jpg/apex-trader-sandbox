// pages/api/edgar-monitor.js — SEC EDGAR Dilution Risk Scanner v3
// Uses data.sec.gov submissions API for exact ticker matching (free, no key needed)
// Scans all tickers in your config for S-3, 424B, and 8-K filings in the last 5 days
//
// v3: Added CIK override table for tickers that map incorrectly in company_tickers.json

const DILUTION_FORMS = new Set(['S-3','S-3ASR','424B1','424B2','424B3','424B4','424B5']);
const ATM_KEYWORDS = ['at-the-market', 'atm program', 'equity offering', 'shelf offering', 'registered direct'];

// Manual CIK overrides for tickers that don't resolve correctly from company_tickers.json
// CIK is zero-padded to 10 digits
const CIK_OVERRIDES = {
  'RCKT': '0001272830', // Rocket Pharmaceuticals -- confirmed CIK
  'SAVA': '0001372514', // Cassava Sciences
  'MNMD': '0001580149', // Mind Medicine (MindMed)
  'LAZR': '0001750153', // Luminar Technologies
  'FAT':  '0001701516', // FAT Brands
};

function daysBetween(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 86400000;
}

function isAtmKeyword(text) {
  const lower = (text || '').toLowerCase();
  return ATM_KEYWORDS.some(kw => lower.includes(kw));
}

async function getRecentFilings(cik, lookbackDays) {
  const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { 'User-Agent': 'APEX-Trader contact@apextrader.io' }
  });
  if (!r.ok) return [];

  const data = await r.json();
  const filings = data.filings && data.filings.recent;
  if (!filings) return [];

  const { form, filingDate, primaryDocument, accessionNumber, primaryDocDescription } = filings;
  const results = [];

  for (let i = 0; i < form.length; i++) {
    const filed = filingDate[i];
    if (daysBetween(filed) > lookbackDays) continue;

    const formType = form[i];
    const desc = (primaryDocDescription[i] || '').toLowerCase();
    const accession = (accessionNumber[i] || '').replace(/-/g, '');
    const docUrl = accession
      ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accession}/${primaryDocument[i] || ''}`
      : '';

    if (DILUTION_FORMS.has(formType)) {
      results.push({
        formType,
        filedAt: filed,
        description: primaryDocDescription[i] || '',
        docUrl,
        riskLevel: formType.startsWith('424B') ? 'HIGH' : 'MEDIUM',
        note: formType.startsWith('424B')
          ? 'Prospectus supplement -- shares being sold NOW. Watch for gap-down next morning.'
          : 'Shelf registration filed -- future dilution authorized. ATM or follow-on offering likely.',
      });
    } else if (formType === '8-K' && isAtmKeyword(desc)) {
      results.push({
        formType: '8-K (ATM/Offering)',
        filedAt: filed,
        description: primaryDocDescription[i] || '',
        docUrl,
        riskLevel: 'HIGH',
        note: 'ATM program or offering announced in 8-K. Strong dilution signal -- short gap-down next session.',
      });
    }
  }

  return results;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const lookbackDays = parseInt(req.query.days) || 5;

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

  // Load CIK map -- one fetch covers all tickers, overrides take priority
  let cikMap = { ...CIK_OVERRIDES };
  try {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'APEX-Trader contact@apextrader.io' }
    });
    if (r.ok) {
      const data = await r.json();
      Object.values(data).forEach(c => {
        const sym = c.ticker.toUpperCase();
        if (!CIK_OVERRIDES[sym]) {
          cikMap[sym] = String(c.cik_str).padStart(10, '0');
        }
      });
    }
  } catch (_) {}

  const flags = [];
  const notFound = [];
  const errors = [];

  for (const sym of tickers) {
    const cik = cikMap[sym];
    if (!cik) { notFound.push(sym); continue; }

    try {
      const filings = await getRecentFilings(cik, lookbackDays);
      for (const f of filings) {
        flags.push({ symbol: sym, cik: parseInt(cik), ...f });
      }
      await new Promise(r => setTimeout(r, 150));
    } catch (e) {
      errors.push({ symbol: sym, error: e.message });
    }
  }

  const highRisk   = flags.filter(f => f.riskLevel === 'HIGH');
  const mediumRisk = flags.filter(f => f.riskLevel === 'MEDIUM');

  return res.status(200).json({
    timestamp:    new Date().toISOString(),
    lookbackDays,
    summary: {
      tickersScanned:  tickers.length,
      tickersNotFound: notFound.length,
      totalFlags:  flags.length,
      highRisk:    highRisk.length,
      mediumRisk:  mediumRisk.length,
      errors:      errors.length,
    },
    highRiskFlags:   highRisk,
    mediumRiskFlags: mediumRisk,
    notFound,
    errors,
    usage: 'HIGH = shares being sold now (424B) or ATM/offering in 8-K. MEDIUM = shelf filed (S-3). ' +
           'Cross-reference with recent 10%+ gap-ups. If both match, watch for short on next-session gap-down.',
  });
}
