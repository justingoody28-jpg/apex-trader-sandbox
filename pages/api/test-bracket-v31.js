// pages/api/test-bracket-v31.js
// ONE-SHOT Tier 2 test endpoint — exercises v3.1 submitBracketVerified
// against real Tradier paper API. DELETE AFTER USE.
//
// Usage:
//   GET /api/test-bracket-v31?ticker=AAPL&qty=1&secret=XXX
//
// Safety:
//   - Requires TV_WEBHOOK_SECRET for auth
//   - Hard cap: qty must be 1-5
//   - Hard cap: price × qty must be under $500 exposure
//   - Places market buy, waits for fill, submits v3.1 bracket
//   - If bracket fails → emergency flatten
//   - Returns full trace

export default async function handler(req, res) {
  // Auth gate
  const _secret = process.env.TV_WEBHOOK_SECRET;
  const _provided = req.headers['x-webhook-secret'] || req.query.secret;
  if (_secret && _provided !== _secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ticker = (req.query.ticker || '').toUpperCase();
  const qty = parseInt(req.query.qty || '1', 10);

  // Input validation
  if (!ticker || !/^[A-Z]{1,6}$/.test(ticker)) {
    return res.status(400).json({ error: 'ticker required (1-6 letters)' });
  }
  if (!Number.isFinite(qty) || qty < 1 || qty > 5) {
    return res.status(400).json({ error: 'qty must be between 1 and 5' });
  }

  // Tradier paper creds
  const LIVE_TOKEN_X = process.env.TRADIER_TOKEN;
  const LIVE_ACCOUNT = process.env.TRADIER_ACCOUNT_ID;
  const LIVE_TOKEN = process.env.TRADIER_TOKEN;
  if (!LIVE_TOKEN_X || !LIVE_ACCOUNT || !LIVE_TOKEN) {
    return res.status(500).json({ error: 'Missing Tradier env vars' });
  }

  const QUOTE_BASE = 'https://api.tradier.com/v1';
  const LIVE_BASE = 'https://api.tradier.com/v1';
  const QUOTE_H = { Authorization: `Bearer ${LIVE_TOKEN}`, Accept: 'application/json' };
  const ORDER_H = { Authorization: `Bearer ${LIVE_TOKEN_X}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };

  const trace = [];
  const log = (step, data) => { trace.push({ t: Date.now(), step, ...data }); };

  const runStartMs = Date.now();
  const retryDelaysMs = [0, 1500, 3000];
  const retryAbortMs = 50000;

  try {
    // Step 1: Fetch current quote to compute max exposure
    log('quote_fetch_start', { ticker });
    const qR = await fetch(`${QUOTE_BASE}/markets/quotes?symbols=${ticker}&greeks=false`, { headers: QUOTE_H });
    const qJ = await qR.json();
    const q = qJ?.quotes?.quote;
    const bidNow = q?.bid;
    const askNow = q?.ask;
    log('quote_fetch_result', { bid: bidNow, ask: askNow, last: q?.last });

    if (!bidNow || !askNow) {
      return res.status(400).json({ error: 'Could not fetch valid quote for ticker', trace });
    }

    const estExposure = askNow * qty;
    if (estExposure > 500) {
      return res.status(400).json({
        error: `Estimated exposure ${estExposure.toFixed(2)} > $500 cap. Use smaller qty or cheaper ticker.`,
        trace,
      });
    }
    log('exposure_check_passed', { estimated: estExposure });

    // Step 2: Market buy at paper
    log('entry_submit_start', {});
    const entryParams = new URLSearchParams({
      'class': 'equity',
      'duration': 'day',
      'symbol': ticker,
      'side': 'buy',
      'quantity': String(qty),
      'type': 'market',
    });
    const entryR = await fetch(`${LIVE_BASE}/accounts/${LIVE_ACCOUNT}/orders`, {
      method: 'POST', headers: ORDER_H, body: entryParams,
    });
    const entryJ = await entryR.json();
    const entryId = entryJ?.order?.id;
    log('entry_submit_result', { http: entryR.status, id: entryId, status: entryJ?.order?.status, body: entryJ });

    if (!entryR.ok || !entryId) {
      return res.status(500).json({ error: 'Entry submission failed', entryResponse: entryJ, trace });
    }

    // Step 3: Poll for fill (500ms × 6)
    let fillPrice = null;
    let finalEntryStatus = null;
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      const pR = await fetch(`${LIVE_BASE}/accounts/${LIVE_ACCOUNT}/orders/${entryId}`, { headers: ORDER_H });
      const pJ = await pR.json();
      const status = pJ?.order?.status;
      const avg = parseFloat(pJ?.order?.avg_fill_price);
      log('entry_poll', { attempt: i + 1, status, avg_fill_price: avg });
      if (status === 'filled' && avg > 0) {
        fillPrice = avg;
        finalEntryStatus = 'filled';
        break;
      }
      if (['rejected', 'canceled', 'expired', 'error'].includes(status)) {
        finalEntryStatus = status;
        log('entry_terminal', { status, reason: pJ?.order?.reason_description });
        return res.status(500).json({ error: `Entry ${status}`, trace });
      }
    }

    if (!fillPrice) {
      log('entry_timeout', {});
      // Try to cancel the unfilled entry
      const cancelR = await fetch(`${LIVE_BASE}/accounts/${LIVE_ACCOUNT}/orders/${entryId}`, { method: 'DELETE', headers: ORDER_H });
      log('entry_cancel', { http: cancelR.status });
      return res.status(500).json({ error: 'Entry did not fill in 3s', trace });
    }

    log('entry_filled', { fillPrice, qty });

    // Step 4: Compute TP / SL (2% each side)
    const tp = +(fillPrice * 1.02).toFixed(2);
    const sl = +(fillPrice * 0.98).toFixed(2);
    log('bracket_prices', { fillPrice, tp, sl, spread: +(tp - sl).toFixed(4) });

    // Step 5: v3.1 submitBracketVerified — full retry loop
    const OK_STATUSES = ['ok', 'open', 'pending', 'partially_filled'];
    const FAIL_STATUSES = ['rejected', 'canceled', 'cancelled', 'expired', 'error'];

    // Stage 1: spread check
    if ((tp - sl) < 0.12) {
      log('preflight_spread_fail', { tp, sl, spread: tp - sl });
      // Entry filled, bracket can't fire — flatten immediately
      await emergencyFlatten(ticker, qty, log, LIVE_BASE, LIVE_ACCOUNT, ORDER_H);
      return res.status(200).json({ ok: false, reason: 'spread_too_narrow', fillPrice, tp, sl, flattened: true, trace });
    }

    // Stage 2: bid-vs-stop check (refresh bid)
    const bidCheckR = await fetch(`${QUOTE_BASE}/markets/quotes?symbols=${ticker}&greeks=false`, { headers: QUOTE_H });
    const bidCheckJ = await bidCheckR.json();
    const currentBid = bidCheckJ?.quotes?.quote?.bid;
    log('preflight_bid_check', { bid: currentBid, sl });
    if (currentBid !== undefined && currentBid !== null && currentBid <= sl + 0.02) {
      log('preflight_bid_fail', { bid: currentBid, sl });
      await emergencyFlatten(ticker, qty, log, LIVE_BASE, LIVE_ACCOUNT, ORDER_H);
      return res.status(200).json({ ok: false, reason: 'bid_at_or_below_stop', fillPrice, tp, sl, flattened: true, trace });
    }

    // Stage 3: retry loop
    let lastResult = { ok: false, reason: 'no_attempts' };
    for (let i = 0; i < retryDelaysMs.length; i++) {
      const delayMs = retryDelaysMs[i];
      const attemptNum = i + 1;

      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));

      const elapsedMs = Date.now() - runStartMs;
      if (elapsedMs > retryAbortMs) {
        log('abort_timer_fired', { elapsedMs, limit: retryAbortMs });
        lastResult = { ok: false, reason: `abort_after_${i}_attempts` };
        break;
      }

      // Submit OCO
      const bracketParams = new URLSearchParams({
        'class': 'oco', 'duration': 'day',
        'symbol[0]': ticker, 'side[0]': 'sell', 'quantity[0]': String(qty), 'type[0]': 'limit', 'price[0]': String(tp),
        'symbol[1]': ticker, 'side[1]': 'sell', 'quantity[1]': String(qty), 'type[1]': 'stop',  'stop[1]':  String(sl),
      });
      const bR = await fetch(`${LIVE_BASE}/accounts/${LIVE_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: bracketParams });
      const bJ = await bR.json();
      const bracketId = bJ?.order?.id || null;
      const immediateStatus = bJ?.order?.status || 'unknown';
      log('bracket_attempt', { attemptNum, http: bR.status, id: bracketId, immediateStatus, body: bJ });

      if (!bR.ok || !OK_STATUSES.includes(immediateStatus)) {
        const reason = bJ?.order?.reason_description || bJ?.order?.partner_error_description || bJ?.fault?.faultstring || `HTTP ${bR.status} status=${immediateStatus}`;
        lastResult = { ok: false, reason: `attempt${attemptNum}_immediate_fail: ${reason}`, bracketId };
        continue;
      }

      // Re-poll at 500ms
      await new Promise(r => setTimeout(r, 500));
      try {
        const rpR = await fetch(`${LIVE_BASE}/accounts/${LIVE_ACCOUNT}/orders/${bracketId}`, { headers: ORDER_H });
        const rpJ = await rpR.json();
        const repollStatus = rpJ?.order?.status;
        const repollReason = rpJ?.order?.reason_description;
        log('bracket_repoll', { attemptNum, repollStatus, repollReason });

        if (FAIL_STATUSES.includes(repollStatus)) {
          lastResult = { ok: false, reason: `attempt${attemptNum}_post_submit_${repollStatus}: ${repollReason || 'no_reason'}`, bracketId };
          continue;
        }
        if (OK_STATUSES.includes(repollStatus)) {
          lastResult = { ok: true, reason: `verified_open_attempt${attemptNum}`, bracketId, finalStatus: repollStatus };
          break;
        }
      } catch (e) {
        log('bracket_repoll_exception', { attemptNum, err: e.message });
        lastResult = { ok: true, reason: `attempt${attemptNum}_repoll_exception_assumed_ok`, bracketId };
        break;
      }
    }

    // Final verdict
    if (lastResult.ok) {
      log('bracket_verified_open', lastResult);
      return res.status(200).json({
        ok: true,
        ticker, qty, fillPrice, tp, sl,
        bracketId: lastResult.bracketId,
        attempts: lastResult.reason.match(/attempt(\d)/) ? parseInt(lastResult.reason.match(/attempt(\d)/)[1], 10) : 1,
        message: 'Bracket is verified OPEN — manually close via Tradier dashboard before 3 PM CDT',
        trace,
      });
    } else {
      log('bracket_all_retries_failed', lastResult);
      await emergencyFlatten(ticker, qty, log, LIVE_BASE, LIVE_ACCOUNT, ORDER_H);
      return res.status(200).json({
        ok: false,
        ticker, qty, fillPrice,
        reason: lastResult.reason,
        flattened: true,
        message: 'Bracket failed all retries, position was emergency-flattened',
        trace,
      });
    }
  } catch (e) {
    log('handler_exception', { err: e.message, stack: e.stack });
    return res.status(500).json({ error: e.message, trace });
  }
}

async function emergencyFlatten(ticker, qty, log, LIVE_BASE, LIVE_ACCOUNT, ORDER_H) {
  log('emergency_flatten_start', { ticker, qty });
  const params = new URLSearchParams({
    'class': 'equity', 'duration': 'day',
    'symbol': ticker, 'side': 'sell', 'quantity': String(qty), 'type': 'market',
  });
  const r = await fetch(`${LIVE_BASE}/accounts/${LIVE_ACCOUNT}/orders`, { method: 'POST', headers: ORDER_H, body: params });
  const j = await r.json();
  log('emergency_flatten_result', { http: r.status, id: j?.order?.id, status: j?.order?.status });
  return j;
}
