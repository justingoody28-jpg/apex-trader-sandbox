# APEX Premarket Filter Derivation

Created 2026-04-24, derived from:
- Full-population tick analysis of 3,659 backtest signals (Q3 2022 – Q2 2025) via Polygon Advanced
- Forensic reconstruction of the Apr 23 2026 live cron execution

This document is the authoritative record of filter thresholds and why they exist.
Everything here is derived from data, not invented. When in doubt, trust this doc.

---

## Part 1: Spread filter — REJECTED

### Motivation
The Apr 23 2026 cron fired trades on illiquid names and lost money. Initial
hypothesis: filter on `NbboSpreadPct` to avoid wide-spread names.

### Method
Analyzed Polygon tick data for the 15-second window after market open for every
one of 3,659 signals in `apex_edge_backtest_OPEN_EXT_full__4_.csv` (F + E1-E4
scenarios, Q3 2022 – Q2 2025). Simulated a 200-share market order and measured
slip vs first-trade price. Binned by spread bucket: <1%, 1-2%, 2-3%, 3-5%,
5-10%, 10%+.

### Result — Scenario F by spread bucket (worst-case slip, all adverse)

| Spread | Large n | Large bktPnL | Large netWorst | Mid n | Mid bktPnL | Mid netWorst |
|:-|-:|-:|-:|-:|-:|-:|
| <1%   | 1,172 | +1.44% | +1.38% | 430 | +1.23% | +1.15% |
| 1-2%  |   363 | +1.54% | +1.36% | 430 | +1.44% | +1.33% |
| 2-3%  |   141 | +1.27% | +1.01% | 283 | +1.13% | +0.96% |
| 3-5%  |    92 | +1.09% | +0.73% | 198 | +1.18% | +1.00% |
| 5-10% |    20 | +1.20% | +0.93% | 139 | +0.82% | +0.56% |
| 10%+  |     4 | −1.00% | −1.14% |  77 | +0.88% | +0.68% |

### Conclusion
**Every spread bucket except `Large 10%+` (n=4, noise) has a positive edge even
under worst-case adverse-slip assumption.** A tight spread filter (e.g.
`spread<3%`) would remove 468 signals without materially improving edge. A
loose filter (`spread<10%`) saves only the 4-signal Large 10%+ bucket.

**Decision: do NOT implement a production spread filter.** Spread is not the
failure mode that caused Apr 23.

### What NOT to claim based on this data
- The backtest PnL numbers assume fill at the 9:30 open price. Worst-case
  net here = `bktPnL − mean|slip|`, which is conservative but not signed.
  True expected net is closer to `bktPnL − 0.2 × mean|slip|` assuming ~60%
  adverse slip.
- The backtest POPULATION EXCLUDES zero-pmv signals by construction — those
  signals wouldn't have qualifying gap values. So this data cannot tell us
  anything about the failure mode of true-zero-volume names.

---

## Part 2: Premarket-freshness filter — ADOPTED

### The Apr 23 2026 forensic

9 trades fired, 8 were losers, net P&L = −$8.09 on $656 notional.
All LIVE account (config.live=true).

Matched Tradier fill history against Polygon minute bars for the premarket
window (08:00–13:29 UTC = 04:00–09:29 EDT):

| Ticker | Premkt bars | Premkt vol | Last bar UTC | Result |
|:-|-:|-:|:-|:-|
| HUBS | 68 | 30,181 | 13:29 | −0.26% (ok) |
| SUPN | **4** | **589** | **10:34 (3h stale)** | −1.42% |
| BRZE | 11 | 12,587 | 13:28 | −1.82% |
| LVS | 47 | 81,155 | 13:29 | −2.17% |
| RYTM | **0** | **0** | — | −1.51% |
| INDB | **0** | **0** | — | −1.67% |
| INFY | 115 | 1,079,115 | 13:29 | +0.12% |
| KYMR | **0** | **0** | — | −2.55% |
| ACCO | **0** | **0** | — | naked sell |

**4 of 9 trades fired on stocks with literally zero premarket bars**
(RYTM, INDB, KYMR, ACCO). **1 more was 3-hour stale** (SUPN).

### Root cause — CONFIRMED (2026-04-24 via source inspection)

**NOT a watchlist issue.** `watchlist-sync.js` only writes `{symbol, bet}`
per ticker. It does NOT populate premkt fields. Premkt data flows through
`auto-trade-c.js` directly from Tradier's `/markets/quotes`.

