import { useState, useCallback, useRef } from"react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from"recharts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTimeET(ts) {
 return new Date(ts).toLocaleTimeString("en-US", {
 timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", hour12: false,
 });
}

function getTradingDays(start, end) {
 const days = [];
 const cur = new Date(start +"T12:00:00Z");
 const fin = new Date(end +"T12:00:00Z");
 while (cur <= fin) {
 const dow = cur.getUTCDay();
 if (dow !== 0 && dow !== 6) days.push(cur.toISOString().split("T")[0]);
 cur.setUTCDate(cur.getUTCDate() + 1);
 }
 return days;
}

function fmt(n, dec = 2) {
 return n !== undefined ? (n >= 0 ?"+":"") + n.toFixed(dec) :"";
}

function daysAgo(n) {
 const d = new Date();
 d.setDate(d.getDate() - n);
 return d.toISOString().split("T")[0];
}

function minsFromMidnight(ts) {
 const t = getTimeET(ts);
 const [h, m] = t.split(":").map(Number);
 return h * 60 + m;
}

const filterPremarket = (bars) =>
 bars.filter((b) => { const m = minsFromMidnight(b.t); return m >= 240 && m < 570; });
const get931Bar = (bars) => bars.find((b) => getTimeET(b.t) ==="09:31");
const getIntraday = (bars) =>
 bars.filter((b) => { const m = minsFromMidnight(b.t); return m >= 571 && m <= 960; });
const getRegular = (bars) =>
 bars.filter((b) => { const m = minsFromMidnight(b.t); return m >= 570 && m <= 960; });

// Polygon API 

async function polyBars(ticker, date, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=1000&apiKey=${key}`);
 if (!res.ok) throw new Error(`Polygon bars ${res.status}`);
 const d = await res.json();
 if (d.status ==="ERROR") throw new Error(d.error ||"Polygon error");
 return d.results || [];
}

async function polyPrevClose(ticker, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev?adjusted=true&apiKey=${key}`);
 if (!res.ok) throw new Error(`Polygon prev ${res.status}`);
 const d = await res.json();
 return d.results?.[0]?.c || null;
}

async function polyAvgVolume(ticker, key) {
 const res = await fetch(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${daysAgo(31)}/${daysAgo(1)}?adjusted=true&sort=asc&limit=35&apiKey=${key}`);
 if (!res.ok) return null;
 const d = await res.json();
 const results = d.results || [];
 if (!results.length) return null;
 return results.reduce((s, b) => s + b.v, 0) / results.length;
}

// Alpaca API Primary live scanner source (free) 
// Free paper account at alpaca.markets covers 4am8pm extended hours

function alpacaHeaders(id, secret) {
 return {"APCA-API-KEY-ID": id,"APCA-API-SECRET-KEY": secret };
}

function toAlpacaET(date, hour, min = 0) {
 return`${date}T${String(hour).padStart(2,"0")}:${String(min).padStart(2,"0")}:00-04:00`;
}

async function alpacaBars(ticker, date, id, secret) {
 const start = encodeURIComponent(toAlpacaET(date, 4));
 const end = encodeURIComponent(toAlpacaET(date, 20));
 const url =`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Min&start=${start}&end=${end}&limit=1000&feed=iex&sort=asc`;
 const res = await fetch(url, { headers: alpacaHeaders(id, secret) });
 if (!res.ok) throw new Error(`Alpaca bars ${res.status}`);
 const d = await res.json();
 return (d.bars || []).map((b) => ({ t: new Date(b.t).getTime(), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

async function alpacaPrevClose(ticker, id, secret) {
 const url =`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&limit=2&feed=iex&sort=desc`;
 const res = await fetch(url, { headers: alpacaHeaders(id, secret) });
 if (!res.ok) return null;
 const d = await res.json();
 const bars = d.bars || [];
 return bars.length >= 2 ? bars[1].c : bars[0]?.c ?? null;
}

async function alpacaAvgVolume(ticker, id, secret) {
 const url =`https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&limit=30&feed=iex&sort=desc`;
 const res = await fetch(url, { headers: alpacaHeaders(id, secret) });
 if (!res.ok) return null;
 const d = await res.json();
 const bars = d.bars || [];
 if (!bars.length) return null;
 return bars.reduce((s, b) => s + b.v, 0) / bars.length;
}

async function alpacaSpyContext(id, secret) {
 const today = new Date().toISOString().split("T")[0];
 try {
 const bars = await alpacaBars("SPY", today, id, secret);
 const pm = filterPremarket(bars);
 if (!pm.length) return { spyScore: 5, spyGap: 0 };
 const spyGap = ((pm.at(-1).c - pm[0].o) / pm[0].o) * 100;
 return { spyScore: spyGap > 0.3 ? 10 : spyGap > -0.1 ? 5 : 0, spyGap: parseFloat(spyGap.toFixed(2)) };
 } catch {
 return { spyScore: 5, spyGap: 0 };
 }
}

// FMP Catalyst (Primary real earnings beats + analyst ratings) 
async function fmpEarnings(ticker, date, fmpKey) {
 const from = new Date(date);
 from.setDate(from.getDate() - 3);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://financialmodelingprep.com/stable/earnings?symbol=${ticker}&from=${fromStr}&to=${date}&apikey=${fmpKey}`);
 if (!res.ok) return null;
 const data = await res.json();
 const results = Array.isArray(data) ? data : (data.earningsCalendar || []);
 if (!results.length) return null;
 const report = results[0];
 const actual = report.epsActual ?? report.eps;
 const est = report.epsEstimated ?? report.estimatedEps;
 if (actual == null || est == null || est === 0) return null;
 const beatPct = ((actual - est) / Math.abs(est)) * 100;
 return { beatPct: parseFloat(beatPct.toFixed(1)), actual, est, date: report.date };
}

async function fmpAnalyst(ticker, date, fmpKey) {
 const from = new Date(date);
 from.setDate(from.getDate() - 2);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://financialmodelingprep.com/stable/upgrades-downgrades?symbol=${ticker}&from=${fromStr}&to=${date}&apikey=${fmpKey}`);
 if (!res.ok) return [];
 const data = await res.json();
 return Array.isArray(data) ? data : [];
}

async function fmpNews(ticker, date, fmpKey) {
 const from = new Date(date);
 from.setDate(from.getDate() - 1);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://financialmodelingprep.com/stable/news/stock?symbols=${ticker}&from=${fromStr}&to=${date}&limit=5&apikey=${fmpKey}`);
 if (!res.ok) return [];
 const data = await res.json();
 return Array.isArray(data) ? data : [];
}

