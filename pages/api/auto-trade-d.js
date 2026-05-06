export const config = {
  maxDuration: 120,
};

// pages/api/auto-trade-d.js — APEX v3.1 Trader (v6 — replaces v5)
//
// v6 CHANGES vs v5:
//   1. NBBO fetch window now uses min(now, 13:29 UTC) so dryruns work at any hour
//      (v5 always queried 12:29-13:29 UTC, returning null for any pre-cron call)
//   2. Pre-fetch retries failed tickers once after main pool completes
//      (rescues ~50-70% of Polygon transient timeouts at concurrency=30)
//   3. New ?bulk_verify=true mode walks watchlist and reports prevC + nbbo
//      health for every ticker — NO trades placed
//   4. Dryrun + bulk responses include skip_reasons summary so failures are visible
//   5. fetchPmAndDaily returns prevSource ('prev'|'walkback'|null) for diagnostics
//
// All other logic (rules, decision tree, Phase 1/2 ordering) is byte-for-byte v5.
//
// Cron: 13:29 UTC weekdays (Vercel cron, same time as c.js)
// Data + Execution: Tradier production API + Polygon NBBO + OTOCO bracket orders
//
// ARCHITECTURE:
//   - 3 universal stacks: F-FreeLunch, G, F-Stack-B (LCTS), F-Stack-C (Mid Cap)
//   - 41 personal rules: 26 FSpecial-C+ (production) + 13 FSpecial-C++ (LCTS) + 2 Mid Cap
//   - Phase 1/Phase 2 timing pattern (entry submit + bracket-after-fill)
//   - Per-trade $250 price filter, 4-trade daily cap ($1k max exposure)
//
// IMPORTANT — d.js coexists with c.js but only ONE should be live at a time.
// To disable c.js, set scenarios.E=false AND scenarios.F=false in
// public/auto-trade-config.json. d.js reads its own config from
// public/auto-trade-d-config.json (separate file).

// ─────────────────────────────────────────────────────────────────────────
// HARDCODED RULES (locked v3.1 spec — last updated 2026-05-03)
// ─────────────────────────────────────────────────────────────────────────

const PERSONAL_RULES = {
  // === FSpecial-C+ (26 production rules from v3 locked spec) ===
  'AMAT':  { feature: 'Nbbo13_29_SpreadPct', op: '>',  value: 0.8231 },
  'AMZN':  { feature: 'RecoveryATRsAtFire',  op: '>',  value: 0.402 },
  'ARQT':  { feature: 'PmRecoveryAtFire',    op: '>',  value: 1.543 },
  'CCL':   { feature: 'PmRangePct',          op: '<=', value: 2.184 },
  'CLF':   { feature: 'Rvol',                op: '<=', value: 0.08  },
  'COIN':  { feature: 'PmTraj10min',         op: '<=', value: -0.908 },
  'DDOG':  { feature: 'PmTraj3min',          op: '<=', value: -0.906 },
  'DHI':   { feature: 'LastPM',              op: '>',  value: 123.5 },
  'F':     { feature: 'Nbbo13_29_SpreadPct', op: '>',  value: 0.1599 },
  'GLW':   { feature: 'PmTraj5min',          op: '>',  value: 0.743 },
  'GOOGL': { feature: 'RecoveryATRsAtFire',  op: '>',  value: 0.54 },
  'HOOD':  { feature: 'Nbbo13_29_SpreadPct', op: '>',  value: 0.4077 },
  'IMVT':  { feature: 'Gap%',                op: '>',  value: -3.43 },
  'INTC':  { feature: 'Nbbo13_29_BidSize',   op: '<=', value: 100 },
  'IOVA':  { feature: 'PmBarCount',          op: '>',  value: 72 },
  'IQ':    { feature: 'Nbbo13_29_BidSize',   op: '>',  value: 10200 },
  'LRCX':  { feature: 'PmAgeAtCronMin',      op: '>',  value: 1 },
  'LSCC':  { feature: 'PmRangePct',          op: '<=', value: 3.699 },
  'NCLH':  { feature: 'Gap%',                op: '>',  value: -2.34 },
  'ONTO':  { feature: 'PmRecoveryAtFire',    op: '>',  value: 0.712 },
  'PANW':  { feature: 'Nbbo13_29_Bid',       op: '>',  value: 180.4 },
  'RMBS':  { feature: 'Gap%',                op: '<=', value: -4.65 },
  'SCCO':  { feature: 'PmRecoveryAtFire',    op: '>',  value: 1.776 },
  'TWLO':  { feature: 'PmRecoveryAtFire',    op: '>',  value: 2.086 },
  'VSCO':  { feature: 'Gap%',                op: '>',  value: -2.48 },
  'WDC':   { feature: 'PmTraj5min',          op: '>',  value: 0.777 },
  // === FSpecial-C++ (13 LCTS rules — new from 2026-05-03) ===
  'PINS':  { feature: 'RecoveryATRsAtFire',  op: '>',  value: 0.2396 },
  'DOCU':  { feature: 'PmVolFracAtLow',      op: '<=', value: 0.9482 },
  'SHOP':  { feature: 'PmRecoveryAtFire',    op: '>',  value: 1.993 },
  'QCOM':  { feature: 'Atr14',               op: '<=', value: 3.788 },
  'U':     { feature: 'DipATRs',             op: '<=', value: 0.368 },
  'TER':   { feature: 'PmBarCount',          op: '>',  value: 29.3 },
  'AFRM':  { feature: 'Nbbo13_29_BidSize',   op: '>',  value: 500 },
  'LYFT':  { feature: 'PmRangePct',          op: '<=', value: 2.644 },
  'MRVL':  { feature: 'PmRangePct',          op: '<=', value: 2.467 },
  'OKTA':  { feature: 'PmBarCount',          op: '>',  value: 21 },
  'FSLR':  { feature: 'Nbbo13_29_AskSize',   op: '>',  value: 100 },
  'SNOW':  { feature: 'Rvol',                op: '<=', value: 0.161 },
  'RBLX':  { feature: 'PmVol',               op: '<=', value: 37500 },
  // === Mid Cap personal rules (NEW v3.1.1) ===
  'AMKR':  { feature: 'PmRecoveryAtFire',    op: '>',  value: 2.933 },
  'S':     { feature: 'PmBarCount',          op: '<=', value: 46 },
};

const LCTS_48 = new Set([
  'AAPL','AMD','AVGO','CRM','CRWD','META','MU','NFLX','NVDA','PLTR','SNAP','UBER',
  'NOW','ARM','HUBS','MDB','VEEV','ZS','NET','INTU','ROKU','DASH','ENPH','COHR',
  'SWKS','MCHP','ZM',
  'PINS','DOCU','SHOP','QCOM','U','TER','AFRM','LYFT','MRVL','OKTA','FSLR','SNOW','RBLX',
]);

