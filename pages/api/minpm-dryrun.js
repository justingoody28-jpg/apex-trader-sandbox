// pages/api/minpm-dryrun.js
//
// READ-ONLY dryrun of Scenarios E and F using the BACKTEST OPEN_EXT_V2 formula:
//   F (long gap-down): gap = (minPM − prevClose) / prevClose, threshold <= -5%
//   E (short gap-up):  gap = (lastPM − prevClose) / prevClose, threshold >= +10%
// where minPM = min(l) over all premkt bars, lastPM = close of last premkt bar.
//
// Applies the same filter gates as auto-trade-c:
//   - spread_gate: Tradier bid/ask spread < 3% (config override)
//   - pm_gate: must have >=1 premkt bar and lastBarAge <= 60 min
//
// Side-by-side comparison with current LIVE formula (gap = (bid − prevClose) / prevClose).
//
// GET /api/minpm-dryrun?date=YYYY-MM-DD  (default: today)
//   &maxSpreadPct=N  (default: 3)
//   &maxPmAgeMin=N   (default: 60)
//   &conc=N          (default: 10 parallel Polygon calls)
//
// Returns: { triggered_backtest: [...], triggered_live: [...], filter_rejects: [...], summary }

const CONFIG_URL = 'https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
  const POLYGON_KEY   = process.env.POLYGON_KEY;
  if (!TRADIER_TOKEN) return res.status(500).json({ error: 'TRADIER_TOKEN not set' });
  if (!POLYGON_KEY)   return res.status(500).json({ error: 'POLYGON_KEY not set' });

  const date = String(req.query.date || new Date().toISOString().split('T')[0]);
  const maxSpreadPct = Number(req.query.maxSpreadPct ?? 3);
  const maxPmAgeMin  = Number(req.query.maxPmAgeMin ?? 60);
  const CONC         = Math.max(1, Math.min(20, Number(req.query.conc ?? 10)));

  // ── Load config (tickers + scenarios) ────────────────────────────────────
  let config = null;
  try {
    const r = await fetch(CONFIG_URL + '?t=' + Date.now());
    config = await r.json();
  } catch (e) { return res.status(500).json({ error: 'config fetch failed', detail: e.message }); }
  const tickers = (config.tickers || []).map(t => ({ symbol: t.symbol.toUpperCase(), bet: t.bet || 500 }));
  if (!tickers.length) return res.status(200).json({ error: 'no tickers in config' });

  // ── Batch Tradier quotes (1 call) ────────────────────────────────────────
  const H = { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' };
  const symbols = tickers.map(t => t.symbol);
  const quoteMap = {};
  try {
    const r = await fetch(`https://api.tradier.com/v1/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    const data = await r.json();
    const raw  = data?.quotes?.quote;
    if (raw) { const arr = Array.isArray(raw) ? raw : [raw]; arr.forEach(q => { quoteMap[q.symbol] = q; }); }
  } catch (e) { return res.status(500).json({ error: 'tradier quote fetch failed', detail: e.message }); }

  // ── Helper: fetch premkt minute bars and compute minPM/lastPM + freshness ─
  async function fetchPremktStats(sym) {
    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;
      const r = await fetch(url);
      if (!r.ok) return { ok: false, reason: `polygon_${r.status}`, bars: 0 };
      const data = await r.json();
      const results = data.results || [];
      // Premkt only: before 13:30 UTC
      const premkt = results.filter(b => {
        const d = new Date(b.t);
        const h = d.getUTCHours(), m = d.getUTCMinutes();
        return h < 13 || (h === 13 && m < 30);
      });
      if (!premkt.length) return { ok: true, bars: 0, minPM: null, lastPM: null, lastBarAgeMin: null };
      const minPM  = Math.min(...premkt.map(b => b.l));
      const lastPM = premkt[premkt.length - 1].c;
      const lastBarT = premkt[premkt.length - 1].t;
      const now = Date.now();
      const lastBarAgeMin = (now - lastBarT) / 60000;
      return { ok: true, bars: premkt.length, minPM, lastPM, lastBarAgeMin, firstBarT: premkt[0].t, lastBarT };
    } catch (e) {
      return { ok: false, reason: 'polygon_exception', bars: 0, error: e.message };
    }
  }

  // ── Parallel fetch of premkt stats (concurrency-limited) ─────────────────
  const tickerResults = new Array(tickers.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= tickers.length) return;
      const sym = tickers[i].symbol;
      const q = quoteMap[sym];
      if (!q || !q.prevclose) { tickerResults[i] = { sym, reason: 'no_quote' }; continue; }
      const pm = await fetchPremktStats(sym);
      tickerResults[i] = { sym, q, pm, bet: tickers[i].bet };
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()));

  // ── Apply formulas + filters ─────────────────────────────────────────────
  const triggered_backtest = [];  // Triggered under backtest formula (minPM/lastPM)
  const triggered_live     = [];  // Triggered under current live formula (bid)
  const filter_rejects     = [];  // Signals blocked by spread_gate or pm_gate
  const no_signal          = [];  // Below thresholds under both formulas
  const skipped            = [];  // no_quote, missing data

  const scenariosF = config.scenarios?.F !== false;  // default true
  const scenariosE = config.scenarios?.E !== false;

  for (const tr of tickerResults) {
    if (!tr) continue;
    if (tr.reason === 'no_quote') { skipped.push({ sym: tr.sym, reason: 'no_quote' }); continue; }
    const { sym, q, pm, bet } = tr;
    const prevClose = q.prevclose;
    const bid = q.bid, ask = q.ask;
    const spreadPct = (bid > 0 && ask > 0) ? ((ask - bid) / bid) * 100 : null;
    const last = q.last || bid;

    // LIVE formula (current production)
    const gap_live = prevClose > 0 ? ((bid - prevClose) / prevClose) * 100 : 0;

    // BACKTEST formula — may be null if no premkt bars
    const gap_bt_F = (pm.ok && pm.minPM != null)  ? ((pm.minPM  - prevClose) / prevClose) * 100 : null;
    const gap_bt_E = (pm.ok && pm.lastPM != null) ? ((pm.lastPM - prevClose) / prevClose) * 100 : null;

    // Scenario matching under BACKTEST formula
    const fires_F_backtest = scenariosF && gap_bt_F != null && gap_bt_F <= -5 && gap_bt_F > -25;
    const fires_E_backtest = scenariosE && gap_bt_E != null && gap_bt_E >= 10;

    // Scenario matching under LIVE formula (for comparison)
    const fires_F_live = scenariosF && gap_live <= -5 && gap_live > -25;
    const fires_E_live = scenariosE && gap_live >= 10;

    // Filter gates
    const pm_ok     = pm.ok && pm.bars > 0 && pm.lastBarAgeMin <= maxPmAgeMin;
    const spread_ok = spreadPct != null && spreadPct <= maxSpreadPct;

    const rec = {
      sym, prevClose, bid, ask, last,
      spread_pct: spreadPct != null ? +spreadPct.toFixed(3) : null,
      pm_bars: pm.bars, pm_age_min: pm.lastBarAgeMin != null ? +pm.lastBarAgeMin.toFixed(1) : null,
      minPM: pm.minPM, lastPM: pm.lastPM,
      gap_live: +gap_live.toFixed(2),
      gap_backtest_F: gap_bt_F != null ? +gap_bt_F.toFixed(2) : null,
      gap_backtest_E: gap_bt_E != null ? +gap_bt_E.toFixed(2) : null,
      bet,
    };

    // If neither formula fires, skip cleanly
    if (!fires_F_backtest && !fires_E_backtest && !fires_F_live && !fires_E_live) {
      no_signal.push({ sym, gap_live: rec.gap_live, gap_bt_F: rec.gap_backtest_F, gap_bt_E: rec.gap_backtest_E });
      continue;
    }

    // Apply filters to any firing signal
    const filter_issues = [];
    if (!pm_ok)     filter_issues.push(pm.bars === 0 ? 'pm_gate:zero_bars' : `pm_gate:stale_${Math.round(pm.lastBarAgeMin||0)}min`);
    if (!spread_ok) filter_issues.push(`spread_gate:${spreadPct?.toFixed(2)}%`);

    const info = { ...rec };

    if (fires_F_backtest || fires_E_backtest) {
      const scen = fires_F_backtest ? 'F' : 'E';
      const gap  = fires_F_backtest ? rec.gap_backtest_F : rec.gap_backtest_E;
      const passes_filters = filter_issues.length === 0;
      triggered_backtest.push({ ...info, scenario: scen, gap_backtest: gap, passes_filters, filter_issues });
    }
    if (fires_F_live || fires_E_live) {
      const scen = fires_F_live ? 'F' : 'E';
      const gap  = fires_F_live ? rec.gap_live : rec.gap_live;
      const passes_filters = filter_issues.length === 0;
      triggered_live.push({ ...info, scenario: scen, gap_live: gap, passes_filters, filter_issues });
    }
    if (filter_issues.length && (fires_F_backtest || fires_E_backtest || fires_F_live || fires_E_live)) {
      filter_rejects.push({ sym, scenario: fires_F_backtest ? 'F' : fires_E_backtest ? 'E' : fires_F_live ? 'F' : 'E',
                            formula: fires_F_backtest || fires_E_backtest ? 'backtest' : 'live',
                            filter_issues, ...rec });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const bt_pass = triggered_backtest.filter(t => t.passes_filters);
  const live_pass = triggered_live.filter(t => t.passes_filters);

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    date,
    filters: { maxSpreadPct, maxPmAgeMin },
    summary: {
      total_tickers: tickers.length,
      quotes_ok: Object.keys(quoteMap).length,
      no_signal: no_signal.length,
      skipped: skipped.length,
      triggered_backtest_total: triggered_backtest.length,
      triggered_backtest_passes_filters: bt_pass.length,
      triggered_live_total: triggered_live.length,
      triggered_live_passes_filters: live_pass.length,
    },
    triggered_backtest: triggered_backtest.sort((a,b) => (a.gap_backtest ?? 0) - (b.gap_backtest ?? 0)),
    triggered_live: triggered_live.sort((a,b) => (a.gap_live ?? 0) - (b.gap_live ?? 0)),
    filter_rejects: filter_rejects.sort((a,b) => (a.gap_backtest_F ?? a.gap_live ?? 0) - (b.gap_backtest_F ?? b.gap_live ?? 0)),
  });
}