async function getCatalyst(ticker, date, polygonKey, fmpKey) {
 if (fmpKey) {
 try {
 const [earnings, analysts, news] = await Promise.all([
 fmpEarnings(ticker, date, fmpKey).catch(() => null),
 fmpAnalyst(ticker, date, fmpKey).catch(() => []),
 fmpNews(ticker, date, fmpKey).catch(() => []),
 ]);
 let catalystScore = 0;
 const headlines = [];
 let catalystType ="none";
 if (earnings) {
 const { beatPct, actual, est } = earnings;
 if (beatPct >= 10) { catalystScore = 25; catalystType ="earnings-beat"; }
 else if (beatPct >= 5) { catalystScore = 20; catalystType ="earnings-beat"; }
 else if (beatPct >= 1) { catalystScore = 15; catalystType ="earnings-beat"; }
 else if (beatPct >= -2) { catalystScore = 8; catalystType ="earnings-inline"; }
 else { catalystScore = 0; catalystType ="earnings-miss"; }
 const tag = beatPct >= 0 ?`Beat by ${beatPct.toFixed(1)}%`:`Missed by ${Math.abs(beatPct).toFixed(1)}%`;
 headlines.push(`Earnings ${tag} (actual: $${actual?.toFixed(2)} vs est: $${est?.toFixed(2)})`);
 }
 for (const a of analysts) {
 const action = (a.action || a.newGrade ||"").toLowerCase();
 const isUp = action.includes("upgrade") || action.includes("buy") || action.includes("overweight") || action.includes("outperform");
 const isDown = action.includes("downgrade") || action.includes("sell") || action.includes("underperform");
 if (isUp) { catalystScore = Math.max(catalystScore, 18); catalystType = catalystType ==="none"?"upgrade": catalystType; }
 if (isDown) { catalystScore = Math.max(catalystScore, 0); catalystType = catalystType ==="none"?"downgrade": catalystType; }
 headlines.push(`${a.gradingCompany ||"Analyst"}: ${a.newGrade || a.action || action}`);
 }
 if (catalystScore === 0 && news.length) {
 const HIGH = ["fda","approved","approval","merger","acqui","deal","buyout"];
 const MED = ["partnership","contract","launch","guidance"];
 for (const item of news) {
 const t = (item.title || item.text ||"").toLowerCase();
 if (HIGH.some((kw) => t.includes(kw))) { catalystScore = Math.max(catalystScore, 20); catalystType ="fda-ma"; }
 else if (MED.some((kw) => t.includes(kw))) { catalystScore = Math.max(catalystScore, 10); catalystType ="news"; }
 else catalystScore = Math.max(catalystScore, 3);
 headlines.push(item.title || item.text ||"");
 }
 }
 return { catalystScore, headlines: headlines.slice(0, 3), catalystType, source:"FMP"};
 } catch { /* Fall through */ }
 }
 if (polygonKey) {
 try {
 const from = new Date(date); from.setDate(from.getDate() - 1);
 const fromStr = from.toISOString().split("T")[0];
 const res = await fetch(`https://api.polygon.io/v2/reference/news?ticker=${ticker}&published_utc.gte=${fromStr}T18:00:00Z&published_utc.lte=${date}T13:30:00Z&limit=5&apiKey=${polygonKey}`);
 if (!res.ok) return { catalystScore: 0, headlines: [], catalystType:"none", source:"none"};
 const d = await res.json();
 const results = d.results || [];
 if (!results.length) return { catalystScore: 0, headlines: [], catalystType:"none", source:"none"};
 const HIGH = ["earnings","beat","revenue","fda","approved","merger","acqui","upgrade","raised"];
 const MED = ["guidance","analyst","launch","partnership","contract","quarterly","results"];
 let catalystScore = 0; const headlines = [];
 for (const item of results) {
 const title = (item.title ||"").toLowerCase();
 if (HIGH.some((kw) => title.includes(kw))) catalystScore = Math.max(catalystScore, 20);
 else if (MED.some((kw) => title.includes(kw))) catalystScore = Math.max(catalystScore, 10);
 else catalystScore = Math.max(catalystScore, 3);
 headlines.push(item.title);
 }
 return { catalystScore, headlines, catalystType:"news-keyword", source:"Polygon"};
 } catch { /* silent */ }
 }
 return { catalystScore: 0, headlines: [], catalystType:"none", source:"none"};
}

async function spyContext(date, key) {
 try {
 const bars = await polyBars("SPY", date, key);
 const pm = filterPremarket(bars);
 if (!pm.length) return { spyScore: 5, spyGap: 0 };
 const spyGap = ((pm.at(-1).c - pm[0].o) / pm[0].o) * 100;
 return { spyScore: spyGap > 0.3 ? 10 : spyGap > -0.1 ? 5 : 0, spyGap: parseFloat(spyGap.toFixed(2)) };
 } catch { return { spyScore: 5, spyGap: 0 }; }
}

function scoreSignals({ pmBars, prevClose, avgDailyVol, catalystData, spyData, shortInterestPct }) {
 const bd = { gap: 0, momentum: 0, consistency: 0, catalyst: 0, relVol: 0, marketCtx: 0, shortInt: 0 };
 if (!pmBars.length || !prevClose) return { score: 0, gap: 0, pmVol: 0, breakdown: bd };
 const lastC = pmBars.at(-1).c;
 const gap = ((lastC - prevClose) / prevClose) * 100;
 const pmVol = pmBars.reduce((s, b) => s + b.v, 0);
 bd.gap = parseFloat(Math.min(gap < 0.5 ? 0 : (gap / 6) * 20, 20).toFixed(1));
 const last30 = pmBars.slice(-30);
 const mom = last30.length > 1 ? ((last30.at(-1).c - last30[0].o) / last30[0].o) * 100 : 0;
 bd.momentum = parseFloat(Math.min(Math.max((mom / 2) * 10, 0), 10).toFixed(1));
 bd.consistency = parseFloat((pmBars.filter((b) => b.c >= b.o).length / pmBars.length * 5).toFixed(1));
 bd.catalyst = catalystData?.catalystScore ?? 0;
 if (avgDailyVol && avgDailyVol > 0) {
 const rvol = (pmVol * 1.18) / avgDailyVol;
 bd.relVol = parseFloat(Math.min(rvol * 6.5, 20).toFixed(1));
 } else { bd.relVol = 5; }
 bd.marketCtx = spyData?.spyScore ?? 5;
 bd.shortInt = shortInterestPct != null ? parseFloat(Math.min((shortInterestPct / 30) * 5, 5).toFixed(1)) : 2.5;
 const score = Math.min(Math.round(Object.values(bd).reduce((a, b) => a + b, 0)), 100);
 const rvol = avgDailyVol ? parseFloat((pmVol * 1.18 / avgDailyVol).toFixed(2)) : null;
 return { score, gap: parseFloat(gap.toFixed(2)), pmVol, breakdown: bd, rvol, spyGap: spyData?.spyGap ?? 0, headlines: catalystData?.headlines || [] };
}