const MID_CAP_17 = new Set([
  'ACMR','ALGM','AMBA','AMKR','ASAN','BILL','CRDO','DOCN','ESTC','FROG',
  'GTLB','MNDY','OLED','PD','S','SITM','WOLF',
]);

const BLACKLIST = new Set([
  'TEAM','TXN','ON','ADI','ABNB','NXPI','SMCI','SQ',
]);

// ─────────────────────────────────────────────────────────────────────────
// CANONICAL FEATURE COMPUTATION (lifted from backtest tool v3.4.3)
// ─────────────────────────────────────────────────────────────────────────

function etH(ms) {
  const d = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return d.getHours() + d.getMinutes() / 60;
}
const isPM  = b => { const h = etH(b.t); return h >= 4   && h < 9.5; };
const isReg = b => { const h = etH(b.t); return h >= 9.5 && h < 16;  };

function computeFeatures({ pm, daily, savedPrevC, date, nbbo }) {
  if (!pm || !pm.length || !savedPrevC) return null;

  const lastPM     = pm[pm.length - 1].c;
  const minPM      = pm.reduce((mn, b) => Math.min(mn, b.l), Infinity);
  const maxPM      = pm.reduce((mx, b) => Math.max(mx, b.h), -Infinity);
  const firstPM    = pm[0].o;
  const pmVol      = pm.reduce((s, b) => s + b.v, 0);
  const pmBarCount = pm.length;

  const gap     = ((lastPM - savedPrevC) / savedPrevC) * 100;
  const gapDown = ((minPM  - savedPrevC) / savedPrevC) * 100;

  const avgVolWindow = Math.min(20, daily.length);
  const avgVol = avgVolWindow > 0
    ? daily.slice(-avgVolWindow).reduce((s, b) => s + b.v, 0) / avgVolWindow
    : null;

  const rvol     = avgVol ? +(pmVol / (avgVol * 0.05)).toFixed(2) : null;
  const relVolPM = avgVol ? +(pmVol / avgVol).toFixed(4) : null;

  const lastPMBar = pm[pm.length - 1];
  const [yy, mm, dd] = date.split('-').map(Number);
  const cronTimeMs = Date.UTC(yy, mm - 1, dd, 13, 29, 0);
  const pmAgeAtCronMin = +((cronTimeMs - lastPMBar.t) / 60000).toFixed(2);

  const pmRangePct       = +(((maxPM - minPM) / Math.max(1e-6, minPM)) * 100).toFixed(3);
  const pmRecoveryAtFire = +(((lastPM - minPM) / Math.max(1e-6, minPM)) * 100).toFixed(3);

  let atr14 = null;
  if (daily.length >= 14) {
    let sumTR = 0;
    const start = daily.length - 14;
    for (let k = start; k < daily.length; k++) sumTR += (daily[k].h - daily[k].l);
    atr14 = +(sumTR / 14).toFixed(4);
  }

  const dipATRs            = atr14 ? +((Math.abs(savedPrevC - minPM)) / atr14).toFixed(3) : null;
  const recoveryATRsAtFire = atr14 ? +((Math.abs(lastPM     - minPM)) / atr14).toFixed(3) : null;

  const lastPMTime = lastPMBar.t;
  function trajectoryOverMinutes(minutesBack) {
    const targetTime = lastPMTime - (minutesBack * 60 * 1000);
    let earlierBar = null;
    for (let k = pm.length - 1; k >= 0; k--) {
      if (pm[k].t <= targetTime) { earlierBar = pm[k]; break; }
    }
    if (!earlierBar) return null;
    return +(((lastPM - earlierBar.c) / Math.max(1e-6, earlierBar.c)) * 100).toFixed(3);
  }
  const pmTrajectory3min  = trajectoryOverMinutes(3);
  const pmTrajectory5min  = trajectoryOverMinutes(5);
  const pmTrajectory10min = trajectoryOverMinutes(10);

  let lowIdx = 0, lowVal = Infinity;
  for (let k = 0; k < pm.length; k++) { if (pm[k].l < lowVal) { lowVal = pm[k].l; lowIdx = k; } }
  let volBefore = 0;
  for (let k = 0; k <= lowIdx; k++) volBefore += pm[k].v;
  const pmVolFracAtLow = pmVol > 0 ? +(volBefore / pmVol).toFixed(3) : null;

  return {
    gap, gapDown, lastPM, minPM, maxPM, firstPM, pmVol, pmBarCount,
    avgVol, rvol, relVolPM, pmAgeAtCronMin, pmRangePct, pmRecoveryAtFire,
    atr14, dipATRs, recoveryATRsAtFire,
    pmTrajectory3min, pmTrajectory5min, pmTrajectory10min, pmVolFracAtLow,
    Nbbo13_29_Bid: nbbo?.bid ?? null,
    Nbbo13_29_Ask: nbbo?.ask ?? null,
    Nbbo13_29_Spread: nbbo?.spread ?? null,
    Nbbo13_29_SpreadPct: nbbo?.spreadPct ?? null,
    Nbbo13_29_BidSize: nbbo?.bidSize ?? null,
    Nbbo13_29_AskSize: nbbo?.askSize ?? null,
  };
}

function getFeatureValue(features, csvName) {
  const map = {
    'Gap%': 'gapDown',
    'Rvol': 'rvol',
    'AvgVol': 'avgVol',
    'PmVol': 'pmVol',
    'PmAgeAtCronMin': 'pmAgeAtCronMin',
    'PmRangePct': 'pmRangePct',
    'PmRecoveryAtFire': 'pmRecoveryAtFire',
    'RecoveryATRsAtFire': 'recoveryATRsAtFire',
    'PmTraj3min': 'pmTrajectory3min',
    'PmTraj5min': 'pmTrajectory5min',
    'PmTraj10min': 'pmTrajectory10min',
    'DipATRs': 'dipATRs',
    'Atr14': 'atr14',
    'RelVolPM': 'relVolPM',
    'PmVolFracAtLow': 'pmVolFracAtLow',
    'PmBarCount': 'pmBarCount',
    'MinPM': 'minPM', 'MaxPM': 'maxPM', 'FirstPM': 'firstPM', 'LastPM': 'lastPM',
    'Nbbo13_29_Bid': 'Nbbo13_29_Bid',
    'Nbbo13_29_Ask': 'Nbbo13_29_Ask',
    'Nbbo13_29_Spread': 'Nbbo13_29_Spread',
    'Nbbo13_29_SpreadPct': 'Nbbo13_29_SpreadPct',
    'Nbbo13_29_BidSize': 'Nbbo13_29_BidSize',
    'Nbbo13_29_AskSize': 'Nbbo13_29_AskSize',
  };
  const key = map[csvName];
  return key ? features[key] : null;
}