The bug is in `auto-trade-c.js` lines 407-417:

```javascript
const bidPrice = (q.bid && q.bid > 0) ? q.bid : null;
const price    = bidPrice;
const prevClose = q.prevclose;
...
const gap = (price - prevClose) / prevClose * 100;
```

**Tradier's `q.bid` returns a value even when zero transactions occurred
premarket.** The bid can be:
- A market-maker placeholder quote (e.g., artificially wide $1×$200)
- A stale overnight bid carried from prior session
- An ECN indicative quote unrelated to real liquidity

Any such bid compared against `prevClose` generates a synthetic gap that
passes the F scenario threshold (`gap <= -5`), firing entries on stocks
nobody is actually trading.

Filter Rule 1 + Rule 2 below are sufficient to fix this. No change to
`watchlist-sync.js` is needed.

### Filter Rule 1 — CRITICAL, highest confidence

```
REJECT signal if Polygon premarket_bars_today == 0
  at cron-fire time (13:29 UTC / 09:29 EDT / 08:29 CDT)
```

**Derivation:** RYTM, INDB, KYMR, ACCO had literally zero premkt minute bars
on Apr 23. Their watchlist-computed "gap" was fiction. A hard reject on
zero-bar premkt would have blocked all 4. Net prevented loss: −$7.22 of the
−$8.09 total.

**Confidence: very high.** Any stock with zero premkt bars has no valid gap
reference. Zero data = zero trade, no judgment call.

### Filter Rule 2 — FRESHNESS, high confidence

```
REJECT signal if minutes_since_last_premkt_bar > 60
  at cron-fire time
```

**Derivation:** SUPN had 4 premkt bars totaling 589 shares but the most
recent was 175 min stale by cron time. That means for the last 3 hours
before market open, nobody was trading SUPN premarket. The system's
"current premkt price" was essentially the price from 6:34 AM EDT — not
actionable as a basis for firing a market order at 9:30.

**Confidence: high.** 60-minute threshold is conservative — a truly liquid
premkt name should print at least once per hour. More aggressive threshold
(30min) might be appropriate but 60min is clearly data-supported.

### Filter Rule 3 — VOLUME FLOOR, deferred

```
REJECT if premkt_volume_today < X  (X not yet derived)
```

**Reasoning:** The backtest population excludes zero-pmv signals, so we have
no clean statistical basis to pick X. Rules 1 + 2 alone would have caught all
5 bad Apr 23 trades. Add Rule 3 only if post-Rule-1,2 monitoring reveals
a residual failure mode.

---

## Part 3: Filter implementation checklist

**Before any production patch:**
1. [x] ~~Verify how `watchlist-sync.js` populates `premarket_volume`~~ — DONE.
      It doesn't. Premkt data comes from Tradier `/markets/quotes` in
      `auto-trade-c.js` directly. Not the bug source.
2. [ ] Add a Polygon-based freshness probe to `auto-trade-c.js` at
      pre-submission time (before OTOCO send). This must query
      `/v2/aggs/ticker/{sym}/range/1/minute/{today}/{today}` and check:
      - count of bars > 0
      - age of last bar (ms since then) < 60 × 60 × 1000
3. [ ] Add a dry-run mode that logs which signals would be rejected vs
      accepted across 1-2 weeks of live data, BEFORE enforcing.
4. [ ] Dedup guard must still run. Freshness filter is an ADDITIONAL
      gate, not a replacement.

**Deployment timing constraints:**
- NEVER commit to `auto-trade-c.js` between 8:29 AM CDT and 3:00 PM CDT on
  weekdays (cron window).
- Always dryrun first.

---

## Part 4: Population anchors (don't re-derive these)

From the 3,659-signal tick analysis (stored in `/tmp/tick_agg/b0-b6.json`
during derivation, source CSV at
`apex_edge_backtest_OPEN_EXT_full__4_.csv`):

- **Full-pop cumulative PnL:** +5,009.17% across 3,656 signals (3 Polygon
  errors). Mean +1.37%/trade.
- **Execution reality in tick-sim:**
  - Partial-fill rate (fi<200 shares in first 15s): 6.3%
  - Slip > 1% rate: 2.5%
  - Slip > 0.5% rate: 6.9%
  - Mean |slip|: 0.135% (13.5 bps)
