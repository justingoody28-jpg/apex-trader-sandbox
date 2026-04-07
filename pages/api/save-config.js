// pages/api/save-config.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { riskControls } = req.body || {};
  if (!riskControls) return res.status(400).json({ error: 'riskControls required' });
  const PAT = process.env.GITHUB_PAT;
  const REPO = 'justingoody28-jpg/apex-trader-sandbox';
  const PATH = 'public/auto-trade-config.json';
  const API = `https://api.github.com/repos/${REPO}/contents/${PATH}`;
  const headers = { 'Authorization': `token ${PAT}`, 'Accept': 'application/json', 'Content-Type': 'application/json' };
  try {
    const fr = await fetch(API, { headers });
    const fd = await fr.json();
    if (!fd.sha) return res.status(500).json({ error: 'Could not fetch config', detail: fd });
    const bytes = Uint8Array.from(atob(fd.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    const cfg = JSON.parse(new TextDecoder().decode(bytes));
    cfg.riskControls = {
      live: riskControls.live === true,
      maxTradesPerDay: parseInt(riskControls.maxTradesPerDay) || 5,
      maxBetOverride: (riskControls.maxBetOverride !== null && riskControls.maxBetOverride !== undefined) ? parseFloat(riskControls.maxBetOverride) : null,
      maxDailyExposure: parseFloat(riskControls.maxDailyExposure) || 1250,
      betByScenario: riskControls.betByScenario || {},
    };
    const enc = new TextEncoder().encode(JSON.stringify(cfg, null, 2));
    const chunks = [];
    for (let i = 0; i < enc.length; i += 3000) { const c = enc.slice(i,i+3000); chunks.push(btoa(Array.from(c).map(b=>String.fromCharCode(b)).join(''))); }
    const mode = cfg.riskControls.live ? 'LIVE' : 'PAPER';
    const msg = `config: ${mode} maxTrades=${cfg.riskControls.maxTradesPerDay} maxBet=${cfg.riskControls.maxBetOverride} exposure=${cfg.riskControls.maxDailyExposure}`;
    const wr = await fetch(API, { method:'PUT', headers, body: JSON.stringify({ message:msg, content:chunks.join(''), sha:fd.sha }) });
    const wd = await wr.json();
    if (wd?.commit?.sha) return res.status(200).json({ ok:true, sha:wd.commit.sha, mode, riskControls:cfg.riskControls });
    return res.status(500).json({ error:'Commit failed', detail:wd });
  } catch(e) { return res.status(500).json({ error: e.message }); }
}