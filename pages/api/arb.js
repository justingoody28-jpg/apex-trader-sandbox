// pages/api/arb.js
// Server-side proxy for Kalshi + Polymarket — no CORS issues.
// Drop this file into pages/api/ alongside your existing market.js, analyze.js, etc.

const CACHE_TTL_MS = 30_000; // 30 seconds
let _cache = { data: null, ts: 0 };

// ─── Kalshi fetcher ───────────────────────────────────────────────────────────
async function fetchKalshi() {
  const res = await fetch(
    "https://api.elections.kalshi.com/trade-api/v2/markets?limit=200&status=open",
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) throw new Error(`Kalshi ${res.status}`);
  const data = await res.json();
  return (data.markets || []).map(m => {
    const bid = m.yes_bid ?? 0;
    const ask = m.yes_ask ?? 100;
    const yes_price = Math.min(Math.max((bid + ask) / 2 / 100, 0.01), 0.99);
    return {
      id: m.ticker,
      title: m.title || m.subtitle || "",
      yes_price,
      volume: m.volume || 0,
      url: `https://kalshi.com/markets/${m.event_ticker || m.ticker}`,
    };
  }).filter(m => m.title && m.yes_price > 0.01 && m.yes_price < 0.99);
}

// ─── Polymarket fetcher ───────────────────────────────────────────────────────
async function fetchPolymarket() {
  // Try CLOB first, fall back to Gamma
  try {
    const res = await fetch(
      "https://clob.polymarket.com/markets?limit=100&active=true&closed=false",
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`CLOB ${res.status}`);
    const data = await res.json();
    const markets = data.data || data || [];
    const results = markets.map(m => {
      const yesToken = (m.tokens || []).find(t => (t.outcome || "").toLowerCase() === "yes");
      const yes_price = Math.min(Math.max(parseFloat(yesToken?.price || 0.5), 0.01), 0.99);
      return {
        id: m.condition_id || m.market_slug,
        title: m.question || "",
        yes_price,
        volume: parseFloat(m.volume || 0),
        url: m.market_slug ? `https://polymarket.com/event/${m.market_slug}` : null,
      };
    }).filter(m => m.title && m.yes_price > 0.01 && m.yes_price < 0.99);
    if (results.length > 0) return results;
    throw new Error("CLOB empty");
  } catch {
    const res = await fetch(
      "https://gamma-api.polymarket.com/markets?limit=200&active=true&closed=false",
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`Gamma ${res.status}`);
    const raw = await res.json();
    return (raw || []).map(m => ({
      id: m.conditionId || String(m.id),
      title: m.question || "",
      yes_price: Math.min(Math.max(parseFloat(m.outcomePrices?.[0] || 0.5), 0.01), 0.99),
      volume: parseFloat(m.volumeNum || m.volume || 0),
      url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
    })).filter(m => m.title && m.yes_price > 0.01 && m.yes_price < 0.99);
  }
}

// ─── Matcher ─────────────────────────────────────────────────────────────────
const STOP = new Set(["will","the","a","an","in","by","of","to","be","is","are","above",
  "below","before","after","than","and","or","for","at","end","this","that","it","its",
  "on","as","from","with","over","under","if","whether","does","do","have","has","reach",
  "hit","go","get","make","end","finish","close","pass","exceed","surpass","cross"]);

function keywords(title) {
  return title.toLowerCase().replace(/,/g,"").replace(/[$%#]/g," ").replace(/[^a-z0-9\s]/g," ")
    .split(/\s+/).filter(w => w.length > 1 && !STOP.has(w));
}

function jaccard(a, b) {
  const A = new Set(keywords(a)), B = new Set(keywords(b));
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter(k => B.has(k)).length;
  return inter / (new Set([...A, ...B]).size);
}

function categorize(title) {
  const t = title.toLowerCase();
  if (/bitcoin|btc|ethereum|eth|crypto|defi|solana|nft/.test(t)) return "Crypto";
  if (/fed|federal reserve|rate|cpi|inflation|unemployment|gdp|recession|fomc/.test(t)) return "Macro";
  if (/s&p|nasdaq|dow|stock|equity|earnings/.test(t)) return "Equities";
  if (/trump|biden|harris|president|election|congress|senate|democrat|republican/.test(t)) return "Politics";
  if (/war|conflict|nato|ukraine|russia|china|taiwan/.test(t)) return "Geopolitics";
  if (/ai|artificial intelligence|openai|anthropic|google|apple|microsoft/.test(t)) return "Tech";
  return "Other";
}

function matchMarkets(kalshi, poly, feeDragCents = 5, threshold = 0.22) {
  const feeDrag = feeDragCents / 100;
  const pairs = [];
  for (const k of kalshi) {
    for (const p of poly) {
      const score = jaccard(k.title, p.title);
      if (score < threshold) continue;
      const div = Math.abs(k.yes_price - p.yes_price);
      const edge = div - feeDrag;
      pairs.push({
        id: `${k.id}__${p.id}`,
        matchScore: +score.toFixed(3),
        category: categorize(k.title),
        kalshi: { id: k.id, title: k.title, yes_price: k.yes_price, volume: k.volume, url: k.url },
        poly:   { id: p.id, title: p.title, yes_price: p.yes_price, volume: p.volume, url: p.url },
        kPrice: k.yes_price,
        pPrice: p.yes_price,
        rawDivergence: +div.toFixed(4),
        feeDrag,
        impliedEdge: +edge.toFixed(4),
        hasEdge: edge > 0,
        buyOn:  k.yes_price < p.yes_price ? "Kalshi" : "Polymarket",
        sellOn: k.yes_price < p.yes_price ? "Polymarket" : "Kalshi",
        scannedAt: new Date().toISOString(),
      });
    }
  }
  return pairs.sort((a, b) => b.impliedEdge - a.impliedEdge);
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  // Return cached result if fresh
  if (_cache.data && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return res.status(200).json({ ..._cache.data, cached: true });
  }

  const feeDrag    = parseFloat(req.query.feeDrag    || "5");
  const threshold  = parseFloat(req.query.threshold  || "0.22");
  const minEdge    = parseFloat(req.query.minEdge    || "0") / 100;
  const category   = req.query.category || null;

  let kalshiMarkets = [], polyMarkets = [], kalshiError = null, polyError = null;

  const [kr, pr] = await Promise.allSettled([fetchKalshi(), fetchPolymarket()]);
  if (kr.status === "fulfilled") kalshiMarkets = kr.value;
  else { kalshiError = kr.reason?.message; }
  if (pr.status === "fulfilled") polyMarkets = pr.value;
  else { polyError = pr.reason?.message; }

  let pairs = matchMarkets(kalshiMarkets, polyMarkets, feeDrag, threshold);
  if (category && category !== "All") pairs = pairs.filter(p => p.category === category);
  if (minEdge > 0) pairs = pairs.filter(p => p.impliedEdge >= minEdge);

  const payload = {
    pairs,
    meta: {
      kalshiCount: kalshiMarkets.length,
      polyCount:   polyMarkets.length,
      pairsFound:  pairs.length,
      withEdge:    pairs.filter(p => p.hasEdge).length,
      kalshiError,
      polyError,
      fetchedAt:   new Date().toISOString(),
      cached:      false,
    },
  };

  _cache = { data: payload, ts: Date.now() };
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  return res.status(200).json(payload);
}