function evaluateTrade(intradayBars, entryPrice, winPct, lossPct) {
 const win = entryPrice * (1 + winPct / 100);
 const stop = entryPrice * (1 - lossPct / 100);
 for (const bar of intradayBars) {
 if (bar.h >= win) return { result:"WIN", pct: winPct };
 if (bar.l <= stop) return { result:"LOSS", pct: -lossPct };
 }
 const last = intradayBars.at(-1);
 if (!last) return { result:"TIMEOUT", pct: 0 };
 return { result:"TIMEOUT", pct: parseFloat((((last.c - entryPrice) / entryPrice) * 100).toFixed(2)) };
}

function calcStats(trades) {
 if (!trades.length) return {};
 const wins = trades.filter((t) => t.result ==="WIN");
 const losses = trades.filter((t) => t.result ==="LOSS");
 const to = trades.filter((t) => t.result ==="TIMEOUT");
 const avgW = wins.length ? wins.reduce((s, t) => s + t.pct, 0) / wins.length : 0;
 const avgL = losses.length ? losses.reduce((s, t) => s + t.pct, 0) / losses.length : 0;
 const pf = losses.length && avgL !== 0 ? Math.abs((wins.length * avgW) / (losses.length * avgL)).toFixed(2) :"";
 return {
 winRate: ((wins.length / trades.length) * 100).toFixed(1),
 wins: wins.length, losses: losses.length, timeouts: to.length, total: trades.length,
 avgWin: avgW.toFixed(2), avgLoss: avgL.toFixed(2), pf,
 totalPct: trades.reduce((s, t) => s + t.pct, 0).toFixed(2),
 };
}

function demoSig(seed) {
 const r = (min, max, s) => min + ((s * 9301 + 49297) % 233280) / 233280 * (max - min);
 const gap = parseFloat(r(0.3, 6.5, seed).toFixed(2));
 const cat = [0, 0, 5, 12, 25][Math.floor(r(0, 5, seed * 7))];
 const rvol = parseFloat(r(0.4, 4.8, seed * 13).toFixed(2));
 const si = parseFloat(r(3, 38, seed * 17).toFixed(1));
 const spyG = r(-0.4, 0.8, seed * 3);
 const bd = {
 gap: parseFloat(Math.min(gap < 0.5 ? 0 : (gap / 6) * 20, 20).toFixed(1)),
 momentum: parseFloat(r(0, 10, seed * 11).toFixed(1)),
 consistency: parseFloat(r(2, 5, seed * 19).toFixed(1)),
 catalyst: cat,
 relVol: parseFloat(Math.min(rvol * 6.5, 20).toFixed(1)),
 marketCtx: spyG > 0.3 ? 10 : spyG > -0.1 ? 5 : 0,
 shortInt: parseFloat(Math.min((si / 30) * 5, 5).toFixed(1)),
 };
 const score = Math.min(Math.round(Object.values(bd).reduce((a, b) => a + b, 0)), 100);
 const headlines = cat >= 25 ? ["Q4 earnings beat estimates by 12%, revenue guidance raised"]
 : cat >= 12 ? ["Analyst upgrade to Overweight, price target raised"]
 : cat >= 5 ? ["Company announces new strategic partnership"] : [];
 return { score, gap, rvol, spyGap: parseFloat(spyG.toFixed(2)), breakdown: bd, headlines };
}

function genDemo(ticker, start, end, winPct, lossPct) {
 const days = getTradingDays(start, end);
 const trades = []; let equity = 10000;
 const curve = [{ date:"Start", equity, cumPct: 0 }];
 days.forEach((date, i) => {
 const seed = i * 997 + date.charCodeAt(5) * 31;
 const sig = demoSig(seed);
 if (sig.score < 40) return;
 const entryPrice = parseFloat((80 + (seed % 320)).toFixed(2));
 const pmVol = Math.round(40000 + (seed * 13337) % 760000);
 const roll = ((seed * 2654435769) >>> 0) / 0xFFFFFFFF;
 let result, pct;
 if (roll < 0.57) { result ="WIN"; pct = winPct; }
 else if (roll < 0.87) { result ="LOSS"; pct = -lossPct; }
 else { result ="TIMEOUT"; pct = parseFloat((-0.3 + (seed % 1000) / 555).toFixed(2)); }
 equity *= 1 + pct / 100;
 const cumPct = parseFloat((((equity - 10000) / 10000) * 100).toFixed(2));
 trades.push({ date, ticker, entryPrice, pmVol, result, pct, ...sig });
 curve.push({ date, equity: Math.round(equity), cumPct });
 });
 return { trades, curve, stats: calcStats(trades) };
}

const T = {
 bg:"#06090f", surface:"#0b1220", panel:"#0f1928", border:"#172236",
 text:"#c8ddf5", muted:"#3d5a7a", dim:"#1e3050",
 green:"#00cc6a", red:"#ff3d4a", amber:"#f5a520", blue:"#2d8fff", purple:"#9b6dff",
};
const S = {
 input: { background: T.surface, border:`1px solid ${T.border}`, color: T.text, padding:"8px 12px", borderRadius:"6px", fontFamily:"inherit", fontSize:"13px", outline:"none", width:"100%", boxSizing:"border-box"},
 btn: { background: T.blue, color:"#fff", border:"none", padding:"9px 20px", borderRadius:"6px", cursor:"pointer", fontFamily:"inherit", fontSize:"13px", fontWeight: 700, letterSpacing:"0.05em"},
 card: { background: T.panel, border:`1px solid ${T.border}`, borderRadius:"8px", padding:"16px"},
 label: { display:"block", color: T.muted, fontSize:"11px", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"6px"},
};

