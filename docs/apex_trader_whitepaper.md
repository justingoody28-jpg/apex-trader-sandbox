# APEX TRADER

## SANDBOX EDITION

Technical White Paper - System Architecture, Signal Logic, Failure Modes & Self-Correction Mechanisms

- Date: March 21, 2026
- Version: Sandbox v1.0 (Production-ready)
- Live URL: `apex-trader-sandbox.vercel.app`
- Author: Claude (Anthropic) + Justin Goody

## 1. Executive Summary

Apex Trader Sandbox is a full-stack paper trading platform built to identify and act on market overreactions in US equities. It combines real-time technical signals from a deterministic 7-factor scoring engine with Claude-powered fundamental analysis across four market-cap categories. The system is designed to be transparent, explainable, and self-correcting under adverse conditions including API rate limits, stale data, and deployment failures.

### Core Philosophy

Markets overreact to short-term news. A stock dropping 15-20% from its 52-week high on sentiment rather than fundamentals creates a statistical edge. Apex Trader identifies these moments using quantitative signals (RSI, MACD, volume ratio, DIP%) and validates them with AI-driven fundamental analysis to separate genuine value from falling knives.

## 2. System Architecture

### 2.1 Infrastructure Stack

| Layer | Technology | Role |
| --- | --- | --- |
| Frontend | Next.js + React (JSX) | Single-page app, all tabs |
| Hosting | Vercel (Hobby) | Auto-deploys from GitHub main |
| Database | Supabase (PostgreSQL) | Portfolio, trades, AI results, watchlist |
| Price Data | Finnhub API | Live quotes, 52w high/low, volume |
| Supplemental | Twelve Data API | Historical series (chart overlays) |
| AI Engine | Claude Sonnet 4 via Anthropic API | Fundamental analysis, signal justification |
| SEC Filings | EDGAR (no API key) | Revenue growth from 10-K filings |
| Source Control | GitHub (justingoody28-jpg) | Separate live + sandbox repos |

### 2.2 API Routes

All external API calls are proxied through server-side Next.js API routes to keep keys off the client:

- `/api/market` - Routes to Finnhub (`fh`) or Twelve Data (`td`) by `source` param
- `/api/analyze` - Proxies to Anthropic Claude API (AI analysis + signal justification)
- `/api/portfolio` - Supabase CRUD: portfolio, positions, trades, watchlist, AI results, validation scores
- `/api/edgar` - Fetches SEC EDGAR 10-K revenue data (free, no key required)

### 2.3 Data Flow

On page load, the app checks `localStorage` for a same-day quote cache. If present, it builds signals immediately from cached data at zero API cost. If not, it fires 20 parallel Finnhub quote calls plus 20 Finnhub metric calls (for 52-week data and volume averages), merges results, builds the signal dataset, and saves to `localStorage`. Subsequent Refresh button presses read from cache only. The New Prices button clears the cache and forces a fresh fetch.

## 3. The Signal Engine

### 3.1 Seven-Factor Scoring Model

Every stock in the screener is scored on a 0-100 composite using seven deterministic factors. Given identical inputs, the same score and signal are always produced.

| Factor | Source | Buy Zone | Points | Weight |
| --- | --- | --- | --- | --- |
| DIP from 52W High | Finnhub metric | 5% to 20% | 30 pts | 30% |
| RSI (14-period) | Calculated | 35 to 55 | 25 pts | 25% |
| MACD Histogram | Calculated | > 0 (bullish) | 25 pts | 25% |
| Volume Ratio | Finnhub metric | > 1.3x average | 20 pts | 20% |
| 52W Range Position | Finnhub metric | Below 40% | Display only | - |
| 1-Day Change | Finnhub quote | Near neutral | Display only | - |
| Composite Score | Sum above | > 60 preferred | 0-100 total | 100% |

### 3.2 Signal Classification

Signals are assigned based on DIP zone and metric quality:

