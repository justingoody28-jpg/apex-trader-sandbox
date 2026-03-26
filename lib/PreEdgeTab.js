import { useState, useRef, useCallback, useEffect } from "react";

// ─── Polygon API key (move to NEXT_PUBLIC_POLYGON_KEY env var when ready) ───
const POLY_KEY = "Bnm35KUdSdLOFv37f6NyfUcQdc1aH5IF";

// ─── Ticker universe ─────────────────────────────────────────────────────────
const ALL_TICKERS = [
  { t: "ATER", grp: "Small/Micro" }, { t: "LAZR", grp: "Small/Micro" },
  { t: "MRNA", grp: "Small/Micro" }, { t: "AGEN", grp: "Small/Micro" },
  { t: "GFAI", grp: "Small/Micro" }, { t: "IONQ", grp: "Small/Micro" },
  { t: "FCEL", grp: "Small/Micro" }, { t: "RCKT", grp: "Small/Micro" },
  { t: "SPCE", grp: "Small/Micro" }, { t: "HUT",  grp: "Small/Micro" },
  { t: "WOLF", grp: "Small/Micro" }, { t: "TWLO", grp: "Mid" },
  { t: "AMD",  grp: "Large" },       { t: "TSLA", grp: "Large" },
  { t: "NVDA", grp: "Large" },       { t: "GOOGL",grp: "Large" },
  { t: "META", grp: "Large" },       { t: "NFLX", grp: "Large" },
  { t: "INTC", grp: "Large" },       { t: "AMZN", grp: "Large" },
  { t: "AAPL", grp: "Large" },       { t: "MSFT", grp: "Large" },
  { t: "JPM",  grp: "Large" },       { t: "LLY",  grp: "Large" },
  { t: "UNH",  grp: "Large" },       { t: "GS",   grp: "Large" },
  { t: "PFE",  grp: "Large" },       { t: "COIN", grp: "Mid" },
  { t: "ACAD", grp: "Mid" },         { t: "NVCR", grp: "Mid" },
  { t: "HUBS", grp: "Mid" },         { t: "OKTA", grp: "Mid" },
  { t: "SNAP", grp: "Mid" },         { t: "HOOD", grp: "Mid" },
  { t: "CRWD", grp: "Mid" },         { t: "DDOG", grp: "Mid" },
  { t: "SOFI", grp: "Mid" },
];

