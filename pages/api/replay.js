// Read-only replay endpoint. No orders. No state writes.
// Computes minPM-based F/E signals for any past date against active watchlist.
// Browser hit → HTML results page. ?format=json → JSON.
//
// Usage: /api/replay?date=2026-04-24
//        /api/replay?date=2026-04-24&maxSpread=3&maxPmAge=60&fGapMin=5&fGapMax=25

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

const POLYGON = 'https://api.polygon.io';
const CAP_MAP = { Lg: 'Large', Large: 'Large', Mid: 'Mid', SM: 'Small/Micro', Small: 'Small/Micro', Micro: 'Small/Micro' };

async function fetchJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: 'fetch_err', err: e.name };
  }
}

async function getMinuteBars(ticker, ymd, key) {
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${ymd}/${ymd}?adjusted=true&sort=asc&limit=5000&apiKey=${key}`;
  const r = await fetchJSON(url, 10000);
  if (!r.ok) return { error: 'bars_' + r.status };
  return { bars: r.data.results || [] };
}

async function getPrevClose(ticker, ymd, key) {
  const [y, m, d] = ymd.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, d) - 14 * 86400000;
  const startStr = new Date(startMs).toISOString().slice(0, 10);
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${startStr}/${ymd}?adjusted=true&sort=asc&apiKey=${key}`;
  const r = await fetchJSON(url, 10000);
  if (!r.ok) return { value: null, reason: 'pc_' + r.status };
  const days = r.data.results || [];
  if (!days.length) return { value: null, reason: 'pc_empty' };
  const targetMs = Date.UTC(y, m - 1, d);
  const prior = days.filter(b => b.t < targetMs);
  if (!prior.length) return { value: null, reason: 'pc_no_prior' };
  return { value: prior[prior.length - 1].c };
}

async function getNbboSpread(ticker, ymd, key) {
  const [y, m, d] = ymd.split('-').map(Number);
  const targetNs = BigInt(Date.UTC(y, m - 1, d, 13, 29, 0)) * 1000000n;
  const winNs = 300n * 1000000000n;
  const url = `${POLYGON}/v3/quotes/${encodeURIComponent(ticker)}?timestamp.gte=${targetNs - winNs}&timestamp.lte=${targetNs + winNs}&order=asc&limit=50&apiKey=${key}`;
  const r = await fetchJSON(url, 6000);
  if (!r.ok) return null;
  const quotes = (r.data && r.data.results) || [];
  let best = null, bestDelta = Infinity;
  for (const q of quotes) {
    if (!q.bid_price || !q.ask_price) continue;
    try {
      const delta = Math.abs(Number(targetNs - BigInt(q.sip_timestamp)));
      if (delta < bestDelta) { best = q; bestDelta = delta; }
    } catch (e) {}
  }
  if (!best) return null;
  const mid = (best.ask_price + best.bid_price) / 2;
  return mid > 0 ? ((best.ask_price - best.bid_price) / mid) * 100 : null;
}