function Badge({ result }) {
 const map = { WIN: { bg:"#00331a", color: T.green, label:"WIN"}, LOSS: { bg:"#330a0d", color: T.red, label:"LOSS"}, TIMEOUT: { bg:"#1a1530", color: T.purple, label:"TIME"}, STRONG: { bg:"#00331a", color: T.green, label:"STRONG"}, MODERATE: { bg:"#2a1f00", color: T.amber, label:"MOD"}, WEAK: { bg:"#1a1020", color: T.muted, label:"WEAK"}, ERROR: { bg:"#330a0d", color: T.red, label:"ERR"} };
 const s = map[result] || map.WEAK;
 return <span style={{ background: s.bg, color: s.color, border:`1px solid ${s.color}33`, padding:"2px 8px", borderRadius:"4px", fontSize:"10px", fontWeight: 700, letterSpacing:"0.1em"}}>{s.label}</span>;
}

function StatCard({ label, value, sub, color }) {
 return (
 <div style={{ ...S.card, textAlign:"center", minWidth: 110 }}>
 <div style={{ fontSize:"11px", color: T.muted, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:"8px"}}>{label}</div>
 <div style={{ fontSize:"22px", fontWeight: 700, color: color || T.text, lineHeight: 1 }}>{value}</div>
 {sub && <div style={{ fontSize:"11px", color: T.muted, marginTop:"4px"}}>{sub}</div>}
 </div>
 );
}

function ScoreBar({ score, max = 100, color }) {
 const c = color || (score / max >= 0.7 ? T.green : score / max >= 0.5 ? T.amber : T.muted);
 return (
 <div style={{ display:"flex", alignItems:"center", gap:"8px"}}>
 <div style={{ flex: 1, height:"4px", background: T.dim, borderRadius:"2px"}}>
 <div style={{ width:`${Math.round((score / max) * 100)}%`, height:"100%", background: c, borderRadius:"2px", transition:"width 0.5s ease"}} />
 </div>
 <span style={{ color: c, fontSize:"11px", minWidth: 28, textAlign:"right"}}>{score}{max !== 100 ?`/${max}`:""}</span>
 </div>
 );
}

function ScoreBreakdown({ breakdown, headlines, rvol, spyGap, catalystSource }) {
 const signals = [
 { key:"catalyst", label:"Catalyst", max: 25, icon:""},
 { key:"relVol", label:"Relative Volume", max: 20, icon:""},
 { key:"gap", label:"Gap %", max: 20, icon:""},
 { key:"momentum", label:"PM Momentum", max: 10, icon:""},
 { key:"marketCtx", label:"Market Context", max: 10, icon:""},
 { key:"consistency", label:"PM Consistency", max: 5, icon:""},
 { key:"shortInt", label:"Short Interest", max: 5, icon:""},
 ];
 return (
 <div style={{ background: T.bg, border:`1px solid ${T.border}`, borderRadius:"8px", padding:"14px", marginTop: 8 }}>
 <div style={{ fontSize:"10px", color: T.muted, letterSpacing:"0.1em", marginBottom: 10 }}>SIGNAL BREAKDOWN</div>
 <div style={{ display:"flex", flexDirection:"column", gap: 8 }}>
 {signals.map(({ key, label, max, icon }) => (
 <div key={key} style={{ display:"grid", gridTemplateColumns:"18px 140px 1fr 42px", alignItems:"center", gap: 8 }}>
 <span style={{ fontSize:"11px"}}>{icon}</span>
 <span style={{ fontSize:"11px", color: T.muted }}>{label}</span>
 <ScoreBar score={breakdown[key] ?? 0} max={max} />
 <span style={{ fontSize:"10px", color: T.muted, textAlign:"right"}}>{breakdown[key] ?? 0}/{max}</span>
 </div>
 ))}
 </div>
 <div style={{ marginTop: 10, fontSize:"11px", color: T.muted, display:"flex", gap: 16 }}>
 {rvol != null && <span>RVOL <span style={{ color: rvol >= 2 ? T.green : T.text }}>{rvol}x</span></span>}
 {spyGap != null && <span>SPY PM <span style={{ color: spyGap >= 0 ? T.green : T.red }}>{spyGap >= 0 ?"+":""}{spyGap}%</span></span>}
 </div>
 {headlines?.length > 0 && (
 <div style={{ marginTop: 10 }}>
 {headlines.slice(0, 3).map((h, i) => (
 <div key={i} style={{ fontSize:"11px", color: T.amber, background:"#1a1200", border:`1px solid ${T.amber}22`, borderRadius: 4, padding:"4px 8px", marginBottom: 4 }}> {h}</div>
 ))}
 </div>
 )}
 {catalystSource && (
 <div style={{ marginTop: 8, fontSize:"10px", color: T.muted }}>
 Catalyst data: <span style={{ color: catalystSource ==="FMP"? T.green : catalystSource ==="Polygon"? T.blue : T.dim }}>
 {catalystSource ==="FMP"?"FMP real earnings & analyst data": catalystSource ==="Polygon"?"Polygon news keyword match":"none"}
 </span>
 </div>
 )}
 </div>
 );
}

function ChartTip({ active, payload, label }) {
 if (!active || !payload?.length) return null;
 const pct = payload[0]?.value;
 return (
 <div style={{ background: T.panel, border:`1px solid ${T.border}`, padding:"8px 12px", borderRadius:"6px", fontSize:"12px"}}>
 <div style={{ color: T.muted, marginBottom: 4 }}>{label}</div>
 <div style={{ color: pct >= 0 ? T.green : T.red, fontWeight: 700 }}>{fmt(pct)}%</div>
 </div>
 );
}