// ─── Pure helpers ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function etH(ts) {
  const d = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "America/New_York" }));
  return d.getHours() + d.getMinutes() / 60;
}
function byDate(bars) {
  const m = {};
  bars.forEach(b => {
    const d = new Date(new Date(b.t).toLocaleString("en-US", { timeZone: "America/New_York" }));
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    if (!m[k]) m[k] = [];
    m[k].push(b);
  });
  return m;
}
const isPM  = b => { const h = etH(b.t); return h >= 4 && h < 9.5; };
const isIn  = b => { const h = etH(b.t); return h >= 9.517 && h < 16; };
const isReg = b => { const h = etH(b.t); return h >= 9.5 && h < 16; };
function get931(bs) { return bs.find(b => { const h = etH(b.t); return h >= 9.517 && h <= 9.65; }); }
function tradingDays(s, e) {
  const out = [];
  const end = new Date(e + "T12:00:00Z");
  const d   = new Date(s + "T12:00:00Z");
  while (d <= end) {
    if (d.getUTCDay() && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function fetchBars(tk, from, to) {
  const r = await fetch(
    `https://api.polygon.io/v2/aggs/ticker/${tk}/range/1/minute/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${POLY_KEY}`
  );
  if (r.status === 429) { const e = new Error("RATE_LIMIT"); e.retry = true; throw e; }
  if (!r.ok) throw new Error("HTTP " + r.status);
  const d = await r.json();
  return d.results || [];
}
async function fetchAvgVol(tk) {
  try {
    const to = new Date(); to.setDate(to.getDate() - 1);
    const fr = new Date(); fr.setDate(fr.getDate() - 31);
    const r = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/${tk}/range/1/day/${fr.toISOString().slice(0,10)}/${to.toISOString().slice(0,10)}?adjusted=true&sort=asc&limit=30&apiKey=${POLY_KEY}`
    );
    if (!r.ok) return null;
    const res = (await r.json()).results || [];
    return res.length ? res.reduce((s, b) => s + b.v, 0) / res.length : null;
  } catch { return null; }
}

function evalLong(intra, ep, wp, sp) {
  const wt = ep * (1 + wp / 100), st = ep * (1 - sp / 100);
  for (const b of intra) {
    if (b.h >= wt) return { r: "WIN",  p: wp };
    if (b.l <= st) return { r: "LOSS", p: -sp };
  }
  const last = intra[intra.length - 1];
  return { r: "TIMEOUT", p: last ? parseFloat(((last.c - ep) / ep * 100).toFixed(2)) : 0 };
}
function evalShort(intra, ep, wp, sp) {
  const wt = ep * (1 - wp / 100), st = ep * (1 + sp / 100);
  for (const b of intra) {
    if (b.l <= wt) return { r: "WIN",  p: wp };
    if (b.h >= st) return { r: "LOSS", p: -sp };
  }
  const last = intra[intra.length - 1];
  return { r: "TIMEOUT", p: last ? parseFloat(((ep - last.c) / ep * 100).toFixed(2)) : 0 };
}
function calcStats(trades) {
  if (!trades.length) return { n: 0, w: 0, l: 0, t: 0, wr: 0, pf: 0, ret: 0 };
  const ws = trades.filter(t => t.r === "WIN");
  const ls = trades.filter(t => t.r === "LOSS");
  const ts = trades.filter(t => t.r === "TIMEOUT");
  const aw = ws.length ? ws.reduce((s, t) => s + t.p, 0) / ws.length : 0;
  const al = ls.length ? ls.reduce((s, t) => s + t.p, 0) / ls.length : 0;
  const pf = ls.length && al ? Math.abs(ws.length * aw / (ls.length * al)) : ws.length ? 99 : 0;
  return { n: trades.length, w: ws.length, l: ls.length, t: ts.length,
           wr: ws.length / trades.length * 100, pf, ret: trades.reduce((s, t) => s + t.p, 0) };
}

async function processTicker(tk, from, to, cfg) {
  const { gfm, gfmF, eWin, eStop, fWin, fStop, runA, runB, runC, runD, runE, runF } = cfg;
  const bars = await fetchBars(tk, from, to);
  if (!bars.length) return null;
  const avgVol = await fetchAvgVol(tk);
  const dmap = byDate(bars);
  const tdays = tradingDays(from, to);
  let prevC = null;
  const trades = { a: [], b: [], c: [], d: [], e: [], f: [] };
  const dayRows = [];

  for (let j = 0; j < tdays.length; j++) {
    const date = tdays[j];
    const db = dmap[date] || [];
    if (!db.length) continue;
    if (!prevC && j > 0) {
      const pb = (dmap[tdays[j-1]] || []).filter(isReg);
      if (pb.length) prevC = pb[pb.length - 1].c;
    }
    const reg = db.filter(isReg);
    if (reg.length) prevC = reg[reg.length - 1].c;
    const pm = db.filter(isPM), ent = get931(db), intra = db.filter(isIn);
    if (!pm.length || !ent || !prevC) continue;
    const lastPM = pm[pm.length - 1].c;
    const minPM  = pm.reduce((mn, b) => Math.min(mn, b.l), Infinity);
    const gap     = ((lastPM - prevC) / prevC) * 100;
    const gapDown = ((minPM  - prevC) / prevC) * 100;
    const pmVol   = pm.reduce((s, b) => s + b.v, 0);
    const rvol    = avgVol ? parseFloat((pmVol / (avgVol * 0.05)).toFixed(2)) : null;
    const ep = ent.o;
    const rA = runA ? evalLong (intra, ep, 2, 0.5) : null;
    const rB = runB ? evalLong (intra, ep, 3, 0.5) : null;
    const rC = runC ? evalLong (intra, ep, 4, 0.5) : null;
    const rD = runD ? evalShort(intra, ep, 2, 0.5) : null;
    const eActive = gap >= gfm;
    const fActive = gapDown <= -gfmF;
    const rE = runE && eActive ? evalShort(intra, ep, eWin, eStop) : null;
    const rF = runF && fActive ? evalLong (intra, ep, fWin, fStop) : null;
    if (rA) trades.a.push(rA); if (rB) trades.b.push(rB);
    if (rC) trades.c.push(rC); if (rD) trades.d.push(rD);
    if (rE) trades.e.push(rE); if (rF) trades.f.push(rF);
    dayRows.push({
      date, gap: parseFloat(gap.toFixed(2)), rvol,
      gapDown: parseFloat(gapDown.toFixed(2)),
      ar: rA?.r || "--", ap: rA?.p || 0,
      br: rB?.r || "--", bp: rB?.p || 0,
      cr: rC?.r || "--", cp: rC?.p || 0,
      dr: rD?.r || "--", dp: rD?.p || 0,
      eActive: eActive && runE, er: rE?.r || "", ep2: rE?.p || 0,
      fActive: fActive && runF, fr: rF?.r || "", fp2: rF?.p || 0,
    });
  }
  return {
    a: calcStats(trades.a), b: calcStats(trades.b),
    c: calcStats(trades.c), d: calcStats(trades.d),
    e: calcStats(trades.e), f: calcStats(trades.f),
    dayRows,
  };
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const S = {
  wrap:     { background: "#0d1117", color: "#e6edf3", fontFamily: "monospace", fontSize: 13, padding: 20, minHeight: "100%" },
  h1:       { color: "#58a6ff", fontSize: 18, marginBottom: 3 },
  sub:      { color: "#8b949e", fontSize: 11, marginBottom: 14 },
  card:     { background: "#161b22", border: "1px solid #30363d", borderRadius: 6, padding: "10px 14px" },
  cardWin:  { background: "#161b22", border: "1px solid #3fb950", borderRadius: 6, padding: "10px 14px" },
  cardH:    { color: "#58a6ff", fontSize: 11, marginBottom: 6, borderBottom: "1px solid #30363d", paddingBottom: 4 },
  row:      { display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 },
  label:    { color: "#8b949e" },
  grid2:    { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8, marginBottom: 14 },
  grid6:    { display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 14 },
  controls: { display: "flex", gap: 10, marginBottom: 14, alignItems: "flex-end", flexWrap: "wrap" },
  fldLabel: { fontSize: 11, color: "#8b949e", display: "block", marginBottom: 3 },
  input:    { background: "#161b22", border: "1px solid #30363d", color: "#e6edf3", padding: "7px 10px", borderRadius: 5, fontFamily: "monospace", fontSize: 12, width: 75 },
  inputWide:{ background: "#161b22", border: "1px solid #30363d", color: "#e6edf3", padding: "7px 10px", borderRadius: 5, fontFamily: "monospace", fontSize: 12, width: 148 },
  select:   { background: "#161b22", border: "1px solid #30363d", color: "#e6edf3", padding: "7px 10px", borderRadius: 5, fontFamily: "monospace", fontSize: 12, minWidth: 200 },
  progWrap: { background: "#161b22", border: "1px solid #30363d", borderRadius: 8, padding: 12, marginBottom: 14 },
  barBg:    { background: "#21262d", borderRadius: 4, height: 7, margin: "6px 0 3px" },
  plab:     { fontSize: 11, color: "#8b949e" },
  log:      { background: "#0d1117", border: "1px solid #30363d", borderRadius: 5, padding: "8px 10px", height: 70, overflowY: "auto", fontSize: 11, marginBottom: 14 },
  cbRow:    { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap", alignItems: "center" },
  tblWrap:  { maxHeight: 360, overflowY: "auto", border: "1px solid #30363d", borderRadius: 8, marginBottom: 14 },
  batchWrap:{ maxHeight: 400, overflowY: "auto", border: "1px solid #30363d", borderRadius: 8, marginBottom: 14 },
  th:       { background: "#161b22", color: "#8b949e", padding: "6px 9px", textAlign: "left", borderBottom: "1px solid #30363d", position: "sticky", top: 0, whiteSpace: "nowrap", cursor: "pointer", fontSize: 11 },
  td:       { padding: "5px 9px", borderBottom: "1px solid #1c2128", fontSize: 11 },
  stitle:   { color: "#58a6ff", fontSize: 12, fontWeight: "bold", margin: "8px 0 6px", borderBottom: "1px solid #30363d", paddingBottom: 4 },
};

const PILL_COLORS = { a: "#58a6ff", b: "#3fb950", c: "#a78bfa", d: "#f85149", e: "#ffa657", f: "#39d353" };
function pillStyle(id, on) {
  const c = PILL_COLORS[id];
  return {
    display: "flex", alignItems: "center", gap: 5,
    background: "#161b22", border: `1px solid ${on ? c : "#30363d"}`,
    borderRadius: 5, padding: "5px 10px", cursor: "pointer", fontSize: 11,
    userSelect: "none", color: on ? c : "#8b949e",
  };
}
function btnStyle(bg, disabled) {
  return disabled
    ? { padding: "8px 16px", border: "none", borderRadius: 5, cursor: "not-allowed", fontSize: 12, fontWeight: "bold", background: "#21262d", color: "#484f58" }
    : { padding: "8px 16px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: "bold", background: bg, color: "#fff" };
}

function wrColor(wr, be) {
  if (wr > be) return "#3fb950";
  if (wr > be * 0.8) return "#ffa657";
  return "#f85149";
}
function pfColor(pf) { return pf >= 1 ? "#3fb950" : pf >= 0.8 ? "#ffa657" : "#f85149"; }
function retColor(ret) { return ret >= 0 ? "#3fb950" : "#f85149"; }
function rcCls(r) { return r === "WIN" ? "#3fb950" : r === "LOSS" ? "#f85149" : "#8b949e"; }
function fmtP(p) { return (p >= 0 ? "+" : "") + parseFloat(p).toFixed(2) + "%"; }

function StatCard({ label, be, stats, active }) {
  if (!active) return null;
  const s = stats || { n: 0, wr: 0, pf: 0, ret: 0 };
  const isWin = s.pf >= 1;
  return (
    <div style={isWin ? S.cardWin : S.card}>
      <div style={S.cardH}>{label}</div>
      <div style={S.row}><span style={S.label}>Signals</span><span style={{ fontWeight: "bold" }}>{s.n || "--"}</span></div>
      <div style={S.row}><span style={S.label}>Win Rate</span>
        <span style={{ fontWeight: "bold", color: s.n ? wrColor(s.wr, be) : "#e6edf3" }}>{s.n ? s.wr.toFixed(1) + "%" : "--"}</span>
      </div>
      <div style={S.row}><span style={S.label}>Prof. Factor</span>
        <span style={{ fontWeight: "bold", color: s.n ? pfColor(s.pf) : "#e6edf3" }}>{s.n ? s.pf.toFixed(2) : "--"}</span>
      </div>
      <div style={S.row}><span style={S.label}>Total Return</span>
        <span style={{ fontWeight: "bold", color: s.n ? retColor(s.ret) : "#e6edf3" }}>{s.n ? fmtP(s.ret) : "--"}</span>
      </div>
    </div>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────
export function PreEdgeTab() {
  // Controls
  const [ticker,     setTicker]     = useState("LAZR");
  const [dateFrom,   setDateFrom]   = useState("2025-09-25");
  const [dateTo,     setDateTo]     = useState("2026-03-25");
  const [gapFade,    setGapFade]    = useState(10);
  const [gapFadeF,   setGapFadeF]   = useState(5);
  const [eWin,       setEWin]       = useState(3);
  const [eStop,      setEStop]      = useState(2);
  const [fWin,       setFWin]       = useState(2);
  const [fStop,      setFStop]      = useState(2);
  const [delay,      setDelay]      = useState(13);
  const [batchGroup, setBatchGroup] = useState("all");
  const [scenarios,  setScenarios]  = useState({ a:true, b:true, c:true, d:true, e:true, f:true });

  // Results
  const [singleStats,  setSingleStats]  = useState({});
  const [singleRows,   setSingleRows]   = useState([]);
  const [singleTicker, setSingleTicker] = useState("");
  const [batchResults, setBatchResults] = useState([]);
  const [showSingle,   setShowSingle]   = useState(false);
  const [showBatch,    setShowBatch]    = useState(false);

  // Progress / log
  const [running,   setRunning]   = useState(false);
  const [progress,  setProgress]  = useState(0);
  const [progLabel, setProgLabel] = useState("Ready — Run Single or Run All 37");
  const [logs,      setLogs]      = useState([]);

  // Sort
  const [sSort, setSSort] = useState({ col: "date", dir: 1 });
  const [bSort, setBSort] = useState({ col: "e_wr", dir: -1 });

  const runningRef = useRef(false);
  const logRef     = useRef(null);

  const addLog = useCallback((msg, cls = "neu") => {
    setLogs(prev => [...prev, { msg: new Date().toLocaleTimeString() + " " + msg, cls }]);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const getActiveTickers = () =>
    batchGroup === "all" ? ALL_TICKERS : ALL_TICKERS.filter(t => t.grp === batchGroup);

  const makeCfg = () => ({
    gfm: gapFade, gfmF: gapFadeF, eWin, eStop, fWin, fStop,
    runA: scenarios.a, runB: scenarios.b, runC: scenarios.c,
    runD: scenarios.d, runE: scenarios.e, runF: scenarios.f,
  });

  // Run Single
  const runOne = async () => {
    setRunning(true); runningRef.current = true;
    setLogs([]); setShowSingle(false); setShowBatch(false);
    setSingleStats({}); setSingleRows([]); setProgress(30);
    setProgLabel(`Fetching ${ticker}…`);
    addLog(`Running ${ticker}…`, "inf");
    try {
      const res = await processTicker(ticker, dateFrom, dateTo, makeCfg());
      setProgress(100);
      if (!res) { addLog(`${ticker}: no data`, "err"); }
      else {
        setSingleStats(res);
        setSingleRows(res.dayRows);
        setSingleTicker(ticker);
        setShowSingle(true);
        addLog(
          `${ticker} | A WR${res.a.wr.toFixed(0)}% PF${res.a.pf.toFixed(2)} | D WR${res.d.wr.toFixed(0)}% | E sigs:${res.e.n} WR${res.e.wr.toFixed(0)}% | F sigs:${res.f.n}`,
          (res.a.pf >= 1 || res.e.pf >= 1) ? "ok" : "neu"
        );
      }
    } catch (err) {
      addLog(`${ticker}: ${err.message}`, "err"); setProgress(100);
    }
    setProgLabel("Single run complete"); setRunning(false); runningRef.current = false;
  };

  // Run All
  const runAll = async () => {
    const tickers = getActiveTickers();
    setRunning(true); runningRef.current = true;
    setLogs([]); setBatchResults([]); setShowBatch(true); setShowSingle(false);
    addLog(`Batch: ${tickers.length} tickers, ${delay}s delay, ~${Math.round(tickers.length * delay / 60)}min`, "inf");
    const cfg = makeCfg();
    for (let i = 0; i < tickers.length; i++) {
      if (!runningRef.current) break;
      const { t: tk, grp } = tickers[i];
      const pct = Math.round(i / tickers.length * 100);
      setProgress(pct);
      setProgLabel(`Batch: ${i+1}/${tickers.length} — ${tk} (${pct}%)`);
      let res = null, attempts = 0;
      while (res === null && attempts < 3) {
        try { res = await processTicker(tk, dateFrom, dateTo, cfg); }
        catch (err) {
          if (err.retry) {
            addLog(`${tk}: rate limited, waiting 65s…`, "err");
            await sleep(65000); attempts++;
          } else { addLog(`${tk}: ${err.message}`, "err"); break; }
        }
      }
      const row = {
        tk, grp,
        a: res?.a || null, b: res?.b || null, c: res?.c || null,
        d: res?.d || null, e: res?.e || null, f: res?.f || null,
        a_wr: res?.a?.wr ?? -999, a_pf: res?.a?.pf ?? -999,
        b_wr: res?.b?.wr ?? -999, b_pf: res?.b?.pf ?? -999,
        c_wr: res?.c?.wr ?? -999, c_pf: res?.c?.pf ?? -999,
        d_wr: res?.d?.wr ?? -999, d_pf: res?.d?.pf ?? -999,
        e_n:  res?.e?.n  ?? 0,    e_wr: res?.e?.wr ?? -999, e_pf: res?.e?.pf ?? -999,
        f_n:  res?.f?.n  ?? 0,    f_wr: res?.f?.wr ?? -999, f_pf: res?.f?.pf ?? -999,
      };
      setBatchResults(prev => [...prev, row]);
      if (res) addLog(
        `${tk}[${grp}] A:${res.a.wr.toFixed(0)}%/PF${res.a.pf.toFixed(2)} | E:${res.e.n} WR${res.e.wr.toFixed(0)}% | F:${res.f.n}`,
        (res.d.pf >= 1 || res.e.pf >= 1) ? "ok" : "neu"
      );
      if (i < tickers.length - 1 && runningRef.current) await sleep(delay * 1000);
    }
    setProgress(100);
    setProgLabel(`Batch complete — ${getActiveTickers().length} tickers processed`);
    addLog("=== BATCH DONE ===", "inf");
    setRunning(false); runningRef.current = false;
  };

  const stopRun = () => { runningRef.current = false; setRunning(false); addLog("Stopped", "err"); };

  // Export Single CSV
  const exportOne = () => {
    const eBE = (eStop / (eWin + eStop) * 100).toFixed(1);
    const fBE = (fStop / (fWin + fStop) * 100).toFixed(1);
    let c = `EDGE SCENARIO -- ${singleTicker}\nRange,${dateFrom} to ${dateTo}\n\n`;
    c += "SCENARIO,Signals,WR%,PF,Return,Breakeven WR\n";
    [["a","A Long +2/-0.5",20],["b","B Long +3/-0.5",14.3],["c","C Long +4/-0.5",11.1],
     ["d","D Short",20],["e","E Gap Fade Short",eBE],["f","F Gap Fade Long",fBE]
    ].forEach(([k,label,be]) => {
      const s = singleStats[k];
      c += `${label},${s?.n||""},${s?.wr?.toFixed(1)||""},${s?.pf?.toFixed(2)||""},${s?.ret?.toFixed(2)||""},${be}%\n`;
    });
    c += "\nDAILY LOG\nDate,Gap%,RVOL,A,A P&L,B,B P&L,C,C P&L,D,D P&L,E Active,E,E P&L,F Active,F,F P&L\n";
    singleRows.forEach(r => {
      c += `${r.date},${r.gap},${r.rvol||""},${r.ar},${r.ap.toFixed(2)},${r.br},${r.bp.toFixed(2)},${r.cr},${r.cp.toFixed(2)},${r.dr},${r.dp.toFixed(2)},${r.eActive?"YES":"NO"},${r.er||""},${r.ep2||""},${r.fActive?"YES":"NO"},${r.fr||""},${r.fp2||""}\n`;
    });
    dlCsv(c, `edge_single_${singleTicker}.csv`);
  };

  // Export Batch CSV
  const exportBatch = () => {
    let c = `EDGE BATCH\nRange,${dateFrom} to ${dateTo}\nGap Fade Min,${gapFade}%\nGenerated,${new Date().toLocaleString()}\n\n`;
    c += "Ticker,Group,A WR%,A PF,A Ret,A Sigs,B WR%,B PF,B Ret,C WR%,C PF,C Ret,D WR%,D PF,D Ret,E Sigs,E WR%,E PF,E Ret,F Sigs,F WR%,F PF,F Ret\n";
    batchResults.forEach(r => {
      const fs = s => s?.n ? `${s.wr.toFixed(1)},${s.pf.toFixed(2)},${s.ret.toFixed(2)},${s.n}` : ",,,";
      c += `${r.tk},${r.grp},${fs(r.a)},${fs(r.b)},${fs(r.c)},${fs(r.d)},${r.e?.n||0},${r.e?.n?r.e.wr.toFixed(1):""},${r.e?.n?r.e.pf.toFixed(2):""},${r.e?.n?r.e.ret.toFixed(2):""},${r.f?.n||0},${r.f?.n?r.f.wr.toFixed(1):""},${r.f?.n?r.f.pf.toFixed(2):""},${r.f?.n?r.f.ret.toFixed(2):""}\n`;
    });
    dlCsv(c, `edge_batch_${dateFrom}.csv`);
  };

  function dlCsv(content, name) {
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([content], { type: "text/csv" })),
      download: name,
    });
    a.click();
  }

  // Sorted rows
  const sortedSingle = [...singleRows].sort((a, b) => {
    const av = a[sSort.col] ?? "", bv = b[sSort.col] ?? "";
    return (av > bv ? 1 : av < bv ? -1 : 0) * sSort.dir;
  });
  const sortedBatch = [...batchResults].sort((a, b) => {
    const av = a[bSort.col] ?? -999, bv = b[bSort.col] ?? -999;
    return (av > bv ? 1 : av < bv ? -1 : 0) * bSort.dir;
  });

  const eBE = parseFloat((eStop / (eWin + eStop) * 100).toFixed(1));
  const fBE = parseFloat((fStop / (fWin + fStop) * 100).toFixed(1));
  const batchCount = getActiveTickers().length;
  const logColors = { ok: "#3fb950", err: "#f85149", inf: "#58a6ff", neu: "#8b949e" };

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>⚡ PRE-MARKET EDGE — Scenario Tester</h1>
      <div style={S.sub}>
        Run Single ticker or all {ALL_TICKERS.length} in batch · 6 scenarios simultaneously · Long and Short setups
      </div>

      {/* Key cards */}
      <div style={S.grid2}>
        <div style={S.card}>
          <div style={S.cardH}>📊 Signal Metrics</div>
          <span style={{ color: "#e6edf3", fontWeight: "bold" }}>Signals</span>
          <span style={{ color: "#8b949e" }}> — Trading days evaluated. E/F fire only when gap exceeds threshold.</span>
        </div>
        <div style={S.card}>
          <div style={S.cardH}>📈 Performance</div>
          <span style={{ color: "#e6edf3", fontWeight: "bold" }}>Win Rate</span>
          <span style={{ color: "#8b949e" }}> — % hitting win target first. · </span>
          <span style={{ color: "#e6edf3", fontWeight: "bold" }}>PF</span>
          <span style={{ color: "#8b949e" }}> — Profit Factor &gt;1.0 = profitable. Card border turns green. · </span>
          <span style={{ color: "#e6edf3", fontWeight: "bold" }}>Return</span>
          <span style={{ color: "#8b949e" }}> — Sum of all P&amp;Ls per 1 unit risked.</span>
        </div>
      </div>

      {/* Legend */}
      <div style={{ ...S.card, marginBottom: 14, lineHeight: 1.9, fontSize: 11 }}>
        <b style={{ color: "#58a6ff" }}>A — LONG +2/-0.5:</b><span style={{ color: "#8b949e" }}> Buy open, win if +2% before -0.5% | BE 20%</span>
        &nbsp;·&nbsp;<b style={{ color: "#3fb950" }}>B — LONG +3/-0.5:</b><span style={{ color: "#8b949e" }}> BE 14.3%</span>
        &nbsp;·&nbsp;<b style={{ color: "#a78bfa" }}>C — LONG +4/-0.5:</b><span style={{ color: "#8b949e" }}> BE 11.1%</span>
        &nbsp;·&nbsp;<b style={{ color: "#f85149" }}>D — SHORT mirror:</b><span style={{ color: "#8b949e" }}> Short open, ↓2%/↑0.5% | BE 20%</span>
        &nbsp;·&nbsp;<b style={{ color: "#ffa657" }}>E — GAP FADE SHORT:</b><span style={{ color: "#8b949e" }}> Gap &gt;+{gapFade}% · ↓{eWin}%/↑{eStop}% | BE {eBE}%</span>
        &nbsp;·&nbsp;<b style={{ color: "#39d353" }}>F — GAP FADE LONG:</b><span style={{ color: "#8b949e" }}> PM min gap &lt;-{gapFadeF}% · ↑{fWin}%/↓{fStop}% | BE {fBE}%</span>
      </div>

      {/* Controls */}
      <div style={S.controls}>
        <div>
          <label style={S.fldLabel}>Single Ticker</label>
          <select style={S.select} value={ticker} onChange={e => setTicker(e.target.value)}>
            <optgroup label="Top Performers (Small/Micro)">
              {["LAZR","ATER","MRNA","AGEN","GFAI","IONQ","FCEL","RCKT","SPCE","HUT","WOLF"].map(t =>
                <option key={t} value={t}>{t}</option>)}
            </optgroup>
            <optgroup label="Large Cap">
              {["AMD","TSLA","NVDA","GOOGL","META","NFLX","INTC","AMZN","AAPL","MSFT","JPM","LLY","UNH","GS","PFE"].map(t =>
                <option key={t} value={t}>{t}</option>)}
            </optgroup>
            <optgroup label="Mid Cap">
              {["TWLO","COIN","ACAD","NVCR","HUBS","OKTA","SNAP","HOOD","CRWD","DDOG","SOFI"].map(t =>
                <option key={t} value={t}>{t}</option>)}
            </optgroup>
          </select>
        </div>
        <div><label style={S.fldLabel}>Start</label><input type="date" style={S.inputWide} value={dateFrom} onChange={e => setDateFrom(e.target.value)}/></div>
        <div><label style={S.fldLabel}>End</label><input type="date" style={S.inputWide} value={dateTo} onChange={e => setDateTo(e.target.value)}/></div>
        <div><label style={S.fldLabel}>E Gap Min%</label><input type="number" style={S.input} value={gapFade} min={1} max={30} onChange={e => setGapFade(+e.target.value)}/></div>
        <div><label style={S.fldLabel}>F Gap Min%</label><input type="number" style={S.input} value={gapFadeF} min={1} max={30} onChange={e => setGapFadeF(+e.target.value)}/></div>
        <div><label style={S.fldLabel}>E Win%</label><input type="number" style={S.input} value={eWin} min={0.5} max={20} step={0.5} onChange={e => setEWin(+e.target.value)}/></div>
        <div><label style={S.fldLabel}>E Stop%</label><input type="number" style={S.input} value={eStop} min={0.5} max={20} step={0.5} onChange={e => setEStop(+e.target.value)}/></div>
        <div><label style={S.fldLabel}>F Win%</label><input type="number" style={S.input} value={fWin} min={0.5} max={20} step={0.5} onChange={e => setFWin(+e.target.value)}/></div>
        <div><label style={S.fldLabel}>F Stop%</label><input type="number" style={S.input} value={fStop} min={0.5} max={20} step={0.5} onChange={e => setFStop(+e.target.value)}/></div>
        <div><label style={S.fldLabel}>Delay (s)</label><input type="number" style={S.input} value={delay} min={1} max={60} onChange={e => setDelay(+e.target.value)}/></div>
        <div>
          <label style={S.fldLabel}>Batch Group</label>
          <select style={{ ...S.select, minWidth: 160 }} value={batchGroup} onChange={e => setBatchGroup(e.target.value)}>
            <option value="all">All {ALL_TICKERS.length} Tickers</option>
            <option value="Small/Micro">Small / Micro Cap</option>
            <option value="Large">Large Cap</option>
            <option value="Mid">Mid Cap</option>
          </select>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={btnStyle("#238636", running)} disabled={running} onClick={runOne}>▶ Run Single</button>
          <button style={btnStyle("#1f6feb", running)} disabled={running} onClick={runAll}>
            ⚡ Run {batchGroup === "all" ? `All ${batchCount}` : `${batchGroup} (${batchCount})`}
          </button>
          <button style={btnStyle("#da3633", !running)} disabled={!running} onClick={stopRun}>■ Stop</button>
          {showSingle && <button style={btnStyle("#388bfd", false)} onClick={exportOne}>⬇ Export Single</button>}
          {showBatch  && <button style={btnStyle("#388bfd", false)} onClick={exportBatch}>⬇ Export Batch</button>}
        </div>
      </div>

      {/* Scenario checkboxes */}
      <div style={S.cbRow}>
        <span style={{ color: "#8b949e", fontSize: 11, marginRight: 4 }}>Run scenarios:</span>
        {[["a","A — Long +2/-0.5"],["b","B — Long +3/-0.5"],["c","C — Long +4/-0.5"],
          ["d","D — Short mirror"],["e","E — Gap Fade Short"],["f","F — Gap Fade Long"]
        ].map(([id, label]) => (
          <label key={id} style={pillStyle(id, scenarios[id])}>
            <input type="checkbox"
              style={{ accentColor: PILL_COLORS[id], width: 13, height: 13, cursor: "pointer" }}
              checked={scenarios[id]}
              onChange={e => setScenarios(s => ({ ...s, [id]: e.target.checked }))}
            />
            {label}
          </label>
        ))}
      </div>

      {/* Progress */}
      <div style={S.progWrap}>
        <div style={S.plab}>{progLabel}</div>
        <div style={S.barBg}>
          <div style={{ background: "#238636", borderRadius: 4, height: 7, width: `${progress}%`, transition: "width 0.3s" }} />
        </div>
      </div>

      {/* Log */}
      <div style={S.log} ref={logRef}>
        {logs.map((l, i) => (
          <span key={i} style={{ color: logColors[l.cls] || "#8b949e", display: "block" }}>{l.msg}</span>
        ))}
      </div>

      {/* Single ticker stat cards */}
      {showSingle && (
        <>
          <div style={S.stitle}>{singleTicker} — Single Ticker Results</div>
          <div style={S.grid6}>
            <StatCard label="A: LONG +2% / -0.5% | BE 20%"         be={20}   stats={singleStats.a} active={scenarios.a} />
            <StatCard label="B: LONG +3% / -0.5% | BE 14.3%"       be={14.3} stats={singleStats.b} active={scenarios.b} />
            <StatCard label="C: LONG +4% / -0.5% | BE 11.1%"       be={11.1} stats={singleStats.c} active={scenarios.c} />
            <StatCard label="D: SHORT ↓2% / ↑0.5% | BE 20%"        be={20}   stats={singleStats.d} active={scenarios.d} />
            <StatCard label={`E: GAP FADE SHORT | >+${gapFade}% | BE ${eBE}%`} be={eBE} stats={singleStats.e} active={scenarios.e} />
            <StatCard label={`F: GAP FADE LONG | <-${gapFadeF}% | BE ${fBE}%`} be={fBE} stats={singleStats.f} active={scenarios.f} />
          </div>

          {/* Day-by-day trade log */}
          <div style={S.tblWrap}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  {[["date","Date"],["gap","Gap%"],["rvol","RVOL"]].map(([k,l]) => (
                    <th key={k} style={S.th} onClick={() => setSSort(s => ({ col: k, dir: s.col===k ? s.dir*-1 : 1 }))}>{l}</th>
                  ))}
                  {scenarios.a && <><th style={S.th}>A</th><th style={S.th}>A P&amp;L</th></>}
                  {scenarios.b && <><th style={S.th}>B</th><th style={S.th}>B P&amp;L</th></>}
                  {scenarios.c && <><th style={S.th}>C</th><th style={S.th}>C P&amp;L</th></>}
                  {scenarios.d && <><th style={S.th}>D</th><th style={S.th}>D P&amp;L</th></>}
                  {scenarios.e && <><th style={S.th}>E</th><th style={S.th}>E P&amp;L</th></>}
                  {scenarios.f && <><th style={S.th}>F</th><th style={S.th}>F P&amp;L</th></>}
                </tr>
              </thead>
              <tbody>
                {sortedSingle.map((r, i) => (
                  <tr key={i} style={{ background: r.eActive ? "#1a1a0a" : "transparent" }}>
                    <td style={S.td}>{r.date}</td>
                    <td style={S.td}>{r.gap >= 0 ? "+" : ""}{r.gap}%</td>
                    <td style={S.td}>{r.rvol != null ? r.rvol + "x" : "--"}</td>
                    {scenarios.a && <><td style={{ ...S.td, color: rcCls(r.ar) }}>{r.ar}</td><td style={{ ...S.td, color: rcCls(r.ar) }}>{fmtP(r.ap)}</td></>}
                    {scenarios.b && <><td style={{ ...S.td, color: rcCls(r.br) }}>{r.br}</td><td style={{ ...S.td, color: rcCls(r.br) }}>{fmtP(r.bp)}</td></>}
                    {scenarios.c && <><td style={{ ...S.td, color: rcCls(r.cr) }}>{r.cr}</td><td style={{ ...S.td, color: rcCls(r.cr) }}>{fmtP(r.cp)}</td></>}
                    {scenarios.d && <><td style={{ ...S.td, color: rcCls(r.dr) }}>{r.dr}</td><td style={{ ...S.td, color: rcCls(r.dr) }}>{fmtP(r.dp)}</td></>}
                    {scenarios.e && (
                      <>
                        <td style={{ ...S.td, color: r.eActive ? rcCls(r.er) : "#8b949e" }}>{r.eActive ? r.er : "--"}</td>
                        <td style={{ ...S.td, color: r.eActive ? rcCls(r.er) : "#8b949e" }}>{r.eActive ? fmtP(r.ep2) : ""}</td>
                      </>
                    )}
                    {scenarios.f && (
                      <>
                        <td style={{ ...S.td, color: r.fActive ? rcCls(r.fr) : "#8b949e" }}>{r.fActive ? r.fr : "--"}</td>
                        <td style={{ ...S.td, color: r.fActive ? rcCls(r.fr) : "#8b949e" }}>{r.fActive ? fmtP(r.fp2) : ""}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Batch results */}
      {showBatch && batchResults.length > 0 && (
        <>
          <div style={S.stitle}>Batch Results — {batchResults.length} Tickers (click column to sort)</div>
          <div style={S.batchWrap}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr>
                  {[["tk","Ticker"],["grp","Group"],
                    ["a_wr","A WR%"],["a_pf","A PF"],
                    ["b_wr","B WR%"],["b_pf","B PF"],
                    ["c_wr","C WR%"],["c_pf","C PF"],
                    ["d_wr","D WR%"],["d_pf","D PF"],
                    ["e_n","E Sigs"],["e_wr","E WR%"],["e_pf","E PF"],
                    ["f_n","F Sigs"],["f_wr","F WR%"],["f_pf","F PF"],
                  ].map(([k,l]) => (
                    <th key={k} style={S.th} onClick={() => setBSort(s => ({ col: k, dir: s.col===k ? s.dir*-1 : -1 }))}>{l}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedBatch.map((r, i) => {
                  const grpBadge = r.grp === "Large"
                    ? <span style={{ background:"#1f3a5f",color:"#79c0ff",padding:"1px 6px",borderRadius:3,fontSize:10,fontWeight:"bold" }}>Large</span>
                    : r.grp === "Mid"
                    ? <span style={{ background:"#2d1b69",color:"#a78bfa",padding:"1px 6px",borderRadius:3,fontSize:10,fontWeight:"bold" }}>Mid</span>
                    : <span style={{ background:"#1a3a2a",color:"#3fb950",padding:"1px 6px",borderRadius:3,fontSize:10,fontWeight:"bold" }}>S/Micro</span>;
                  const cwr = (v, be) => v?.n ? <span style={{ color: wrColor(v.wr, be) }}>{v.wr.toFixed(1)}%</span> : <span style={{ color: "#8b949e" }}>--</span>;
                  const cpf = v => v?.n ? <span style={{ color: pfColor(v.pf) }}>{v.pf.toFixed(2)}</span> : <span style={{ color: "#8b949e" }}>--</span>;
                  return (
                    <tr key={i}>
                      <td style={S.td}><b>{r.tk}</b></td>
                      <td style={S.td}>{grpBadge}</td>
                      <td style={S.td}>{cwr(r.a,20)}</td><td style={S.td}>{cpf(r.a)}</td>
                      <td style={S.td}>{cwr(r.b,14.3)}</td><td style={S.td}>{cpf(r.b)}</td>
                      <td style={S.td}>{cwr(r.c,11.1)}</td><td style={S.td}>{cpf(r.c)}</td>
                      <td style={S.td}>{cwr(r.d,20)}</td><td style={S.td}>{cpf(r.d)}</td>
                      <td style={S.td}>{r.e?.n || 0}</td>
                      <td style={S.td}>{cwr(r.e, eBE)}</td><td style={S.td}>{cpf(r.e)}</td>
                      <td style={S.td}>{r.f?.n || 0}</td>
                      <td style={S.td}>{cwr(r.f, fBE)}</td><td style={S.td}>{cpf(r.f)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