async function processOne(t, ymd, key, p) {
  const r = { ticker: t.ticker, cap: t.cap, status: 'pending', reason: '', minPM: null, lastPM: null, prevC: null, gap: null, spreadPct: null, pmAge: null, scenario: null, tier: null };

  const [bars, pc] = await Promise.all([
    getMinuteBars(t.ticker, ymd, key),
    getPrevClose(t.ticker, ymd, key),
  ]);

  if (bars.error) { r.status = 'error'; r.reason = bars.error; return r; }
  if (!pc.value) { r.status = 'error'; r.reason = pc.reason; return r; }
  r.prevC = pc.value;

  const [y, mo, d] = ymd.split('-').map(Number);
  const openMs = Date.UTC(y, mo - 1, d, 13, 30, 0);
  const cronMs = Date.UTC(y, mo - 1, d, 13, 29, 0);
  const pm = (bars.bars || []).filter(b => b.t < openMs);

  if (pm.length === 0) { r.status = 'reject'; r.reason = 'pm_bars=0'; return r; }

  const minPM = Math.min(...pm.map(b => b.c));
  const lastPM = pm[pm.length - 1].c;
  const pmAge = +((cronMs - pm[pm.length - 1].t) / 60000).toFixed(2);
  r.minPM = +minPM.toFixed(2);
  r.lastPM = +lastPM.toFixed(2);
  r.pmAge = pmAge;

  if (pmAge > p.maxPmAge) { r.status = 'reject'; r.reason = `pm_age=${pmAge}>${p.maxPmAge}`; return r; }

  const gapF = ((minPM - r.prevC) / r.prevC) * 100;
  const gapE = ((lastPM - r.prevC) / r.prevC) * 100;

  if (gapF <= -p.fGapMin && gapF >= -p.fGapMax) {
    r.scenario = 'F'; r.gap = +gapF.toFixed(2);
  } else if (gapE >= 10) {
    r.scenario = 'E';
    r.tier = gapE >= 15 ? 'E4' : gapE >= 13 ? 'E3' : gapE >= 11 ? 'E2' : 'E1';
    r.gap = +gapE.toFixed(2);
  } else {
    r.status = 'no_signal';
    r.reason = `gapF=${gapF.toFixed(2)} gapE=${gapE.toFixed(2)}`;
    return r;
  }

  const sp = await getNbboSpread(t.ticker, ymd, key);
  if (sp !== null) r.spreadPct = +sp.toFixed(3);
  if (sp !== null && sp > p.maxSpread) {
    r.status = 'reject';
    r.reason = `spread=${sp.toFixed(2)}>${p.maxSpread}`;
    return r;
  }

  r.status = 'fire';
  return r;
}

function renderHTML(out, ymd, params) {
  const fired = out.filter(r => r.status === 'fire');
  const rejected = out.filter(r => r.status === 'reject');
  const noSig = out.filter(r => r.status === 'no_signal');
  const errors = out.filter(r => r.status === 'error');

  const rowFired = r => `<tr><td><b>${r.ticker}</b></td><td>${r.cap}</td><td>${r.scenario}</td><td>${r.tier || ''}</td><td>${r.prevC?.toFixed(2)}</td><td>${r.minPM}</td><td>${r.lastPM}</td><td style="color:${r.gap < 0 ? '#ef4444' : '#10b981'}">${r.gap}</td><td>${r.pmAge}</td><td>${r.spreadPct ?? '-'}</td></tr>`;
  const rowRej = r => `<tr><td>${r.ticker}</td><td>${r.cap}</td><td style="color:#f59e0b">${r.reason}</td><td>${r.scenario || ''}</td><td>${r.gap ?? '-'}</td><td>${r.pmAge ?? '-'}</td><td>${r.spreadPct ?? '-'}</td></tr>`;
  const rowErr = r => `<tr><td>${r.ticker}</td><td style="color:#ef4444">${r.reason}</td></tr>`;
  const rowNo = r => `<tr><td>${r.ticker}</td><td style="color:#6b7280">${r.reason}</td></tr>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>APEX Replay ${ymd}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;background:#0b0f17;color:#e5e7eb;margin:0;padding:20px;font-size:13px;}
  h3{margin-top:0;}
  h4{margin:20px 0 8px 0;}
  table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px;font-family:ui-monospace,monospace;}
  th,td{padding:5px 8px;border-bottom:1px solid #1a2838;text-align:left;}
  th{background:#0f1822;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;}
  details{margin-top:14px;}
  summary{cursor:pointer;color:#60a5fa;padding:6px 0;}
  .params{color:#6b7280;font-size:11px;margin-bottom:14px;font-family:ui-monospace,monospace;}
</style></head><body>
<h3>APEX Replay — ${ymd}</h3>
<div class="params">params: maxSpread=${params.maxSpread}% · maxPmAge=${params.maxPmAge}min · fGapMin=${params.fGapMin}% · fGapMax=${params.fGapMax}%</div>
<div style="margin:10px 0; font-size:14px;">
  <span style="color:#10b981">${fired.length} FIRED</span> ·
  <span style="color:#f59e0b">${rejected.length} rejected</span> ·
  <span style="color:#6b7280">${noSig.length} no signal</span> ·
  <span style="color:#ef4444">${errors.length} errors</span>
</div>
${fired.length ? `<h4 style="color:#10b981">FIRED (${fired.length})</h4>
<table><tr><th>Ticker</th><th>Cap</th><th>Scen</th><th>Tier</th><th>PrevC</th><th>minPM</th><th>lastPM</th><th>Gap%</th><th>PM age</th><th>Spread%</th></tr>
${fired.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).map(rowFired).join('')}</table>` : ''}
${rejected.length ? `<details open><summary style="color:#f59e0b">REJECTED (${rejected.length})</summary>
<table><tr><th>Ticker</th><th>Cap</th><th>Reason</th><th>Scen</th><th>Gap%</th><th>PM age</th><th>Spread%</th></tr>
${rejected.map(rowRej).join('')}</table></details>` : ''}
${errors.length ? `<details><summary style="color:#ef4444">ERRORS (${errors.length})</summary>
<table><tr><th>Ticker</th><th>Reason</th></tr>${errors.map(rowErr).join('')}</table></details>` : ''}
${noSig.length ? `<details><summary style="color:#6b7280">NO SIGNAL (${noSig.length})</summary>
<table><tr><th>Ticker</th><th>Detail</th></tr>${noSig.map(rowNo).join('')}</table></details>` : ''}
</body></html>`;
}

