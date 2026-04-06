import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const GITHUB_PAT = process.env.GITHUB_PAT;
const REPO = 'justingoody28-jpg/apex-trader-sandbox';
const CONFIG_PATH = 'public/auto-trade-config.json';

function kellyBet(w, l, pf, accountSize = 50000) {
  const n = w + l;
  if (n < 5 || pf <= 0) return 500;
  const wr = w / n;
  const rr = pf;
  const kelly = Math.max(0, wr - (1 - wr) / rr);
  const halfKelly = kelly * 0.5;
  return Math.round(Math.max(250, Math.min(2000, halfKelly * accountSize)) / 50) * 50;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    // 1. Get active tickers from apex_watchlist
    const { data: wlData, error: wlErr } = await supabase
      .from('apex_watchlist').select('active,excluded').eq('id', 'default').single();
    if (wlErr) throw new Error('Watchlist read failed: ' + wlErr.message);
    const activeSet = new Set(wlData.active || []);

    // 2. Get most recent snapshot for Kelly sizing
    const { data: snaps, error: snapErr } = await supabase
      .from('apex_backtest_snapshots').select('rows,label').order('saved_at', { ascending: false }).limit(1);
    if (snapErr) throw new Error('Snapshot read failed: ' + snapErr.message);
    const snapRows = snaps?.[0]?.rows || [];
    const snapLabel = snaps?.[0]?.label || 'unknown';

    // 3. Build ticker list with Kelly bets — only active tickers
    const tickers = [...activeSet].map(symbol => {
      const row = snapRows.find(r => r.tk === symbol);
      if (!row) return { symbol, bet: 500 };
      // Use E scenario data for Kelly sizing (primary scenario)
      const e = row.e;
      const bet = (e && e.n >= 5) ? kellyBet(e.w, e.l, e.pf) : 500;
      return { symbol, bet };
    }).filter(t => t.symbol);

    // 4. Read current config from GitHub
    const cfgRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${CONFIG_PATH}`, {
      headers: { Authorization: `token ${GITHUB_PAT}` }
    });
    const cfgData = await cfgRes.json();
    const existing = JSON.parse(Buffer.from(cfgData.content, 'base64').toString());

    // 5. Update config with new tickers and Kelly bets
    existing.tickers = tickers;
    existing.count = tickers.length;
    existing.updated = new Date().toISOString();
    existing._note = `Auto-synced from apex_watchlist (${tickers.length} tickers, Kelly from ${snapLabel})`;

    // 6. Write back to GitHub
    const encoded = Buffer.from(JSON.stringify(existing, null, 2)).toString('base64');
    const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${CONFIG_PATH}`, {
      method: 'PUT',
      headers: { Authorization: `token ${GITHUB_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `watchlist-sync: ${tickers.length} active tickers, Kelly from ${snapLabel}`, content: encoded, sha: cfgData.sha })
    });
    const putData = await putRes.json();
    if (!putData.commit) throw new Error('GitHub write failed: ' + JSON.stringify(putData).slice(0, 100));

    return res.status(200).json({ ok: true, tickers: tickers.length, kellySource: snapLabel, commit: putData.commit.sha.slice(0,8) });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}