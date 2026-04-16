// pages/api/auto-trade-c.js — Scenario D/E/F/A GAP FADE, Tiered Exits — cron 9:30 AM EDT
// Cron: 9:29 AM EDT weekdays (Vercel cron)
// Data + Execution: Tradier production API + OTOCO bracket orders
//
// TIERED EXIT LOGIC (Scenario E):
//   Gap 10.0-10.99% -> TP 2.0% / SL 1.0%
//   Gap 11.0-12.99% -> TP 2.5% / SL 1.5%
//   Gap 13.0-14.99% -> TP 3.0% / SL 1.5%
//   Gap 15.0%+      -> TP 5.0% / SL 3.0%
//
// Uses q.bid for pre-market price (updates live).
// q.last only updates when a trade prints, stays at prev close pre-market.

export default async function handler(req, res) {
  const DRY_RUN = req.query.dryrun === '1' || req.query.dryrun === 'true';
  const runId = new Date().toISOString();
  console.log(`[APEX] ===== RUN START ${runId} dryrun=${DRY_RUN} =====`);

  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const TRADIER_TOKEN         = process.env.TRADIER_TOKEN;
  const TRADIER_ACCOUNT_ID    = process.env.TRADIER_ACCOUNT_ID;
  const TRADIER_PAPER_TOKEN   = process.env.TRADIER_PAPER_TOKEN;
  const TRADIER_PAPER_ACCOUNT_ID = process.env.TRADIER_PAPER_ACCOUNT_ID;
  const POLYGON_KEY           = process.env.POLYGON_KEY;

  if (!TRADIER_TOKEN || !TRADIER_ACCOUNT_ID) {
    console.log('[APEX] ERROR: Missing env vars TRADIER_TOKEN or TRADIER_ACCOUNT_ID');
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const H    = { 'Authorization': `Bearer ${TRADIER_TOKEN}`, 'Accept': 'application/json' };
  const BASE = 'https://api.tradier.com/v1';

  function getTier(gap) {
    if (gap >= 15) return { tier: 3, tpPct: 5.0, slPct: 3.0, bet: 2000 };
    if (gap >= 13) return { tier: 2, tpPct: 3.0, slPct: 1.5, bet: 1000 };
    if (gap >= 11) return { tier: 1, tpPct: 2.5, slPct: 1.5, bet: 750  };
    if (gap >= 10) return { tier: 0, tpPct: 2.0, slPct: 1.0, bet: 500  };
    return null;
  }

  // ── Load config FIRST so _live is known before dedup ────────────────────
  // Hardcoded fallback ensures a GitHub fetch failure never kills the run
  const CONFIG_FALLBACK = {"live":true,"maxTradesPerDay":10,"maxBetOverride":null,"maxDailyExposure":400,"betByScenario":{"A":25,"B":25,"C":25,"D":25,"E1":25,"E2":25,"E3":25,"E4":25,"F":25},"scenarios":{"A":false,"B":false,"C":false,"D":false,"E":true,"F":true,"G":false,"H":false}};
  let config;
  try {
    const _cfgCtrl = new AbortController();
    const _cfgTimeout = setTimeout(() => _cfgCtrl.abort(), 5000);
    const r = await fetch('https://raw.githubusercontent.com/justingoody28-jpg/apex-trader-sandbox/main/public/auto-trade-config.json', { signal: _cfgCtrl.signal });
    clearTimeout(_cfgTimeout);
    if (!r.ok) throw new Error('Config fetch failed: ' + r.status);
    config = await r.json();
    console.log('[APEX] Config loaded from GitHub');
  } catch (e) {
    console.log('[APEX] Config fetch failed, using fallback:', e.message);
    config = CONFIG_FALLBACK;
  }

  const _live        = config.live === true;
  const _maxTrades   = config.maxTradesPerDay  || 999;
  const _maxExposure = config.maxDailyExposure || 999999;
  const _betOverride = config.maxBetOverride   || null;
  const _betBySc     = config.betByScenario    || {};

  console.log(`[APEX] Config loaded | live=${_live} maxTrades=${_maxTrades} maxExposure=${_maxExposure} betByScenario=${JSON.stringify(_betBySc)}`);

  const LIVE_BASE  = 'https://api.tradier.com/v1';
  const PAPER_BASE = _live ? LIVE_BASE : 'https://sandbox.tradier.com/v1';
  const ORDER_ACCOUNT = _live ? TRADIER_ACCOUNT_ID    : TRADIER_PAPER_ACCOUNT_ID;
  const ORDER_TOKEN   = _live ? TRADIER_TOKEN          : TRADIER_PAPER_TOKEN;
  const ORDER_H = { 'Authorization': `Bearer ${ORDER_TOKEN}`, 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };

  console.log(`[APEX] Routing: ${_live ? 'LIVE api.tradier.com account=' + TRADIER_ACCOUNT_ID : 'PAPER sandbox.tradier.com account=' + TRADIER_PAPER_ACCOUNT_ID}`);

  // ── Dedup guard: check the CORRECT account based on _live (skipped in dryrun) ──
  const _todayEDT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().slice(0, 10);
  if (!DRY_RUN) {
    try {
      const _dedupBase = _live ? LIVE_BASE : 'https://sandbox.tradier.com/v1';
      const _dedupAcct = ORDER_ACCOUNT;
      const _dedupTok  = ORDER_TOKEN;
      const _or = await fetch(`${_dedupBase}/accounts/${_dedupAcct}/orders`,
        { headers: { 'Authorization': `Bearer ${_dedupTok}`, 'Accept': 'application/json' } });
      const _od   = await _or.json();
      const _ol   = _od?.orders?.order;
      const _oArr = Array.isArray(_ol) ? _ol : (_ol ? [_ol] : []);
      const _tod  = _oArr.filter(o =>
        o.create_date?.startsWith(_todayEDT) &&
        o.status !== 'canceled' && o.status !== 'cancelled' &&
        o.status !== 'rejected' && o.status !== 'expired'
      );
      console.log(`[APEX] Dedup check (${_live ? 'LIVE' : 'PAPER'} account) | today=${_todayEDT} | existing orders=${_tod.length}`);
      if (_tod.length > 0) {
        const syms = _tod.map(o => o.symbol || (Array.isArray(o.leg) ? o.leg[0]?.symbol : o.leg?.symbol) || '?');
        console.log(`[APEX] DEDUP BLOCK: ${_tod.length} orders already placed today. Symbols: ${syms.join(',')}`);
        return res.status(200).json({
          timestamp: runId, status: 'already_ran',
          message: `Dedup guard: ${_tod.length} orders already placed today (${_todayEDT}). Skipping.`,
          symbols: syms
        });
      }
    } catch (_e) {
      console.log('[APEX] Dedup check failed (non-fatal):', _e.message);
    }
  } else {
    console.log(`[APEX] Dedup skipped (dryrun mode)`);
  }

  // ── Weekend guard (day-of-week only — Tradier clock unreliable at 9:29 AM EDT) ──
  const _nowEDT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _dayEDT = _nowEDT.getDay();
  if (_dayEDT === 0 || _dayEDT === 6) {
    console.log('[APEX] Weekend — no trades placed');
    return res.status(200).json({ timestamp: runId, status: 'market_closed', message: 'Weekend. No trades placed.', trades: [] });
  }
  console.log(`[APEX] Day check passed (day=${_dayEDT}) — proceeding`);

  function scBet(sc, tickerBet) {
    if (_betBySc[sc] > 0) return _betBySc[sc];
    if (_betOverride) return Math.min(tickerBet, _betOverride);
    return tickerBet;
  }

  if (!config.scenarios || !config.scenarios.E) {
    console.log('[APEX] Scenario E disabled in config');
    return res.status(200).json({ message: 'Scenario E disabled', trades: [] });
  }

  // ── Load tickers from Supabase ───────────────────────────────────────────
  let tickers = [];
  let _excl   = {};
  try {
    const _sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const _sbKey = process.env.SUPABASE_SERVICE_KEY;
    const _sbH   = { apikey: _sbKey, Authorization: `Bearer ${_sbKey}` };
    const _wlR   = await fetch(`${_sbUrl}/rest/v1/apex_watchlist?id=eq.default`, { headers: _sbH });
    const _wlD   = await _wlR.json();
    const _active  = new Set(_wlD[0]?.active || []);
    const _exclRaw = _wlD[0]?.excluded;
    _excl = (_exclRaw && !Array.isArray(_exclRaw)) ? _exclRaw : {};
    const _snR  = await fetch(`${_sbUrl}/rest/v1/apex_backtest_snapshots?select=rows,label&order=saved_at.desc&limit=1`, { headers: _sbH });
    const _snD  = await _snR.json();
    const _rows = _snD[0]?.rows || [];
    tickers = [..._active].map(sym => {
      const row = _rows.find(r => r.tk === sym);
      const e   = row?.e;
      if (e && e.n >= 5 && e.pf > 0) {
        const wr  = e.w / (e.w + e.l);
        const k   = Math.max(0, wr - (1 - wr) / e.pf);
        const bet = Math.round(Math.max(250, Math.min(2000, k * 0.5 * 50000)) / 50) * 50;
        return { symbol: sym, bet };
      }
      return { symbol: sym, bet: 500 };
    });
    console.log(`[APEX] Watchlist loaded: ${tickers.length} tickers from Supabase`);
  } catch (_sbErr) {
    console.log('[APEX] Supabase load failed, falling back to config tickers:', _sbErr.message);
    tickers = (config.tickers || []).filter(t => t.symbol && t.bet > 0);
  }

  if (_betOverride) tickers = tickers.map(t => ({ ...t, bet: Math.min(t.bet, _betOverride) }));
  if (!tickers.length) {
    console.log('[APEX] No tickers — exiting');
    return res.status(200).json({ message: 'No tickers', trades: [] });
  }

  // ── Fetch quotes ─────────────────────────────────────────────────────────
  const symbols  = [...new Set([...tickers.map(t => t.symbol.toUpperCase()), 'SPY'])];
  let quoteMap   = {};
  try {
    const r = await fetch(`${BASE}/markets/quotes?symbols=${symbols.join(',')}&greeks=false`, { headers: H });
    if (r.ok) {
      const data = await r.json();
      const raw  = data.quotes && data.quotes.quote;
      if (raw) { const arr = Array.isArray(raw) ? raw : [raw]; arr.forEach(q => { quoteMap[q.symbol] = q; }); }
    }
    console.log(`[APEX] Quotes fetched for ${Object.keys(quoteMap).length} symbols`);
  } catch (_qe) { console.log('[APEX] Quote fetch failed (non-fatal):', _qe.message); }

  // ── SPY filters ──────────────────────────────────────────────────────────
  const spyQ    = quoteMap['SPY'];
  const spyGap  = spyQ && spyQ.prevclose > 0 ? ((spyQ.bid || spyQ.last) - spyQ.prevclose) / spyQ.prevclose * 100 : 0;
  const skipD   = spyGap > 0.5;
  console.log(`[APEX] SPY gap=${spyGap.toFixed(2)}% skipD=${skipD}`);

  let spyRecovering = false;
  try {
    if (POLYGON_KEY && spyQ) {
      const ds  = new Date().toISOString().split('T')[0];
      const pr  = await fetch(`https://api.polygon.io/v2/aggs/ticker/SPY/range/1/minute/${ds}T09:00:00/${ds}T09:01:00?adjusted=false&limit=1&apiKey=${POLYGON_KEY}`);
      if (pr.ok) {
        const pd     = await pr.json();
        const spy900 = pd.results && pd.results[0] ? pd.results[0].c : null;
        const spy929 = spyQ.bid || spyQ.last;
        if (spy900 && spy929) spyRecovering = spy929 > spy900;
        console.log(`[APEX] SPY 9:00=${spy900} 9:29=${spy929} recovering=${spyRecovering}`);
      }
    }
  } catch (e) { console.log('[APEX] SPY recovery check failed (non-fatal):', e.message); }

  let vix = null;
  try {
    if (POLYGON_KEY) {
      const ds = new Date().toISOString().split('T')[0];
      const vr = await fetch(`https://api.polygon.io/v2/aggs/ticker/I:VIX/range/1/day/${ds}/${ds}?adjusted=false&limit=1&apiKey=${POLYGON_KEY}`);
      if (vr.ok) {
        const vd = await vr.json();
        if (vd.results && vd.results[0]) vix = vd.results[0].c;
        console.log(`[APEX] VIX=${vix}`);
      }
    }
  } catch (e) { console.log('[APEX] VIX fetch failed (non-fatal):', e.message); }

  const results       = [];
  let _tradesPlaced   = 0;
  let _exposureUsed   = 0;

  function _riskOk(betAmt) {
    if (_tradesPlaced >= _maxTrades)           return false;
    if (_exposureUsed + betAmt > _maxExposure) return false;
    return true;
  }

  // ── Ticker loop ──────────────────────────────────────────────────────────
  for (const ticker of tickers) {
    const sym = ticker.symbol.toUpperCase();
    const bet = ticker.bet;
    const q   = quoteMap[sym];

    if (!q) {
      console.log(`[APEX] ${sym} | SKIP: no quote`);
      results.push({ symbol: sym, status: 'skipped', reason: 'No quote from Tradier' });
      continue;
    }

    const bidPrice = (q.bid && q.bid > 0) ? q.bid : null;
    const price    = bidPrice;
    const prevClose = q.prevclose;

    if (!price || !prevClose || price <= 0 || prevClose <= 0) {
      console.log(`[APEX] ${sym} | SKIP: missing price (bid=${q.bid} prevclose=${prevClose})`);
      results.push({ symbol: sym, status: 'skipped', reason: 'Missing price or prevclose' });
      continue;
    }

    const gap  = (price - prevClose) / prevClose * 100;
    const tier = getTier(gap);
    const rvol = (q.average_volume > 0) ? +(q.volume / q.average_volume).toFixed(2) : null;

    console.log(`[APEX] ${sym} | bid=${price} prevclose=${prevClose} gap=${gap.toFixed(2)}% rvol=${rvol}`);

    // ── Scenario D: Short gap-up >=2% ──────────────────────────────────────
    if (config.scenarios.D !== false && gap >= 2 && !skipD && !spyRecovering && (vix === null || vix > 20) && !(_excl.D || []).includes(sym) && _riskOk(scBet('D', bet))) {
      const _betD = scBet('D', bet);
      const tpD   = +(price * 0.98).toFixed(2);
      const slD   = +(price * 1.005).toFixed(2);
      const qtyD  = Math.max(1, Math.floor(_betD / price));
      console.log(`[APEX] ${sym} | SCENARIO D SHORT | bet=${_betD} qty=${qtyD} entry=${price} TP=${tpD} SL=${slD}`);
      try {
        const paramsD = new URLSearchParams({
          'class': 'otoco', 'duration': 'day',
          'symbol[0]': sym, 'side[0]': 'sell_short',    'quantity[0]': String(qtyD), 'type[0]': 'market',
          'symbol[1]': sym, 'side[1]': 'buy_to_cover',  'quantity[1]': String(qtyD), 'type[1]': 'limit', 'price[1]': String(tpD),
          'symbol[2]': sym, 'side[2]': 'buy_to_cover',  'quantity[2]': String(qtyD), 'type[2]': 'stop',  'stop[2]':  String(slD),
        });
        if (DRY_RUN) {
          results.push({ symbol: sym, scenario: 'D', status: 'dry_run', gap: +gap.toFixed(2), price, bet: _betD, qty: qtyD, tp: tpD, sl: slD });
        } else {
          const rdD = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: paramsD });
          const jD  = await rdD.json();
          console.log(`[APEX] ${sym} D order result: status=${rdD.status} orderId=${jD?.order?.id}`);
          if (rdD.ok) { _tradesPlaced++; _exposureUsed += _betD; }
          results.push({ symbol: sym, scenario: 'D', status: rdD.ok ? 'filled' : 'error', gap: gap.toFixed(2), price, qty: qtyD, tp: tpD, sl: slD, order: jD?.order });
        }
      } catch (eD) {
        console.log(`[APEX] ${sym} D order exception:`, eD.message);
        results.push({ symbol: sym, scenario: 'D', status: 'error', error: eD.message });
      }
    }

    // ── Scenario A: Long gap-up >=2% when SPY recovering ──────────────────
    if (gap >= 2 && spyGap > 0.5 && spyRecovering && (vix === null || vix <= 25) && !(_excl.A || []).includes(sym) && _riskOk(scBet('A', bet))) {
      const _betA = scBet('A', bet);
      const tpA   = +(price * 1.02).toFixed(2);
      const slA   = +(price * 0.995).toFixed(2);
      const qtyA  = Math.max(1, Math.floor(_betA / price));
      console.log(`[APEX] ${sym} | SCENARIO A LONG | bet=${_betA} qty=${qtyA} entry=${price} TP=${tpA} SL=${slA}`);
      try {
        const paramsA = new URLSearchParams({
          'class': 'otoco', 'duration': 'day',
          'symbol[0]': sym, 'side[0]': 'buy',  'quantity[0]': String(qtyA), 'type[0]': 'market',
          'symbol[1]': sym, 'side[1]': 'sell', 'quantity[1]': String(qtyA), 'type[1]': 'limit', 'price[1]': String(tpA),
          'symbol[2]': sym, 'side[2]': 'sell', 'quantity[2]': String(qtyA), 'type[2]': 'stop',  'stop[2]':  String(slA),
        });
        if (DRY_RUN) {
          results.push({ symbol: sym, scenario: 'A', status: 'dry_run', gap: +gap.toFixed(2), price, bet: _betA, qty: qtyA, tp: tpA, sl: slA });
        } else {
          const rdA = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: paramsA });
          const jA  = await rdA.json();
          console.log(`[APEX] ${sym} A order result: status=${rdA.status} orderId=${jA?.order?.id}`);
          if (rdA.ok) { _tradesPlaced++; _exposureUsed += _betA; }
          results.push({ symbol: sym, scenario: 'A', status: rdA.ok ? 'filled' : 'error', gap: gap.toFixed(2), spyGap: spyGap.toFixed(2), price, qty: qtyA, tp: tpA, sl: slA, order: jA?.order });
        }
      } catch (eA) {
        console.log(`[APEX] ${sym} A order exception:`, eA.message);
        results.push({ symbol: sym, scenario: 'A', status: 'error', error: eA.message });
      }
    }

    // ── Scenario F: Long gap-down <=-5% ───────────────────────────────────
    if (gap <= -5 && gap > -25 && !(_excl.F || []).includes(sym) && _riskOk(scBet('F', bet))) {
      const _betF = scBet('F', bet);
      const tpF   = +(price * 1.02).toFixed(2);
      const slF   = +(price * 0.98).toFixed(2);
      const qtyF  = Math.max(1, Math.floor(_betF / price));
      console.log(`[APEX] ${sym} | SCENARIO F LONG | bet=${_betF} qty=${qtyF} entry=${price} TP=${tpF} SL=${slF}`);
      try {
        const paramsF = new URLSearchParams({
          'class': 'otoco', 'duration': 'day',
          'symbol[0]': sym, 'side[0]': 'buy',  'quantity[0]': String(qtyF), 'type[0]': 'market',
          'symbol[1]': sym, 'side[1]': 'sell', 'quantity[1]': String(qtyF), 'type[1]': 'limit', 'price[1]': String(tpF),
          'symbol[2]': sym, 'side[2]': 'sell', 'quantity[2]': String(qtyF), 'type[2]': 'stop',  'stop[2]':  String(slF),
        });
        if (DRY_RUN) {
          results.push({ symbol: sym, scenario: 'F', status: 'dry_run', gap: +gap.toFixed(2), price, bet: _betF, qty: qtyF, tp: tpF, sl: slF });
        } else {
          const rdF = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: paramsF });
          const jF  = await rdF.json();
          console.log(`[APEX] ${sym} F order result: status=${rdF.status} orderId=${jF?.order?.id}`);
          if (rdF.ok) { _tradesPlaced++; _exposureUsed += _betF; }
          results.push({ symbol: sym, scenario: 'F', status: rdF.ok ? 'filled' : 'error', gap: gap.toFixed(2), price, qty: qtyF, tp: tpF, sl: slF, order: jF?.order });
        }
      } catch (eF) {
        console.log(`[APEX] ${sym} F order exception:`, eF.message);
        results.push({ symbol: sym, scenario: 'F', status: 'error', error: eF.message });
      }
    }

    // ── Scenario E: Short gap-up >=10% tiered ─────────────────────────────
    if (!tier) {
      results.push({ symbol: sym, status: 'skipped', reason: `Gap ${gap.toFixed(2)}% below +10% threshold`, gap: +gap.toFixed(2), rvol_logged: rvol });
      continue;
    }
    if ((_excl[tier.tier] || []).includes(sym)) {
      console.log(`[APEX] ${sym} | SKIP: excluded from E${tier.tier + 1}`);
      results.push({ symbol: sym, status: 'skipped', reason: `Excluded from ${tier.tier}`, gap: +gap.toFixed(2), tier: tier.tier });
      continue;
    }
    if (!_riskOk(tier.bet || bet)) {
      console.log(`[APEX] ${sym} | SKIP: risk cap reached (placed=${_tradesPlaced} exposure=${_exposureUsed})`);
      results.push({ symbol: sym, status: 'skipped', reason: 'Risk cap reached', gap: +gap.toFixed(2), tier: tier.tier });
      continue;
    }

    const eBet = scBet('E' + (tier.tier + 1), tier.bet || bet);
    const qty  = Math.max(1, Math.floor(eBet / price));
    if (qty < 1) {
      console.log(`[APEX] ${sym} | SKIP: bet too small at $${price}`);
      results.push({ symbol: sym, status: 'skipped', reason: `Bet too small at $${price.toFixed(2)}`, gap: +gap.toFixed(2), tier: tier.tier });
      continue;
    }

    const tp = +(price * (1 - tier.tpPct / 100)).toFixed(2);
    const sl = +(price * (1 + tier.slPct / 100)).toFixed(2);
    console.log(`[APEX] ${sym} | SCENARIO E${tier.tier + 1} SHORT | bet=${eBet} qty=${qty} entry=${price} TP=${tp} SL=${sl} gap=${gap.toFixed(2)}%`);

    try {
      const params = new URLSearchParams({
        'class': 'otoco', 'duration': 'day',
        'symbol[0]': sym, 'side[0]': 'sell_short',   'quantity[0]': String(qty), 'type[0]': 'market',
        'symbol[1]': sym, 'side[1]': 'buy_to_cover', 'quantity[1]': String(qty), 'type[1]': 'limit', 'price[1]': String(tp),
        'symbol[2]': sym, 'side[2]': 'buy_to_cover', 'quantity[2]': String(qty), 'type[2]': 'stop',  'stop[2]':  String(sl),
      });
      if (DRY_RUN) {
        results.push({ symbol: sym, scenario: 'E', status: 'dry_run', gap: +gap.toFixed(2), tier: tier.tier, price: +price.toFixed(2), qty, tp, sl });
      } else {
        const or = await fetch(`${PAPER_BASE}/accounts/${ORDER_ACCOUNT}/orders`, {
          method: 'POST', headers: { ...ORDER_H, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
        });
        const od = await or.json();
        console.log(`[APEX] ${sym} E order result: status=${or.status} orderId=${od?.order?.id} orderStatus=${od?.order?.status}`);
        if (!or.ok || (od.order && od.order.status === 'error')) {
          results.push({ symbol: sym, status: 'error', reason: od.order?.partner_error_description || od.fault?.faultstring || `Tradier ${or.status}`, gap: +gap.toFixed(2), tier: tier.tier });
        } else {
          _tradesPlaced++;
          _exposureUsed += eBet;
          results.push({ symbol: sym, status: 'traded', scenario: 'E', variant: 'C-Tradier-tiered', side: 'sell_short', qty, entryPrice: +price.toFixed(2), tier: tier.tier, tpPct: tier.tpPct, slPct: tier.slPct, takeProfitPrice: tp, stopLossPrice: sl, gap: +gap.toFixed(2), rvol_logged: rvol, orderId: od.order?.id, orderStatus: od.order?.status });
        }
      }
    } catch (e) {
      console.log(`[APEX] ${sym} E order exception:`, e.message);
      results.push({ symbol: sym, status: 'error', reason: e.message });
    }
  }

  const traded  = results.filter(r => r.status === 'traded' || r.status === 'dry_run').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors  = results.filter(r => r.status === 'error').length;
  console.log(`[APEX] ===== RUN COMPLETE | traded=${traded} skipped=${skipped} errors=${errors} totalExposure=$${_exposureUsed} =====`);

  // ── Persist trade log to Supabase ────────────────────────────────────────
  try {
    const _sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const _sbKey = process.env.SUPABASE_SERVICE_KEY;
    const _sbH   = { 'apikey': _sbKey, 'Authorization': `Bearer ${_sbKey}`, 'Content-Type': 'application/json' };
    const _trigger = DRY_RUN ? 'dryrun' : (req.headers['x-vercel-cron'] ? 'cron' : 'manual');
    const _logRows = results
      .filter(r => r.status === 'traded' || r.status === 'dry_run' || r.status === 'error' ||
                   (r.status === 'skipped' && r.gap !== undefined && Math.abs(r.gap) >= 2))
      .map(r => ({
        run_at:       runId,
        trigger_type: _trigger,
        live:         _live,
        symbol:       r.symbol,
        scenario:     r.scenario || null,
        status:       r.status,
        gap:          r.gap !== undefined ? +r.gap : null,
        price:        r.price || r.entryPrice || null,
        qty:          r.qty || null,
        tp:           r.tp || r.takeProfitPrice || null,
        sl:           r.sl || r.stopLossPrice  || null,
        bet:          r.bet || null,
        order_id:     r.order?.id || r.orderId || null,
        reason:       r.reason || null,
      }));
    if (_logRows.length > 0) {
      const _lr = await fetch(`${_sbUrl}/rest/v1/apex_trade_log`, {
        method: 'POST',
        headers: { ..._sbH, 'Prefer': 'return=minimal' },
        body: JSON.stringify(_logRows)
      });
      console.log(`[APEX] Trade log written: ${_logRows.length} rows | status=${_lr.status}`);
    }
  } catch (_logErr) {
    console.log('[APEX] Trade log write failed (non-fatal):', _logErr.message);
  }

  return res.status(200).json({
    timestamp: runId, variant: 'C-Tradier-tiered-9:29',
    live: _live,
    summary: { traded, skipped, errors },
    trades: results
  });
}
// force deploy Thu Apr 16 10:37:00 UTC 2026