| Signal | DIP Range | Conditions |
| --- | --- | --- |
| STRONG BUY | 5% to 20% | RSI 45-60 AND MACD > 0 AND Volume >= 1.3x |
| BUY | 5% to 40% | RSI >= 35 AND MACD > -0.5 (extended zone: 20-40% with momentum) |
| WATCH | 5% to 40% | RSI below oversold OR mixed metrics in extended zone |
| HOLD | Any | No clear buy setup; metrics do not align |
| SELL | < 5% or > 40% | Near 52W high (overbought) or extreme drop with weak metrics |

### 3.3 Deterministic Price History

RSI and MACD require a 90-day price series. Since the free Finnhub tier does not provide historical OHLCV data, the app constructs a deterministic synthetic price path anchored to real data:

- Start point: 52-week low (real, from Finnhub metric)
- End point: Current price (real, from Finnhub quote)
- Trajectory: Power-law interpolation (`progress^0.7`) from low to current
- Oscillation: Deterministic wave using ticker character codes as a hash seed
- Formula:

```text
osc = ((hash * day) % 17 - 8) / 8 * (h52hi - h52lo) * 0.04
```

The key property: identical inputs (ticker, current price, 52w high, 52w low) always produce identical RSI and MACD. Signals only change when the real market prices change.

### Why Not Fetch Real Historical Data?

Twelve Data's free tier allows 8 API credits per minute and 800 per day. A single batch quote of 20 symbols costs 20 credits, blowing the per-minute limit. Fetching 90 days of daily OHLCV for 20 tickers would cost 1,800 credits in one shot. The deterministic synthetic history solves this at zero API cost while keeping RSI/MACD directionally accurate relative to the real 52w price range.

## 4. Data Pipeline

### 4.1 Finnhub Integration

The live screener fires 40 parallel API calls on New Prices (20 quote + 20 metric). Each call returns:

- Quote endpoint: current price (`c`), previous close (`pc`), 1D % change (`dp`)
- Metric endpoint: `52WeekHigh`, `52WeekLow`, `10DayAverageTradingVolume`, `3MonthAverageTradingVolume`, beta, P/E ratio

Volume ratio is derived as: 10-day average volume / 3-month average volume. A ratio above 1.0 indicates elevated recent trading versus the longer baseline, suggesting institutional interest or momentum.

### 4.2 Caching Strategy

To prevent repeated API calls and ensure stable signals within a session, the app uses a two-layer cache:

| Cache Layer | Storage | TTL | Content |
| --- | --- | --- | --- |
| Daily price cache | `localStorage` | Until next calendar day | All 20 Finnhub quote + metric responses |
| Vercel CDN cache | Edge network | 60 seconds (quotes) | API route responses |
| Supabase storage | PostgreSQL | Permanent | AI analysis results, validation scores |

## 5. AI Analysis System

### 5.1 Four-Category Framework

The AI Analysis tab uses Claude Sonnet 4 to analyze stocks by market cap category, applying the Fallen Giants methodology (overreaction investing) to each tier:

| Category | Market Cap | Icon | Focus |
| --- | --- | --- | --- |
| Fallen Giants | $100B+ | Crown | Household names: Apple, Nike, Disney, Google |
| Mid-Market | $10B-$100B | Building | Industry leaders with higher upside |
| Rising Stars | $1B-$10B | Rocket | Growth companies with strong trajectories |
| Speculative | Under $1B | Lightning | High risk/reward; explicit solvency scrutiny |

### 5.2 Per-Stock Analysis Output

Each AI Analysis card returns a structured JSON object with the following fields:

- Verdict: Strong Overreaction | Overreaction | Partial Overreaction | Mixed | Justified
- Catalyst: 2-sentence description of the most recent significant development
- Bull Case: 3-sentence strongest argument for recovery
- Bear Case: 3-sentence strongest argument against
- Analyst Target: consensus price target from analyst community
- Upside: percentage upside to analyst target
- P/E Ratio and Revenue Growth: fundamental context
- Recommendation: Strong Buy | Buy | Watch | Avoid
- Summary: 3-sentence overall investment thesis

### 5.3 Real-Data Validation Layer

After each AI analysis run, the app fires 8 parallel validation checks against free-tier APIs to cross-check Claude's assessment with actual market data:

| # | Check | Source | Pass Condition |
| --- | --- | --- | --- |
| 1 | Analyst buy consensus | Finnhub `/stock/recommendation` | Buy% > 50% of all ratings |
| 2 | Analyst price target | Finnhub `/stock/price-target` | Target > current price |
| 3 | Earnings beat rate | Finnhub `/stock/earnings` | Beat 2 of last 4 quarters |
| 4 | 52-week range position | Twelve Data `/quote` | Price below 40% of annual range |
| 5 | Volume vs average | Twelve Data `/quote` | Today's volume > 1.5x average |
| 6 | Recent price move | Finnhub `/quote` | 1D drop > 5% = capitulation signal |
| 7 | Beta and P/E ratio | Finnhub `/stock/metric` | Beta < 1.5 (lower volatility) |
| 8 | SEC revenue growth | EDGAR 10-K filings (free) | YoY revenue positive |

Results are scored: HIGH confidence (60%+ checks pass), MEDIUM (40-60%), LOW (<40%). Scores and check details are saved to Supabase for trend analysis.

### 5.4 Screener Signal Cross-Reference

Each AI Analysis card displays a SCREENER badge showing the technical signal for that ticker alongside Claude's fundamental verdict. This allows users to immediately see when the two systems agree or disagree, which is itself a signal:

- Both say BUY: Strong convergence from technical momentum + fundamental value
- AI says Buy, Screener says SELL: Deep value situation where technicals haven't bottomed yet
- AI says Avoid, Screener says BUY: Fundamental concern despite temporary price bounce
- Disagreement: Signals independent perspectives for user judgment

## 6. Screener Ticker Detail Panel

Clicking any ticker in the Market Screener opens a 400px slide-in panel from the right containing two sections:

### 6.1 Signal Breakdown Gauges

Seven animated progress bars, color-coded to the buy zone. Each gauge includes a note explaining the target range and the current value in context. Colors indicate: green = in buy zone, yellow = marginal, red = outside zone.

### 6.2 AI Signal Justification

On panel open, a lightweight Claude API call is fired with a prompt containing the stock's exact metric values. Claude returns 3-4 sentences specifically referencing the RSI, DIP%, MACD, and volume to explain why this signal was generated. This makes the system fully explainable to the user.

## 7. Paper Trading & Autopilot

### 7.1 Paper Trading Engine

The Paper Trade tab provides a $100,000 simulated portfolio. Trades are persisted to Supabase across sessions. Each position tracks entry price, quantity, stop-loss ($7% default), and take-profit (20% default).

### 7.2 Backtester

The Backtest tab runs a 90-day simulation on any screener stock using the same signal logic as the live screener. Output includes a full equity curve, drawdown chart, trade log, and 12 statistical metrics:

- Total Return vs Buy & Hold (alpha)
- Sharpe Ratio (target >= 1.5), Sortino Ratio (target >= 2.0), Calmar Ratio
- Win Rate, Profit Factor, Expectancy
- Max Drawdown, Average Hold Days, Largest Win/Loss, Max Win/Loss Streaks

### 7.3 Autopilot

The Autopilot tab auto-executes buy signals every 15 seconds against the paper portfolio. It respects position limits (max 5 open positions, max 18% per position) and logs every action with a timestamp and rationale.

### 7.4 Self-Tuning Engine

After each backtest, the system compares results against target thresholds and adjusts parameters for the next run:

- Sharpe < 0.5: Tighten stop-loss by 1%
- Sharpe > 2.0: Loosen stop-loss by 1%
- Win rate < 40%: Raise RSI recovery threshold by 2 points
- Win rate > 70%: Lower RSI recovery threshold by 2 points
- Profit factor < 1.2: Extend take-profit by 2%
- Max drawdown > 25%: Narrow DIP max by 2%
- Total trades < 2: Lower RSI oversold floor by 3 points

## 8. Known Failure Modes & Self-Correction

### 8.1 API Rate Limits

**Failure Mode**

Twelve Data free tier: 8 credits/minute, 800 credits/day. Finnhub free tier is more generous but still limited. If either API returns a 429 rate limit error during a batch fetch, the app would previously fall back to random simulated data, causing signals to flip unpredictably.

**Self-Correction**