function evalCondition(features, csvFeatureName, op, threshold) {
  const v = getFeatureValue(features, csvFeatureName);
  if (v == null) return false;
  if (op === '>') return v > threshold;
  if (op === '<=' || op === '≤') return v <= threshold;
  if (op === '>=' || op === '≥') return v >= threshold;
  if (op === '<')  return v < threshold;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// RULE EVALUATORS — universal stacks (UNCHANGED FROM v5)
// ─────────────────────────────────────────────────────────────────────────

function evalFFreeLunch(f) {
  const T2 = evalCondition(f, 'Gap%', '>', -2.32)
          && evalCondition(f, 'PmAgeAtCronMin', '>', -60)
          && evalCondition(f, 'PmRangePct', '>', 3.721);
  const T3 = evalCondition(f, 'RecoveryATRsAtFire', '>', 0.603)
          && evalCondition(f, 'FirstPM', '>', 80.88)
          && evalCondition(f, 'Nbbo13_29_BidSize', '>', 200);
  const extraFilter = evalCondition(f, 'RecoveryATRsAtFire', '>', 0.155);
  return (T2 || T3) && extraFilter;
}

function evalG(f) {
  return evalCondition(f, 'Gap%', '<=', 4.39)
      && evalCondition(f, 'PmRecoveryAtFire', '<=', 1.781)
      && evalCondition(f, 'PmVolFracAtLow', '<=', 0.216)
      && evalCondition(f, 'PmTraj3min', '>', -0.046);
}

function evalStackB(f) {
  const T1 = evalCondition(f, 'PmAgeAtCronMin', '<=', -60)
          && evalCondition(f, 'PmRecoveryAtFire', '>', 0.75)
          && evalCondition(f, 'Atr14', '<=', 3.8931);
  const T2 = evalCondition(f, 'Gap%', '>', -2.8)
          && evalCondition(f, 'PmTraj10min', '>', 0.053)
          && evalCondition(f, 'DipATRs', '>', 0.665);
  const F  = evalCondition(f, 'PmRangePct', '<=', 3.7);
  return (T1 || T2) && F;
}

function evalStackC(f) {
  const T1 = evalCondition(f, 'DipATRs', '>', 0.446)
          && evalCondition(f, 'Nbbo13_29_SpreadPct', '<=', 2.0794)
          && evalCondition(f, 'Nbbo13_29_BidSize', '>', 200);
  const T2 = evalCondition(f, 'AvgVol', '>', 2116475)
          && evalCondition(f, 'Nbbo13_29_Spread', '<=', 1.1)
          && evalCondition(f, 'Nbbo13_29_BidSize', '<=', 100);
  const F  = evalCondition(f, 'RecoveryATRsAtFire', '>', 0.139);
  return (T1 || T2) && F;
}

// ─────────────────────────────────────────────────────────────────────────
// PREMARKET FRESHNESS PROBE (Polygon)
// ─────────────────────────────────────────────────────────────────────────

async function fetchPmAndDaily(ticker, todayYMD, polygonKey) {
  // Returns { pm, daily, savedPrevC, prevSource }
  // prevSource: 'prev' = /prev endpoint succeeded, 'walkback' = fallback used, null = both failed
  if (!polygonKey) return { pm: [], daily: [], savedPrevC: null, prevSource: null };

  const pmUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${todayYMD}/${todayYMD}?adjusted=true&sort=asc&limit=1000&apiKey=${polygonKey}`;
  const target = new Date(todayYMD + 'T00:00:00Z');
  const start = new Date(target); start.setUTCDate(start.getUTCDate() - 60);
  const endTarget = new Date(target); endTarget.setUTCDate(endTarget.getUTCDate() - 1);
  const startStr = start.toISOString().slice(0, 10);
  const endStr   = endTarget.toISOString().slice(0, 10);
  const dailyUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${startStr}/${endStr}?adjusted=true&sort=asc&limit=200&apiKey=${polygonKey}`;

  let pm = [], daily = [], savedPrevC = null, prevSource = null;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 8000);
    const [pmR, dailyR] = await Promise.all([
      fetch(pmUrl, { signal: ctrl.signal }).catch(() => null),
      fetch(dailyUrl, { signal: ctrl.signal }).catch(() => null),
    ]);
    clearTimeout(tid);
    if (pmR && pmR.ok) {
      const data = await pmR.json();
      const all = data.results || [];
      pm = all.filter(isPM);
    }
    if (dailyR && dailyR.ok) {
      const data = await dailyR.json();
      daily = (data.results || []).filter(b => b.t < target.getTime());
    }
  } catch (e) {
    // continue with whatever we got
  }

  function lastTradingDayYMD(targetDate) {
    const d = new Date(targetDate);
    for (let i = 0; i < 7; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) return d.toISOString().slice(0, 10);
    }
    return null;
  }
  const expectedPrevDate = lastTradingDayYMD(target);

  // Method B: /prev endpoint
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 4000);
    const prevUrl = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${polygonKey}`;
    const r = await fetch(prevUrl, { signal: ctrl.signal });
    clearTimeout(tid);
    if (r.ok) {
      const j = await r.json();
      const x = (j.results && j.results[0]) ? j.results[0] : null;
      if (x && x.c > 0) {
        const returnedDate = new Date(x.t).toISOString().slice(0, 10);
        const daysAgo = Math.round((target.getTime() - x.t) / 86400000);
        if (returnedDate === expectedPrevDate || (daysAgo >= 1 && daysAgo <= 5)) {
          savedPrevC = x.c;
          prevSource = 'prev';
        }
      }
    }
  } catch (_) { /* fall through to walkback */ }

  // Fallback: minute-bar walkback
  if (!savedPrevC) {
    for (let back = 1; back <= 7 && !savedPrevC; back++) {
      const d = new Date(target); d.setUTCDate(d.getUTCDate() - back);
      const ymd = d.toISOString().slice(0, 10);
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 4000);
        const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${ymd}/${ymd}?adjusted=true&sort=asc&limit=5000&apiKey=${polygonKey}`;
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!r.ok) continue;
        const j = await r.json();
        const reg = (j.results || []).filter(isReg);
        if (reg.length) {
          savedPrevC = reg[reg.length - 1].c;
          prevSource = 'walkback';
        }
      } catch (_) { /* try previous day */ }
    }
  }

  return { pm, daily, savedPrevC, prevSource };
}