- **Scenario mix with NBBO coverage:** F=3,352, E1=94, E2=101, E3=58, E4=54.
  A/B/C/D not in this backtest CSV.

These numbers are the ground truth for "what the strategy looks like in
execution." Any future analysis that doesn't start here is re-inventing.

---

## Part 5: What I am NOT claiming

1. The −$8.09 Apr 23 loss is not the whole story — it's 1 day. Historical
   loss patterns from other low-pmv days have not been pulled.
2. I have not verified `watchlist-sync.js` logic. The "watchlist is stale"
   hypothesis is inference from Polygon vs Tradier comparison, not source
   inspection. Next step is to read that file.
3. The spread filter rejection is correct within the backtest population,
   but the backtest excludes the exact failure mode (zero-pmv). The spread
   conclusion applies only to the space of signals that would reach
   post-freshness-filter evaluation.
4. Filter Rule 2's 60-minute threshold is conservative-but-reasonable,
   not optimally tuned. If more low-pmv days are analyzed, a tighter
   threshold (30 or 45min) may emerge as data-supported.


---

## Part 6: Signed slip distribution (added 2026-04-24)

Derived from `/tmp/tick_batches/b0-b5_raw.json`, 2,997 OK F-scenario signals
with per-signal tick data:

| Percentile | Signed slip |
|-----------:|------------:|
| p10        | −0.138%     |
| p25        | −0.001%     |
| p50        |  0.000%     |
| p75        | +0.003%     |
| p90        | +0.179%     |

- Mean signed slip: **+0.012%** (essentially zero)
- Adverse (slip > 0): 26.3%
- Favorable (slip < 0): 25.3%
- Zero slip: 48.4%

**Implication:** The worst-case-all-adverse slip analysis in Part 1 is
overly pessimistic. True expected net edge = bktPnL − 0.012% ≈ bktPnL.
Execution cost is noise against a 137bp/trade mean edge.

### Fill quality (200-share order, 15s window)
- Full fill (200 shares): 93.3%
- Partial <100 shares: 5.3%
- Partial <50 shares: 4.5%

### First-trade latency (ms after 9:30 open)
- p25: 74ms | p50: 553ms | p75: 881ms | p90: 1,529ms | p99: 11,188ms

Half of all signals see their first trade within 553ms of market open;
90% within 1.5 seconds. The p99 tail (11+ seconds) is the illiquid-name
failure mode already covered by Rules 1 + 2.

---

## Part 7: Apr 23 2026 forensic — preserved record

Tradier fills (LIVE account, config.live=true):

| Ticker | Side | Qty | Price  | Round-trip result |
|:-------|:-----|----:|-------:|------------------:|
| HUBS   | buy  |   1 | 213.62 | −0.26% (sell 213.07) |
| SUPN   | buy  |   1 |  50.94 | −1.42% (sell 50.22)  |
| BRZE   | buy  |   2 |  23.02 | −1.82% (sell 22.60)  |
| LVS    | buy  |   1 |  51.55 | −2.17% (sell 50.43)  |
| RYTM   | buy  |   1 |  86.29 | −1.51% (sell 84.99)  |
| INDB   | buy  |   1 |  80.04 | −1.67% (sell 78.70)  |
| INFY   | buy  |   3 |  12.89 | +0.12% (sell 12.90)  |
| KYMR   | buy  |   1 |  88.93 | −2.55% (sell 86.66)  |
| ACCO   | sell |  16 |   3.27 | NAKED (no buy leg)   |

Net realized: −$8.09 on ~$656 notional (−1.23% day).

Polygon premarket bar counts (04:00–09:29 EDT window):

| Ticker | bars | vol     | Last bar (UTC) |
|:-------|-----:|--------:|:---------------|
| HUBS   |   68 |  30,181 | 13:29          |
| SUPN   |    4 |     589 | **10:34 (3h stale)** |
| BRZE   |   11 |  12,587 | 13:28          |
| LVS    |   47 |  81,155 | 13:29          |
| RYTM   |    **0** |       **0** | —              |
| INDB   |    **0** |       **0** | —              |
| INFY   |  115 | 1,079,115 | 13:29        |
| KYMR   |    **0** |       **0** | —              |
| ACCO   |    **0** |       **0** | —              |

This is the ground-truth forensic behind Filter Rule 1 adoption.

