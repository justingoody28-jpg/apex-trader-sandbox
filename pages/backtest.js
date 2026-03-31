import { useState, useCallback, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

const TICKERS = [
  'MRNA','GFAI','FCEL','TSLA','COIN','NVCR','HOOD','ATEN','LPSN','HALO',
  'FRPT','SG','ASTE','APOG','ARCB','MATX','AGEN','RCKT','ATER','RRGB',
  'RIOT','MARA','SNDX','MNMD','RXRX','BBIO','ARDX','DBVT','RCAT','ACMR',
  'SMCI','HIMS','SAVA','UPST','AFRM','OPEN','CLOV','MLGO','RGTI','FAT','LAZR'
];

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
  const res = await fetch(`/api/backtest-daily?ticker=${encodeURIComponent(ticker)}&from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getFMPData(ticker) {
  const res = await fetch(`/api/backtest-fmp?ticker=${encodeURIComponent(ticker)}`);
  if (!res.ok) return { earns: [], analysts: [] };
  return res.json();
}

// --- Signal scorers ---
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
function evalTrade(bar, dir, win, stop) {
  const{o,h,l}=bar; if(!o||o===0) return 'unknown';
  const up=(h-o)/o, down=(o-l)/o;
  const hitW=dir==='long'?up>=win:down>=win;
  const hitS=dir==='long'?down>=stop:up>=stop;
  if(hitW&&!hitS) return 'win'; if(hitS&&!hitW) return 'loss';
  if(hitW&&hitS) return 'ambiguous'; return 'timeout';
}

function analyze(trades) {
  const wr=arr=>arr.length<5?null:arr.filter(t=>t.outcome==='win').length/arr.length;
  const ok=t=>t.outcome!=='ambiguous'&&t.outcome!=='unknown';
  const L=trades.filter(t=>t.dir==='long'&&ok(t));
  const S=trades.filter(t=>t.dir==='short'&&ok(t));
  const sigStats=SIGS.map(sig=>{
    const tiers=[0,1,2].map(i=>{
      const lo=sig.max/3*i,hi=sig.max/3*(i+1)+.01;
      const iL=L.filter(t=>t.sigs[sig.key]>=lo&&t.sigs[sig.key]<hi);
      const iS=S.filter(t=>t.sigs[sig.key]>=lo&&t.sigs[sig.key]<hi);
      return{label:['Low','Med','High'][i],longWR:wr(iL),shortWR:wr(iS),longN:iL.length,shortN:iS.length};
    });
    const lp=tiers[2].longWR!=null&&tiers[0].longWR!=null?tiers[2].longWR-tiers[0].longWR:0;
    const sp=tiers[2].shortWR!=null&&tiers[0].shortWR!=null?tiers[2].shortWR-tiers[0].shortWR:0;
    return{...sig,tiers,longPower:lp,shortPower:sp};
  });
  const pairs=[];
  for(let i=0;i<SIGS.length;i++) for(let j=i+1;j<SIGS.length;j++){
    const a=SIGS[i],b=SIGS[j];
    const hi=t=>t.sigs[a.key]>=a.max*2/3&&t.sigs[b.key]>=b.max*2/3;
    const bL=L.filter(hi),bS=S.filter(hi);
    if(bL.length<5&&bS.length<5) continue;
    pairs.push({label:`${a.label}+${b.label}`,longWR:wr(bL),shortWR:wr(bS),longN:bL.length,shortN:bS.length});
  }
  pairs.sort((a,b)=>Math.max(b.longWR||0,b.shortWR||0)-Math.max(a.longWR||0,a.shortWR||0));
  return{
    sigStats,pairs:pairs.slice(0,10),
    baseline:{longWR:wr(L),shortWR:wr(S),longN:L.length,shortN:S.length},
    ambiguous:trades.filter(t=>t.outcome==='ambiguous').length,
    total:trades.length,
  };
}

export default function BacktestPage() {
  const [minGap,  setMinGap]  = useState(3);
  const [lWin,    setLWin]    = useState(2);
  const [lStop,   setLStop]   = useState(0.5);
  const [sWin,    setSWin]    = useState(2);
  const [sStop,   setSStop]   = useState(2);
  const [tab,     setTab]     = useState('setup');
  const [log,     setLog]     = useState([]);
  const [prog,    setProg]    = useState({ msg:'', pct:0, tickersDone:0 });
  const [result,  setResult]  = useState(null);
  const [partial, setPartial] = useState(false);
  const [running, setRunning] = useState(false);
  const cancelRef = useRef(false);
  const logRef    = useRef([]);
  const tradesRef = useRef([]);

  const addLog = msg => {
    logRef.current = [...logRef.current.slice(-200), msg];
    setLog([...logRef.current]);
  };

  const updateResults = (trades, done, total, isFinal) => {
    const res = analyze(trades);
    setResult({ ...res, tickersDone: done, totalTickers: total, isFinal });
    setPartial(!isFinal);
  };

  const run = useCallback(async () => {
    cancelRef.current = false;
    tradesRef.current = [];
    setRunning(true); setTab('running');
    setResult(null); setPartial(false);
    logRef.current=[]; setLog([]);

    const FROM='2024-03-01', TO='2025-03-01';
    const allTrades = [];

    try {
      setProg({ msg:'Fetching SPY baseline...', pct:1, tickersDone:0 });
      addLog('↓ SPY...');
      const spyBars = await getDailyBars('SPY', FROM, TO);
      await sleep(150);
      const spyMap={};
      spyBars.forEach((b,i)=>{
        const d=new Date(b.t).toISOString().slice(0,10);
        const prev=spyBars[i-1];
        if(prev) spyMap[d]=(b.o-prev.c)/prev.c;
      });
      addLog(`✓ SPY: ${spyBars.length} days`);

      for (let ti=0; ti<TICKERS.length; ti++) {
        if(cancelRef.current) break;
        const ticker=TICKERS[ti];
        const done=ti+1;
        setProg({ msg:`${ticker} (${done}/${TICKERS.length})`, pct:2+Math.round(ti/TICKERS.length*88), tickersDone:done });

        let bars;
        try {
          addLog(`↓ ${ticker}...`);
          bars = await getDailyBars(ticker, FROM, TO);
          await sleep(150);
        } catch(e) { addLog(`✗ ${ticker}: ${e.message}`); continue; }
        if(!bars||bars.length<25){ addLog(`⚠ ${ticker}: no data`); continue; }

        let earns=[],analysts=[];
        try {
          const fmp=await getFMPData(ticker);
          earns=fmp.earns||[]; analysts=fmp.analysts||[];
          await sleep(150);
        } catch(e){}

        const vols=bars.map(b=>b.v||0);
        let n=0;
        for(let di=25;di<bars.length;di++){
          const bar=bars[di],prev=bars[di-1];
          if(!bar.o||!prev.c||prev.c===0) continue;
          const gap=(bar.o-prev.c)/prev.c;
          if(gap<minGap/100) continue;
          const date=new Date(bar.t).toISOString().slice(0,10);
          const avgVol=vols.slice(Math.max(0,di-20),di).reduce((a,b)=>a+b,0)/Math.min(20,di);
          const rvol=avgVol>0?(bar.v||0)/avgVol:1;
          const prior5=di>=5?(prev.c-bars[di-5].c)/bars[di-5].c:0;
          const sigs={
            gap:scoreGap(gap),rvol:scoreRVOL(rvol),momentum:scoreMomentum(gap,prior5),
            catalyst:scoreCatalyst(earns,analysts,date),marketCtx:scoreMktCtx(spyMap[date]||0),
          };
          const total=Object.values(sigs).reduce((a,b)=>a+b,0);
          const base={ticker,date,gap:(gap*100).toFixed(1),rvolN:rvol.toFixed(1),sigs,total};
          allTrades.push({...base,dir:'long', outcome:evalTrade(bar,'long', lWin/100,lStop/100)});
          allTrades.push({...base,dir:'short',outcome:evalTrade(bar,'short',sWin/100,sStop/100)});
          n++;
        }
        addLog(`✓ ${ticker}: ${n} gap days → ${allTrades.length} total trades`);

        // Emit partial results every CHUNK tickers
        if(done % CHUNK === 0 || done === TICKERS.length) {
          const isFinal = done === TICKERS.length;
          addLog(`\n📊 Interim analysis — ${done}/${TICKERS.length} tickers (${allTrades.length} trades)\n`);
          updateResults([...allTrades], done, TICKERS.length, isFinal);
        }
      }

      setProg({ msg:'Complete', pct:100, tickersDone:TICKERS.length });
      addLog(`✅ Final: ${allTrades.length} trades across ${TICKERS.length} tickers`);
      setTab('results');

    } catch(e) {
      addLog(`\n💥 ${e.message}`);
      setProg(p=>({...p, msg:`Error: ${e.message}`}));
    } finally { setRunning(false); }
  }, [minGap, lWin, lStop, sWin, sStop]);

  const pct   = v => v===null?'—':`${(v*100).toFixed(0)}%`;
  const col   = v => v===null?'#4b5563':v>=.65?'#34d399':v>=.52?'#fbbf24':'#f87171';
  const pp    = v => `${v>0?'+':''}${(v*100).toFixed(0)}pp`;
  const ppCol = v => Math.abs(v*100)>=10?(v>0?'#34d399':'#f87171'):'#9ca3af';

  const C={
    page: {background:'#0d0d0d',color:'#e5e7eb',minHeight:'100vh',fontFamily:'monospace',padding:'16px',fontSize:'12px'},
    card: {background:'#111827',border:'1px solid #1f2937',borderRadius:'6px',padding:'14px'},
    input:{display:'block',width:'100%',marginTop:'4px',padding:'7px 8px',background:'#0f172a',border:'1px solid #1f2937',borderRadius:'4px',color:'#e5e7eb',fontFamily:'monospace',fontSize:'12px',boxSizing:'border-box'},
    lbl:  {display:'block',color:'#9ca3af',marginBottom:'2px'},
    tabBtn:on=>({padding:'4px 12px',background:on?'#1e3a5f':'transparent',border:`1px solid ${on?'#1d4ed8':'#1f2937'}`,borderRadius:'4px',color:on?'#93c5fd':'#6f7280',cursor:'pointer',fontSize:'11px',textTransform:'uppercase'}),
    th:   {padding:'6px 10px',color:'#6b7280',fontWeight:'normal',textAlign:'left',borderBottom:'1px solid #1f2937',fontSize:'11px'},
    td:   {padding:'7px 10px',borderBottom:'1px solid #0d0d0d'},
    num:  v=>({padding:'7px 10px',borderBottom:'1px solid #0d0d0d',textAlign:'center',color:col(v)}),
  };

  const tabLabel = t => {
    if(t==='results' && result && running) return `📊 Results (${result.tickersDone}/${result.totalTickers})`;
    if(t==='results' && result) return '📊 Results ✓';
    return {setup:'⚙ Setup',running:'▶ Running',results:'📊 Results'}[t];
  };

  return (
    <div style={C.page}>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',borderBottom:'1px solid #1f2937',paddingBottom:'12px',marginBottom:'16px'}}>
        <div>
          <div style={{display:'flex',alignItems:'center',gap:'12px'}}>
            <a href="/" style={{color:'#4b5563',fontSize:'11px',textDecoration:'none'}}>← APEX</a>
            <div style={{fontSize:'16px',fontWeight:'bold',color:'#f9fafb'}}>◈ Signal Correlation Backtester</div>
          </div>
          <div style={{fontSize:'10px',color:'#4b5563',marginTop:'2px'}}>41 tickers · 5 signals · Mar 2024–Mar 2025 · Long + Short · Polygon + FMP via env vars</div>
        </div>
        <div style={{display:'flex',gap:'6px',alignItems:'center'}}>
          {['setup','running','results'].map(t=>(
            <button key={t} style={C.tabBtn(tab===t)} onClick={()=>setTab(t)}>{tabLabel(t)}</button>
          ))}
          {running && <span style={{fontSize:'10px',color:'#fbbf24',marginLeft:'6px',animation:"pulse 1s infinite"}}>● LIVE</span>}
        </div>
      </div>

      {/* SETUP */}
      {tab==='setup' && (
        <div style={{maxWidth:'520px',display:'flex',flexDirection:'column',gap:'14px'}}>
          <div style={{...C.card,borderColor:'#064e3b',background:'#022c22'}}>
            <div style={{fontSize:'11px',color:'#34d399'}}>✓ API keys loaded from environment — Polygon + FMP ready. Interim results every {CHUNK} tickers.</div>
          </div>
          <div style={C.card}>
            <div style={{color:'#6b7280',fontSize:'10px',marginBottom:'10px',textTransform:'uppercase',letterSpacing:'1px'}}>Parameters</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:'8px',marginBottom:'8px'}}>
              <label><span style={C.lbl}>Min Gap (%)</span><input type="number" style={C.input} value={minGap} onChange={e=>setMinGap(+e.target.value)} step=".5"/></label>
              <label><span style={C.lbl}>Long Target (%)</span><input type="number" style={C.input} value={lWin} onChange={e=>setLWin(+e.target.value)} step=".5"/></label>
              <label><span style={C.lbl}>Long Stop (%)</span><input type="number" style={C.input} value={lStop} onChange={e=>setLStop(+e.target.value)} step=".5"/></label>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'8px'}}>
              <label><span style={C.lbl}>Short Target (%)</span><input type="number" style={C.input} value={sWin} onChange={e=>setSWin(+e.target.value)} step=".5"/></label>
              <label><span style={C.lbl}>Short Stop (%)</span><input type="number" style={C.input} value={sStop} onChange={e=>setSStop(+e.target.value)} step=".5"/></label>
            </div>
          </div>
          <button onClick={run} disabled={running}
            style={{padding:'10px',background:running?'#1f2937':'#1d4ed8',border:'none',borderRadius:'4px',color:running?'#6b7280':'#fff',cursor:running?'default':'pointer',fontSize:'13px',fontWeight:'bold'}}>
            {running?'⟳ Running...':'▶ Run Backtest — Results preview every 10 tickers'}
          </button>
        </div>
      )}

      {/* RUNNING */}
      {tab==='running' && (
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
          {/* Log panel */}
          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>Progress Log</div>
            <div style={{display:'flex',justifyContent:'space-between',marginBottom:'6px'}}>
              <span style={{color:'#9ca3af',fontSize:'11px'}}>{prog.msg}</span>
              <span style={{color:'#f9fafb',fontWeight:'bold'}}>{prog.pct}%</span>
            </div>
            <div style={{background:'#0f172a',borderRadius:'4px',height:'4px',marginBottom:'10px'}}>
              <div style={{height:'4px',background:'#1d4ed8',borderRadius:'4px',width:`${prog.pct}%`,transition:'width .3s'}}/>
            </div>
            <div style={{height:'400px',overflowY:'auto',fontSize:'11px',color:'#6b7280',lineHeight:'1.7'}}>
              {log.map((l,i)=><div key={i} style={{color:l.startsWith('✓')?'#4b5563':l.startsWith('✗')?'#7f1d1d':l.startsWith('📊')?'#3b82f6':l.startsWith('✅')?'#065f46':'#6b7280'}}>{l}</div>)}
            </div>
            {running&&<button onClick={()=>{cancelRef.current=true;}} style={{marginTop:'8px',padding:'4px 12px',background:'#7f1d1d',border:'none',borderRadius:'3px',color:'#fca5a5',cursor:'pointer',fontSize:'11px'}}>Cancel</button>}
          </div>

          {/* Live mini-results */}
          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>
              Live Signal Preview {result ? `— ${result.tickersDone}/${result.totalTickers} tickers` : '— waiting...'}
            </div>
            {!result && <div style={{color:'#374151',fontSize:'11px',paddingTop:'20px',textAlign:'center'}}>Results appear after first {CHUNK} tickers...</div>}
            {result && (
              <>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px',marginBottom:'10px'}}>
                  <div style={{background:'#0f172a',borderRadius:'4px',padding:'8px'}}>
                    <div style={{fontSize:'9px',color:'#6b7280'}}>BASELINE LONG WR</div>
                    <div style={{fontSize:'18px',fontWeight:'bold',color:col(result.baseline.longWR)}}>{pct(result.baseline.longWR)}</div>
                    <div style={{fontSize:'9px',color:'#374151'}}>n={result.baseline.longN}</div>
                  </div>
                  <div style={{background:'#0f172a',borderRadius:'4px',padding:'8px'}}>
                    <div style={{fontSize:'9px',color:'#6b7280'}}>BASELINE SHORT WR</div>
                    <div style={{fontSize:'18px',fontWeight:'bold',color:col(result.baseline.shortWR)}}>{pct(result.baseline.shortWR)}</div>
                    <div style={{fontSize:'9px',color:'#374151'}}>n={result.baseline.shortN}</div>
                  </div>
                </div>
                {/* Mini signal power bars */}
                <div style={{fontSize:'9px',color:'#6b7280',marginBottom:'4px',textTransform:'uppercase'}}>Signal Predictive Power (Short Δ)</div>
                {[...result.sigStats].sort((a,b)=>Math.abs(b.shortPower)-Math.abs(a.shortPower)).map(sig=>(
                  <div key={sig.key} style={{display:'flex',alignItems:'center',gap:'6px',marginBottom:'4px'}}>
                    <span style={{color:'#9ca3af',width:'52px',fontSize:'10px'}}>{sig.label}</span>
                    <div style={{flex:1,background:'#0f172a',borderRadius:'2px',height:'14px',position:'relative'}}>
                      <div style={{
                        position:'absolute',height:'14px',borderRadius:'2px',
                        background:sig.shortPower>0?sig.color:'#374151',
                        width:`${Math.min(Math.abs(sig.shortPower)*200, 100)}%`,
                        left:sig.shortPower<0?`${100-Math.min(Math.abs(sig.shortPower)*200,100)}%`:'0'
                      }}/>
                    </div>
                    <span style={{color:ppCol(sig.shortPower),width:'36px',textAlign:'right',fontSize:'10px'}}>{pp(sig.shortPower)}</span>
                  </div>
                ))}
                <div style={{marginTop:'8px',fontSize:'9px',color:'#374151'}}>
                  {result.total} trades · {result.ambiguous} ambiguous
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* RESULTS */}
      {tab==='results' && result && (
        <div style={{display:'flex',flexDirection:'column',gap:'14px'}}>
          {/* Partial banner */}
          {partial && (
            <div style={{background:'#1c1a00',border:'1px solid #713f12',borderRadius:'6px',padding:'8px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{color:'#fbbf24',fontSize:'11px'}}>
                ⟳ Partial results — {result.tickersDone}/{result.totalTickers} tickers processed. Auto-updates every {CHUNK} tickers.
              </span>
              <span style={{color:'#713f12',fontSize:'10px'}}>Switch to ▶ Running tab to see progress</span>
            </div>
          )}

          {/* Overview cards */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:'8px'}}>
            {[
              ['Trades',result.total,'gap-up days × 2'],
              ['Long WR',pct(result.baseline.longWR),`n=${result.baseline.longN}`],
              ['Short WR',pct(result.baseline.shortWR),`n=${result.baseline.shortN}`],
              ['Ambiguous',result.ambiguous,'excluded'],
            ].map(([lbl,val,sub])=>(
              <div key={lbl} style={C.card}>
                <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'4px'}}>{lbl}</div>
                <div style={{fontSize:'22px',fontWeight:'bold',color:'#f9fafb'}}>{val}</div>
                <div style={{fontSize:'10px',color:'#374151'}}>{sub}</div>
              </div>
            ))}
          </div>

          {/* Signal tier table */}
          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'10px',textTransform:'uppercase',letterSpacing:'1px'}}>Signal Tier Analysis — Win Rate by Score Bucket</div>
            <div style={{overflowX:'auto'}}>
              <table style={{width:'100%',borderCollapse:'collapse'}}>
                <thead>
                  <tr>
                    <th style={C.th}>Signal</th>
                    <th style={{...C.th,textAlign:'center',color:'#374151'}} colSpan="2">LOW</th>
                    <th style={{...C.th,textAlign:'center',color:'#374151'}} colSpan="2">MED</th>
                    <th style={{...C.th,textAlign:'center',color:'#374151'}} colSpan="2">HIGH</th>
                    <th style={{...C.th,textAlign:'center',color:'#60a5fa'}}>Long Δ</th>
                    <th style={{...C.th,textAlign:'center',color:'#fb7185'}}>Short Δ</th>
                  </tr>
                  <tr style={{borderBottom:'1px solid #1f2937'}}>
                    <th style={{padding:'2px 10px'}}/>
                    {['Long','Short','Long','Short','Long','Short'].map((d,i)=>(
                      <th key={i} style={{textAlign:'center',padding:'2px 6px',color:d==='Long'?'#60a5fa':'#fb7185',fontSize:'10px',fontWeight:'normal'}}>{d}</th>
                    ))}
                    <th colSpan="2"/>
                  </tr>
                </thead>
                <tbody>
                  {result.sigStats.map(sig=>(
                    <tr key={sig.key}>
                      <td style={C.td}>
                        <span style={{display:'inline-block',width:'8px',height:'8px',borderRadius:'50%',background:sig.color,marginRight:'6px'}}/>
                        {sig.label}
                      </td>
                      {sig.tiers.flatMap((tier,i)=>[
                        <td key={`${i}L`} style={C.num(tier.longWR)}>{pct(tier.longWR)}<span style={{color:'#374151',fontSize:'9px'}}> ({tier.longN})</span></td>,
                        <td key={`${i}S`} style={C.num(tier.shortWR)}>{pct(tier.shortWR)}<span style={{color:'#374151',fontSize:'9px'}}> ({tier.shortN})</span></td>,
                      ])}
                      <td style={{...C.td,textAlign:'center',color:ppCol(sig.longPower)}}>{pp(sig.longPower)}</td>
                      <td style={{...C.td,textAlign:'center',color:ppCol(sig.shortPower)}}>{pp(sig.shortPower)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{fontSize:'10px',color:'#374151',marginTop:'6px'}}>Δ = High tier WR − Low tier WR &nbsp;·&nbsp; Green ≥65% &nbsp;·&nbsp; Yellow ≥52% &nbsp;·&nbsp; Red &lt;52% &nbsp;·&nbsp; — = &lt;5 trades</div>
          </div>

          {/* Power charts */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'12px'}}>
            {['long','short'].map(dir=>{
              const field=dir==='long'?'longPower':'shortPower';
              const data=[...result.sigStats].sort((a,b)=>Math.abs(b[field])-Math.abs(a[field])).map(s=>({name:s.label,v:+(s[field]*100).toFixed(0),color:s.color}));
              return(
                <div key={dir} style={C.card}>
                  <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'8px',textTransform:'uppercase'}}>
                    {dir==='long'?'📈 Long':'📉 Short'} — Predictive Power (High−Low pp)
                  </div>
                  <ResponsiveContainer width="100%" height={150}>
                    <BarChart data={data} layout="vertical" margin={{left:5,right:24,top:0,bottom:0}}>
                      <XAxis type="number" tick={{fill:'#4b5563',fontSize:9}} tickFormatter={v=>`${v}pp`}/>
                      <YAxis type="category" dataKey="name" tick={{fill:'#9ca3af',fontSize:11}} width={58}/>
                      <Tooltip formatter={v=>[`${v}pp`,'High−Low spread']} contentStyle={{background:'#111827',border:'1px solid #1f2937',fontSize:'11px',color:'#e5e7eb'}}/>
                      <Bar dataKey="v" radius={[0,3,3,0]}>{data.map((d,i)=><Cell key={i} fill={d.v>0?d.color:'#374151'}/>)}</Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              );
            })}
          </div>

          {/* Top pairs */}
          <div style={C.card}>
            <div style={{fontSize:'10px',color:'#6b7280',marginBottom:'10px',textTransform:'uppercase',letterSpacing:'1px'}}>Top Signal Pairs — Both in High Tier</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'6px'}}>
              {result.pairs.map(p=>(
                <div key={p.label} style={{background:'#0f172a',border:'1px solid #1f2937',borderRadius:'4px',padding:'8px 10px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{color:'#d1d5db',fontSize:'11px'}}>{p.label}</span>
                  <div style={{display:'flex',gap:'10px',fontSize:'11px'}}>
                    <span style={{color:col(p.longWR)}}>L:{pct(p.longWR)}<span style={{color:'#374151',fontSize:'9px'}}>({p.longN})</span></span>
                    <span style={{color:col(p.shortWR)}}>S:{pct(p.shortWR)}<span style={{color:'#374151',fontSize:'9px'}}>({p.shortN})</span></span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Key insights */}
          <div style={{...C.card,borderColor:'#1e3a5f'}}>
            <div style={{fontSize:'10px',color:'#3b82f6',marginBottom:'10px',textTransform:'uppercase',letterSpacing:'1px'}}>Key Findings {partial&&<span style={{color:'#713f12'}}>(partial)</span>}</div>
            {result.sigStats.slice().sort((a,b)=>Math.max(Math.abs(b.longPower),Math.abs(b.shortPower))-Math.max(Math.abs(a.longPower),Math.abs(a.shortPower))).map(sig=>{
              const lp=sig.longPower,sp=sig.shortPower;
              const lines=[];
              if(Math.abs(lp)>=.08) lines.push(`Long: ${lp>0?'follow-through predictor':'fade indicator'} (${pp(lp)})`);
              if(Math.abs(sp)>=.08) lines.push(`Short: ${sp>0?'fade predictor':'follow-through indicator'} (${pp(sp)})`);
              if(!lines.length) return null;
              return(
                <div key={sig.key} style={{marginBottom:'7px',color:'#d1d5db',lineHeight:'1.5'}}>
                  <span style={{color:sig.color}}>▸ {sig.label}:</span>{' '}{lines.join(' · ')}
                </div>
              );
            }).filter(Boolean)}
            <div style={{marginTop:'10px',fontSize:'10px',color:'#374151',borderTop:'1px solid #1f2937',paddingTop:'8px'}}>
              ℹ Outcomes use daily OHLC approximation. Ambiguous trades (both target and stop hit) excluded.
            </div>
          </div>
        </div>
      )}
      {tab==='results'&&!result&&(
        <div style={{color:'#4b5563',textAlign:'center',padding:'60px'}}>Run the backtest to see results.</div>
      )}
    </div>
  );
}