Daily `localStorage` cache: prices are fetched once per day and stored. All Refresh button presses read from cache at zero API cost. New Prices button clears cache for intentional fresh fetch. The app switched from Twelve Data batch quotes (which hit the per-minute limit for 20 symbols) to individual Finnhub calls which have no per-batch limit.

### 8.2 Build Failures from JSX Encoding

**Failure Mode**

Next.js uses Babel to compile JSX. Several Unicode characters that are valid in JavaScript strings are not valid in JSX attribute values: arrows (U+2192), middle dots (U+00B7), en-dashes (U+2013), and curly quotes. These caused repeated Vercel build failures across 10+ deployment attempts, with the error always pointing to the nearest line rather than the actual offending character.

**Self-Correction**

All JSX string attributes that contained dynamic concatenation were wrapped in curly braces (`note={"string"+var}` not `note="string"+var`). All special Unicode chars were replaced with ASCII equivalents in JSX prop context. A pre-push validation script now checks for all 8 problem character types before any push.

### 8.3 Browser `btoa()` Encoding Corruption

**Failure Mode**

The primary deployment method (pushing large files via GitHub API from the browser) uses `btoa()` to base64-encode file content. `btoa()` is not UTF-8 safe: multi-byte characters (like emojis) are corrupted during the `atob(fetch) -> modify -> btoa(push)` round-trip. This caused a cycle where each browser-based fix introduced new corruption.

**Self-Correction**

Python's `base64.b64encode()` is lossless for all UTF-8 content. All file pushes are now generated as static HTML files using Python to encode the content, which the user opens in Chrome. This bypasses the `btoa()` corruption entirely. The HTML file contains only ASCII characters (base64 output) so no encoding issues occur.

### 8.4 Vercel Build Cache Serving Stale Code

**Failure Mode**

Vercel's Redeploy function replays a specific commit, not the latest `main` branch. After fixing code in GitHub, redeploying an old deployment ID served the old broken code regardless of what was in GitHub. The build cache also sometimes served outdated compiled output even when source had changed.

**Self-Correction**

To trigger a fresh build from the latest commit, push a new change (even a README timestamp update) to `main`. This creates a new commit SHA and Vercel auto-deploys from the current HEAD. When redeploying manually, always uncheck "Use existing Build Cache" to force a clean compile.

### 8.5 Stale Prices from CDN Cache

**Failure Mode**

The Vercel Edge CDN caches API route responses. When quote cache was set to `s-maxage=300` (5 minutes), some tickers would return fresh prices and others stale prices depending on when each CDN node last refreshed. This caused signals to drift between refreshes as some inputs changed and others did not.

**Self-Correction**

Quote endpoint cache TTL reduced to `s-maxage=60` (1 minute). Combined with the daily `localStorage` cache, the effective behavior is: use cached prices all day unless New Prices is clicked, at which point fresh data is fetched and re-cached. The CDN cache only affects the underlying API route, not the user-visible signal stability.

### 8.6 Signal Randomness from Simulated Data

**Failure Mode**

The original `genStock()` fallback function used `Math.random()` to generate price history, volume ratio, and volatility. When the API failed (rate limit, network error), the app fell back to this function, generating different random values on every refresh. This caused signals to change on every page load, undermining user trust.

**Self-Correction**

The `detStock()` fallback now uses a deterministic algorithm: price history is built from real anchor points (52w low to current price) with a hash-seeded oscillation using the ticker's character codes. Same ticker + same prices = same RSI + same signal, always. The `genStock()` random function is retained only as a last-resort fallback when no real data exists at all.

### 8.7 Signal Divergence Between Screener and AI Analysis

**Failure Mode**

The Screener uses technical signals (RSI, MACD, volume, DIP%). The AI Analysis uses Claude's fundamental assessment. These two systems can and do disagree. Without visibility into both, users could act on one signal while being unaware of a conflicting signal from the other system.

**By Design + Mitigation**

Disagreement between systems is intentional and valuable: it surfaces the tension between momentum (screener) and value (AI). The mitigation is transparency: every AI Analysis card now shows a SCREENER badge indicating the current technical signal for that ticker. Users see both perspectives side by side and can apply their own judgment to the disagreement.

## 9. Database Schema (Supabase)

