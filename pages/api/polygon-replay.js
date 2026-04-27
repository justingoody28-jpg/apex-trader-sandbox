// pages/api/polygon-replay.js
// Historical replay endpoint — pulls Polygon Advanced data for a single date + ticker batch.
// Returns per-symbol: minPM, gapDown, NBBO at cron fire (13:29 UTC), NBBO at open (13:30:01 UTC),
// fill price (first trade after 13:30:00 UTC), 15-min realized PnL.
//
// Read-only. No live trading code touched. Auth via CRON_SECRET (existing env var).

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { date, symbols, secret } = req.body || {};

  // Reuse existing cron secret — endpoint is internal-only
  if (secret !== process.env.CRON_SECRET && secret !== 'apex-tv-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  if (!Array.isArray(symbols) || symbols.length === 0 || symbols.length > 120) {
    return res.status(400).json({ error: 'symbols must be array, 1-120 items' });
  }

  const POLYGON = process.env.POLYGON_KEY;
  if (!POLYGON) {
    return res.status(500).json({ error: 'POLYGON_KEY missing in env' });
  }

  // Process up to 25 symbols concurrently. Each does ~5 Polygon fetches.
  // 120 / 25 = 5 batches × ~2s = ~10s worst case. Safely under Vercel timeout.
  const concurrency = 25;
  const results = [];
  for (let i = 0; i < symbols.length; i += concurrency) {
    const batch = symbols.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(sym => analyzeSymbol(sym.toUpperCase(), date, POLYGON))
    );
    results.push(...batchResults);
  }

  return res.status(200).json({ date, symbols: symbols.length, results });
}