async function fetchNbbo13_29(ticker, todayYMD, polygonKey) {
  // v6 FIX: Use min(now, 13:29 UTC) so dryruns at any hour return the most
  // recent quote rather than nothing. At cron time (13:29 UTC) behavior is
  // identical to v5. Field is still NAMED Nbbo13_29 but for early dryruns
  // the data is "most recent quote up to now."
  if (!polygonKey) return null;
  const targetMs = Date.parse(todayYMD + 'T13:29:00.000Z');
  const nowMs    = Date.now();
  const endMs    = Math.min(nowMs, targetMs);
  const startNs  = (endMs - 3600 * 1000) * 1e6;
  const endNs    = endMs * 1e6;
  try {
    const url = `https://api.polygon.io/v3/quotes/${encodeURIComponent(ticker)}?timestamp.gte=${startNs}&timestamp.lte=${endNs}&order=desc&limit=1&apiKey=${polygonKey}`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) return null;
    const d = await r.json();
    const quotes = d.results || [];
    if (!quotes.length) return null;
    const q = quotes[0];
    const bid = q.bid_price ?? null;
    const ask = q.ask_price ?? null;
    const bidSize = q.bid_size ?? null;
    const askSize = q.ask_size ?? null;
    const spread    = (bid != null && ask != null) ? +(ask - bid).toFixed(4) : null;
    const spreadPct = (bid != null && ask != null && bid > 0) ? +(((ask - bid) / bid) * 100).toFixed(3) : null;
    return { bid, ask, bidSize, askSize, spread, spreadPct };
  } catch (_) { return null; }
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const DRY_RUN       = req.query.dryrun === '1' || req.query.dryrun === 'true';
  const VERIFY_DATE   = req.query.verify;
  const VERIFY_TICKER = req.query.ticker;
  const BULK_VERIFY   = req.query.bulk_verify === '1' || req.query.bulk_verify === 'true';
  const runId = new Date().toISOString();
  console.log(`[APEX-D] ===== RUN START ${runId} dryrun=${DRY_RUN} verify=${VERIFY_DATE || 'no'} bulk_verify=${BULK_VERIFY} =====`);

  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Webhook secret check
  const _secret = process.env.TV_WEBHOOK_SECRET;
  if (_secret && !DRY_RUN && !VERIFY_DATE && !BULK_VERIFY) {
    const _provided = req.headers['x-webhook-secret'] || req.query.secret;
    if (_provided !== _secret) {
      console.log('[APEX-D] Unauthorized — invalid webhook secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const TRADIER_TOKEN          = process.env.TRADIER_TOKEN;
  const TRADIER_ACCOUNT_ID     = process.env.TRADIER_ACCOUNT_ID;
  const TRADIER_PAPER_TOKEN    = process.env.TRADIER_PAPER_TOKEN;
  const TRADIER_PAPER_ACCOUNT_ID = process.env.TRADIER_PAPER_ACCOUNT_ID;
  const POLYGON_KEY            = process.env.POLYGON_KEY;

  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID || !POLYGON_KEY) {
    console.log('[APEX-D] ERROR: missing env vars');
    return res.status(500).json({ error: 'Missing env vars (TRADIER_TOKEN, TRADIER_ACCOUNT_ID, POLYGON_KEY)' });
  }

  const H    = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://api.tradier.com/v1';

  const CONFIG_FALLBACK = {
    enabled: false,
    live: true,
    positionBudgetDollars: 250,
    maxPositionsPerDay: 4,
    maxDailyExposure: 1000,
    maxPricePerTrade: 250,
    maxSpreadPct: 3.0,
    bracketTpPct: 2.0,
    bracketSlPct: 2.0,
    bracketRetries: { delaysMs: [0, 1500, 3000], abortAfterMs: 50000 },
    selectionPriority: 'personal_first',
    pmConcurrency: 30,
  };
  let config;
  try {
    const cfgCtrl = new AbortController();
    const cfgTimeout = setTimeout(() => cfgCtrl.abort(), 5000);
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-d-config.json', { signal: cfgCtrl.signal });
    clearTimeout(cfgTimeout);
    if (!r.ok) throw new Error('Config fetch failed: ' + r.status);
    config = await r.json();
    console.log('[APEX-D] Config loaded from GitHub');
  } catch (e) {
    console.log('[APEX-D] Config fetch failed, using fallback:', e.message);
    config = CONFIG_FALLBACK;
  }

  // Master kill switch (bypassed for read-only modes: DRY_RUN, VERIFY, BULK_VERIFY)
  if (config.enabled !== true && !DRY_RUN && !VERIFY_DATE && !BULK_VERIFY) {
    console.log('[APEX-D] disabled in config — exiting cleanly');
    return res.status(200).json({ status: 'disabled', message: 'd.js is disabled in config (set enabled:true to activate)' });
  }

  const _live           = config.live === true;
  const _posBudget      = config.positionBudgetDollars || 250;
  const _maxPositions   = config.maxPositionsPerDay    || 4;
  const _maxExposure    = config.maxDailyExposure      || 1000;
  const _maxPrice       = config.maxPricePerTrade      || 250;
  const _maxSpread      = config.maxSpreadPct          || 3.0;
  const _tpPct          = config.bracketTpPct          || 2.0;
  const _slPct          = config.bracketSlPct          || 2.0;
  const _retryCfg       = config.bracketRetries        || {};
  const _retryDelaysMs  = Array.isArray(_retryCfg.delaysMs) ? _retryCfg.delaysMs : [0, 1500, 3000];
  const _retryAbortMs   = _retryCfg.abortAfterMs ?? 50000;
  const _pmConcurrency  = config.pmConcurrency || 30;

  console.log(`[APEX-D] Config | live=${_live} budget=$${_posBudget} maxPos=${_maxPositions} maxExp=$${_maxExposure} maxPrice=$${_maxPrice}`);

  const LIVE_BASE  = 'https://api.tradier.com/v1';
  const PAPER_BASE = _live ? LIVE_BASE : 'https://sandbox.tradier.com/v1';
  const ORDER_ACCOUNT = _live ? TRADIER_ACCOUNT_ID : TRADIER_PAPER_ACCOUNT_ID;
  const ORDER_TOKEN   = _live ? TRADIER_TOKEN      : TRADIER_PAPER_TOKEN;
  const ORDER_H = { 'Authorization': `Bearer ${ORDER_TOKEN}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };

  console.log(`[APEX-D] Routing: ${_live ? 'LIVE account=' + TRADIER_ACCOUNT_ID : 'PAPER account=' + TRADIER_PAPER_ACCOUNT_ID}`);

  // ── VERIFY MODE (single-ticker historical replay) ──────────────────────
  if (VERIFY_DATE) {
    if (!VERIFY_TICKER) return res.status(400).json({ error: 'verify mode requires &ticker=SYM' });
    console.log(`[APEX-D] VERIFY mode: ticker=${VERIFY_TICKER} date=${VERIFY_DATE}`);
    const { pm, daily, savedPrevC, prevSource } = await fetchPmAndDaily(VERIFY_TICKER.toUpperCase(), VERIFY_DATE, POLYGON_KEY);
    const nbbo = await fetchNbbo13_29(VERIFY_TICKER.toUpperCase(), VERIFY_DATE, POLYGON_KEY);
    const features = computeFeatures({ pm, daily, savedPrevC, date: VERIFY_DATE, nbbo });
    if (!features) return res.status(200).json({ status: 'no_features', ticker: VERIFY_TICKER, date: VERIFY_DATE, pm_bars: pm.length, daily_bars: daily.length, savedPrevC, prevSource });
    const upper = VERIFY_TICKER.toUpperCase();
    const personal = PERSONAL_RULES[upper];
    const decisions = {
      personal_rule_present: !!personal,
      personal_rule:         personal ? `${personal.feature} ${personal.op} ${personal.value}` : null,
      personal_rule_fires:   personal ? evalCondition(features, personal.feature, personal.op, personal.value) : false,
      f_freelunch_fires:     evalFFreeLunch(features),
      g_fires:               evalG(features),
      stack_b_fires:         LCTS_48.has(upper) && !personal && evalStackB(features),
      stack_c_fires:         MID_CAP_17.has(upper) && !personal && evalStackC(features),
      blacklisted:           BLACKLIST.has(upper),
    };
    return res.status(200).json({ status: 'verify', ticker: VERIFY_TICKER, date: VERIFY_DATE, savedPrevC, prevSource, pm_bars: pm.length, daily_bars: daily.length, features, decisions });
  }

  // ── Dedup guard (skipped for read-only modes) ──────────────────────────
  const _todayEDT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
  if (!DRY_RUN && !BULK_VERIFY) {
    try {
      const _or = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { headers: ORDER_H });
      const _od = await _or.json();
      const _ol = _od?.orders?.order;
      const _arr = Array.isArray(_ol) ? _ol : (_ol ? [_ol] : []);
      const _todays = _arr.filter(o =>
        o.create_date?.startsWith(_todayEDT) &&
        (o.tag || '').startsWith('v3') &&
        o.status !== 'canceled' && o.status !== 'cancelled' &&
        o.status !== 'rejected' && o.status !== 'expired'
      );
      if (_todays.length > 0) {
        const syms = _todays.map(o => o.symbol || (Array.isArray(o.leg) ? o.leg[0]?.symbol : o.leg?.symbol) || '?');
        console.log(`[APEX-D] DEDUP BLOCK: ${_todays.length} d.js orders already today: ${syms.join(',')}`);
        return res.status(200).json({ status: 'already_ran', existing: syms });
      }
    } catch (e) {
      console.log('[APEX-D] Dedup check error (non-fatal):', e.message);
    }
  }

  // ── Weekend guard (skipped for read-only modes) ────────────────────────
  const _nowEDT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _dow = _nowEDT.getDay();
  if ((_dow === 0 || _dow === 6) && !DRY_RUN && !BULK_VERIFY) {
    console.log('[APEX-D] Weekend — exiting');
    return res.status(200).json({ status: 'market_closed' });
  }

  // ── Load watchlist from Supabase ────────────────────────────────────────
  let tickers = [];
  try {
    const _sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const _sbKey = process.env.SUPABASE_SERVICE_KEY;
    const _sbH   = { apikey: _sbKey, Authorization: `Bearer ${_sbKey}` };
    const _wlR   = await fetch(`${_sbUrl}/rest/v1/apex_v3_watchlist?id=eq.default`, { headers: _sbH });
    const _wlD   = await _wlR.json();
    tickers = (_wlD[0]?.active || []).map(s => s.toUpperCase());
    console.log(`[APEX-D] Watchlist loaded from Supabase: ${tickers.length} tickers`);
  } catch (e) {
    console.log('[APEX-D] Watchlist load failed, falling back to config:', e.message);
    tickers = (config.watchlist || []).map(s => s.toUpperCase());
  }
  if (tickers.length === 0) {
    console.log('[APEX-D] Empty watchlist — exiting');
    return res.status(200).json({ status: 'no_watchlist' });
  }

  const blocked = tickers.filter(t => BLACKLIST.has(t));
  if (blocked.length) console.log(`[APEX-D] Blacklist excludes ${blocked.length} tickers: ${blocked.join(',')}`);
  tickers = tickers.filter(t => !BLACKLIST.has(t));

  // ── Bounded-concurrency feature pre-fetch ──────────────────────────────
  console.log(`[APEX-D] Pre-fetching pm+daily+nbbo for ${tickers.length} tickers (concurrency=${_pmConcurrency})...`);
  const _featStart = Date.now();
  const tickerData = {};
  const queue = [...tickers];
  const worker = async () => {
    while (queue.length > 0) {
      const tk = queue.shift();
      if (!tk) break;
      try {
        const [{pm, daily, savedPrevC, prevSource}, nbbo] = await Promise.all([
          fetchPmAndDaily(tk, _todayEDT, POLYGON_KEY),
          fetchNbbo13_29(tk, _todayEDT, POLYGON_KEY),
        ]);
        const features = computeFeatures({ pm, daily, savedPrevC, date: _todayEDT, nbbo });
        tickerData[tk] = { pm_bars: pm.length, daily_bars: daily.length, savedPrevC, prevSource, nbbo, features };
      } catch (e) {
        tickerData[tk] = { error: e.message };
      }
    }
  };
  await Promise.all(Array.from({ length: _pmConcurrency }, worker));
  let _okFeat = Object.values(tickerData).filter(d => d.features).length;
  console.log(`[APEX-D] Feature pre-fetch done in ${Date.now() - _featStart}ms (${_okFeat}/${tickers.length} computed)`);

  // ── v6 NEW: Retry pass for failed tickers (lower concurrency, same timeouts) ──
  // Catches Polygon transient timeouts. Only retries tickers where features failed.
  // Skipped for VERIFY mode (single ticker) — only relevant for full-watchlist runs.
  const failedTickers = Object.keys(tickerData).filter(tk => !tickerData[tk].features);
  if (failedTickers.length > 0) {
    console.log(`[APEX-D] Retry pass: ${failedTickers.length} failed tickers, concurrency=10`);
    const _retryStart = Date.now();
    const retryQueue = [...failedTickers];
    const retryWorker = async () => {
      while (retryQueue.length > 0) {
        const tk = retryQueue.shift();
        if (!tk) break;
        try {
          const [{pm, daily, savedPrevC, prevSource}, nbbo] = await Promise.all([
            fetchPmAndDaily(tk, _todayEDT, POLYGON_KEY),
            fetchNbbo13_29(tk, _todayEDT, POLYGON_KEY),
          ]);
          const features = computeFeatures({ pm, daily, savedPrevC, date: _todayEDT, nbbo });
          // Only overwrite if retry got a better result (features computed)
          if (features) {
            tickerData[tk] = { pm_bars: pm.length, daily_bars: daily.length, savedPrevC, prevSource, nbbo, features, retried: true };
          }
        } catch (e) {
          // Keep original error
        }
      }
    };
    await Promise.all(Array.from({ length: 10 }, retryWorker));
    const _newOkFeat = Object.values(tickerData).filter(d => d.features).length;
    const _rescued = _newOkFeat - _okFeat;
    console.log(`[APEX-D] Retry pass done in ${Date.now() - _retryStart}ms (rescued ${_rescued}/${failedTickers.length} → total ${_newOkFeat}/${tickers.length})`);
    _okFeat = _newOkFeat;
  }

  // ── v6 NEW: BULK_VERIFY MODE — return per-ticker health, no rule evaluation ───
  if (BULK_VERIFY) {
    const summary = { total: tickers.length, fetched_features: 0, prevC_ok: 0, prevC_via_prev: 0, prevC_via_walkback: 0, prevC_failed: 0, nbbo_ok: 0, nbbo_failed: 0 };
    const details = [];
    for (const tk of tickers) {
      const d = tickerData[tk] || {};
      const hasPrevC = d.savedPrevC != null && d.savedPrevC > 0;
      const hasNbbo  = d.nbbo && d.nbbo.bid != null && d.nbbo.bid > 0;
      const hasFeat  = !!d.features;
      if (hasFeat) summary.fetched_features++;
      if (hasPrevC) {
        summary.prevC_ok++;
        if (d.prevSource === 'prev') summary.prevC_via_prev++;
        else if (d.prevSource === 'walkback') summary.prevC_via_walkback++;
      } else summary.prevC_failed++;
      if (hasNbbo) summary.nbbo_ok++;
      else summary.nbbo_failed++;
      details.push({
        ticker: tk,
        savedPrevC: d.savedPrevC ?? null,
        prevSource: d.prevSource ?? null,
        nbbo_bid: d.nbbo?.bid ?? null,
        nbbo_ask: d.nbbo?.ask ?? null,
        nbbo_bidSize: d.nbbo?.bidSize ?? null,
        pm_bars: d.pm_bars ?? 0,
        daily_bars: d.daily_bars ?? 0,
        gap: d.features?.gap ?? null,
        gapDown: d.features?.gapDown ?? null,
        retried: d.retried ?? false,
        error: d.error ?? null,
      });
    }
    return res.status(200).json({
      status: 'bulk_verify',
      timestamp: runId,
      asof_local: _todayEDT,
      summary,
      details,
    });
  }

  // ── Decision tree ──────────────────────────────────────────────────────
  const candidates = [];
  const skipReasons = {}; // v6 NEW: aggregate skip reason counts
  function bump(reason) { skipReasons[reason] = (skipReasons[reason] || 0) + 1; }

  for (const tk of tickers) {
    const d = tickerData[tk];
    if (!d || !d.features) {
      console.log(`[APEX-D] ${tk} | SKIP: no features (${d?.error || 'pm/daily fetch failed'})`);
      bump('no_features');
      continue;
    }
    const f = d.features;

    const px = f.Nbbo13_29_Bid;
    if (px == null || px <= 0) {
      console.log(`[APEX-D] ${tk} | SKIP: no NBBO bid`);
      bump('no_nbbo_bid');
      continue;
    }
    if (px > _maxPrice) {
      console.log(`[APEX-D] ${tk} | SKIP: price $${px} > max $${_maxPrice}`);
      bump('price_over_max');
      continue;
    }

    if (f.Nbbo13_29_SpreadPct != null && f.Nbbo13_29_SpreadPct > _maxSpread) {
      console.log(`[APEX-D] ${tk} | SKIP: spread ${f.Nbbo13_29_SpreadPct}% > ${_maxSpread}%`);
      bump('spread_over_max');
      continue;
    }

    const F_GAP_WIDE = 2;
    const isFEligible = (f.gapDown != null) && (f.gapDown <= -F_GAP_WIDE) && (f.gapDown >= -25);
    const isGEligible = (f.gapDown != null) && (f.gapDown >=  F_GAP_WIDE) && (f.gapDown <=  25);
    if (!isFEligible && !isGEligible) {
      bump('gap_not_eligible');
      continue;
    }

    if (f.pmAgeAtCronMin != null && f.pmAgeAtCronMin > 60) {
      console.log(`[APEX-D] ${tk} | SKIP: PM age ${f.pmAgeAtCronMin}min > 60min`);
      bump('pm_age_over_60min');
      continue;
    }

    let layer = null;
    let scenario = null;

    const personal = PERSONAL_RULES[tk];
    if (isFEligible) {
      if (personal && evalCondition(f, personal.feature, personal.op, personal.value)) {
        layer = `personal:${tk}`;
        scenario = 'F';
      } else if (LCTS_48.has(tk) && evalStackB(f)) {
        layer = 'stack_b';
        scenario = 'F';
      } else if (MID_CAP_17.has(tk) && evalStackC(f)) {
        layer = 'stack_c';
        scenario = 'F';
      } else if (evalFFreeLunch(f)) {
        layer = 'f_freelunch';
        scenario = 'F';
      }
    }
    if (!layer && isGEligible && evalG(f)) {
      layer = 'g_universal';
      scenario = 'G';
    }

    if (!layer) {
      bump('no_rule_fires');
      continue;
    }

    const qty = Math.floor(_posBudget / px);
    if (qty < 1) {
      console.log(`[APEX-D] ${tk} | SKIP: bet too small at $${px} (qty=${qty})`);
      bump('qty_too_small');
      continue;
    }
    const positionDollars = qty * px;

    candidates.push({
      ticker: tk, layer, scenario,
      price: px, qty, positionDollars, gap: f.gap, gapDown: f.gapDown,
      features: f,
    });
  }

  console.log(`[APEX-D] ${candidates.length} candidates after rule evaluation:`);
  for (const c of candidates) console.log(`  ${c.ticker} layer=${c.layer} qty=${c.qty} bid=$${c.price} pos=$${c.positionDollars.toFixed(2)} gapDn=${c.gapDown?.toFixed(2)}%`);
  console.log(`[APEX-D] Skip reasons: ${JSON.stringify(skipReasons)}`);

  const personalFires = candidates.filter(c => c.layer.startsWith('personal:')).sort((a,b) => a.ticker.localeCompare(b.ticker));
  const stackBFires   = candidates.filter(c => c.layer === 'stack_b').sort((a,b) => a.ticker.localeCompare(b.ticker));
  const stackCFires   = candidates.filter(c => c.layer === 'stack_c').sort((a,b) => a.ticker.localeCompare(b.ticker));
  const ffreelunch    = candidates.filter(c => c.layer === 'f_freelunch').sort((a,b) => a.ticker.localeCompare(b.ticker));
  const gFires        = candidates.filter(c => c.layer === 'g_universal').sort((a,b) => a.ticker.localeCompare(b.ticker));
  const ordered = [...personalFires, ...stackBFires, ...stackCFires, ...ffreelunch, ...gFires];

  const selected = [];
  let exposureUsed = 0;
  for (const c of ordered) {
    if (selected.length >= _maxPositions) break;
    if (exposureUsed + c.positionDollars > _maxExposure) continue;
    selected.push(c);
    exposureUsed += c.positionDollars;
  }
  console.log(`[APEX-D] After cap: ${selected.length} of ${candidates.length} fire (exposure=$${exposureUsed.toFixed(2)} of $${_maxExposure})`);

  if (selected.length === 0) {
    return res.status(200).json({
      status: 'no_fires',
      timestamp: runId,
      watchlist_size: tickers.length,
      candidates: 0,
      features_computed: _okFeat,
      skip_reasons: skipReasons,
    });
  }

  const results = [];
  const pendingOrders = [];

  for (const c of selected) {
    const rawTag = c.layer.startsWith('personal:') ? `v3FS${c.ticker}` : `v3${c.layer.replace(/_/g,'')}`;
    const tag = rawTag.replace(/[^A-Za-z0-9]/g, '').slice(0, 25);

    if (DRY_RUN) {
      results.push({ symbol: c.ticker, layer: c.layer, scenario: c.scenario, status: 'dry_run', qty: c.qty, price: c.price, gap: c.gap, gapDown: c.gapDown });
      console.log(`[APEX-D] ${c.ticker} | DRY-RUN entry: layer=${c.layer} qty=${c.qty} pos=$${c.positionDollars.toFixed(2)}`);
      continue;
    }

    try {
      const params = new URLSearchParams({
        'class': 'equity', 'duration': 'day',
        'symbol': c.ticker, 'side': 'buy', 'quantity': String(c.qty), 'type': 'market',
        'tag': tag,
      });
      const r = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: params });
      const respText = await r.text();
      let j = null;
      try { j = JSON.parse(respText); } catch (_) { j = null; }
      if (j === null) {
        console.log(`[APEX-D] ${c.ticker} | entry NON-JSON response: http=${r.status} body=${respText.slice(0,300)}`);
        results.push({ symbol: c.ticker, layer: c.layer, status: 'error', reason: `tradier_${r.status}: ${respText.slice(0,200)}` });
        continue;
      }
      const orderId = j?.order?.id;
      console.log(`[APEX-D] ${c.ticker} | entry submit: http=${r.status} orderId=${orderId} layer=${c.layer} tag=${tag}`);
      if (!r.ok || !orderId) {
        const reason = j?.order?.partner_error_description || j?.errors?.error || j?.fault?.faultstring || `HTTP ${r.status}: ${respText.slice(0,200)}`;
        console.log(`[APEX-D] ${c.ticker} | entry rejected: ${reason}`);
        results.push({ symbol: c.ticker, layer: c.layer, status: 'error', reason });
        continue;
      }
      pendingOrders.push({ ...c, entryId: orderId, tag });
    } catch (e) {
      console.log(`[APEX-D] ${c.ticker} | entry exception:`, e.message);
      results.push({ symbol: c.ticker, layer: c.layer, status: 'error', reason: e.message });
    }
  }

  if (DRY_RUN || pendingOrders.length === 0) {
    return res.status(200).json({
      status: 'phase1_complete',
      timestamp: runId,
      dry_run: DRY_RUN,
      candidates: candidates.length,
      selected: selected.length,
      features_computed: _okFeat,
      skip_reasons: skipReasons,
      results,
    });
  }

  // ── PHASE 2: sleep until 13:30:03 UTC, then bracket each fill ──────────
  console.log(`[APEX-D] Phase 1 complete: ${pendingOrders.length} entries submitted, sleeping until 13:30:03 UTC`);
  const _now = new Date();
  const _target = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth(), _now.getUTCDate(), 13, 30, 3, 0));
  const _sleepMs = _target.getTime() - _now.getTime();
  if (_sleepMs > 0) await new Promise(r => setTimeout(r, _sleepMs));
  console.log(`[APEX-D] Phase 2 starting parallel resolution`);

  async function fetchCurrentBid(sym) {
    try {
      const r = await fetch(`${BASE}/markets/quotes?symbols=${sym}`, { headers: H });
      if (!r.ok) return null;
      const d = await r.json();
      const q = d?.quotes?.quote;
      const bid = q?.bid;
      return (bid && bid > 0) ? +bid : null;
    } catch (_) { return null; }
  }

  async function emergencyFlatten(sym, qty) {
    console.log(`[APEX-D] ${sym} EMERGENCY FLATTEN: qty=${qty}`);
    try {
      const params = new URLSearchParams({
        'class': 'equity', 'duration': 'day',
        'symbol': sym, 'side': 'sell', 'quantity': String(qty), 'type': 'market',
      });
      const r = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: params });
      const respText = await r.text();
      let j = null;
      try { j = JSON.parse(respText); } catch (_) { j = null; }
      if (j === null) {
        console.log(`[APEX-D] ${sym} flatten NON-JSON: http=${r.status} body=${respText.slice(0,200)}`);
        return null;
      }
      return j?.order?.id || null;
    } catch (e) { return null; }
  }

  async function submitBracket({ sym, qty, fillPrice, tpF, slF }) {
    const spread = +(tpF - slF).toFixed(4);
    if (spread < 0.12) return { ok: false, reason: `spread_too_narrow: $${spread}`, bracketId: null };
    const cb = await fetchCurrentBid(sym);
    if (cb !== null && cb <= slF + 0.02) return { ok: false, reason: `bid_at_or_below_stop: bid=${cb} sl=${slF}`, bracketId: null };

    const _start = Date.now();
    const OK_STATUSES = ['ok','open','pending','partially_filled'];
    const FAIL_STATUSES = ['rejected','canceled','cancelled','expired','error'];
    let last = { ok: false, reason: 'no_attempts', bracketId: null };

    for (let i = 0; i < _retryDelaysMs.length; i++) {
      if (_retryDelaysMs[i] > 0) await new Promise(r => setTimeout(r, _retryDelaysMs[i]));
      if (Date.now() - _start > _retryAbortMs) return { ok: false, reason: `abort_after_${i}_attempts`, bracketId: null };

      const params = new URLSearchParams({
        'class': 'oco', 'duration': 'day',
        'symbol[0]': sym, 'side[0]': 'sell', 'quantity[0]': String(qty), 'type[0]': 'limit', 'price[0]': String(tpF),
        'symbol[1]': sym, 'side[1]': 'sell', 'quantity[1]': String(qty), 'type[1]': 'stop',  'stop[1]':  String(slF),
      });
      const r = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: params });
      const respText = await r.text();
      let j = null;
      try { j = JSON.parse(respText); } catch (_) { j = null; }
      if (j === null) {
        last = { ok: false, reason: `attempt${i+1}_non_json: http=${r.status} body=${respText.slice(0,150)}`, bracketId: null };
        continue;
      }
      const bid = j?.order?.id;
      const st  = j?.order?.status || 'unknown';
      if (!r.ok || !OK_STATUSES.includes(st)) {
        const reason = j?.order?.reason_description || j?.order?.partner_error_description || j?.errors?.error || `HTTP ${r.status} status=${st} body=${respText.slice(0,150)}`;
        last = { ok: false, reason: `attempt${i+1}_immediate_fail: ${reason}`, bracketId: bid };
        continue;
      }
      await new Promise(rs => setTimeout(rs, 500));
      try {
        const rp = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders/${bid}`, { headers: ORDER_H });
        const rj = await rp.json();
        const ps = rj?.order?.status || 'unknown';
        if (FAIL_STATUSES.includes(ps)) {
          last = { ok: false, reason: `attempt${i+1}_post_submit_${ps}`, bracketId: bid };
          continue;
        }
        if (OK_STATUSES.includes(ps)) return { ok: true, reason: `verified_attempt${i+1}`, bracketId: bid };
      } catch (_) {
        return { ok: true, reason: `repoll_exception_assumed_ok`, bracketId: bid };
      }
    }
    return last;
  }

  async function resolveOrder(c) {
    const { ticker: sym, qty, entryId, layer, tag, scenario, gap, gapDown, price } = c;
    let fillPrice = 0, status = 'pending';
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const r = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders/${entryId}`, { headers: ORDER_H });
        const j = await r.json();
        const o = j?.order;
        status = o?.status || 'unknown';
        if (status === 'filled' && o?.avg_fill_price > 0) {
          fillPrice = +o.avg_fill_price;
          break;
        }
        if (['rejected','canceled','cancelled','expired'].includes(status)) break;
      } catch (_) { /* retry */ }
    }

    if (status !== 'filled' || !fillPrice) {
      try {
        await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders/${entryId}`, { method: 'DELETE', headers: ORDER_H });
      } catch (_) {}
      await new Promise(r => setTimeout(r, 500));
      try {
        const r = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders/${entryId}`, { headers: ORDER_H });
        const j = await r.json();
        const o = j?.order;
        if (o?.status === 'filled' && o?.avg_fill_price > 0) {
          fillPrice = +o.avg_fill_price;
          status = 'filled';
        }
      } catch (_) {}
      if (status !== 'filled') {
        return { symbol: sym, layer, scenario, status: 'skipped', reason: `entry_${status}`, gap, gapDown, qty, entryId, tag };
      }
    }

    const tpF = +(fillPrice * (1 + _tpPct/100)).toFixed(2);
    const slF = +(fillPrice * (1 - _slPct/100)).toFixed(2);
    const br  = await submitBracket({ sym, qty, fillPrice, tpF, slF });
    if (br.ok) {
      return { symbol: sym, layer, scenario, status: 'filled', qty, fillPrice, tp: tpF, sl: slF, gap, gapDown, entryId, bracketId: br.bracketId, tag };
    }
    const flatId = await emergencyFlatten(sym, qty);
    return { symbol: sym, layer, scenario, status: 'error', qty, fillPrice, gap, gapDown, entryId, tag, reason: `bracket_failed_flattened: ${br.reason}`, flattenId: flatId };
  }

  const phase2Results = await Promise.all(pendingOrders.map(resolveOrder));
  for (const r of phase2Results) results.push(r);

  try {
    const _sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const _sbKey = process.env.SUPABASE_SERVICE_KEY;
    const _sbH   = { apikey: _sbKey, Authorization: `Bearer ${_sbKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };
    const trigger = req.headers['x-vercel-cron'] ? 'cron' : 'manual';
    const rows = results.map(r => ({
      run_at: runId, trigger_type: trigger, live: _live,
      symbol: r.symbol, layer: r.layer, scenario: r.scenario, status: r.status,
      gap: r.gap ?? null, gap_down: r.gapDown ?? null, qty: r.qty ?? null,
      fill_price: r.fillPrice ?? r.price ?? null,
      tp: r.tp ?? null, sl: r.sl ?? null,
      entry_id: r.entryId ?? null, bracket_id: r.bracketId ?? null,
      tag: r.tag ?? null, reason: r.reason ?? null,
    }));
    if (rows.length > 0) {
      const lr = await fetch(`${_sbUrl}/rest/v1/apex_v3_trades`, { method: 'POST', headers: _sbH, body: JSON.stringify(rows) });
      console.log(`[APEX-D] Trade log written: ${rows.length} rows | http=${lr.status}`);
    }
  } catch (e) {
    console.log('[APEX-D] Trade log write failed:', e.message);
  }

  const traded  = results.filter(r => r.status === 'filled').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;
  console.log(`[APEX-D] ===== RUN COMPLETE | filled=${traded} skipped=${skipped} errors=${errors} exposure=$${exposureUsed.toFixed(2)} =====`);

  return res.status(200).json({
    status: 'complete', timestamp: runId, live: _live,
    summary: { candidates: candidates.length, selected: selected.length, filled: traded, skipped, errors, exposure_used: exposureUsed },
    skip_reasons: skipReasons,
    trades: results,
  });
}
