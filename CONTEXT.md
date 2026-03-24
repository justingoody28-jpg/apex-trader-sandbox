# Apex Trader Sandbox — Project Context
*Last updated: 2026-03-24*

## Live & Repo
- **Live:** https://apex-trader-sandbox.vercel.app
- **Repo:** https://github.com/justingoody28-jpg/apex-trader-sandbox
- **Vercel team slug:** justingoody28-7737s-projects

---

## Stack
- Next.js 14 deployed on Vercel
- Supabase for auth (email/password)
- Single-page app — main logic in `pages/index.js` (~162KB)
- All market data proxied through `pages/api/market.js`

---

## Architecture — Three Top-Level Tabs

Controlled by `topTab` state: `"apex"` | `"module"` | `"edge"`

### 1. APEX (`topTab === "apex"`)
Stock analysis and paper trading tool.

**Sub-tabs** (controlled by `tab` state, all gated with `topTab==="apex"&&`):
`screener` | `signals` | `paper` | `backtest` | `autopilot` | `ai` | `settings`

**Data sources:**
- FMP (primary) — Starter plan. Key: `LNXhjGVvJWSSf5BCWk95BElPxVCSWxSY`
- Finnhub — fallback quotes/recommendations
- Supabase — signals, watchlist, portfolio

**Key state:**
- `stocks` — 20-ticker screener universe (hardcoded TICKERS)
- `watchlistStocks` — 28 AI-selected stocks
- `port` — paper portfolio, persists to `localStorage("apex_port")`
- `liveRefresh` — 10-second AUTO price refresh toggle

---

### 2. MODULE (`topTab === "module"`)
Prediction market arbitrage scanner. Renders `<ArbTab/>`.

**File:** `lib/ArbTab.js`  
**API:** `pages/api/arb.js`

Kalshi × Polymarket mispricing detector. Pulls open contracts, fuzzy-matches events, scores edge = probability difference minus fees.

**Sub-tabs inside ArbTab:** LIVE SCANNER | PAPER TRADER | BACKTESTER

**Known limitation:** Fuzzy text matching finds very few pairs (~0–5). Pairing algorithm needs semantic matching improvement.

---

### 3. EDGE (`topTab === "edge"`)
Pre-market stock scanner and signal scorer. Renders `<PreMarketEdge/>`.

**File:** `components/PreMarketEdge.jsx`

**7-signal scoring engine (100 pts total):**
1. Gap % (0–15pts)
2. Pre-market volume (0–15pts)
3. Price momentum (0–10pts)
4. Green bar consistency (0–10pts)
5. Catalyst/news via FMP earnings + analyst data (0–25pts)
6. Relative volume vs 30-day avg (0–20pts)
7. SPY context (0–10pts) + Short interest (0–5pts)

**Sub-tabs:** BACKTEST | SCANNER | SETTINGS

**Live vs Demo logic:**
```js
isDemo    = !settings.polygonKey && !settings.alpacaId
isBtLive  = !!settings.polygonKey        // Polygon for backtest
isScanLive = !!settings.alpacaId && !!settings.alpacaSecret  // Alpaca for scanner
```

**Data sources (all free tier):**
- Polygon.io — historical minute bars (backtest). Free plan, 5 calls/min.
- Alpaca — live pre-market bars 4am–9:30am (scanner). Free paper account.
- FMP — earnings beats + analyst upgrades (catalyst signal). Free tier.

**Settings persistence:**
Keys are saved to `localStorage("edge_settings")` via two `useEffect` hooks with `typeof window !== "undefined"` SSR guards:
1. Load on mount: reads saved keys and hydrates state
2. Save on change: writes updated settings to localStorage on every keystroke

User keys survive page refreshes, tab switches, and browser restarts.

---

## Key Files

| File | Purpose |
|------|---------|
| `pages/_app.js` | Auth wrapper — Supabase session, AuthContext. Has `.catch(()=>setUser(null))` guard on getSession. |
| `pages/index.js` | Main app (~162KB) — all APEX logic, tab routing, topTab/tab state |
| `pages/login.js` | Login/signup page |
| `lib/ArbTab.js` | MODULE tab — Kalshi×Polymarket arb scanner component |
| `lib/supabase.js` | Supabase client + helpers |
| `components/PreMarketEdge.jsx` | EDGE tab — 7-signal scorer, backtest, scanner, settings |
| `pages/api/market.js` | FMP + Finnhub server-side proxy |
| `pages/api/arb.js` | Kalshi + Polymarket API proxy |
| `pages/api/portfolio.js` | Supabase portfolio CRUD |
| `pages/api/analyze.js` | Claude AI analysis endpoint |

---

## Auth Flow
- Supabase email/password
- `_app.js` calls `supabase.auth.getSession().then(...).catch(()=>setUser(null))`
- `onAuthStateChange` keeps session live
- `useAuth()` exposes `{ user, profile, isAdmin, loading }`
- `loading === true` (user === undefined) → LOADING screen
- `user === null` → LoginPage
- `user !== null` → main app

---

## Important Implementation Notes

- All `{tab===` render blocks in `index.js` are wrapped with `topTab==="apex"&&` to prevent APEX content bleeding into MODULE/EDGE
- MODULE and EDGE tabs have no sub-tabs in `index.js` — they are full-screen components
- FMP API key is hardcoded in the client bundle (fine for personal use)
- EDGE scanner default tickers: `["NVDA","AAPL","TSLA","AMD","META"]` — user can remove via × button
- All emoji stripped from PreMarketEdge.jsx (UTF-8 encoding issue) — labels are plain text

---

## Known Issues / Future Work
- Arb pairing: fuzzy text matching finds 0–5 pairs. Needs semantic/embedding-based matching.
- EDGE scanner: no auto-scan on mount, user must click SCAN NOW manually
- FMP key should move to Vercel env var if repo is made public

---

## Change Log

### 2026-03-24 (this session)
- Added EDGE tab (`topTab==="edge"`) rendering `<PreMarketEdge/>`
- Fixed MODULE tab bleed-through: added `topTab==="apex"&&` guard to all 7 APEX render blocks
- Fixed garbled UTF-8 emoji in PreMarketEdge — stripped all non-ASCII
- Fixed invisible × on scanner ticker remove buttons
- Fixed EDGE settings persistence: added `useEffect` load+save with `typeof window` SSR guard
- Fixed `_app.js` infinite loading: added `.catch(()=>setUser(null))` to `getSession()`
- Added this `CONTEXT.md` file
