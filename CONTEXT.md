# Apex Trader Sandbox — Project Context
*Last updated: 2026-03-24*

## Live & Repo
- **Live:** https://apex-trader-sandbox.vercel.app
- **Repo:** https://github.com/justingoody28-jpg/apex-trader-sandbox
- **Vercel team:** justingoody28-7737s-projects

---

## Stack
- Next.js 14 deployed on Vercel
- Supabase for auth (email/password)
- Single-page app — main logic lives in `pages/index.js` (~162KB)
- All market data proxied through `pages/api/market.js` to hide API keys

---

## Architecture — Three Top-Level Tabs

The app has three top tabs controlled by `topTab` state in `pages/index.js`:

### 1. APEX (`topTab === "apex"`)
Stock analysis and paper trading tool.

**Sub-tabs** (controlled by `tab` state):
- `screener` — 20-ticker screener universe (hardcoded TICKERS constant)
- `signals` — buy/sell signal log from Supabase
- `paper` — paper trade portfolio ($100k virtual, persists to `apex_port` in localStorage)
- `backtest` — historical signal backtester
- `autopilot` — automated paper trading
- `ai` — AI analysis via Claude API
- `settings` — app settings

**Data sources:**
- FMP (Financial Modeling Prep) — primary. Starter plan ($29/mo). Key: `LNXhjGVvJWSSf5BCWk95BElPxVCSWxSY`
- Finnhub — fallback for quotes and recommendations
- Supabase — signals storage, watchlist, portfolio

**Key state:**
- `stocks` — 20-ticker screener universe
- `watchlistStocks` — 28 AI-selected stocks
- `port` — paper trade portfolio (cash, positions, history)
- `liveRefresh` — 10-second AUTO price refresh toggle

**Important:** All `{tab===` render blocks are gated with `topTab==="apex"&&` to prevent bleed-through into other top tabs.

---

### 2. MODULE (`topTab === "module"`)
Prediction market arbitrage scanner.

**File:** `lib/ArbTab.js`
**API:** `pages/api/arb.js`

Kalshi × Polymarket mispricing detector. Pulls open contracts from both platforms, fuzzy-matches events by description, and scores edge (probability difference minus fees).

**Sub-tabs inside ArbTab:**
- LIVE SCANNER — real-time pair scanner with category filters
- PAPER TRADER — simulates arb trades, tracks P&L
- BACKTESTER — tests strategy on historical resolved contracts

**Known limitation:** Fuzzy text matching between Kalshi and Polymarket event titles finds very few pairs (~5). The pairing algorithm needs improvement to find more real opportunities.

---

### 3. EDGE (`topTab === "edge"`)
Pre-market stock scanner and signal scorer.

**File:** `components/PreMarketEdge.jsx`

7-signal scoring engine that analyzes pre-market gap setups and predicts 9:31 open trade outcomes.

**Signals scored (100 pts total):**
1. Gap % (0–15pts)
2. Pre-market volume (0–15pts)
3. Price momentum (0–10pts)
4. Green bar consistency (0–10pts)
5. Catalyst / news (0–25pts) — FMP earnings + analyst data
6. Relative volume vs 30-day avg (0–20pts)
7. SPY pre-market context (0–10pts) + Short interest (0–5pts)

**Three sub-tabs:**
- BACKTEST — runs 7-signal scorer against historical Polygon minute bars
- SCANNER — live pre-market scanner using Alpaca real-time data
- SETTINGS — API key management

**Data sources (all free):**
- Polygon.io — historical minute bars for backtest (free tier, rate-limited to 5 calls/min)
- Alpaca — live pre-market scanner data (free paper account)
- FMP — earnings beats and analyst ratings for catalyst signal (free tier)

**Demo vs Live:**
- `isDemo = !settings.polygonKey && !settings.alpacaId`
- `isBtLive = !!settings.polygonKey`
- `isScanLive = !!settings.alpacaId && !!settings.alpacaSecret`

**Settings persistence:** Keys typed into the Settings tab are stored in browser `localStorage` under the key `edge_settings`. They survive page refreshes. The user's keys are already saved in their browser.

---

## Key Files

| File | Purpose |
|------|---------|
| `pages/_app.js` | Auth wrapper — Supabase session management, AuthContext provider |
| `pages/index.js` | Main app (~162KB) — all APEX logic, tab routing, state |
| `pages/login.js` | Login/signup page |
| `lib/ArbTab.js` | MODULE tab — full Kalshi×Polymarket arb scanner component |
| `lib/supabase.js` | Supabase client + helper functions |
| `components/PreMarketEdge.jsx` | EDGE tab — pre-market scorer/backtest/scanner |
| `pages/api/market.js` | FMP + Finnhub proxy — keeps API keys server-side |
| `pages/api/arb.js` | Kalshi + Polymarket API proxy |
| `pages/api/portfolio.js` | Supabase portfolio CRUD |
| `pages/api/analyze.js` | Claude AI analysis endpoint |

---

## Auth Flow
- Supabase email/password auth
- `_app.js` calls `supabase.auth.getSession()` on mount with `.catch(() => setUser(null))` fallback
- `onAuthStateChange` keeps session in sync
- `useAuth()` hook exposes `{ user, profile, isAdmin, loading }` to all pages
- If `loading === true` (user === undefined), shows LOADING... screen
- If `user === null` (not logged in), shows LoginPage
- Signals, watchlist, and portfolio read/write through Supabase

---

## Known Issues / Future Work
- EDGE settings persistence needs `typeof window !== 'undefined'` guard if SSR is ever enabled
- Arb pairing algorithm (fuzzy text match) finds very few pairs — needs semantic matching improvement
- FMP API key is hardcoded in the client bundle (acceptable for personal use, move to env var if public)
- EDGE Scanner: tickers default to `["NVDA","AAPL","TSLA","AMD","META"]` — user can add/remove via the × button

---

## Recent Changes (2026-03-24)
- Added EDGE tab (`topTab === "edge"`) rendering `<PreMarketEdge/>`
- Fixed MODULE tab bleeding APEX watchlist through — all `{tab===` blocks now gated with `topTab==="apex"&&`
- Fixed garbled UTF-8 emoji in PreMarketEdge.jsx (stripped all non-ASCII, labels now plain text)
- Fixed invisible × remove button on scanner ticker tags
- Fixed EDGE settings persistence via localStorage (useEffect pattern)
- Fixed `_app.js` getSession infinite loading — added `.catch(() => setUser(null))`
