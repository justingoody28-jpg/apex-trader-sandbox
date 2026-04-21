// Read-only diag endpoint: resolves Scenario F outcomes for the
// 2026-04-20 missed cohort (15 trades skipped after 10-trade cap).
//
// Pulls minute bars from Polygon, walks each bar from 9:31 ET forward,
// returns first-touch outcome (TP / SL / OPEN) for each ticker.
//
// No writes, no trade impact. Uses POLYGON_KEY env var.
//
// Usage: GET /api/resolve-cohort

const TRADES = [
  { sym: 'PH',   entry: 980.03,  tp: 999.63,  sl: 960.43 },
  { sym: 'J',    entry: 128.76,  tp: 131.34,  sl: 126.18 },
  { sym: 'UMBF', entry: 122.65,  tp: 125.10,  sl: 120.20 },
  { sym: 'WTFC', entry: 147.38,  tp: 150.33,  sl: 144.43 },
  { sym: 'FFIN', entry: 32.41,   tp: 33.06,   sl: 31.76  },
  { sym: 'TREX', entry: 42.32,   tp: 43.17,   sl: 41.47  },
  { sym: 'PRAX', entry: 342.68,  tp: 349.53,  sl: 335.83 },
  { sym: 'BOOT', entry: 162.87,  tp: 166.13,  sl: 159.61 },
  { sym: 'DOV',  entry: 218.32,  tp: 222.69,  sl: 213.95 },
  { sym: 'ODFL', entry: 216.21,  tp: 220.53,  sl: 211.89 },
  { sym: 'WAT',  entry: 326.78,  tp: 333.32,  sl: 320.24 },
  { sym: 'TRGP', entry: 233.85,  tp: 238.53,  sl: 229.17 },
  { sym: 'RPM',  entry: 109.17,  tp: 111.35,  sl: 106.99 },
  { sym: 'RBC',  entry: 586.79,  tp: 598.53,  sl: 575.05 },
  { sym: 'HAYW', entry: 15.40,   tp: 15.71,   sl: 15.09  },
];

const DATE = '2026-04-20';

function etH(timestampMs) {
  const d = new Date(new Date(timestampMs).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return d.getHours() + d.getMinutes() / 60;
}

async function fetchBars(sym, key) {
  const url = `https://api.polygon.io/v2/aggs/ticker/${sym}/range/1/minute/${DATE}/${DATE}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Polygon ${r.status}`);
  const d = await r.json();
  return Array.isArray(d.results) ? d.results : [];
}

function resolveLong(bars, entry, tp, sl) {
  for (const b of bars) {
    const h = etH(b.t);
    if (h < 9.5167) continue;
    if (h >= 16) break;
    const hitTP = b.h >= tp;
    const hitSL = b.l <= sl;
    if (hitTP && hitSL) return { outcome: 'AMBIG', t: b.t, note: 'TP+SL same bar (assume SL first)' };
    if (hitTP) return { outcome: 'WIN', t: b.t };
    if (hitSL) return { outcome: 'LOSS', t: b.t };
  }
  return { outcome: 'OPEN', t: bars.length ? bars[bars.length-1].t : null };
}

export default async function handler(req, res) {
  const key = process.env.POLYGON_KEY;
  if (!key) return res.status(500).json({ error: 'POLYGON_KEY not set' });

  const results = [];
  for (const t of TRADES) {
    try {
      const bars = await fetchBars(t.sym, key);
      const tradingBars = bars.filter(b => {
        const h = etH(b.t);
        return h >= 9.5167 && h < 16;
      });

      const bar931 = tradingBars[0];
      const actual931Open = bar931 ? bar931.o : null;
      const entryDeltaPct = actual931Open ? ((actual931Open - t.entry) / t.entry * 100) : null;

      const outcome = resolveLong(tradingBars, t.entry, t.tp, t.sl);
      const closeBar = tradingBars[tradingBars.length - 1];
      const dayHigh = tradingBars.length ? Math.max(...tradingBars.map(b => b.h)) : null;
      const dayLow  = tradingBars.length ? Math.min(...tradingBars.map(b => b.l))  : null;

      results.push({
        sym: t.sym,
        entry: t.entry,
        tp: t.tp,
        sl: t.sl,
        actual931Open,
        entryDeltaPct: entryDeltaPct !== null ? Number(entryDeltaPct.toFixed(2)) : null,
        outcome: outcome.outcome,
        outcomeTimeUTC: outcome.t ? new Date(outcome.t).toISOString().slice(11, 16) : null,
        dayHigh,
        dayLow,
        close: closeBar ? closeBar.c : null,
        bars: tradingBars.length,
        note: outcome.note || null,
      });
      // Polite delay
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      results.push({ sym: t.sym, error: e.message });
    }
  }

  // Tally
  let wins = 0, losses = 0, opens = 0, errs = 0, ambig = 0;
  for (const r of results) {
    if (r.error) errs++;
    else if (r.outcome === 'WIN') wins++;
    else if (r.outcome === 'LOSS') losses++;
    else if (r.outcome === 'AMBIG') { losses++; ambig++; }
    else if (r.outcome === 'OPEN') opens++;
  }
  const locked = wins + losses;
  const wrLocked = locked > 0 ? Number((wins / locked * 100).toFixed(1)) : null;

  return res.status(200).json({
    date: DATE,
    cohortSize: TRADES.length,
    summary: { wins, losses, opens, errs, ambig, wrLockedPct: wrLocked },
    methodology: 'TP +2% / SL -2%, first-touch on minute bars from 9:31 ET. AMBIG = TP & SL hit in same bar (counted as LOSS).',
    results,
  });
}