export default function PreMarketEdge() {
 const [tab, setTab] = useState("backtest");
 const [settings, setSettings] = useState({ polygonKey:"", fmpKey:"", alpacaId:"", alpacaSecret:"", winPct: 2.0, lossPct: 0.5, minScore: 55 });

 const [btTicker, setBtTicker] = useState("NVDA");
 const [btStart, setBtStart] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().split("T")[0]; });
 const [btEnd, setBtEnd] = useState(() => new Date().toISOString().split("T")[0]);
 const [btRunning, setBtRunning] = useState(false);
 const [btResults, setBtResults] = useState(null);
 const [btProgress, setBtProgress] = useState(0);
 const [btLog, setBtLog] = useState([]);
 const [showLog, setShowLog] = useState(false);
 const [expandRow, setExpandRow] = useState(null);
 const logRef = useRef(null);
 const [scanInput, setScanInput] = useState("");
 const [scanTickers, setScanTickers] = useState(["NVDA","AAPL","TSLA","AMD","META"]);
 const [scanResults, setScanResults] = useState(null);
 const [scanning, setScanning] = useState(false);
 const [expandScan, setExpandScan] = useState(null);

 const addLog = useCallback((msg) => {
 setBtLog((p) => [...p.slice(-200),`${new Date().toLocaleTimeString()} ${msg}`]);
 setTimeout(() => logRef.current?.scrollTo({ top: 99999, behavior:"smooth"}), 50);
 }, []);

 const isDemo = !settings.polygonKey && !settings.alpacaId;
 const isBtLive = !!settings.polygonKey;
 const isScanLive = !!settings.alpacaId && !!settings.alpacaSecret;

 const runBacktest = useCallback(async () => {
 setBtRunning(true); setBtResults(null); setBtProgress(0); setBtLog([]); setExpandRow(null);
 if (!isBtLive) {
 addLog("Demo mode add FREE Polygon key for real backtest");
 for (let i = 0; i <= 100; i += 5) { setBtProgress(i); await sleep(20); }
 const r = genDemo(btTicker, btStart, btEnd, settings.winPct, settings.lossPct);
 addLog(`${r.trades.length} signals | Win ${r.stats.winRate}% | PF ${r.stats.pf} | Total ${fmt(parseFloat(r.stats.totalPct))}%`);
 setBtResults(r); setBtRunning(false); return;
 }
 const days = getTradingDays(btStart, btEnd);
 addLog(`${btTicker} | ${days.length} days | min score ${settings.minScore}`);
 const avgDailyVol = await polyAvgVolume(btTicker, settings.polygonKey).catch(() => null);
 if (avgDailyVol) addLog(`30-day avg vol: ${(avgDailyVol / 1000).toFixed(0)}K`);
 const trades = []; let equity = 10000;
 const curve = [{ date:"Start", equity, cumPct: 0 }];
 let prevClose = null;
 for (let i = 0; i < days.length; i++) {
 const date = days[i];
 setBtProgress(Math.round(((i + 1) / days.length) * 100));
 try {
 const [bars, catData, spy] = await Promise.all([
 polyBars(btTicker, date, settings.polygonKey),
 getCatalyst(btTicker, date, settings.polygonKey, settings.fmpKey),
 spyContext(date, settings.polygonKey),
 ]);
 await sleep(350);
 if (!bars.length) { addLog(`${date} no data`); continue; }
 if (prevClose === null) { prevClose = await polyPrevClose(btTicker, settings.polygonKey); await sleep(200); }
 const pmBars = filterPremarket(bars);
 const entry = get931Bar(bars);
 const intra = getIntraday(bars);
 const regular = getRegular(bars);
 if (regular.length) prevClose = regular.at(-1).c;
 if (!pmBars.length || !entry || !prevClose) { addLog(`${date} no PM data`); continue; }
 const sig = scoreSignals({ pmBars, prevClose, avgDailyVol, catalystData: catData, spyData: spy, shortInterestPct: null });
 if (sig.score < settings.minScore) { addLog(`${date} score ${sig.score}`); continue; }
 const trade = evaluateTrade(intra, entry.o, settings.winPct, settings.lossPct);
 equity *= 1 + trade.pct / 100;
 const cumPct = parseFloat((((equity - 10000) / 10000) * 100).toFixed(2));
 trades.push({ date, ticker: btTicker, entryPrice: entry.o, pmVol: sig.pmVol, catalystSource: catData.source, ...sig, ...trade });
 curve.push({ date, equity: Math.round(equity), cumPct });
 const icon = trade.result ==="WIN"?"": trade.result ==="LOSS"?"":"";
 addLog(`${icon} ${date} | ${sig.score}pts | gap +${sig.gap}% rvol ${sig.rvol}x | ${trade.result} (${fmt(trade.pct)}%)`);
 } catch (err) { addLog(`${date} ${err.message}`); }
 }
 setBtProgress(100);
 const stats = calcStats(trades);
 setBtResults({ trades, curve, stats });
 addLog(`${trades.length} signals | Win ${stats.winRate}% | PF ${stats.pf} | Return ${fmt(parseFloat(stats.totalPct))}%`);
 setBtRunning(false);
 }, [btTicker, btStart, btEnd, settings, isBtLive, addLog]);

 const runScan = useCallback(async () => {
 setScanning(true); setScanResults(null); setExpandScan(null);
 if (!isScanLive && !isBtLive) {
 await sleep(700);
 setScanResults(scanTickers.map((ticker, i) => {
 const sig = demoSig(i * 997 + ticker.charCodeAt(0) * 31);
 return { ticker, ...sig, signal: sig.score >= 70 ?"STRONG": sig.score >= 50 ?"MODERATE":"WEAK"};
 }).sort((a, b) => b.score - a.score));
 setScanning(false); return;
 }
 const today = new Date().toISOString().split("T")[0];
 const results = [];
 for (const ticker of scanTickers) {
 try {
 let bars, avgVol, pc, spy;
 if (isScanLive) {
 [bars, avgVol, pc, spy] = await Promise.all([
 alpacaBars(ticker, today, settings.alpacaId, settings.alpacaSecret),
 alpacaAvgVolume(ticker, settings.alpacaId, settings.alpacaSecret),
 alpacaPrevClose(ticker, settings.alpacaId, settings.alpacaSecret),
 alpacaSpyContext(settings.alpacaId, settings.alpacaSecret),
 ]);
 } else {
 [bars, avgVol, pc, spy] = await Promise.all([
 polyBars(ticker, today, settings.polygonKey),
 polyAvgVolume(ticker, settings.polygonKey),
 polyPrevClose(ticker, settings.polygonKey),
 spyContext(today, settings.polygonKey),
 ]);
 }
 const cat = await getCatalyst(ticker, today, settings.polygonKey, settings.fmpKey);
 const sig = scoreSignals({ pmBars: filterPremarket(bars), prevClose: pc, avgDailyVol: avgVol, catalystData: cat, spyData: spy, shortInterestPct: null });
 results.push({ ticker, catalystSource: cat.source, dataSource: isScanLive ?"Alpaca":"Polygon", ...sig, signal: sig.score >= 70 ?"STRONG": sig.score >= 50 ?"MODERATE":"WEAK"});
 await sleep(300);
 } catch (e) {
 results.push({ ticker, score: 0, gap: 0, pmVol: 0, rvol: null, breakdown: {}, headlines: [], signal:"ERROR"});
 }
 }
 setScanResults(results.sort((a, b) => b.score - a.score));
 setScanning(false);
 }, [scanTickers, settings, isScanLive, isBtLive]);

 const TABS = [{ id:"backtest", label:"BACKTEST"}, { id:"scanner", label:"SCANNER"}, { id:"settings", label:"SETTINGS"}];

 return (
 <div style={{ background: T.bg, color: T.text, minHeight:"100vh", fontFamily:"'JetBrains Mono','Courier New',monospace", fontSize:"13px"}}>
 <div style={{ borderBottom:`1px solid ${T.border}`, padding:"14px 24px", display:"flex", alignItems:"center", gap: 16 }}>
 <div>
 <div style={{ fontSize:"15px", fontWeight: 700, letterSpacing:"0.12em", color: T.blue }}> PRE-MARKET EDGE</div>
 <div style={{ fontSize:"10px", color: T.muted, letterSpacing:"0.08em"}}>7-SIGNAL SCORER BACKTEST 9:31 MARKET ENTRY</div>
 </div>
 <div style={{ marginLeft:"auto", display:"flex", gap: 8, alignItems:"center"}}>
 <div style={{ fontSize:"11px", color: T.muted }}>WIN +{settings.winPct}% STOP -{settings.lossPct}%</div>
 <span style={{ background: isBtLive ?"#00330f":"#2a1e00", border:`1px solid ${isBtLive ? T.green : T.amber}44`, color: isBtLive ? T.green : T.amber, padding:"3px 8px", borderRadius:"4px", fontSize:"10px"}}>
 {isBtLive ?"BT LIVE":"BT DEMO"}
 </span>
 <span style={{ background: isScanLive ?"#00330f":"#2a1e00", border:`1px solid ${isScanLive ? T.green : T.amber}44`, color: isScanLive ? T.green : T.amber, padding:"3px 8px", borderRadius:"4px", fontSize:"10px"}}>
 {isScanLive ?"SCAN LIVE":"SCAN DEMO"}
 </span>
 </div>
 </div>

 <div style={{ display:"flex", borderBottom:`1px solid ${T.border}`, paddingLeft: 24 }}>
 {TABS.map((t) => (
 <button key={t.id} onClick={() => setTab(t.id)} style={{ background:"none", border:"none", cursor:"pointer", fontFamily:"inherit", fontSize:"11px", letterSpacing:"0.1em", padding:"12px 20px", color: tab === t.id ? T.blue : T.muted, borderBottom:`2px solid ${tab === t.id ? T.blue :"transparent"}`}}>
 {t.label}
 </button>
 ))}
 </div>

 {tab ==="backtest"&& (
 <div style={{ padding: 24 }}>
 <div style={{ display:"flex", gap: 12, marginBottom: 20, flexWrap:"wrap", alignItems:"flex-end"}}>
 <div><label style={S.label}>Ticker</label><input value={btTicker} onChange={(e) => setBtTicker(e.target.value.toUpperCase())} style={{ ...S.input, width: 100 }} /></div>
 <div><label style={S.label}>Start</label><input type="date"value={btStart} onChange={(e) => setBtStart(e.target.value)} style={{ ...S.input, width: 150 }} /></div>
 <div><label style={S.label}>End</label><input type="date"value={btEnd} onChange={(e) => setBtEnd(e.target.value)} style={{ ...S.input, width: 150 }} /></div>
 <button onClick={runBacktest} disabled={btRunning} style={{ ...S.btn, background: btRunning ? T.dim : T.blue, cursor: btRunning ?"not-allowed":"pointer", minWidth: 140 }}>
 {btRunning ?`RUNNING ${btProgress}%`:"RUN BACKTEST"}
 </button>
 {btResults && <button onClick={() => setShowLog((v) => !v)} style={{ ...S.btn, background:"transparent", border:`1px solid ${T.border}`, color: T.muted }}>{showLog ?"HIDE LOG":"SHOW LOG"}</button>}
 </div>
 {btRunning && <div style={{ marginBottom: 20, height: 3, background: T.dim, borderRadius: 2, overflow:"hidden"}}><div style={{ width:`${btProgress}%`, height:"100%", background: T.blue, transition:"width 0.2s"}} /></div>}
 {showLog && btLog.length > 0 && (
 <div ref={logRef} style={{ ...S.card, maxHeight: 160, overflowY:"auto", marginBottom: 20, fontSize:"11px", lineHeight: 1.9, color: T.muted }}>
 {btLog.map((l, i) => <div key={i}>{l}</div>)}
 </div>
 )}
 {btResults && (
 <>
 <div style={{ display:"flex", gap: 12, flexWrap:"wrap", marginBottom: 20 }}>
 <StatCard label="Win Rate"value={`${btResults.stats.winRate}%`} sub={`${btResults.stats.wins}W / ${btResults.stats.losses}L`} color={parseFloat(btResults.stats.winRate) >= 50 ? T.green : T.red} />
 <StatCard label="Signals"value={btResults.stats.total} sub={`+${btResults.stats.timeouts} timeout`} />
 <StatCard label="Avg Win"value={`+${btResults.stats.avgWin}%`} color={T.green} />
 <StatCard label="Avg Loss"value={`${btResults.stats.avgLoss}%`} color={T.red} />
 <StatCard label="Profit Factor"value={btResults.stats.pf} color={parseFloat(btResults.stats.pf) >= 1.5 ? T.green : T.amber} />
 <StatCard label="Total Return"value={`${parseFloat(btResults.stats.totalPct) >= 0 ?"+":""}${btResults.stats.totalPct}%`} color={parseFloat(btResults.stats.totalPct) >= 0 ? T.green : T.red} />
 </div>
 <div style={{ ...S.card, marginBottom: 20 }}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 12 }}>EQUITY CURVE CUMULATIVE RETURN</div>
 <ResponsiveContainer width="100%"height={200}>
 <LineChart data={btResults.curve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
 <CartesianGrid strokeDasharray="3 3"stroke={T.border} />
 <XAxis dataKey="date"tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} interval={Math.max(1, Math.floor(btResults.curve.length / 6))} />
 <YAxis tick={{ fill: T.muted, fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) =>`${v >= 0 ?"+":""}${v}%`} />
 <Tooltip content={<ChartTip />} />
 <Line type="monotone"dataKey="cumPct"stroke={T.blue} strokeWidth={2} dot={false} />
 </LineChart>
 </ResponsiveContainer>
 </div>
 <div style={S.card}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 12 }}>TRADE LOG click any row for signal breakdown</div>
 <div style={{ overflowX:"auto"}}>
 <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"12px"}}>
 <thead>
 <tr>{["DATE","ENTRY $","GAP","SCORE","RVOL","CATALYST","RESULT","P&L"].map((h) => <th key={h} style={{ padding:"6px 10px", fontWeight: 400, fontSize:"10px", color: T.muted, textAlign:"left", borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr>
 </thead>
 <tbody>
 {btResults.trades.flatMap((t, i) => {
 const rows = [
 <tr key={i} onClick={() => setExpandRow(expandRow === i ? null : i)} style={{ borderBottom:`1px solid ${T.dim}`, cursor:"pointer", background: expandRow === i ? T.surface :"transparent"}}>
 <td style={{ padding:"7px 10px", color: T.muted }}>{t.date}</td>
 <td style={{ padding:"7px 10px"}}>${t.entryPrice?.toFixed(2)}</td>
 <td style={{ padding:"7px 10px", color: t.gap >= 0 ? T.green : T.red }}>{t.gap >= 0 ?"+":""}{t.gap}%</td>
 <td style={{ padding:"7px 10px", minWidth: 110 }}><ScoreBar score={t.score} /></td>
 <td style={{ padding:"7px 10px", color: t.rvol >= 2 ? T.green : T.muted }}>{t.rvol != null ?`${t.rvol}x`:""}</td>
 <td style={{ padding:"7px 10px"}}>{t.breakdown?.catalyst >= 25 ? <Badge result="STRONG"/> : t.breakdown?.catalyst >= 12 ? <Badge result="MODERATE"/> : <span style={{ color: T.dim }}></span>}</td>
 <td style={{ padding:"7px 10px"}}><Badge result={t.result} /></td>
 <td style={{ padding:"7px 10px", color: t.pct >= 0 ? T.green : T.red, fontWeight: 700 }}>{t.pct >= 0 ?"+":""}{t.pct?.toFixed(2)}%</td>
 </tr>
 ];
 if (expandRow === i) rows.push(<tr key={`exp${i}`}><td colSpan={8} style={{ padding:"0 10px 12px"}}><ScoreBreakdown breakdown={t.breakdown || {}} headlines={t.headlines} rvol={t.rvol} spyGap={t.spyGap} catalystSource={t.catalystSource} /></td></tr>);
 return rows;
 })}
 </tbody>
 </table>
 </div>
 </div>
 </>
 )}
 {!btResults && !btRunning && (
 <div style={{ textAlign:"center", padding:"60px 0", color: T.muted }}>
 <div style={{ fontSize:"32px", marginBottom: 12 }}></div>
 <div>Set ticker + date range RUN BACKTEST</div>
 <div style={{ fontSize:"11px", marginTop: 8, color: T.dim }}>{isDemo ?"Demo uses all 7 signals with simulated data":"Live mode active Polygon.io"}</div>
 </div>
 )}
 </div>
 )}

 {tab ==="scanner"&& (
 <div style={{ padding: 24 }}>
 <div style={{ display:"flex", gap: 12, marginBottom: 16, alignItems:"flex-end", flexWrap:"wrap"}}>
 <div style={{ flex: 1, minWidth: 180 }}>
 <label style={S.label}>Add Ticker</label>
 <input value={scanInput} onChange={(e) => setScanInput(e.target.value.toUpperCase())}
 onKeyDown={(e) => { if (e.key ==="Enter"&& scanInput.trim()) { setScanTickers((p) => [...new Set([...p, scanInput.trim()])]); setScanInput(""); } }}
 placeholder="Ticker + Enter"style={S.input} />
 </div>
 <button onClick={runScan} disabled={scanning} style={{ ...S.btn, background: scanning ? T.dim : T.blue, cursor: scanning ?"not-allowed":"pointer"}}>
 {scanning ?"SCANNING...":"SCAN NOW"}
 </button>
 </div>
 <div style={{ display:"flex", gap: 8, flexWrap:"wrap", marginBottom: 20 }}>
 {scanTickers.map((tk) => (
 <div key={tk} style={{ background: T.panel, border:`1px solid ${T.border}`, borderRadius: 6, padding:"4px 10px", display:"flex", gap: 8, alignItems:"center"}}>
 <span>{tk}</span>
 <button onClick={() => setScanTickers((p) => p.filter((t) => t !== tk))} style={{ background:"none", border:"none", color: T.muted, cursor:"pointer", fontSize:"14px", padding:"0 4px", fontWeight:"bold" }}>×</button>
 </div>
 ))}
 </div>
 {scanResults && (
 <div style={S.card}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 12 }}>{isDemo ?"DEMO ADD POLYGON/ALPACA KEY FOR LIVE":`LIVE ${new Date().toLocaleTimeString()}`}</div>
 <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"12px"}}>
 <thead>
 <tr>{["TICKER","SCORE","GAP","RVOL","CATALYST","SPY PM","SIGNAL"].map((h) => <th key={h} style={{ padding:"6px 12px", fontWeight: 400, fontSize:"10px", color: T.muted, textAlign:"left", borderBottom:`1px solid ${T.border}`}}>{h}</th>)}</tr>
 </thead>
 <tbody>
 {scanResults.flatMap((r, i) => {
 const rows = [
 <tr key={i} onClick={() => setExpandScan(expandScan === i ? null : i)} style={{ borderBottom:`1px solid ${T.dim}`, cursor:"pointer", background: expandScan === i ? T.surface :"transparent"}}>
 <td style={{ padding:"10px 12px", fontWeight: 700 }}>{r.ticker}</td>
 <td style={{ padding:"10px 12px", minWidth: 120 }}><ScoreBar score={r.score} /></td>
 <td style={{ padding:"10px 12px", color: r.gap >= 0 ? T.green : T.red }}>{r.gap >= 0 ?"+":""}{r.gap}%</td>
 <td style={{ padding:"10px 12px", color: r.rvol >= 2 ? T.green : T.muted }}>{r.rvol != null ?`${r.rvol}x`:""}</td>
 <td style={{ padding:"10px 12px"}}>{r.breakdown?.catalyst >= 25 ? <Badge result="STRONG"/> : r.breakdown?.catalyst >= 12 ? <Badge result="MODERATE"/> : <span style={{ color: T.dim }}></span>}</td>
 <td style={{ padding:"10px 12px", color: r.spyGap >= 0 ? T.green : T.red }}>{r.spyGap != null ?`${r.spyGap >= 0 ?"+":""}${r.spyGap}%`:""}</td>
 <td style={{ padding:"10px 12px"}}><Badge result={r.signal} /></td>
 </tr>
 ];
 if (expandScan === i) rows.push(<tr key={`es${i}`}><td colSpan={7} style={{ padding:"0 12px 14px"}}><ScoreBreakdown breakdown={r.breakdown || {}} headlines={r.headlines} rvol={r.rvol} spyGap={r.spyGap} catalystSource={r.catalystSource} /></td></tr>);
 return rows;
 })}
 </tbody>
 </table>
 </div>
 )}
 {!scanResults && !scanning && (
 <div style={{ textAlign:"center", padding:"60px 0", color: T.muted }}>
 <div style={{ fontSize:"32px", marginBottom: 12 }}></div>
 <div>Add tickers and hit SCAN NOW</div>
 <div style={{ fontSize:"11px", marginTop: 8 }}>Best run 4:009:30 AM ET click any row to expand breakdown</div>
 </div>
 )}
 </div>
 )}

 {tab ==="settings"&& (
 <div style={{ padding: 24, maxWidth: 560 }}>
 <div style={{ ...S.card, marginBottom: 16 }}>
 <div style={{ fontSize:"11px", color: T.amber, marginBottom: 16 }}> API KEYS leave blank for demo mode</div>
 <div style={{ marginBottom: 14 }}>
 <label style={S.label}>Polygon.io Key pre-market bars SPY context avg volume (Backtest)</label>
 <input type="password"value={settings.polygonKey} onChange={(e) => setSettings((s) => ({ ...s, polygonKey: e.target.value }))} placeholder="Polygon key..."style={S.input} />
 <div style={{ fontSize:"10px", color: T.muted, marginTop: 4 }}>Free plan works for backtesting. Rate-limited to 5 calls/min.</div>
 </div>
 <div style={{ marginBottom: 14 }}>
 <label style={S.label}>FMP Key real earnings beats analyst upgrades (Optional)</label>
 <input type="password"value={settings.fmpKey} onChange={(e) => setSettings((s) => ({ ...s, fmpKey: e.target.value }))} placeholder="FMP key..."style={S.input} />
 <div style={{ fontSize:"10px", color: T.muted, marginTop: 4 }}>Optional. Free plan works. Upgrades catalyst from keyword matching to real EPS beat % and analyst data.</div>
 </div>
 <div style={{ marginBottom: 14 }}>
 <label style={S.label}>Alpaca Key ID PRIMARY live scanner source (FREE)</label>
 <input type="password"value={settings.alpacaId} onChange={(e) => setSettings((s) => ({ ...s, alpacaId: e.target.value }))} placeholder="Alpaca key ID..."style={S.input} />
 <div style={{ fontSize:"10px", color: T.muted, marginTop: 4 }}>Free paper account at alpaca.markets 4am8pm extended hours in real time. No credit card needed.</div>
 </div>
 <div>
 <label style={S.label}>Alpaca Secret Key</label>
 <input type="password"value={settings.alpacaSecret} onChange={(e) => setSettings((s) => ({ ...s, alpacaSecret: e.target.value }))} placeholder="Alpaca secret..."style={S.input} />
 </div>
 </div>
 <div style={{ ...S.card, marginBottom: 16 }}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 14 }}>TRADE LOGIC</div>
 <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap: 12 }}>
 <div><label style={S.label}>Win Target %</label><input type="number"step="0.1"min="0.5"max="20"value={settings.winPct} onChange={(e) => setSettings((s) => ({ ...s, winPct: parseFloat(e.target.value) }))} style={S.input} /></div>
 <div><label style={S.label}>Stop Loss %</label><input type="number"step="0.1"min="0.1"max="5"value={settings.lossPct} onChange={(e) => setSettings((s) => ({ ...s, lossPct: parseFloat(e.target.value) }))} style={S.input} /></div>
 <div><label style={S.label}>Min Score</label><input type="number"step="1"min="0"max="95"value={settings.minScore} onChange={(e) => setSettings((s) => ({ ...s, minScore: parseInt(e.target.value) }))} style={S.input} /></div>
 </div>
 </div>
 <div style={S.card}>
 <div style={{ fontSize:"11px", color: T.muted, marginBottom: 14 }}>7-SIGNAL GUIDE</div>
 {[
 { icon:"", name:"Catalyst", max: 25, note:"Earnings beat=25 Analyst upgrade=12 News=5 None=0"},
 { icon:"", name:"Relative Volume", max: 20, note:"Projected day vol vs 30-day avg. 3x RVOL 20pts"},
 { icon:"", name:"Gap %", max: 20, note:"Pre-market vs prev close. 6%+ gap = full 20pts"},
 { icon:"", name:"PM Momentum", max: 10, note:"Last 30 PM bars trending up"},
 { icon:"", name:"Market Context", max: 10, note:"SPY PM green=10 flat=5 red=0"},
 { icon:"", name:"PM Consistency", max: 5, note:"% of green candles pre-market"},
 { icon:"", name:"Short Interest", max: 5, note:"High SI = squeeze potential (neutral 2.5 if N/A)"},
 ].map(({ icon, name, max, note }) => (
 <div key={name} style={{ display:"flex", gap: 10, marginBottom: 10 }}>
 <span style={{ fontSize:"14px", minWidth: 20 }}>{icon}</span>
 <div><div style={{ fontSize:"12px", color: T.text, marginBottom: 2 }}>{name} <span style={{ color: T.muted, fontSize:"10px"}}>/{max}pts</span></div><div style={{ fontSize:"10px", color: T.muted }}>{note}</div></div>
 </div>
 ))}
 <div style={{ marginTop: 12, padding: 10, background: T.bg, borderRadius: 6, fontSize:"11px", color: T.muted, lineHeight: 1.8 }}>
 <span style={{ color: T.amber }}>Tip:</span> Set min score 5565 for selective signals. Score 70+ = act. Score 80+ = full size.
 </div>
 </div>
 </div>
 )}
 </div>
 );
}