export default async function handler(req, res) {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).send('Required: ?date=YYYY-MM-DD');
  }

  const params = {
    maxSpread: +(req.query.maxSpread || 3),
    maxPmAge: +(req.query.maxPmAge || 60),
    fGapMin: +(req.query.fGapMin || 5),
    fGapMax: +(req.query.fGapMax || 25),
  };

  const POLYGON_KEY = process.env.POLYGON_KEY || process.env.POLYGON_API_KEY;
  if (!POLYGON_KEY) return res.status(500).send('POLYGON_KEY not set in env');

  // Load active watchlist
  const { data: wl, error: wlErr } = await supabase
    .from('apex_watchlist')
    .select('*')
    .eq('id', 'default')
    .single();

  if (wlErr || !wl) return res.status(500).send('Watchlist load failed: ' + (wlErr?.message || 'no data'));

  const meta = Array.isArray(wl.tickers) ? wl.tickers : [];
  const active = new Set(Array.isArray(wl.active) ? wl.active : []);
  if (!active.size) return res.status(500).send('Active watchlist is empty');

  const capBy = {};
  meta.forEach(t => { capBy[t.t] = CAP_MAP[t.g] || t.g; });
  const universe = [...active]
    .map(s => ({ ticker: s, cap: capBy[s] || 'Unknown' }))
    .filter(u => u.cap === 'Large' || u.cap === 'Mid');

  // Process in batches of 10 (Polygon Stocks Advanced = unlimited rate)
  const out = [];
  const BATCH = 10;
  for (let i = 0; i < universe.length; i += BATCH) {
    const slice = universe.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(t =>
      Promise.race([
        processOne(t, date, POLYGON_KEY, params),
        new Promise(r => setTimeout(() => r({ ticker: t.ticker, cap: t.cap, status: 'error', reason: 'timeout' }), 25000))
      ])
    ));
    out.push(...results);
  }

  if (req.query.format === 'json') {
    return res.status(200).json({
      date, params,
      universe: universe.length,
      fired: out.filter(r => r.status === 'fire'),
      rejected: out.filter(r => r.status === 'reject'),
      noSignal: out.filter(r => r.status === 'no_signal').length,
      errors: out.filter(r => r.status === 'error'),
    });
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(renderHTML(out, date, params));
}