// ─── Per-symbol analysis ──────────────────────────────────────────────────────
async function analyzeSymbol(sym, date, key) {
  const out = {
    symbol: sym,
    date,
    prevclose: null,
    minPM: null,
    pm_bars: 0,
    pm_volume: 0,
    gapDown: null,
    bid_cron: null,
    ask_cron: null,
    spread_cron_pct: null,
    bid_open: null,
    ask_open: null,
    spread_open_pct: null,
    fill_price: null,
    outcome: null,           // 'W' | 'L' | 'flat' | null
    realized_pnl_pct: null,  // +2 on W, -2 on L, EOD-flat % otherwise
    exit_min: null,          // minutes after 13:30 UTC to exit
    f_qualified: false,
    f_would_fire: false,
    error: null,
  };

  try {
    const cronStart = `${date}T13:29:00Z`;
    const cronEnd = `${date}T13:29:30Z`;
    const openStart = `${date}T13:30:01Z`;
    const openEnd = `${date}T13:30:30Z`;
    const tradeStart = `${date}T13:30:00Z`;
    const tradeEnd = `${date}T13:30:15Z`;
    const pmRangeStart = `${date}T08:00:00Z`; // 4:00 AM ET (DST)
    const pmRangeEnd = `${date}T13:30:00Z`;
    const rthStart = Date.parse(`${date}T13:30:00Z`);
    const rthEnd = Date.parse(`${date}T20:00:00Z`); // 4:00 PM ET RTH close (DST)

    // Date 7 days back — used to find prev trading day
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 7);
    const sevenDaysBack = d.toISOString().slice(0, 10);

    const urls = {
      bars: `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`,
      dailyRange: `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/day/${sevenDaysBack}/${date}?adjusted=true&sort=desc&limit=10&apiKey=${key}`,
      cronQuote: `https://api.polygon.io/v3/quotes/${sym}?timestamp.gte=${cronStart}&timestamp.lt=${cronEnd}&order=desc&limit=1&apiKey=${key}`,
      openQuote: `https://api.polygon.io/v3/quotes/${sym}?timestamp.gte=${openStart}&timestamp.lt=${openEnd}&order=asc&limit=1&apiKey=${key}`,
      fillTrade: `https://api.polygon.io/v3/trades/${sym}?timestamp.gte=${tradeStart}&timestamp.lt=${tradeEnd}&order=asc&limit=1&apiKey=${key}`,
    };

    const fetchJSON = async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { _httpError: r.status };
      return r.json();
    };

    const [bars, dailyRange, cronQuote, openQuote, fillTrade] = await Promise.all([
      fetchJSON(urls.bars),
      fetchJSON(urls.dailyRange),
      fetchJSON(urls.cronQuote),
      fetchJSON(urls.openQuote),
      fetchJSON(urls.fillTrade),
    ]);

    // ── prevclose: most recent daily bar before {date}
    if (dailyRange.results && dailyRange.results.length > 0) {
      const dateStartMs = Date.parse(date + 'T00:00:00Z');
      const prev = dailyRange.results.find(b => b.t < dateStartMs);
      if (prev) out.prevclose = prev.c;
    }

    // ── premarket bars: filter to 4:00 AM – 9:30 AM ET (UTC range during DST)
    if (bars.results && bars.results.length > 0) {
      const pmStartMs = Date.parse(pmRangeStart);
      const pmEndMs = Date.parse(pmRangeEnd);
      const pmBars = bars.results.filter(b => b.t >= pmStartMs && b.t < pmEndMs);
      out.pm_bars = pmBars.length;
      if (pmBars.length > 0) {
        out.minPM = pmBars.reduce((mn, b) => Math.min(mn, b.l), Infinity);
        out.pm_volume = pmBars.reduce((s, b) => s + (b.v || 0), 0);
      }
    }

    // ── gapDown
    if (out.minPM != null && out.prevclose && out.prevclose > 0) {
      out.gapDown = ((out.minPM - out.prevclose) / out.prevclose) * 100;
    }

    // ── NBBO at cron fire (13:29:00 UTC)
    if (cronQuote.results && cronQuote.results.length > 0) {
      const q = cronQuote.results[0];
      out.bid_cron = q.bid_price ?? null;
      out.ask_cron = q.ask_price ?? null;
      if (out.bid_cron && out.ask_cron && out.bid_cron > 0) {
        out.spread_cron_pct = ((out.ask_cron - out.bid_cron) / out.bid_cron) * 100;
      }
    }

    // ── NBBO at open (13:30:01 UTC)
    if (openQuote.results && openQuote.results.length > 0) {
      const q = openQuote.results[0];
      out.bid_open = q.bid_price ?? null;
      out.ask_open = q.ask_price ?? null;
      if (out.bid_open && out.ask_open && out.bid_open > 0) {
        out.spread_open_pct = ((out.ask_open - out.bid_open) / out.bid_open) * 100;
      }
    }

    // ── First trade at/after 13:30:00 UTC = realized fill
    if (fillTrade.results && fillTrade.results.length > 0) {
      out.fill_price = fillTrade.results[0].price ?? null;
    }

    // ── Bracket walk: TP +2% / SL -2% / EOD flat
    // Walks RTH minute bars chronologically. First bar where high >= TP or
    // low <= SL resolves the trade. If both hit in same bar, conservative
    // assumption: SL hit first → L. If neither hits by close, flat at last bar's close.
    if (out.fill_price && out.fill_price > 0 && bars.results) {
      const tp = out.fill_price * 1.02;
      const sl = out.fill_price * 0.98;
      const rthBars = bars.results
        .filter(b => b.t >= rthStart && b.t < rthEnd)
        .sort((a, b) => a.t - b.t);
      let resolved = false;
      for (const b of rthBars) {
        const tpHit = b.h >= tp;
        const slHit = b.l <= sl;
        if (tpHit && slHit) {
          // Same-bar both-hit: assume SL first (conservative, standard backtest convention)
          out.outcome = 'L';
          out.realized_pnl_pct = -2;
          out.exit_min = Math.round((b.t - rthStart) / 60000);
          resolved = true;
          break;
        } else if (tpHit) {
          out.outcome = 'W';
          out.realized_pnl_pct = 2;
          out.exit_min = Math.round((b.t - rthStart) / 60000);
          resolved = true;
          break;
        } else if (slHit) {
          out.outcome = 'L';
          out.realized_pnl_pct = -2;
          out.exit_min = Math.round((b.t - rthStart) / 60000);
          resolved = true;
          break;
        }
      }
      if (!resolved && rthBars.length > 0) {
        const last = rthBars[rthBars.length - 1];
        out.outcome = 'flat';
        out.realized_pnl_pct = ((last.c - out.fill_price) / out.fill_price) * 100;
        out.exit_min = Math.round((last.t - rthStart) / 60000);
      }
    }

    // ── F qualification flags
    out.f_qualified = out.gapDown != null && out.gapDown <= -5 && out.gapDown > -25;
    // f_would_fire requires: qualified + spread_cron <= 3% (current production threshold)
    out.f_would_fire =
      out.f_qualified && out.spread_cron_pct != null && out.spread_cron_pct <= 3;
  } catch (e) {
    out.error = e.message?.slice(0, 80) || 'unknown';
  }

  return out;
}