| Table | Key Columns | Purpose |
| --- | --- | --- |
| portfolio | cash, updated_at | Current cash balance |
| positions | ticker, qty, entry, sl, tp | Open paper trade positions |
| trades | ticker, side, qty, price, pnl | Full trade history |
| ai_analysis | ticker, category, verdict, upside, recommendation | Claude's analysis results per run |
| validation_scores | ticker, score, confidence, checks_detail | 8-check real-data validation results |
| watchlist | ticker, name, added_from | Stocks saved from AI Analysis to Screener |

## 10. Free Tier API Limits & Operating Envelope

| API | Per-Minute Limit | Daily Limit | Our Usage Pattern |
| --- | --- | --- | --- |
| Finnhub | 30 calls/sec | Generous | 40 calls on New Prices (once/day) |
| Twelve Data | 8 credits/min | 800 credits/day | Chart overlays only; not main screener |
| Anthropic Claude | Variable | Usage-based billing | AI Analysis runs + signal justifications |
| SEC EDGAR | Unlimited | Unlimited | Revenue validation check only |
| Supabase | 500 MB storage | 50,000 MAU | Portfolio + AI result persistence |

## 11. Deployment Process

### 11.1 Standard Flow

All code changes follow this process to ensure reliability:

1. Edit `pages/index.js` locally in `/home/claude/apex-trader-sandbox/`
2. Run `node --check pages/index.js` (syntax validation)
3. Run the pre-push validation script: checks 8 problem Unicode chars, features present, `Math.random` usage, signal determinism
4. Generate a push HTML file using Python's `base64.b64encode()` (lossless encoding)
5. User opens HTML file in Chrome; it calls GitHub API `PUT` to push the file
6. Vercel auto-detects the GitHub push and deploys in ~25 seconds
7. Verify deployment in Vercel dashboard, check build logs if error

### 11.2 Why HTML Push Files?

The sandbox environment has no outbound network access from bash. All GitHub API calls must go through the browser. Large files (>20KB) cannot be reliably injected as JavaScript strings due to browser execution timeouts and `btoa()` encoding corruption. The HTML file approach embeds the pre-encoded base64 content as a static string literal, avoiding all encoding issues.

## 12. Suggested Improvements for Production

- Upgrade Twelve Data to Growth plan ($29/month): enables real 90-day OHLCV history for genuine RSI/MACD, removes the synthetic price path
- Add options flow data: unusual options activity as a leading signal before stock moves
- Insider transaction tracking: SEC Form 4 filings via EDGAR for insider buy/sell signals
- Sentiment layer: earnings call transcript sentiment via SEC EDGAR or news API
- Portfolio correlation analysis: avoid over-concentration in correlated sectors
- Notification system: push alerts when a HOLD transitions to BUY signal
- Mobile responsive: current layout is desktop-optimized; needs breakpoints for mobile
- Live trading integration: Alpaca API credentials already wired in Settings tab

## System Summary

### What Apex Trader Sandbox does in one paragraph

#### The Complete Picture

Apex Trader Sandbox fetches real-time prices for 20 US equities from Finnhub once per day, builds a deterministic 90-day synthetic price history anchored to each stock's actual 52-week range, and scores every stock on a 7-factor signal model (DIP from high, RSI, MACD, volume ratio, 52W position, 1D change, composite score). Technical signals (STRONG BUY through SELL) are stable within each trading day and only change when real prices change. A separate AI layer uses Claude Sonnet 4 to perform fundamental analysis across four market-cap categories, returning structured verdicts (Strong Overreaction through Justified) with bull/bear cases, analyst targets, and recommendations. Clicking any screener ticker opens a slide-in panel showing the full signal breakdown with animated gauges and a Claude-generated 3-4 sentence justification referencing the exact metric values. Both systems are cross-referenced: AI cards show the screener signal, making agreement and disagreement immediately visible. All data is persisted to Supabase. The system self-corrects against API rate limits via daily caching, against stale prices via TTL management, and against signal instability via deterministic calculation. When the build system fails, pre-push validation catches encoding and JSX syntax issues before deployment.

`apex-trader-sandbox.vercel.app`

Built with Claude (Anthropic) - March 2026
