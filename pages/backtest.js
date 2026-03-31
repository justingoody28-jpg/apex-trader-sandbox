import { useState, useCallback, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const TICKERS = [
  'MRNA','GFAI','FCEL','TSLA','COIN','NVCR','HOOD','ATEN','LPSN','HALO',
  'FRPT','SG','ASTE','APOG','ARCB','MATX','AGEN','RCKT','ATER','RRGB',
  'RIOT','MARA','SNDX','MNMD','RXRX','BBIO','ARDX','DBVT','RCAT','ACMR',
  'SMCI','HIMS','SAVA','UPST','AFRM','OPEN','CLOV','MLGO','RGTI','FAT','LAZR'
];

// All 7 scenarios with their exact parameters
const SCENARIOS = {
  A: { label:'A', full:'Long +2% / -0.5%',  dir:'long',  gapDir:'up',   gapMin:0.02, gapMax:null,  rvolMin:null, tp:0.020, sl:0.005, be:20.0, color:'#34d399' },
  B: { label:'B', full:'Long +3% / -0.5%',  dir:'long',  gapDir:'up',   gapMin:0.02, gapMax:null,  rvolMin:null, tp:0.030, sl:0.005, be:14.3, color:'#60a5fa' },
  C: { label:'C', full:'Long +4% / -0.5%',  dir:'long',  gapDir:'up',   gapMin:0.02, gapMax:null,  rvolMin:null, tp:0.040, sl:0.005, be:11.1, color:'#a78bfa' },
  D: { label:'D', full:'Short -2% / +0.5%', dir:'short', gapDir:'up',   gapMin:0.02, gapMax:null,  rvolMin:null, tp:0.020, sl:0.005, be:20.0, color:'#fb923c' },
  E: { label:'E', full:'Short -2% / +2%',   dir:'short', gapDir:'up',   gapMin:0.10, gapMax:null,  rvolMin:null, tp:0.020, sl:0.020, be:50.0, color:'#fb7185' },
  G: { label:'G', full:'Long +3% / -3%',    dir:'long',  gapDir:'down', gapMin:null, gapMax:-0.08, rvolMin:3,    tp:0.030, sl:0.030, be:50.0, color:'#fbbf24' },
  H: { label:'H', full:'Long +3% / -5%',    dir:'long',  gapDir:'down', gapMin:null, gapMax:-0.10, rvolMin:4,    tp:0.030, sl:0.050, be:62.5, color:'#f97316' },
};

const SIGS = [
  { key:'gap',       label:'Gap %',    max:20, color:'#60a5fa' },
  { key:'rvol',      label:'RVOL',     max:20, color:'#34d399' },
  { key:'momentum',  label:'Momentum', max:15, color:'#fbbf24' },
  { key:'catalyst',  label:'Catalyst', max:24, color:'#a78bfa' },
  { key:'marketCtx', label:'Mkt Ctx',  max:10, color:'#fb923c' },
];

const CHUNK = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getDailyBars(ticker, from, to) {
  const r = await fetch(`/api/backtest-daily?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getFMPData(ticker) {
  const r = await fetch(`/api/backtest-fmp?ticker=${encodeURIComponent(ticker)}`);
  if (!r.ok) return { earns:[], analysts:[] };
  return r.json();
}

const scoreGap = g => { const a=Math.abs(g); return a>=.15?20:a>=.10?17:a>=.07?14:a>=.05?10:a>=.03?6:a>=.02?3:0; };
const scoreRVOL = r => r>=5?20:r>=3?15:r>=2?10:r>=1.5?5:0;
const scoreMktCtx = g => g>.005?10:g>.002?7:g>-.002?5:g>-.005?2:0;

function scoreMomentum(gap, prior5) {
  const same=(gap>=0)===(prior5>=0), str=Math.abs(prior5);
  return same?(str>.08?15:str>.04?12:8):(str>.08?0:str>.04?3:5);
}

function scoreCatalyst(earns, analysts, dateStr) {
  const dt=new Date(dateStr).getTime(); let s=0;
  for (const e of (earns||[])) {
    const diff=Math.abs(new Date(e.date).getTime()-dt)/86400000;
    if(diff>2) continue;
    const actual=e.actualEarningResult??e.eps, est=e.estimatedEarning??e.epsEstimated;
    if(actual==null||est==null||est===0) continue;
    const beat=(actual-est)/Math.abs(est);
    s=Math.max(s,beat>.20?24:beat>.10?18:beat>0?12:beat>-.10?5:0);
  }
  for (const r of (analysts||[])) {
    if(s>=12) break;
    const diff=Math.abs(new Date(r.publishedDate||r.date||'').getTime()-dt)/86400000;
    if(diff>7||isNaN(diff)) continue;
    const a=(r.newGrade||r.action||'').toLowerCase();
    if(a.includes('buy')||a.includes('upgrade')||a.includes('outperform')) s=Math.max(s,10);
  }
  return s;
}

function evalTrade(bar, dir, tp, sl, entry) {
  // entry = pre-market price if available, else daily open
  const e = entry || bar.o;
  const{h,l}=bar; if(!e||e===0) return 'unknown';
  const up=(h-e)/e, down=(e-l)/e;
  const hitW=dir==='long'?up>=tp:down>=tp;
  const hitS=dir==='long'?down>=sl:up>=sl;
  if(hitW&&!hitS) return 'win'; if(hitS&&!hitW) return 'loss';
  if(hitW&&hitS)  return 'ambiguous'; return 'timeout';
}

function qualifyScenarios(gap, rvol) {
  const q=[];
  if(gap>=0.02)                              { q.push('A'); q.push('B'); q.push('C'); q.push('D'); }
  if(gap>=0.10)                               q.push('E');
  if(gap<=-0.08 && rvol>=3)                   q.push('G');
  if(gap<=-0.10 && rvol>=4)                   q.push('H');
  return q;
}

function calcStats(trades, sc) {
  const scenTrades = trades.filter(t=>t.scenario===sc);
  const ok = t=>t.outcome!=='ambiguous'&&t.outcome!=='unknown';
  const valid = scenTrades.filter(ok);
  const wins  = valid.filter(t=>t.outcome==='win');
  const losses = valid.filter(t=>t.outcome==='loss');
  const { tp, sl } = SCENARIOS[sc];

  const wr = valid.length>=5 ? wins.length/valid.length : null;
  const grossWin  = wins.length * tp;
  const grossLoss = losses.length * sl;
  const pf = grossLoss > 0 ? grossWin/grossLoss : (grossWin > 0 ? Infinity : null);
  // Total return: sum of P&L as % per $1 risked per trade (flat sizing)
  const totalReturn = valid.length > 0 ? (wins.length*tp - losses.length*sl) : null;

  const sigStats = SIGS.map(sig => {
    const tiers=[0,1,2].map(i=>{
      const lo=sig.max/3*i, hi=sig.max/3*(i+1)+.01;
      const inT=valid.filter(t=>t.sigs[sig.key]>=lo&&t.sigs[sig.key]<hi);
      const wrT=inT.length>=5?inT.filter(t=>t.outcome==='win').length/inT.length:null;
      return{label:['Low','Med','High'][i],wr:wrT,n:inT.length};
    });
    const lp=tiers[2].wr!=null&&tiers[0].wr!=null?tiers[2].wr-tiers[0].wr:0;
    return{...sig,tiers,power:lp};
  });

  const wrFn = arr => arr.length<5?null:arr.filter(t=>t.outcome==='win').length/arr.length;
  const pairs=[];
  for(let i=0;i<SIGS.length;i++) for(let j=i+1;j<SIGS.length;j++){
    const a=SIGS[i],b=SIGS[j];
    const hi=t=>t.sigs[a.key]>=a.max*2/3&&t.sigs[b.key]>=b.max*2/3;
    const bH=valid.filter(hi);
    if(bH.length<5) continue;
    pairs.push({label:`${a.label}+${b.label}`,wr:wrFn(bH),n:bH.length});
  }
  pairs.sort((a,b)=>(b.wr||0)-(a.wr||0));

  return {
    wr, pf, totalReturn,
    winsN:wins.length, lossesN:losses.length,
    validN:valid.length, totalN:scenTrades.length,
    ambiguous:scenTrades.filter(t=>t.outcome==='ambiguous').length,
    sigStats, pairs:pairs.slice(0,8),
  };
}

export default function BacktestPage() {
  const [tab,     setTab]     = useState('setup');
  const [log,     setLog]     = useState([]);
  const [prog,    setProg]    = useState({ msg:'', pct:0 });
  const [results, setResults] = useState(null);
  const [partial, setPartial] = useState(false);
  const [running, setRunning] = useState(false);
  const [scen,    setScen]    = useState('A');
  const cancelRef = useRef(false);
  const logRef    = useRef([]);

  const addLog = msg => { logRef.current=[...logRef.current.slice(-200),msg]; setLog([...logRef.current]); };

  const updateResults = (trades, done, total, isFinal) => {
    const r={};
    Object.keys(SCENARIOS).forEach(k=>{ r[k]=calcStats(trades,k); });
    setResults({...r, tickersDone:done, totalTickers:total, isFinal});
    setPartial(!isFinal);
  };

  const run = useCallback(async () => {
    cancelRef.current=false;
    setRunning(true); setTab('running');
    setResults(null); setPartial(false);
    logRef.current=[]; setLog([]);

    const FROM='2024-03-01', TO='2025-03-01';
    const allTrades=[];

    try {
      setProg({msg:'Fetching SPY...',pct:1});
      addLog('↓ SPY...');
      const spyBars=await getDailyBars('SPY',FROM,TO);
      await sleep(150);
      const spyMap={};
      spyBars.forEach((b,i)=>{ const d=new Date(b.t).toISOString().slice(0,10); const p=spyBars[i-1]; if(p) spyMap[d]=(b.o-p.c)/p.c; });
      addLog(`✓ SPY: ${spyBars.length} days`);

      for(let ti=0;ti<TICKERS.length;ti++){
        if(cancelRef.current) break;
        const ticker=TICKERS[ti], done=ti+1;
        setProg({msg:`${ticker} (${done}/${TICKERS.length})`,pct:2+Math.round(ti/TICKERS.length*88)});

        let bars;
        try { addLog(`↓ ${ticker}...`); bars=await getDailyBars(ticker,FROM,TO); await sleep(150); }
        catch(e){ addLog(`✗ ${ticker}: ${e.message}`); continue; }
        if(!bars||bars.length<25){ addLog(`⚠ ${ticker}: no data`); continue; }

        let earns=[],analysts=[];
        try{ const f=await getFMPData(ticker); earns=f.earns||[]; analysts=f.analysts||[]; await sleep(150); } catch(e){}

        const vols=bars.map(b=>b.v||0);
        let n=0;
        for(let di=25;di<bars.length;di++){
          const bar=bars[di], prev=bars[di-1];
          const entry=bar.pmPrice||bar.o; // pre-market price at ~9:29 AM, else daily open
          if(!entry||!prev.c||prev.c===0) continue;
          const gap=(entry-prev.c)/prev.c;
          const avgVol=vols.slice(Math.max(0,di-20),di).reduce((a,b)=>a+b,0)/Math.min(20,di);
          const rvol=avgVol>0?(bar.v||0)/avgVol:1;

          const qualifying=qualifyScenarios(gap,rvol);
          if(!qualifying.length) continue;

          const date=new Date(bar.t).toISOString().slice(0,10);
          const prior5=di>=5?(prev.c-bars[di-5].c)/bars[di-5].c:0;
          const sigs={
            gap:scoreGap(gap), rvol:scoreRVOL(rvol), momentum:scoreMomentum(gap,prior5),
            catalyst:scoreCatalyst(earns,analysts,date), marketCtx:scoreMktCtx(spyMap[date]||0),
          };
          const total=Object.values(sigs).reduce((a,b)=>a+b,0);
          const base={ticker,date,gap:(gap*100).toFixed(1),rvolN:rvol.toFixed(1),sigs,total};

          for(const sc of qualifying){
            const{dir,tp,sl}=SCENARIOS[sc];
            allTrades.push({...base,scenario:sc,dir,outcome:evalTrade(bar,dir,tp,sl,entry)});
          }
          n++;
        }
        addLog(`✓ ${ticker}: ${n} qualifying days`);

        if(done%CHUNK===0||done===TICKERS.length){
          const isFinal=done===TICKERS.length;
          addLog(`\n📊 Interim — ${done}/${TICKERS.length} tickers (${allTrades.length} trades)\n`);
          updateResults([...allTrades],done,TICKERS.length,isFinal);
        }
      }

      setProg({msg:'Complete',pct:100});
      addLog(`✅ Done — ${allTrades.length} total trades`);
      setTab('results');

    } catch(e){ addLog(`\n💥 ${e.message}`); }
    finally{ setRunning(false); }
  },[]);

  // Formatters
  const pct   = v => v===null?'—':`${(v*100).toFixed(1)}%`;
  const pfmt  = v => v===null?'—':v===Infinity?'∞':`${v.toFixed(2)}x`;
  const ret   = v => v===null?'—':`${v>0?'+':''}${(v*100).toFixed(1)}%`;
  const col   = v => v===null?'#4b5563':v>=.65?'#34d399':v>=.52?'#fbbf24':'#f87171';
  const retcol= v => v===null?'#4b5563':v>0?'#34d399':v<0?'#f87171':'#9ca3af';
  const pp    = v => `${v>0?'+':''}${(v*100).toFixed(0)}pp`;
  const ppCol = v => Math.abs(v*100)>=10?(v>0?'#34d399':'#f87171'):'#9ca3af';

  const C={
    page: {background:'#0d0d0d',color:'#e5e7eb',minHeight:'100vh',fontFamily:'monospace',padding:'16px',fontSize:'12px'},
    card: {background:'#111827',border:'1px solid #1f2937',borderRadius:'6px',padding:'14px'},
    tabBtn:on=>({padding:'4px 12px',background:on?'#1e3a5f':'transparent',border:`1px solid ${on?'#1d4ed8':'#1f2937'}`,borderRadius:'4px',color:on?'#93c5fd':'#6b7280',cursor:'pointer',fontSize:'11px',textTransform:'uppercase'}),
    th:   {padding:'6px 10px',color:'#6b7280',fontWeight:'normal',textAlign:'left',borderBottom:'1px solid #1f2937',fontSize:'11px'},
    td:   {padding:'7px 10px',borderBottom:'1px solid #0d0d0d'},
    num:  v=>({padding:'7px 10px',borderBottom:'1px solid #0d0d0d',textAlign:'center',color:col(v)}),
  };

  const tabLabel = t => {
    if(t==='results'&&results&&running) return `📊 Results (${results.tickersDone}/${results.totalTickers})`;
    if(t==='results'&&results) return '📊 Results ✓';
    return {setup:'⚙ Setup',running:'▶ Running',results:'📊 Results'}[t];
  };

  const r = results && results[scen];

  return (
    <div style={C.page}>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #1f2937',paddingBottom:'12px',marginBottom:'16px'}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
            <a href="/" style={{color:'#4b5563',fontSize:'11px',textDecoration:'none'}}>← APEX</a>
            <div style={{fontSize:'16px',fontWeight:'bold',color:'#f9fafb'}}>◈ Signal Correlation Backtester</div>
          </div>
          <div style={{fontSize:'10px',color:'#4b5563',marginTop:'2px'}}>41 tickers · 5 signals · Mar 2024–Mar 2025 · Scenarios A B C D E G H</div>
        </div>
        <div style={{display:'flex',gap:'6px',alignItems:'center'}}>
          {['setup','running','results'].map(t=>(
            <button key={t} style={C.tabBtn(tab===t)} onClick={()=>setTab(t)}>{tabLabel(t)}</button>
          ))}
          {running&&<span style={{fontSize:'10px',color:'#fbbf24',marginLeft:'4px'}}>● LIVE</span>}
        </div>
      </div>

      {/* SETUP */}
      {tab==='setup'&&(
        <div style={{maxWidth:'580px',display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{...C.card,borderColor:'#064e3b',background:'#022c22'}}>
            <div style={{fontSize:'11px',color:'#34d399'}}>✓ API keys loaded from environment. Interim results every {CHUNK} tickers.</div>
          </div>
          <div style={C.card}>
            <div style={{color:'#6b7280',fontSize:'10px',marginBottom:'10px',textTransform:'uppercase',letterSpacing:'1px'}}>Scenarios</div>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'11px'}}>
              <thead>
                <tr style={{borderBottom:'1px solid #1f2937'}}>
                  {['Scenario','Direction','Entry','TP','SL','Breakeven WR'].map(h=>(
                    <th key={h} style={{...C.th,padding:'4px 8px'}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(SCENARIOS).map(([k,s])=>(
                  <tr key={k} style={{borderBottom:'1px solid #111827'}}>
                    <td style={{...C.td,padding:'6px 8px'}}><span style={{color:s.color,fontWeight:'bold'}}>{k}</span></td>
                    <td style={{...C.td,padding:'6px 8px',color:s.dir==='long'?'#34d399':'#fb7185'}}>{s.dir}</td>
                    <td style={{...C.td,padding:'6px 8px',color:'#9ca3af'}}>
                      {s.gapDir==='up'?`gap ≥${(s.gapMin*100).toFixed(0)}%`:`gap ≤${(s.gapMax*100).toFixed(0)}%${s.rvolMin?` RVOL≥${s.rvolMin}x`:''}`}
                    </td>
                    <td style={{...C.td,padding:'6px 8px',color:'#34d399'}}>+{(s.tp*100).toFixed(1)}%</td>
                    <td style={{...C.td,padding:'6px 8px',color:'#f87171'}}>-{(s.sl*100).toFixed(1)}%</td>
                    <td style={{...C.td,padding:'6px 8px',color:'#9ca3af'}}>{s.be.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button onClick={run} disabled={running}
            style={{padding:'10px',background:running?'#1f2937':'#1d4ed8',border:'none',borderRadius:'4px',color:running?'#6b7280':'#fff',cursor:running?'default':'pointer',fontSize:'13px',fontWeight:'bold'}}>
            {running?'⟳ Running...':'▶ Run Backtest — 7 Scenarios · Results every 10 tickers'}
          </button>
        </div>
      )}

      {/* RUNNING */}
      {tab==='running'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>Progress</div>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:'6px'}}>
              <span style={{color:'#9ca3af',fontSize:'11px'}}>{prog.msg}</span>
              <span style={{color:'#f9fafb',fontWeight:'bold'}}>{prog.pct}%</span>
            </div>
            <div style={{background:'#0f172a',borderRadius:'4px',height:'4px',marginBottom:'10px'}}>
              <div style={{height:'4px',background:'#1d4ed8',borderRadius:'4px',width:`${prog.pct}%`,transition:'width .3s'}}/>
            </div>
            <div style={{height:'400px',overflowY:'auto',fontSize:'11px',lineHeight:'1.7'}}>
              {log.map((l,i)=>(
                <div key={i} style={{color:l.startsWith('✓')?'#374151':l.startsWith('✗')?'#7f1d1d':l.startsWith('📊')?'#3b82f6':l.startsWith('✅')?'#065f46':'#6b7280'}}>{l}</div>
              ))}
            </div>
            {running&&<button onClick={()=>{cancelRef.current=true;}} style={{marginTop:'8px',padding:'4px 12px',background:'#7f1d1d',border:'none',borderRadius:'3px',color:'#fca5a5',cursor:'pointer',fontSize:'11px'}}>Cancel</button>}
          </div>

          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>
              Live Overview {results?`— ${results.tickersDone}/${results.totalTickers} tickers`:'— waiting...'}
            </div>
            {!results&&<div style={{color:'#374151',textAlign:'center',paddingTop:'30px',fontSize:'11px'}}>Results after first {CHUNK} tickers...</div>}
            {results&&(
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr 1fr',gap:'6px'}}>
                {Object.entries(SCENARIOS).map(([k,s])=>{
                  const r=results[k];
                  return(
                    <div key={k} style={{background:'#0f172a',border:`1px solid ${s.color}33`,borderRadius:'4px',padding:'8px',textAlign:'center'}}>
                      <div style={{color:s.color,fontWeight:'bold',fontSize:'13px'}}>{k}</div>
                      <div style={{fontSize:'18px',fontWeight:'bold',color:col(r.wr),lineHeight:'1.2',marginTop:'2px'}}>{pct(r.wr)}</div>
                      <div style={{fontSize:'9px',color:retcol(r.totalReturn),marginTop:'2px'}}>{ret(r.totalReturn)}</div>
                      <div style={{fontSize:'9px',color:'#4b5563'}}>PF {pfmt(r.pf)}</div>
                      <div style={{fontSize:'9px',color:'#374151'}}>n={r.validN}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* RESULTS */}
      {tab==='results'&&results&&(
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          {partial&&(
            <div style={{background:'#1c1a00',border:'1px solid #713f12',borderRadius:'6px',padding:'8px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{color:'#fbbf24',fontSize:'11px'}}>⟳ Partial — {results.tickersDone}/{results.totalTickers} tickers. Auto-updates every {CHUNK}.</span>
              <span style={{color:'#713f12',fontSize:'10px'}}>Switch to ▶ Running for progress</span>
            </div>
          )}

          {/* Summary table — all scenarios at once */}
          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'10px',textTransform:'uppercase',letterSpacing:'1px'}}>All Scenarios — Summary</div>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:'11px'}}>
              <thead>
                <tr style={{borderBottom:'1px solid #1f2937'}}>
                  {['Scenario','Setup','Win Rate','Prof. Factor','Total Return','Wins','Losses','Trades'].map(h=>(
                    <th key={h} style={C.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(SCENARIOS).map(([k,s])=>{
                  const r=results[k];
                  return(
                    <tr key={k} style={{borderBottom:'1px solid #111827',background:scen===k?'#0f172a':'transparent',cursor:'pointer'}}
                      onClick={()=>setScen(k)}>
                      <td style={{...C.td,fontWeight:'bold'}}><span style={{color:s.color}}>{k}</span></td>
                      <td style={{...C.td,color:'#6b7280'}}>{s.full}</td>
                      <td style={{...C.td,color:col(r.wr),textAlign:'center',fontWeight:'bold'}}>{pct(r.wr)}</td>
                      <td style={{...C.td,color:r.pf&&r.pf>1?'#34d399':r.pf===null?'#4b5563':'#f87171',textAlign:'center'}}>{pfmt(r.pf)}</td>
                      <td style={{...C.td,color:retcol(r.totalReturn),textAlign:'center',fontWeight:'bold'}}>{ret(r.totalReturn)}</td>
                      <td style={{...C.td,color:'#34d399',textAlign:'center'}}>{r.winsN}</td>
                      <td style={{...C.td,color:'#f87171',textAlign:'center'}}>{r.lossesN}</td>
                      <td style={{...C.td,color:'#6b7280',textAlign:'center'}}>{r.validN}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{fontSize:'10px',color:'#374151',marginTop:'6px'}}>Click a row to drill into signal analysis. Total Return = flat sizing, sum of (wins×TP − losses×SL).</div>
          </div>

          {/* Scenario selector */}
          <div style={{display:'flex',gap:'6px'}}>
            {Object.entries(SCENARIOS).map(([k,s])=>(
              <button key={k} onClick={()=>setScen(k)}
                style={{padding:'5px 12px',background:scen===k?s.color+'22':'transparent',border:`1px solid ${scen===k?s.color:'#1f2937'}`,borderRadius:'4px',color:scen===k?s.color:'#6b7280',cursor:'pointer',fontSize:'11px',fontWeight:scen===k?'bold':'normal'}}>
                {k}
              </button>
            ))}
          </div>

          {r&&(
            <>
              {/* Signal tier table for selected scenario */}
              <div style={C.card}>
                <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase',letterSpacing:'1px'}}>
                  Scenario <span style={{color:SCENARIOS[scen].color}}>{scen}</span> — Signal Tier Analysis
                  <span style={{color:'#374151',marginLeft:'8px',fontWeight:'normal',textTransform:'none'}}>({SCENARIOS[scen].full})</span>
                </div>
                {(scen==='G'||scen==='H')&&(
                  <div style={{fontSize:'10px',color:'#713f12',background:'#1c1200',padding:'6px 8px',borderRadius:'3px',marginBottom:'8px'}}>
                    ℹ Gap-down setup: LOW Momentum = counter-trend gap = better reversal candidate. LOW Catalyst = no fundamental driver = gap may be overreaction.
                  </div>
                )}
                <table style={{width:'100%',borderCollapse:'collapse'}}>
                  <thead>
                    <tr>
                      <th style={C.th}>Signal</th>
                      <th style={{...C.th,textAlign:'center',color:'#374151'}}>LOW</th>
                      <th style={{...C.th,textAlign:'center',color:'#374151'}}>MED</th>
                      <th style={{...C.th,textAlign:'center',color:'#374151'}}>HIGH</th>
                      <th style={{...C.th,textAlign:'center',color:SCENARIOS[scen].color}}>Δ (H−L)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.sigStats.map(sig=>(
                      <tr key={sig.key}>
                        <td style={C.td}>
                          <span style={{display:'inline-block',width:'8px',height:'8px',borderRadius:'50%',background:sig.color,marginRight:'6px'}}/>
                          {sig.label}
                        </td>
                        {sig.tiers.map((tier,i)=>(
                          <td key={i} style={C.num(tier.wr)}>
                            {pct(tier.wr)}<span style={{color:'#374151',fontSize:'9px'}}> ({tier.n})</span>
                          </td>
                        ))}
                        <td style={{...C.td,textAlign:'center',color:ppCol(sig.power)}}>{pp(sig.power)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{fontSize:'10px',color:'#374151',marginTop:'6px'}}>Δ = High tier WR − Low tier WR · Green ≥65% · Yellow ≥52% · Red &lt;52% · — = &lt;5 trades</div>
              </div>

              {/* Power chart + Pairs */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
                <div style={C.card}>
                  <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>
                    Scenario {scen} — Signal Predictive Power (Δ pp)
                  </div>
                  <ResponsiveContainer width="100%" height={160}>
                    <BarChart data={[...r.sigStats].sort((a,b)=>Math.abs(b.power)-Math.abs(a.power)).map(s=>({name:s.label,v:+(s.power*100).toFixed(0),color:s.color}))}
                      layout="vertical" margin={{left:5,right:24,top:0,bottom:0}}>
                      <XAxis type="number" tick={{fill:'#4b5563',fontSize:9}} tickFormatter={v=>`${v}pp`}/>
                      <YAxis type="category" dataKey="name" tick={{fill:'#9ca3af',fontSize:11}} width={58}/>
                      <Tooltip formatter={v=>[`${v}pp`,'High−Low spread']} contentStyle={{background:'#111827',border:'1px solid #1f2937',fontSize:'11px',color:'#e5e7eb'}}/>
                      <Bar dataKey="v" radius={[0,3,3,0]}>
                        {[...r.sigStats].sort((a,b)=>Math.abs(b.power)-Math.abs(a.power)).map((d,i)=>(
                          <Cell key={i} fill={d.power>0?d.color:'#374151'}/>
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div style={C.card}>
                  <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>Top Signal Pairs — Both High Tier</div>
                  {r.pairs.length===0&&<div style={{color:'#374151',fontSize:'11px',paddingTop:'10px'}}>Not enough data yet...</div>}
                  {r.pairs.map(p=>(
                    <div key={p.label} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'5px 0',borderBottom:'1px solid #0d0d0d'}}>
                      <span style={{color:'#d1d5db',fontSize:'11px'}}>{p.label}</span>
                      <div style={{display:'flex',gap:'10px',fontSize:'11px'}}>
                        <span style={{color:col(p.wr),fontWeight:'bold'}}>{pct(p.wr)}</span>
                        <span style={{color:'#4b5563'}}>n={p.n}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {tab==='results'&&!results&&(
        <div style={{color:'#4b5563',textAlign:'center',padding:'60px'}}>Run the backtest to see results.</div>
      )}
    </div>
  );
}
